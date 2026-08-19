// ── 지정가/스탑로스/테이크프로핏/조건부 체결 체크 ──────────────────────────
// Cloudflare Pages Functions 는 정기 실행(cron)을 지원하지 않는다. 그래서 이 유저의
// state/order 요청이 들어올 때마다(클라이언트가 몇 초 간격으로 폴링) checkTriggers() 를
// 호출해 조건이 맞으면 그 자리에서 체결시킨다 — "접속 중이면 ~1초 안에 체결"이 이 경로.
//
// ⚠ 그리고 **접속자가 아무도 없어도** 같은 평가가 돌아야 하므로 sweepTriggers() 를 따로 뒀다
// — cron/ 의 별도 Worker(Cron Trigger, Pages 는 cron 미지원이라 분리 배포)가 매 1분 호출해
// 포지션/미체결/조건부가 있는 **전 유저**를 훑는다(강제청산·지정가·SL/TP·조건부 전부).
// 예전엔 이 sweep 이 강제청산만 봐서, 무한 조건부를 걸어놔도 앱을 닫으면 매수가 멈췄다.
// 두 경로는 runTriggers() 하나를 공유하므로 "접속 중에만 되는 기능"이 생길 여지가 없다.

import {
  type D1PreparedStatement,
  type Env,
  type PendingRow,
  type PositionRow,
  type ConditionalRow,
  fetchPrices,
  isVirtualSymbol,
  feeRateOf,
  feeAccrualStmts,
  unrealizedTotal,
  repeatModeOf,
  effectiveCooldownMs,
  sizeEps,
} from './_shared';
import { autoWritesBlocked } from './_budget';
import {
  matchLimitPendingAgainstBook,
  matchMarketOxOrder,
  matchReduceOnlyOxPending,
  recordVirtualFill,
  PARTIAL_FILL_COOLDOWN_MS,
} from './api/spot';

const EPS = 1e-9; // 부동소수점 잔여수량 판정 오차(조건부 주문 부분체결 잔량 등)

// OX/USDT 는 진짜 상대 거래자가 없으니, 지정가/SL·TP 체결도 합성 시장(호가창·체결내역·다음 봇
// 기준가)에 반영해준다 — order.ts 의 reflectVirtualFill 과 동일한 이유(실패해도 무시, 표시용 부가효과).
async function reflectVirtualFill(env: Env, symbol: string, uid: string, price: number, takerSide: 'buy' | 'sell', size: number) {
  if (!isVirtualSymbol(symbol)) return;
  try {
    await recordVirtualFill(env, symbol, uid, price, takerSide, size);
  } catch {
    /* 표시용 부가효과 — 실패해도 무시 */
  }
}

/** 평가자산(잔고+미실현손익 합) < 0 이면 그 유저의 전 포지션을 강제청산 + 미체결 취소 + 잔고 0.
 * 심볼 가격을 하나라도 못 받아왔으면(allPriced=false) 이번 라운드는 건너뛴다 — 불완전한
 * 데이터로 잘못 청산시키는 것보다 다음 평가에서 다시 보는 게 안전. 청산이 실행됐으면 true. */
async function liquidateIfBankrupt(
  env: Env,
  uid: string,
  positions: PositionRow[],
  pendings: PendingRow[],
  prices: Record<string, number>,
): Promise<boolean> {
  if (positions.length === 0) return false;
  const user = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(uid).first<{ balance: number }>();
  if (!user) return false;

  // 계좌 순자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익).
  // ⚠ 예전엔 증거금 항을 빠뜨리고 "잔고 + 미실현손익"으로만 계산했다 — 진입 시 증거금은 잔고에서
  // 이미 빠져나갔는데(그게 곧 담보다) 그걸 순자산에서 또 제외한 꼴이라, 증거금 비중을 크게 잡으면
  // (슬라이더 100% 등) 진입 즉시 equity 가 0 근처가 돼 아주 작은 역행 틱에도 강제청산되던 치명적 버그.
  let equity = user.balance;
  let allPriced = true;
  for (const pos of positions) {
    const mark = prices[pos.symbol];
    if (mark == null) {
      allPriced = false;
      continue;
    }
    const dir = pos.side === 'long' ? 1 : -1;
    equity += pos.margin + (mark - pos.entry_price) * pos.size * dir;
  }
  if (!allPriced || equity >= 0) return false;

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const pos of positions) {
    const mark = prices[pos.symbol]!;
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (mark - pos.entry_price) * pos.size * dir;
    stmts.push(env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid));
    stmts.push(
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, pos.symbol, pos.side, mark, pos.size, pos.leverage, 'liquidation', pnl, now),
    );
    // ⚠ 강제청산은 **수수료를 걷지 않는다**(바로 아래에서 잔고를 0 으로 리셋하므로 실제로 걷을 수
    // 없는 돈이다 — 부과하면 원장에 걷지도 못한 수익이 잡힌다). 다만 실제로 체결된 거래이므로
    // 거래대금은 누적한다(VIP 등급 산정에 반영). fee=0 인 'liquidation' 원장 행이 남아 나중에
    // "강제청산으로 얼마가 돌았는지"도 집계할 수 있다.
    stmts.push(...feeAccrualStmts(env, uid, pos.symbol, 'liquidation', mark * pos.size, 0, 0, now));
  }
  for (const p of pendings) {
    stmts.push(env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid));
  }
  stmts.push(env.DB.prepare('UPDATE users SET balance = 0 WHERE id = ?').bind(uid));
  await env.DB.batch(stmts);

  // ⚠ OX 강제청산도 상대편(봇)에겐 실제 체결이다 — 진입 때 봇이 팔았던 물량을 여기서 되사줘야
  // 봇 재고가 "유저 전체 순포지션의 거울"로 유지된다. 이걸 빼면 유저가 청산될 때마다 봇 재고가
  // 한쪽으로 영구히 어긋난다(진입 −수량은 기록되는데 청산 +수량이 영영 안 들어옴). 겸사겸사
  // 청산 물량이 체결 테이프/차트에도 찍혀 실제 거래소처럼 "청산이 시장에 나온" 흔적이 남는다.
  // 유저는 수수료를 안 내지만(위 참고) 봇은 낸다 — 봇 잔고는 무한 풀이라 실제로 걷히는 돈이다.
  for (const pos of positions) {
    await reflectVirtualFill(env, pos.symbol, uid, prices[pos.symbol]!, pos.side === 'long' ? 'sell' : 'buy', pos.size);
  }
  return true;
}

/** 조건부(스탑) 주문 로드 — 신규 테이블이라 마이그레이션 전이면 아직 없을 수 있어 방어적으로 감싼다
 * (없으면 조건부 기능만 조용히 비활성, 앱 전체가 500 이 되진 않게). uid 생략 = 전 유저(cron sweep). */
async function loadConditionals(env: Env, uid?: string): Promise<ConditionalRow[]> {
  try {
    const q = uid
      ? env.DB.prepare('SELECT * FROM conditional_orders WHERE user_id = ?').bind(uid)
      : env.DB.prepare('SELECT * FROM conditional_orders');
    return (await q.all<ConditionalRow>()).results;
  } catch {
    return []; // conditional_orders 테이블 미생성(마이그레이션 전)
  }
}

/**
 * cron/ Worker 가 접속자 유무와 무관하게 주기 호출 — 포지션·미체결·조건부가 있는 **전 유저**를 훑어
 * checkTriggers 와 **똑같은 평가**(강제청산 → 지정가 → SL/TP → 조건부)를 돌린다. 즉 앱을 완전히
 * 닫아둬도 조건부(특히 무한 반복)·지정가·SL/TP 가 계속 체결된다. 접속 중일 때와의 차이는 **주기뿐**
 * 이다(폴링 ~1초 vs cron 라운드 ~수십초, cron/index.ts 참고).
 *
 * `cachedPrices` = 같은 cron 실행 안에서 이미 받아둔 시세 맵(있으면 재사용). **실제 코인**은 외부
 * 거래소 fetch 라 한 번의 cron 안에서 여러 번 받아봐야 의미가 없어 재사용하고, **OX** 는 봇 기준가
 * (D1 read)라 항상 새로 읽는다 — cron 이 유일한 클럭일 때 봇이 만든 가격 경로를 라운드마다 다시
 * 샘플링해야 "떨어질 때마다 산다" 같은 조건이 그 사이 지나간 딥을 놓치지 않는다.
 * 반환한 prices 를 다음 라운드에 그대로 넘기면 된다.
 */
/** 한 평가 구간에서 그 심볼이 지나온 가격 범위(§ runTriggers ranges). cron 이 봇 시뮬 경로의 최저/최고를
 * 넘긴다 — 유저 폴링 경로는 안 넘기며, 그때는 현재가 한 점으로 판정한다(예전과 동일). */
export type PriceRanges = Record<string, { low: number; high: number }>;

/** cron 1회가 훑는 최대 유저 수(무료 플랜 invocation당 D1 쿼리 50 방어, § sweepTriggers).
 * 현재 포지션/미체결/조건부를 가진 유저는 4명이라 회전이 아예 일어나지 않는다 — 늘어났을 때를 위한 상한이다. */
const MAX_SWEEP_USERS = 8;

/** 가격 경로 배열을 범위로 압축. 빈 배열이면 undefined(= 범위 정보 없음). */
export function rangeOfPath(path: number[]): { low: number; high: number } | undefined {
  if (path.length === 0) return undefined;
  let low = path[0];
  let high = path[0];
  for (const p of path) {
    if (p < low) low = p;
    if (p > high) high = p;
  }
  return { low, high };
}

export async function sweepTriggers(
  env: Env,
  cachedPrices?: Record<string, number>,
  ranges?: PriceRanges,
): Promise<{ checked: number; liquidated: number; prices: Record<string, number> }> {
  const positions = (await env.DB.prepare('SELECT * FROM positions').all<PositionRow>()).results;
  const pendings = (await env.DB.prepare('SELECT * FROM pending_orders').all<PendingRow>()).results;
  const conditionals = await loadConditionals(env);
  if (positions.length === 0 && pendings.length === 0 && conditionals.length === 0) {
    return { checked: 0, liquidated: 0, prices: cachedPrices ?? {} };
  }

  interface UserWork {
    positions: PositionRow[];
    pendings: PendingRow[];
    conditionals: ConditionalRow[];
  }
  const byUser = new Map<string, UserWork>();
  const workOf = (uid: string): UserWork => {
    let w = byUser.get(uid);
    if (!w) byUser.set(uid, (w = { positions: [], pendings: [], conditionals: [] }));
    return w;
  };
  for (const p of positions) workOf(p.user_id).positions.push(p);
  for (const p of pendings) workOf(p.user_id).pendings.push(p);
  for (const c of conditionals) workOf(c.user_id).conditionals.push(c);

  const symbols = [
    ...new Set([...positions.map((p) => p.symbol), ...pendings.map((p) => p.symbol), ...conditionals.map((c) => c.symbol)]),
  ];
  const stale = symbols.filter((s) => isVirtualSymbol(s) || cachedPrices?.[s] == null);
  const prices = { ...cachedPrices, ...(await fetchPrices(env, stale)) };

  // ⚠⚠ **한 invocation 에서 훑는 유저 수에 상한**을 둔다(2026-08-14, 무료 플랜). Workers/D1 무료 플랜은
  // **invocation당 D1 쿼리 50개**가 한도이고, 넘으면 그 요청이 통째로 실패한다(= 그 분의 청산·체결이
  // 전부 스킵). cron 1회의 고정 비용(봇 2페어 ≈ 12쿼리 + 여기 조회 3)을 빼면 유저 몫은 ~30쿼리인데,
  // 유저 한 명이 실제로 체결되면 5~10쿼리를 쓴다. 유저가 늘어도 이 수가 늘지 않게 **분 단위로 회전**하며
  // 나눠 훑는다 — 접속 중인 유저는 어차피 자기 폴링(checkTriggers, 2.5초)이 즉시 처리하므로, 여기서
  // 늦어지는 건 "앱을 닫아둔 유저"뿐이고 그마저 몇 분 안에 반드시 차례가 온다.
  const uids = [...byUser.keys()].sort(); // 정렬 = 회전 순서가 실행마다 흔들리지 않게(굶는 유저 방지)
  const offset = uids.length > MAX_SWEEP_USERS ? Math.floor(Date.now() / 60_000) % uids.length : 0;
  const slice =
    uids.length <= MAX_SWEEP_USERS
      ? uids
      : Array.from({ length: MAX_SWEEP_USERS }, (_, i) => uids[(offset + i) % uids.length]);

  let liquidated = 0;
  for (const uid of slice) {
    const w = byUser.get(uid)!;
    // 한 유저가 터져도 나머지는 계속 평가한다(다음 라운드/다음 cron 에서 재시도).
    try {
      if (await runTriggers(env, uid, w.pendings, w.positions, w.conditionals, prices, ranges)) liquidated++;
    } catch (e) {
      console.error(`[sweepTriggers] uid=${uid}`, e);
    }
  }
  return { checked: slice.length, liquidated, prices };
}

/** 실제 코인 지정가 청산(reduce-only) 정산 — mark 가 지정가를 크로스하면 대상 포지션을 그 지정가에 청산.
 * 대상 포지션(주문 side 의 반대)을 최신 상태로 다시 읽어(같은 폴링에서 물타기 등이 바꿨을 수 있음) 있으면
 * min(주문수량, 포지션수량)만큼 청산하고 pending 을 삭제한다. 포지션이 이미 없으면 고아 pending 을 정리.
 * (OX 는 봇 호가창 walking 이 필요해 spot.ts matchReduceOnlyOxPending 이 따로 담당 — 여기선 실제 코인 전용.) */
async function settleReduceOnlyClose(env: Env, uid: string, p: PendingRow, mark: number, touch: number): Promise<void> {
  const posSide = p.side === 'short' ? 'long' : 'short'; // 청산 대상 포지션 방향(주문 side 의 반대)
  const pos = await env.DB.prepare('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?')
    .bind(uid, p.symbol, posSide)
    .first<PositionRow>();
  if (!pos) {
    await env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid).run(); // 고아 정리
    return;
  }
  // 매도청산(side short)은 가격이 지정가 이상으로 오르면, 매수청산(side long)은 지정가 이하로 내리면 체결.
  // touch = 이 구간에서 그 방향으로 가장 멀리 간 가격(범위가 없으면 mark 와 같다, § runTriggers ranges).
  const fills = p.side === 'short' ? touch >= p.limit_price : touch <= p.limit_price;
  if (!fills) return;

  const closeSize = Math.min(p.size, pos.size);
  const dir = pos.side === 'long' ? 1 : -1;
  const pnl = (p.limit_price - pos.entry_price) * closeSize * dir;
  // 전량 판정 오차는 수량 비례(sizeEps) — 대량(1e15+) 포지션은 고정 1e-9 로는 전량을 인정 못 해 먼지가 남는다.
  const fullyClosed = closeSize >= pos.size - sizeEps(pos.size);
  const marginReleased = fullyClosed ? pos.margin : (pos.margin * closeSize) / pos.size;
  const now = Date.now();
  const rate = await feeRateOf(env, uid);
  const notional = p.limit_price * closeSize;
  const fee = notional * rate;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(marginReleased + pnl - fee, uid),
    ...feeAccrualStmts(env, uid, p.symbol, 'close', notional, rate, fee, now),
    fullyClosed
      ? env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid)
      : env.DB.prepare('UPDATE positions SET size = ?, margin = ? WHERE id = ? AND user_id = ?')
          .bind(pos.size - closeSize, pos.margin - marginReleased, pos.id, uid),
    env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
    env.DB.prepare(
      'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, p.symbol, pos.side, p.limit_price, closeSize, pos.leverage, 'close', pnl, now),
  ]);
  await reflectVirtualFill(env, p.symbol, uid, p.limit_price, pos.side === 'long' ? 'sell' : 'buy', closeSize);
}

/** 무한 조건부의 "재무장" 가격 — 트리거 반대편으로 여기까지 돌아오면 다시 무장한다(미설정=트리거 가격). */
function rearmPriceOf(c: ConditionalRow): number {
  const r = c.rearm_price;
  return r != null && isFinite(r) && r > 0 ? r : c.trigger_price;
}

/** 체결 뒤 조건부 주문 행을 어떻게 남길지 결정하는 문장 1개.
 * - 무한(repeating): size 는 "1회 실행 수량"이라 차감하지 않고 실행 횟수/마지막 실행 시각만 갱신한다.
 *   `continuous` 는 **무장을 유지**해 조건이 참인 동안 다음 폴링에서 또 실행되고, `rearm` 은 armed=0 으로
 *   내려 가격이 되돌아올 때까지 쉰다. max_fills 에 도달했으면 주문을 삭제한다.
 * - 1회성: 기존대로 남은 수량을 차감하고, 다 채웠으면 삭제(부분 체결이면 조건이 계속 살아있음). */
function conditionalAfterFillStmt(env: Env, uid: string, c: ConditionalRow, filled: number): D1PreparedStatement {
  if (c.repeating) {
    const fills = (c.fill_count ?? 0) + 1;
    const done = c.max_fills != null && fills >= c.max_fills;
    if (done) return env.DB.prepare('DELETE FROM conditional_orders WHERE id = ? AND user_id = ?').bind(c.id, uid);
    const stayArmed = repeatModeOf(c) === 'continuous' ? 1 : 0;
    return env.DB.prepare(
      'UPDATE conditional_orders SET armed = ?, fill_count = ?, last_fill_at = ? WHERE id = ? AND user_id = ?',
    ).bind(stayArmed, fills, Date.now(), c.id, uid);
  }
  const remaining = c.size - filled;
  return remaining <= sizeEps(c.size) // 잔량 판정도 수량 비례(대량 예약이 먼지 잔량으로 영원히 남지 않게)
    ? env.DB.prepare('DELETE FROM conditional_orders WHERE id = ? AND user_id = ?').bind(c.id, uid)
    : env.DB.prepare('UPDATE conditional_orders SET size = ? WHERE id = ? AND user_id = ?').bind(remaining, c.id, uid);
}

/** 조건부(스탑) 주문 정산 — 트리거 가격을 넘어서면 그 자리에서 **시장가**로 남은 수량만큼 진입한다.
 * OX 는 봇 호가창 walking(matchMarketOxOrder), 실제 코인은 mark 가에 즉시 체결하되 **가용 증거금만큼만**
 * 체결하고 못 채운 잔량은 조건을 살려둔다(size 를 줄임) — "예약 수량이 다 안 채워지면 계속 조건 유지".
 * 트리거가 안 됐으면 아무것도 안 하고 그대로 대기. marks 는 크로스 가용(미실현손익) 계산용.
 *
 * ⚠ 무한(반복) 조건부는 체결 후에도 사라지지 않는다:
 *   - `continuous`(기본): 조건이 참인 **동안 계속** 실행 — 폴링마다 1회(cooldown_ms 로 간격 제한 가능).
 *     "1.5 이하로 떨어져 있는 동안 계속 사 모은다". 자동으로 멈추지 않으므로 브레이크는
 *     cooldown_ms/max_fills 뿐이고, 둘 다 없으면 잔고가 바닥날 때까지 진입한다(유저가 택한 동작).
 *   - `rearm`: 한 번 실행되면 무장을 풀고, 가격이 트리거 반대편으로 돌아왔을 때만 다시 무장 → "내려갈 때마다 한 번". */
async function settleConditionalOrder(
  env: Env,
  uid: string,
  c: ConditionalRow,
  mark: number,
  marks: Record<string, number>,
  low: number,
  high: number,
): Promise<void> {
  const mode = repeatModeOf(c);
  // 재무장 대기 중(rearm 모드가 방금 실행된 상태) — 반대편으로 돌아왔으면 다시 무장만 하고 끝낸다.
  // ⚠ 판정은 구간 범위로 — above 조건은 가격이 아래로 돌아와야 재무장이므로 저가를, below 는 고가를 본다
  // (§ runTriggers ranges). 범위가 없으면 low=high=mark 라 예전과 동일하다.
  if (c.repeating && mode === 'rearm' && (c.armed ?? 1) === 0) {
    const rearm = rearmPriceOf(c);
    const back = c.trigger_dir === 'above' ? low <= rearm : high >= rearm;
    if (back) {
      await env.DB.prepare('UPDATE conditional_orders SET armed = 1 WHERE id = ? AND user_id = ?').bind(c.id, uid).run();
    }
    return;
  }

  // ⚠ 발동 판정도 구간 범위로 — 이 구간에 트리거가를 **한 번이라도 건드렸으면** 발동이다. 봇 틱을 한 번에
  // 몰아 도는 cron 경로에서 그 사이 지나간 딥/스파이크를 놓치지 않기 위한 것(§ runTriggers ranges).
  // 체결은 발동 시점이 아니라 **지금 호가창**에 대해 일어난다(가격이 되돌아왔으면 되돌아온 가격에 체결) —
  // 시장가 스탑 주문의 현실적인 동작이고, 예전 4점 샘플링도 그 시점의 호가창에 체결하던 것과 같다.
  const triggered = c.trigger_dir === 'above' ? high >= c.trigger_price : low <= c.trigger_price;
  if (!triggered) return;

  // ⚠ 연속 모드의 재실행 간격 — **하한 5초가 항상 적용된다**(effectiveCooldownMs, § MIN_CONTINUOUS_COOLDOWN_MS).
  // 저장값이 아니라 이 함수로 판정하는 이유: 하한 도입 전에 만들어진 주문들은 DB 에 cooldown_ms=0 으로
  // 남아 있어서, 생성 검증만 고치면 그 주문들은 계속 1초 간격으로 돌아 예산을 태운다.
  if (c.repeating && mode === 'continuous') {
    const cooldown = effectiveCooldownMs(c.cooldown_ms);
    if (c.last_fill_at != null && Date.now() - c.last_fill_at < cooldown) return;
  }

  // ⚠ 반복 조건부는 이 사이트에서 유일하게 "스스로 무한히, 개수 제한도 없이" 쓰기를 만드는 경로다
  // (5초 간격 × 체결당 ~20행 = 주문 하나당 하루 35만 행 → 3개면 100만 행). 그래서 일일/월 차단선을
  // 넘었으면 조용히 물러난다(§ _budget.ts — 봇보다 **먼저** 끊는 쪽이 이것이다).
  // 1회성 주문은 총량이 유한하므로 막지 않는다(막으면 걸어둔 스탑이 안 걸리는 게 더 큰 사고다).
  if (c.repeating && (await autoWritesBlocked(env, 'repeat'))) return;

  // OX/USDT — 봇 호가창을 walking 하며 있는 물량만 실제 호가 가격에 체결(내부에서 잔고/증거금/수수료/봇
  // 재고·체결테이프·캔들까지 전부 정산). 부분 체결이면 filled 만큼만 나가고 잔량은 아래에서 조건 유지.
  if (isVirtualSymbol(c.symbol)) {
    const uPnL = await unrealizedTotal(env, uid, marks);
    const { filled } = await matchMarketOxOrder(env, c.symbol, uid, c.side, c.size, c.leverage, null, null, uPnL);
    // filled==0(감당 못 함/유동성 없음): 아무것도 안 건드림 → 조건(및 무장 상태) 그대로 유지, 다음 폴링 재시도.
    // ⚠ 여기서 예산 계량을 따로 하지 않는다 — matchMarketOxOrder 안의 feeAccrualStmts 가 이미 계량했다
    // (§ _budget.ts "계량 지점"). 여기 또 넣으면 이중 계산이 된다.
    if (filled > EPS) await conditionalAfterFillStmt(env, uid, c, filled).run();
    return;
  }

  // 실제 코인 — 외부 시세(mark)로 즉시 체결(무한 유동성). 단, 감당 가능한 만큼만 체결하고 잔량은 유지.
  const price = mark;
  const feeRate = await feeRateOf(env, uid);
  const uPnL = await unrealizedTotal(env, uid, marks);
  const user = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(uid).first<{ balance: number }>();
  if (!user) return;
  const existing = await env.DB.prepare('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?')
    .bind(uid, c.symbol, c.side)
    .first<PositionRow>();
  const effLev = existing ? existing.leverage : c.leverage; // 물타기 시 기존 포지션 레버리지 고정
  const available = user.balance + uPnL;
  const perUnit = price / effLev + price * feeRate; // 1코인당 드는 돈(증거금+수수료)
  const affordable = perUnit > 0 ? (available * 0.999) / perUnit : 0;
  const fillSize = Math.min(c.size, Math.max(0, affordable));
  if (fillSize <= EPS) return; // 가용이 부족해 하나도 못 삼 → 조건 유지, 다음 폴링 재시도

  const margin = (price * fillSize) / effLev;
  const notional = price * fillSize;
  const fee = notional * feeRate;
  const now = Date.now();
  const ordId = crypto.randomUUID();

  // ⚠ 잔고 차감을 **먼저** 원자 가드로 확정하고, 성공했을 때만 포지션/원장을 기록한다 — batch 로 묶으면
  // 잔고 가드가 0행이어도 포지션 INSERT 가 그대로 커밋돼 "증거금 없이 포지션만 생기는" 상태가 된다
  // (D1 batch 는 조건부 UPDATE 0행을 실패로 안 봄 — editLimit 과 동일한 함정).
  const charge = await env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance - ? >= ?')
    .bind(margin + fee, uid, margin + fee, -uPnL)
    .run();
  if (charge.meta.changes !== 1) return; // 레이스로 가용 부족 → 조건 유지

  const stmts: D1PreparedStatement[] = [...feeAccrualStmts(env, uid, c.symbol, 'open', notional, feeRate, fee, now)];
  if (existing) {
    const newSize = existing.size + fillSize;
    const newEntry = (existing.entry_price * existing.size + price * fillSize) / newSize;
    stmts.push(
      env.DB.prepare('UPDATE positions SET entry_price = ?, size = ?, margin = ? WHERE id = ? AND user_id = ?').bind(
        newEntry,
        newSize,
        existing.margin + margin,
        existing.id,
        uid,
      ),
    );
  } else {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, c.symbol, c.side, price, fillSize, c.leverage, margin, now, null, null),
    );
  }
  stmts.push(
    env.DB.prepare(
      'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(ordId, uid, c.symbol, c.side, price, fillSize, effLev, 'open', null, now),
  );
  stmts.push(conditionalAfterFillStmt(env, uid, c, fillSize));
  // (예산 계량은 위 stmts 첫 항목인 feeAccrualStmts 가 이미 했다 — 여기 또 넣으면 이중 계산)
  await env.DB.batch(stmts);
}

// 반환값 = 이번에 받아온 마크가격 맵(loadState 로 넘겨 클라가 서버와 동일한 시세로 청산가/평가자산을
// 즉시 계산하게 한다 — 추가 fetch 없이 재사용). 포지션/미체결/조건부가 없으면 빈 맵.
export async function checkTriggers(env: Env, uid: string): Promise<Record<string, number>> {
  const pendings = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ?').bind(uid).all<PendingRow>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results;
  const conditionals = await loadConditionals(env, uid);
  if (pendings.length === 0 && positions.length === 0 && conditionals.length === 0) return {};

  const symbols = [
    ...new Set([...pendings.map((p) => p.symbol), ...positions.map((p) => p.symbol), ...conditionals.map((c) => c.symbol)]),
  ];
  const prices = await fetchPrices(env, symbols);
  await runTriggers(env, uid, pendings, positions, conditionals, prices);
  return prices;
}

/** 트리거 평가 본체 — 한 유저의 데이터·시세를 이미 손에 쥔 상태에서 강제청산 → 지정가 → SL/TP →
 * 조건부 순으로 평가한다. 접속 폴링(checkTriggers)과 cron sweep(sweepTriggers)이 **이 함수를 공유**해서
 * "접속 중에만 되는 기능"이 갈라지지 않게 한다. 반환값 = 강제청산이 실행됐는지. */
async function runTriggers(
  env: Env,
  uid: string,
  pendings: PendingRow[],
  positions: PositionRow[],
  conditionals: ConditionalRow[],
  prices: Record<string, number>,
  ranges?: PriceRanges,
): Promise<boolean> {
  // ⚠ 트리거 "발동 여부"는 현재가 한 점이 아니라 **직전 평가 이후 지나온 가격 범위**로 판정한다
  // (2026-08-14). 실제 거래소도 구간의 고가/저가로 스탑을 판정한다. 이게 필요한 이유: OX 가격은
  // 벽시계가 아니라 봇 틱이 돌 때만 움직이는데, cron 은 1분치 틱을 한 번에 몰아 돌린다 — 그 사이
  // 지나간 딥/스파이크를 현재가 한 점으로만 보면 통째로 놓친다("1.0 이하면 매수"인데 8번째 틱에서만
  // 1.0 을 찍고 되돌아온 경우). 예전엔 이걸 "cron 안에서 sweep 을 4번 반복"으로 때웠는데, sweep 한 번이
  // D1 쿼리 ~18개라 4번이면 그것만으로 무료 플랜 invocation 한도(50)를 넘겼다. 범위로 판정하면
  // **한 번의 평가로 그 구간의 모든 딥/스파이크를 잡는다**(4점 샘플링보다 오히려 정확하다).
  // 범위를 안 주면(유저 폴링 경로) 현재가 한 점 = 예전과 동일한 동작.
  const lowOf = (sym: string) => ranges?.[sym]?.low ?? prices[sym];
  const highOf = (sym: string) => ranges?.[sym]?.high ?? prices[sym];
  // ⚠ 강제청산만은 현재가로 본다 — 순간적으로 스쳐간 저가로 계좌를 파산시키면 되돌릴 방법이 없다
  // (스탑 체결은 유저가 예약한 것이지만 강제청산은 아니다). 보수적인 쪽을 택한다.
  if (await liquidateIfBankrupt(env, uid, positions, pendings, prices)) return true; // 방금 지운 대상으로 아래 로직 더 돌릴 필요 없음

  // ── 지정가 체결 ── long: mark<=limit(싸게 매수), short: mark>=limit(비싸게 매도)
  // 체결가는 limit_price 그대로 사용(생성 시 이미 그 가격 기준으로 증거금을 잠갔으므로 재계산 불필요).
  // 같은 심볼·방향 포지션이 이미 있으면(또는 이번 루프에서 방금 합쳐졌으면) 새 행을 또 만들지 않고
  // 평단가를 재계산해 합친다 — order.ts 의 시장가 진입과 동일한 원웨이 모드 동작(포지션 중복 생성 버그 수정).
  const posBySymbolSide = new Map<string, PositionRow>();
  for (const pos of positions) posBySymbolSide.set(`${pos.symbol}|${pos.side}`, pos);

  for (const p of pendings) {
    const mark = prices[p.symbol];
    if (mark == null) continue;

    // OX/USDT 는 봇 호가창에 walking 매칭(runMarketMaker 와 공유하는 실제 매칭 엔진). 있는 물량만
    // 실제 호가 가격에 체결, 잔량은 대기. reduce_only(지정가 청산)면 청산 매칭으로 분기. 실제 코인은 아래로.
    if (isVirtualSymbol(p.symbol)) {
      // ⚠ 재체결 간격 하한은 여기에도 걸어야 한다(§ spot.ts PARTIAL_FILL_COOLDOWN_MS) — 이 경로는
      // sweepRestingOxPendings 와 **같은 주문을 각자** 매칭하므로, 여기만 빠뜨리면 하한이 통째로 무력화된다.
      // 첫 체결(last_fill_at == null)은 그대로 즉시 처리한다.
      if (p.last_fill_at != null && Date.now() - p.last_fill_at < PARTIAL_FILL_COOLDOWN_MS) continue;
      // 여기 오는 주문도 **걸려 있던** 지정가라 taker 는 봇이다(§ spot.ts Aggressor) — 체결내역 라벨은
      // 유저 방향의 반대로 찍힌다. 장부(포지션·잔고·상대방)는 영향 없다.
      if (p.reduce_only) await matchReduceOnlyOxPending(env, p.id, 'bot');
      else await matchLimitPendingAgainstBook(env, p.id, 'bot');
      continue;
    }

    // 지정가 청산(reduce-only, 실제 코인) — 로컬 호가창이 없어 mark 가 지정가를 크로스하면 그 지정가에 청산.
    // 매도청산(side short)은 mark>=limit(가격이 오르면 롱 익절), 매수청산(side long)은 mark<=limit(가격이 내리면 숏 익절).
    if (p.reduce_only) {
      // 매도청산은 고가가, 매수청산은 저가가 지정가를 건드렸는지로 판정(체결가는 지정가 그대로).
      await settleReduceOnlyClose(env, uid, p, mark, p.side === 'short' ? highOf(p.symbol) : lowOf(p.symbol));
      continue;
    }

    const fills = p.side === 'long' ? lowOf(p.symbol) <= p.limit_price : highOf(p.symbol) >= p.limit_price;
    if (!fills) continue;

    const now = Date.now();
    const ordId = crypto.randomUUID();
    const key = `${p.symbol}|${p.side}`;
    const existing = posBySymbolSide.get(key);
    // 지정가는 **주문 낼 때가 아니라 체결될 때** 수수료를 뗀다(거래소 관행). 증거금은 주문 시점에
    // 이미 잠갔으므로 여기선 수수료만 잔고에서 차감한다 — 명목금액의 0.03% 이하라 잔고가 모자라
    // 실패할 여지는 사실상 없고(증거금 대비 수 %), 부족하면 크로스 평가자산이 줄어 강제청산이 처리한다.
    const feeRate = await feeRateOf(env, uid);
    const notional = p.limit_price * p.size;
    const fee = notional * feeRate;
    const feeStmts = [
      env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(fee, uid),
      ...feeAccrualStmts(env, uid, p.symbol, 'open', notional, feeRate, fee, now),
    ];

    if (existing) {
      const newSize = existing.size + p.size;
      const newEntry = (existing.entry_price * existing.size + p.limit_price * p.size) / newSize;
      const newMargin = existing.margin + p.margin;
      const finalSl = p.stop_loss != null ? p.stop_loss : existing.stop_loss;
      const finalTp = p.take_profit != null ? p.take_profit : existing.take_profit;
      await env.DB.batch([
        ...feeStmts,
        env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
        env.DB.prepare(
          'UPDATE positions SET entry_price = ?, size = ?, margin = ?, stop_loss = ?, take_profit = ? WHERE id = ? AND user_id = ?',
        ).bind(newEntry, newSize, newMargin, finalSl, finalTp, existing.id, uid),
        env.DB.prepare(
          'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(ordId, uid, p.symbol, p.side, p.limit_price, p.size, existing.leverage, 'open', null, now),
      ]);
      await reflectVirtualFill(env, p.symbol, uid, p.limit_price, p.side === 'long' ? 'buy' : 'sell', p.size);
      posBySymbolSide.set(key, {
        ...existing,
        entry_price: newEntry,
        size: newSize,
        margin: newMargin,
        stop_loss: finalSl,
        take_profit: finalTp,
      });
    } else {
      const posId = crypto.randomUUID();
      await env.DB.batch([
        ...feeStmts,
        env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
        env.DB.prepare(
          'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).bind(posId, uid, p.symbol, p.side, p.limit_price, p.size, p.leverage, p.margin, now, p.stop_loss, p.take_profit),
        env.DB.prepare(
          'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(ordId, uid, p.symbol, p.side, p.limit_price, p.size, p.leverage, 'open', null, now),
      ]);
      await reflectVirtualFill(env, p.symbol, uid, p.limit_price, p.side === 'long' ? 'buy' : 'sell', p.size);
      posBySymbolSide.set(key, {
        id: posId,
        user_id: uid,
        symbol: p.symbol,
        side: p.side,
        entry_price: p.limit_price,
        size: p.size,
        leverage: p.leverage,
        margin: p.margin,
        opened_at: now,
        stop_loss: p.stop_loss,
        take_profit: p.take_profit,
      });
    }
  }

  // ── SL/TP 트리거 ── 체결가는 stop_loss/take_profit 값 그대로 사용(슬리피지 모델링 없음).
  for (const posSnap of positions) {
    if (posSnap.stop_loss == null && posSnap.take_profit == null) continue;
    const mark = prices[posSnap.symbol];
    if (mark == null) continue;
    // ⚠ 같은 폴링에서 지정가 청산(reduce-only)·물타기가 이 포지션을 이미 줄이거나 없앴을 수 있으므로,
    // 스냅샷이 아니라 최신 상태를 다시 읽어 이중 청산(사라진 포지션에 잔고를 또 환급)하지 않게 한다.
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(posSnap.id, uid)
      .first<PositionRow>();
    if (!pos || (pos.stop_loss == null && pos.take_profit == null)) continue;
    const dir = pos.side === 'long' ? 1 : -1;

    // ⚠ 발동 판정은 구간의 저가/고가로(§ runTriggers ranges) — 롱은 저가가 SL 을, 고가가 TP 를 건드렸는지.
    // 체결가는 예전과 같이 SL/TP 값 그대로다(슬리피지 모델링 없음).
    const low = lowOf(pos.symbol);
    const high = highOf(pos.symbol);
    let trigger: number | null = null;
    if (pos.side === 'long') {
      if (pos.stop_loss != null && low <= pos.stop_loss) trigger = pos.stop_loss;
      else if (pos.take_profit != null && high >= pos.take_profit) trigger = pos.take_profit;
    } else {
      if (pos.stop_loss != null && high >= pos.stop_loss) trigger = pos.stop_loss;
      else if (pos.take_profit != null && low <= pos.take_profit) trigger = pos.take_profit;
    }
    if (trigger == null) continue;

    const pnl = (trigger - pos.entry_price) * pos.size * dir;
    const now = Date.now();
    const ordId = crypto.randomUUID();
    const slRate = await feeRateOf(env, uid);
    const slNotional = trigger * pos.size;
    const slFee = slNotional * slRate;
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(pos.margin + pnl - slFee, uid),
      ...feeAccrualStmts(env, uid, pos.symbol, 'close', slNotional, slRate, slFee, now),
      env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, pos.symbol, pos.side, trigger, pos.size, pos.leverage, 'close', pnl, now),
    ]);
    await reflectVirtualFill(env, pos.symbol, uid, trigger, pos.side === 'long' ? 'sell' : 'buy', pos.size);
  }

  // ── 조건부(스탑) 주문 트리거 ── 트리거 가격을 넘어서면 시장가로 진입(있는 만큼만, 잔량은 조건 유지).
  for (const c of conditionals) {
    const mark = prices[c.symbol];
    if (mark == null) continue;
    await settleConditionalOrder(env, uid, c, mark, prices, lowOf(c.symbol), highOf(c.symbol));
  }

  return false;
}
