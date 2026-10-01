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
  quoteOf,
  balCol,
  balColOf,
  type Quote,
  positionAddStmts,
  positionClaimStmt,
  pendingClaimStmt,
  claimThenSettle,
  guardStmt,
  guardedBatch,
} from './_shared';
import { autoWritesBlocked } from './_budget';
import {
  matchLimitPendingAgainstBook,
  matchMarketOxOrder,
  matchReduceOnlyOxPending,
  marketCloseOxPosition,
  crossingOxPendings,
  recordVirtualFill,
  PARTIAL_FILL_COOLDOWN_MS,
} from './api/spot';

const EPS = 1e-9; // 부동소수점 잔여수량 판정 오차(조건부 주문 부분체결 잔량 등)
/** 배열을 n 개씩 — D1 바운드 파라미터 상한(쿼리당 100)에 맞춰 IN 목록·다중행 INSERT 를 자른다. */
const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

// ── 한 요청이 트리거 체결에 쓸 수 있는 D1 쿼리 몫(2026-10-01, §6 invocation당 쿼리 50) ─────────────────
// ⚠ 체결 하나가 가상 코인은 ~25쿼리(읽기 4 + batch ~20), 실제 코인은 ~10쿼리다. 한 평가에 여러 개가 몰리면(대기 지정가
// 여럿이 한꺼번에 크로스, cron 이 여러 유저를 훑음) 한도를 넘겨 그 요청이 통째로 실패했다 — batch 는 원자라 돈은 안전하지만
// 폴링이 500 이 되고, cron 이면 그 뒤 유저들의 강제청산·SL 까지 그 분은 멈춘다. 몫을 넘는 체결은 **다음 평가로 미룬다**
// (폴링 2.5초·cron 1분 — 걸린 조건은 그대로 남아 있으므로 잃는 건 몇 초다). 강제청산은 몫과 무관하게 항상 돈다.
export interface FillBudget {
  q: number;
}
const HEAVY_FILL_Q = 25; // 가상 코인 호가창 체결(지정가·지정가 청산·SL/TP·조건부)
const LIGHT_FILL_Q = 10; // 실제 코인 체결(외부 시세 정산)
/** 가상 코인 매칭을 시도했는데 하나도 못 채웠을 때 실제로 든 몫(읽기 ~5). ⚠ 몫은 **시도 전에 확인하고 결과에 따라 뗀다** — 잔고가
 * 없어 영영 못 채우는 크로스 주문(예: 증거금 없는 초저가 숏 지정가)이 매번 25 를 먼저 떼면 cron 의 공유 몫을 혼자 다 써서 다른
 * 유저의 SL·지정가가 밀렸다(로컬 재현). */
const PROBE_Q = 5;
/** 몫이 cost 만큼 남았나(떼지는 않는다). */
const hasRoom = (b: FillBudget, cost: number) => b.q >= cost;
/** 폴링 한 번의 몫 — 가상 코인 체결 하나 또는 실제 코인 체결 셋. */
export const POLL_FILL_Q = 30;
/** 통합 폴링(`?tick=`)의 몫 — 봇 커밋·호가창·캔들을 함께 하므로 가상 코인 체결 하나까지만. */
export const HEAVY_TICK_FILL_Q = HEAVY_FILL_Q;
/** 주문 액션 앞의 평가 몫 — 그 액션 자체가 무거울 수 있어(가상 코인 시장가 ~25) 실제 코인 체결 하나까지만. */
export const ACTION_FILL_Q = 10;
/** cron 1회(모든 유저 합계)의 몫 — 봇 버스트(읽기 4 + 페어별 커밋 ~3)와 전체 조회(4)를 뺀 ~36 에서 여유를 둔 값.
 * 가상 코인 체결 하나는 늘 들어가야 한다(안 그러면 앱을 닫아 둔 유저의 OX 지정가·SL 이 영영 안 걸린다).
 * 유저마다 기본 조회(잔고 1)도 여기서 뗀다. */
const CRON_FILL_Q = 34;
const CRON_USER_BASE_Q = 1;
/** 몫이 남았으면 떼고 true. */
function spend(b: FillBudget, cost: number): boolean {
  if (b.q < cost) return false;
  b.q -= cost;
  return true;
}

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

type WalletBalances = { balance: number; krw_balance: number };

/** 강제청산 대상 지갑들 — 순수 계산(D1 없음). `liquidateIfBankrupt` 의 판정과 cron 의 사전 점검(§ sweepTriggers)이
 * **이 함수 하나**를 쓴다(두 곳에 식을 따로 적으면 한쪽만 고쳐져 "점검은 통과했는데 실제론 파산"이 생긴다).
 * ⚠ 지갑(결제통화)별로 따로 판정한다 — 원화 지갑이 파산해도 USDT 포지션은 건드리지 않는다(§ _shared quoteOf).
 * 그 지갑의 심볼 가격을 하나라도 못 받아왔으면 그 지갑은 대상에서 뺀다 — 불완전한 데이터로 잘못 청산시키는 것보다
 * 다음 평가에서 다시 보는 게 안전. 빗썸이 멈춰도 USDT 지갑 판정은 계속 돈다. */
function bankruptWallets(
  user: WalletBalances,
  positions: PositionRow[],
  prices: Record<string, number>,
  pendings: PendingRow[] = [],
): Quote[] {
  const out: Quote[] = [];
  for (const q of ['USDT', 'KRW'] as Quote[]) {
    const qPos = positions.filter((p) => quoteOf(p.symbol) === q);
    if (qPos.length === 0) continue;
    // 계좌 순자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익) + Σ(대기 지정가에 잠긴 증거금).
    // ⚠ 예전엔 증거금 항을 빠뜨리고 "잔고 + 미실현손익"으로만 계산했다 — 진입 시 증거금은 잔고에서
    // 이미 빠져나갔는데(그게 곧 담보다) 그걸 순자산에서 또 제외한 꼴이라, 증거금 비중을 크게 잡으면
    // (슬라이더 100% 등) 진입 즉시 equity 가 0 근처가 돼 아주 작은 역행 틱에도 강제청산되던 치명적 버그.
    // ⚠⚠ 대기 지정가(진입)에 잠긴 증거금도 같은 이유로 순자산이다(2026-10-01) — 잔고에서 빠져 주문에 묶였을 뿐 내 돈이다.
    // 이걸 빼고 계산해서, 지정가에 9,000 을 걸어 둔 채 작은 포지션이 조금만 손실 나도 파산으로 판정됐고, 청산이 그 주문을
    // **환불 없이** 지워 버렸다(감사). 리필·랭킹·화면(useEquity)도 같은 식이다.
    let equity = q === 'KRW' ? (user.krw_balance ?? 0) : user.balance;
    for (const p of pendings) if (!p.reduce_only && quoteOf(p.symbol) === q) equity += p.margin;
    let allPriced = true;
    for (const pos of qPos) {
      const mark = prices[pos.symbol];
      if (mark == null) {
        allPriced = false;
        continue;
      }
      const dir = pos.side === 'long' ? 1 : -1;
      equity += pos.margin + (mark - pos.entry_price) * pos.size * dir;
    }
    if (allPriced && equity < 0) out.push(q);
  }
  return out;
}

/** 평가자산(잔고+미실현손익 합) < 0 이면 **그 지갑의** 전 포지션을 강제청산 + 미체결 취소 + 잔고 0.
 * 판정은 `bankruptWallets`(지갑별, 시세가 빈 지갑은 건너뜀). ⚠ 잔고는 **여기서 새로 읽는다** — 되돌릴 수 없는
 * 동작이라 미리 읽어 둔 값으로 결정하지 않는다(cron 의 사전 점검은 "할 일이 없는 유저"를 거르는 데만 쓴다).
 * 청산이 하나라도 실행됐으면 true. */
async function liquidateIfBankrupt(
  env: Env,
  uid: string,
  positions: PositionRow[],
  pendings: PendingRow[],
  prices: Record<string, number>,
): Promise<boolean> {
  if (positions.length === 0) return false;
  const user = await env.DB.prepare('SELECT balance, krw_balance FROM users WHERE id = ?')
    .bind(uid)
    .first<WalletBalances>();
  if (!user) return false;

  let any = false;
  for (const q of bankruptWallets(user, positions, prices, pendings)) {
    const qPos = positions.filter((p) => quoteOf(p.symbol) === q);
    const qPend = pendings.filter((p) => quoteOf(p.symbol) === q);
    const now = Date.now();
    // ⚠⚠ 문장 수가 포지션 수와 **무관하게** 일정해야 한다(2026-10-01). 예전엔 포지션마다 DELETE + 주문 INSERT + 원장 3문장,
    // 대기 주문마다 DELETE 를 한 batch 에 넣어서 포지션이 ~10개면 요청당 쿼리 50 을 넘겨 batch 가 통째로 거부됐다 —
    // 청산이 영원히 안 되고, 모든 요청이 맨 앞에서 이걸 돌리므로 **그 유저의 폴링·주문이 전부 500** 이 됐다(감사).
    // 지금은 포지션 삭제(30개/문장) + 주문 기록 다중행 INSERT(9행/문장) + 원장 1회 + 대기 주문 삭제 + 잔고 1.
    // ⚠ 판정에 쓴 값이 **그대로일 때만** 청산한다 — 포지션은 수량·증거금까지, 잔고는 읽은 값과 같을 때만(가드, § _shared).
    // 다른 평가(폴링·cron)가 먼저 청산했거나 그 사이 체결·환급·환전으로 무엇이든 바뀌었으면 batch 전체가 되돌려지고, 다음
    // 평가가 최신 값으로 다시 판정한다(같은 청산을 두 번 기록하거나, 방금 들어온 환급을 0 으로 지워 버리지 않게).
    const stmts: D1PreparedStatement[] = [];
    for (const rows of chunk(qPos, 30)) {
      stmts.push(
        env.DB.prepare(
          `DELETE FROM positions WHERE user_id = ? AND (${rows.map(() => '(id = ? AND size = ? AND margin = ?)').join(' OR ')})`,
        ).bind(uid, ...rows.flatMap((p) => [p.id, p.size, p.margin])),
        guardStmt(env, rows.length),
      );
    }
    const col = balCol(q);
    stmts.push(
      env.DB.prepare(`UPDATE users SET ${col} = 0 WHERE id = ? AND ${col} = ?`).bind(uid, q === 'KRW' ? (user.krw_balance ?? 0) : user.balance),
      guardStmt(env),
    );
    for (const rows of chunk(qPos, 9)) {
      const binds: unknown[] = [];
      for (const pos of rows) {
        const mark = prices[pos.symbol]!;
        const pnl = (mark - pos.entry_price) * pos.size * (pos.side === 'long' ? 1 : -1);
        binds.push(crypto.randomUUID(), uid, pos.symbol, pos.side, mark, pos.size, pos.leverage, 'liquidation', pnl, now);
      }
      stmts.push(
        env.DB.prepare(
          `INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        ).bind(...binds),
      );
    }
    // ⚠ 강제청산은 **수수료를 걷지 않는다**(위에서 잔고를 0 으로 리셋하므로 실제로 걷을 수
    // 없는 돈이다 — 부과하면 원장에 걷지도 못한 수익이 잡힌다). 다만 실제로 체결된 거래이므로
    // 거래대금은 누적한다(VIP 등급 산정에 반영). 같은 지갑이라 환산 기준이 같아 **합계로 한 번만** 남긴다.
    stmts.push(
      ...feeAccrualStmts(env, uid, qPos[0].symbol, 'liquidation', qPos.reduce((a, p) => a + prices[p.symbol]! * p.size, 0), 0, 0, now),
    );
    // 이 지갑의 미체결만 취소한다(다른 통화 주문은 그 지갑 담보라 그대로 둔다). 진입 지정가에 잠긴 증거금은 위 순자산에
    // 이미 들어가 함께 바닥났으므로 환불하지 않는다.
    for (const ids of chunk(qPend.map((p) => p.id), 90)) {
      stmts.push(env.DB.prepare(`DELETE FROM pending_orders WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(uid, ...ids));
    }
    let done: boolean;
    try {
      done = await guardedBatch(env, stmts);
    } catch (e) {
      // batch 는 통째로 롤백됐다(아무것도 안 바뀜) — 다음 평가가 다시 시도한다. 조용히 넘기지 말고 남긴다.
      console.error(`[liquidate] uid=${uid} ${q} 실패(변경 없음):`, e instanceof Error ? e.message : e);
      throw e;
    }
    if (!done) continue; // 그 사이 다른 평가·체결이 상태를 바꿨다 — 다음 평가가 최신 값으로 다시 판정한다

    // ⚠ OX 강제청산도 상대편(봇)에겐 실제 체결이다 — 진입 때 봇이 팔았던 물량을 여기서 되사줘야
    // 봇 재고가 "유저 전체 순포지션의 거울"로 유지된다. 이걸 빼면 유저가 청산될 때마다 봇 재고가
    // 한쪽으로 영구히 어긋난다(진입 −수량은 기록되는데 청산 +수량이 영영 안 들어옴). 겸사겸사
    // 청산 물량이 체결 테이프/차트에도 찍혀 실제 거래소처럼 "청산이 시장에 나온" 흔적이 남는다.
    // 유저는 수수료를 안 내지만(위 참고) 봇은 낸다 — 봇 잔고는 무한 풀이라 실제로 걷히는 돈이다.
    for (const pos of qPos) {
      await reflectVirtualFill(env, pos.symbol, uid, prices[pos.symbol]!, pos.side === 'long' ? 'sell' : 'buy', pos.size);
    }
    any = true;
  }
  return any;
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
  seed?: Record<string, number>, // 이 실행이 이미 아는 시세(cron: 방금 커밋한 가상 코인 기준가) — 다시 읽지 않는다
): Promise<{ checked: number; liquidated: number; prices: Record<string, number> }> {
  // ⚠⚠ 읽기 넷(포지션·대기·조건부·잔고)을 **batch 하나로**(2026-10-01, cron CPU 초과 수정). 무료 플랜 CPU 10ms 에서
  // D1 호출 1회가 isolate CPU ~0.45ms 라(실측), 예전처럼 테이블마다 + 유저마다 따로 읽으면 sweep 혼자 4~5ms 를 썼다.
  // 잔고는 **포지션이 있는 유저만**(강제청산 판정에만 쓴다). batch 가 깨지면(예: 조건부 테이블 마이그레이션 전)
  // 예전처럼 하나씩 읽는다 — 그때는 잔고를 미리 못 읽으므로 사전 점검 없이 전원을 평가한다(무회귀).
  let positions: PositionRow[];
  let pendings: PendingRow[];
  let conditionals: ConditionalRow[];
  let balances: Map<string, WalletBalances> | null = null;
  try {
    const [pos, pend, cond, bal] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM positions'),
      env.DB.prepare('SELECT * FROM pending_orders'),
      env.DB.prepare('SELECT * FROM conditional_orders'),
      env.DB.prepare('SELECT id, balance, krw_balance FROM users WHERE id IN (SELECT user_id FROM positions)'),
    ]);
    positions = pos.results as PositionRow[];
    pendings = pend.results as PendingRow[];
    conditionals = cond.results as ConditionalRow[];
    balances = new Map((bal.results as (WalletBalances & { id: string })[]).map((u) => [u.id, u]));
  } catch {
    positions = (await env.DB.prepare('SELECT * FROM positions').all<PositionRow>()).results;
    pendings = (await env.DB.prepare('SELECT * FROM pending_orders').all<PendingRow>()).results;
    conditionals = await loadConditionals(env);
  }
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
  const prices = { ...cachedPrices, ...(await fetchPrices(env, stale, seed)) };

  // ⚠⚠ **한 invocation 에서 훑는 유저 수에 상한**을 둔다(2026-08-14, 무료 플랜). Workers/D1 무료 플랜은
  // **invocation당 D1 쿼리 50개**가 한도이고, 넘으면 그 요청이 통째로 실패한다(= 그 분의 청산·체결이
  // 전부 스킵). cron 1회의 고정 비용(봇 2페어 ≈ 12쿼리 + 여기 조회 3)을 빼면 유저 몫은 ~30쿼리인데,
  // 유저 한 명이 실제로 체결되면 5~10쿼리를 쓴다. 유저가 늘어도 이 수가 늘지 않게 **분 단위로 회전**하며
  // 나눠 훑는다 — 접속 중인 유저는 어차피 자기 폴링(checkTriggers, 2.5초)이 즉시 처리하므로, 여기서
  // 늦어지는 건 "앱을 닫아둔 유저"뿐이고 그마저 몇 분 안에 반드시 차례가 온다.
  // ⚠ 시작점은 **항상** 분마다 돈다(2026-10-01) — 체결 몫(§ FillBudget)이 앞 유저에게서 바닥나면 뒤 유저가 매번 밀리므로,
  // 유저 수가 상한 아래여도 같은 유저가 늘 맨 앞에 서지 않게 한다.
  const uids = [...byUser.keys()].sort(); // 정렬 = 회전 순서가 실행마다 흔들리지 않게(굶는 유저 방지)
  const offset = uids.length > 0 ? Math.floor(Date.now() / 60_000) % uids.length : 0;
  const slice = Array.from({ length: Math.min(MAX_SWEEP_USERS, uids.length) }, (_, i) => uids[(offset + i) % uids.length]);
  const budget: FillBudget = { q: CRON_FILL_Q }; // 이 실행의 모든 유저가 나눠 쓴다

  let liquidated = 0;
  for (const uid of slice) {
    const w = byUser.get(uid)!;
    // ⚠ **할 일이 없는 유저는 건너뛴다** — 걸어둔 게 없고(대기·조건부·SL/TP 0) 미리 읽은 잔고로 봐도 파산이 아니면
    // runTriggers 가 할 수 있는 일이 없다(강제청산 판정용 잔고 조회 1회만 하고 끝난다). 가장 흔한 유저(포지션만 들고
    // 있는 사람)가 여기 해당해 유저마다 나가던 D1 왕복이 사라진다. 파산 후보이거나 걸어둔 게 있으면 예전과 똑같이
    // 평가하고, **강제청산 여부는 runTriggers 가 잔고를 새로 읽어 다시 판정**한다(§ liquidateIfBankrupt).
    const armed = w.pendings.length > 0 || w.conditionals.length > 0 || w.positions.some((p) => p.stop_loss != null || p.take_profit != null);
    if (!armed && balances) {
      const bal = balances.get(uid);
      if (!bal || bankruptWallets(bal, w.positions, prices, w.pendings).length === 0) continue;
    }
    // 유저마다 기본 조회(잔고·사다리)가 드니 그 몫도 뗀다 — 다 썼으면 나머지 유저는 다음 분에(시작점이 돈다).
    if (!spend(budget, CRON_USER_BASE_Q)) break;
    // 한 유저가 터져도 나머지는 계속 평가한다(다음 라운드/다음 cron 에서 재시도).
    try {
      if (await runTriggers(env, uid, w.pendings, w.positions, w.conditionals, prices, ranges, budget)) liquidated++;
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
async function settleReduceOnlyClose(env: Env, uid: string, p: PendingRow, mark: number, touch: number, budget: FillBudget): Promise<void> {
  // 매도청산(side short)은 가격이 지정가 이상으로 오르면, 매수청산(side long)은 지정가 이하로 내리면 체결.
  // touch = 이 구간에서 그 방향으로 가장 멀리 간 가격(범위가 없으면 mark 와 같다, § runTriggers ranges).
  // ⚠ 발동 판정을 **읽기 전에** 한다 — 안 걸린 주문 때문에 매 평가마다 포지션을 다시 읽지 않게(요청당 쿼리 50, §6).
  const fills = p.side === 'short' ? touch >= p.limit_price : touch <= p.limit_price;
  if (!fills || !spend(budget, LIGHT_FILL_Q)) return;
  const posSide = p.side === 'short' ? 'long' : 'short'; // 청산 대상 포지션 방향(주문 side 의 반대)
  const pos = await env.DB.prepare('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?')
    .bind(uid, p.symbol, posSide)
    .first<PositionRow>();
  if (!pos) {
    await pendingClaimStmt(env, p).run(); // 고아 정리(청산할 포지션이 없다)
    return;
  }

  const closeSize = Math.min(p.size, pos.size);
  const dir = pos.side === 'long' ? 1 : -1;
  // 전량 판정 오차는 수량 비례(sizeEps) — 대량(1e15+) 포지션은 고정 1e-9 로는 전량을 인정 못 해 먼지가 남는다.
  const full = closeSize >= pos.size - sizeEps(pos.size);
  const cut = { size: full ? pos.size : closeSize, margin: full ? pos.margin : (pos.margin * closeSize) / pos.size, full };
  const pnl = (p.limit_price - pos.entry_price) * cut.size * dir;
  const now = Date.now();
  const rate = await feeRateOf(env, uid);
  const notional = p.limit_price * cut.size;
  const fee = notional * rate;
  const col = balColOf(p.symbol);
  // ⚠⚠ 주문과 포지션을 **둘 다 선점**한 뒤에만 환급한다(2026-10-01) — 예전엔 환급·삭제를 한 batch 에 넣고 결과를 안 봐서
  // 폴링과 cron 이 같은 주문을 동시에 처리하면 두 번 환급됐다(감사). 둘 중 하나라도 빗나가면 batch 전체가 되돌려진다(§ 가드 문장).
  await claimThenSettle(
    env,
    [
      pendingClaimStmt(env, p),
      positionClaimStmt(env, uid, pos, cut),
    ],
    [
      env.DB.prepare(`UPDATE users SET ${col} = ${col} + ? WHERE id = ?`).bind(cut.margin + pnl - fee, uid),
      ...feeAccrualStmts(env, uid, p.symbol, 'close', notional, rate, fee, now),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, p.symbol, pos.side, p.limit_price, cut.size, pos.leverage, 'close', pnl, now),
    ],
  );
}

/** 실제 코인 진입 지정가 체결 — 주문 때 잠가 둔 증거금을 그대로 포지션으로 옮기고 수수료만 뗀다(체결가 = 지정가).
 * ⚠⚠ 주문을 **선점한 뒤에만** 포지션을 만든다(2026-10-01). 예전엔 삭제·포지션 기록을 한 batch 에 넣고 결과를 안 봐서
 * 폴링과 cron 이 같은 주문을 동시에 처리하면 증거금은 한 번 잠갔는데 포지션이 두 번 생겼다(감사). 합치기도 읽어 둔
 * 포지션 값이 아니라 SQL 상대값으로 한다(§ _shared positionAddStmts) — 같은 평가 안에서 연달아 체결돼도 정확하다.
 * 지정가는 **주문 낼 때가 아니라 체결될 때** 수수료를 뗀다(거래소 관행) — 명목금액의 0.03% 이하라 잔고가 모자랄 일은
 * 사실상 없고, 모자라면 크로스 평가자산이 줄어 강제청산이 처리한다. */
async function settleLimitOpen(env: Env, uid: string, p: PendingRow): Promise<void> {
  const now = Date.now();
  const feeRate = await feeRateOf(env, uid);
  const notional = p.limit_price * p.size;
  const fee = notional * feeRate;
  const col = balColOf(p.symbol);
  await claimThenSettle(
    env,
    [pendingClaimStmt(env, p)],
    [
      env.DB.prepare(`UPDATE users SET ${col} = ${col} - ? WHERE id = ?`).bind(fee, uid),
      ...feeAccrualStmts(env, uid, p.symbol, 'open', notional, feeRate, fee, now),
      ...positionAddStmts(env, {
        uid,
        symbol: p.symbol,
        side: p.side,
        price: p.limit_price,
        size: p.size,
        leverage: p.leverage,
        margin: p.margin,
        stopLoss: p.stop_loss,
        takeProfit: p.take_profit,
        now,
      }),
      // 주문내역의 레버리지 = 합쳐진 포지션의 레버리지(물타기면 기존 값 고정, 새로 열렸으면 이 주문 값). 바로 위 문장들 뒤에
      // 실행되므로 하위 조회가 그 결과를 본다 — 포지션을 따로 읽지 않는다.
      env.DB.prepare(
        `INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at)
         VALUES (?,?,?,?,?,?,COALESCE((SELECT leverage FROM positions WHERE user_id = ? AND symbol = ? AND side = ? ORDER BY opened_at LIMIT 1), ?),?,?,?)`,
      ).bind(crypto.randomUUID(), uid, p.symbol, p.side, p.limit_price, p.size, uid, p.symbol, p.side, p.leverage, 'open', null, now),
    ],
  );
}

/** 이 구간에 SL/TP 가 걸렸나 — 롱은 저가가 SL 을, 고가가 TP 를 건드렸는지(숏은 반대). 둘 다 걸렸으면 SL 이 먼저다
 * (어느 쪽이 먼저 닿았는지 모를 때 유저에게 유리한 쪽을 가정하지 않는다). */
function slTpHit(pos: PositionRow, low: number, high: number): 'sl' | 'tp' | null {
  if (pos.side === 'long') {
    if (pos.stop_loss != null && low <= pos.stop_loss) return 'sl';
    if (pos.take_profit != null && high >= pos.take_profit) return 'tp';
  } else {
    if (pos.stop_loss != null && high >= pos.stop_loss) return 'sl';
    if (pos.take_profit != null && low <= pos.take_profit) return 'tp';
  }
  return null;
}

/** 실제 코인 SL/TP 전량 청산 — 포지션을 **선점한 뒤에만** 환급한다(동시 평가가 두 번 환급하지 않게, § claimThenSettle). */
async function settleSlTpClose(env: Env, uid: string, pos: PositionRow, price: number): Promise<void> {
  const pnl = (price - pos.entry_price) * pos.size * (pos.side === 'long' ? 1 : -1);
  const now = Date.now();
  const rate = await feeRateOf(env, uid);
  const notional = price * pos.size;
  const fee = notional * rate;
  const col = balColOf(pos.symbol);
  const cut = { size: pos.size, margin: pos.margin, full: true };
  await claimThenSettle(
    env,
    [positionClaimStmt(env, uid, pos, cut)],
    [
      env.DB.prepare(`UPDATE users SET ${col} = ${col} + ? WHERE id = ?`).bind(pos.margin + pnl - fee, uid),
      ...feeAccrualStmts(env, uid, pos.symbol, 'close', notional, rate, fee, now),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, pos.symbol, pos.side, price, pos.size, pos.leverage, 'close', pnl, now),
    ],
  );
}

/** 무한 조건부의 "재무장" 가격 — 트리거 반대편으로 여기까지 돌아오면 다시 무장한다(미설정=트리거 가격). */
function rearmPriceOf(c: ConditionalRow): number {
  const r = c.rearm_price;
  return r != null && isFinite(r) && r > 0 ? r : c.trigger_price;
}

/// ── 조건부 주문의 체결 기록 = 선점(2026-10-01) ─────────────────────────────────────────────────
// ⚠⚠ 화면 폴링(2.5초)·cron·두 번째 탭이 같은 유저를 동시에 평가하면 같은 조건부를 둘 다 "발동"으로 본다. 예전엔
// 아무 표시 없이 각자 체결해서 1회성 주문이 두 번 채워지고(수량 2배), 실행 횟수를 **읽은 값 + 1** 로 덮어써
// `max_fills` 를 넘겼다(감사). 지금은 체결을 기록하는 문장 자체가 **읽은 상태 그대로일 때만** 바뀌는 선점이고, 바로 뒤의
// 가드가 그걸 확인한다 — 체결(잔고·포지션·원장)과 같은 batch 라 둘 중 하나만 반영되는 일이 없다(§ _shared 가드 문장):
//   · 1회성: 남은 수량을 체결분만큼 줄인다 — 읽은 수량 그대로일 때만(size CAS).
//   · continuous: 마지막 실행 시각이 재실행 간격(≥5초)보다 오래됐을 때만 지금으로 바꾼다 — 그 게이트가 곧 선점이다.
//   · rearm: 무장(armed 1)일 때만 0 으로 내린다(체결되면 원래 내려가는 값).
// 무한 주문은 같은 문장에서 실행 횟수를 **상대값으로** +1 한다(size 는 "1회 실행 수량"이라 그대로 둔다).
function conditionalFillStmts(env: Env, uid: string, c: ConditionalRow, filled: number, now: number): D1PreparedStatement[] {
  if (c.repeating) {
    const claim =
      repeatModeOf(c) === 'rearm'
        ? env.DB.prepare(
            'UPDATE conditional_orders SET armed = 0, fill_count = IFNULL(fill_count, 0) + 1, last_fill_at = ? WHERE id = ? AND user_id = ? AND IFNULL(armed, 1) = 1',
          ).bind(now, c.id, uid)
        : env.DB.prepare(
            'UPDATE conditional_orders SET fill_count = IFNULL(fill_count, 0) + 1, last_fill_at = ? WHERE id = ? AND user_id = ? AND (last_fill_at IS NULL OR last_fill_at <= ?)',
          ).bind(now, c.id, uid, now - effectiveCooldownMs(c.cooldown_ms));
    return [
      claim,
      guardStmt(env),
      env.DB.prepare(
        'DELETE FROM conditional_orders WHERE id = ? AND user_id = ? AND max_fills IS NOT NULL AND fill_count >= max_fills',
      ).bind(c.id, uid),
    ];
  }
  return [
    env.DB.prepare('UPDATE conditional_orders SET size = size - ? WHERE id = ? AND user_id = ? AND size = ?').bind(filled, c.id, uid, c.size),
    guardStmt(env),
    // 잔량 판정도 수량 비례(대량 예약이 먼지 잔량으로 영원히 남지 않게) — 다 채웠으면 지운다, 아니면 조건이 계속 살아있다.
    env.DB.prepare('DELETE FROM conditional_orders WHERE id = ? AND user_id = ? AND size <= ?').bind(c.id, uid, sizeEps(c.size)),
  ];
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
  budget: FillBudget,
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
  // 남아 있어서, 생성 검증만 고치면 그 주문들은 계속 1초 간격으로 돌아 예산을 태운다. (여기는 읽은 값으로 하는 빠른
  // 거르기이고, 진짜 판정은 체결 batch 안의 선점 문장이 원자적으로 한다 — § conditionalFillStmts.)
  if (c.repeating && mode === 'continuous') {
    const cooldown = effectiveCooldownMs(c.cooldown_ms);
    if (c.last_fill_at != null && Date.now() - c.last_fill_at < cooldown) return;
  }

  // ⚠ 반복 조건부는 이 사이트에서 유일하게 "스스로 무한히, 개수 제한도 없이" 쓰기를 만드는 경로다
  // (5초 간격 × 체결당 ~20행 = 주문 하나당 하루 35만 행 → 3개면 100만 행). 그래서 일일/월 차단선을
  // 넘었으면 조용히 물러난다(§ _budget.ts — 봇보다 **먼저** 끊는 쪽이 이것이다).
  // 1회성 주문은 총량이 유한하므로 막지 않는다(막으면 걸어둔 스탑이 안 걸리는 게 더 큰 사고다).
  if (c.repeating && (await autoWritesBlocked(env, 'repeat'))) return;
  // 이 요청의 체결 몫이 바닥났으면 다음 평가에서(조건은 그대로 살아 있다, § FillBudget).
  // (가상 코인은 시도 결과에 따라 뗀다 — § PROBE_Q)
  if (isVirtualSymbol(c.symbol) ? !hasRoom(budget, HEAVY_FILL_Q) : !spend(budget, LIGHT_FILL_Q)) return;

  // 크로스 가용 = 여유잔고 + 그 지갑 미실현손익. 시세 모르는 포지션이 있으면 이번엔 쉰다(§ unrealizedTotal).
  const uPnL = await unrealizedTotal(env, uid, marks, quoteOf(c.symbol));
  if (!isFinite(uPnL)) return;
  const now = Date.now();

  // OX/USDT — 봇 호가창을 walking 하며 있는 물량만 실제 호가 가격에 체결(내부에서 잔고/증거금/수수료/봇
  // 재고·체결테이프·캔들까지 전부 정산). 이 주문의 체결 기록(=선점)은 그 체결 batch 에 함께 실려 원자적으로 반영된다 —
  // 다른 평가가 먼저 처리했으면 batch 전체가 되돌려진다. 못 채웠으면(감당 불가·유동성 없음) 아무것도 안 바뀌고 다음 평가에서 재시도.
  // ⚠ 여기서 예산 계량을 따로 하지 않는다 — matchMarketOxOrder 안의 feeAccrualStmts 가 이미 계량한다(§ _budget.ts).
  if (isVirtualSymbol(c.symbol)) {
    const { filled } = await matchMarketOxOrder(env, c.symbol, uid, c.side, c.size, c.leverage, null, null, uPnL, (f) =>
      conditionalFillStmts(env, uid, c, f, now),
    );
    budget.q -= filled > EPS ? HEAVY_FILL_Q : PROBE_Q;
    return;
  }

  // 실제 코인 — 외부 시세(mark)로 즉시 체결(무한 유동성). 단, 감당 가능한 만큼만 체결하고 잔량은 유지.
  const price = mark;
  const feeRate = await feeRateOf(env, uid);
  const col = balColOf(c.symbol); // 원화 심볼이면 원화 지갑(§ _shared quoteOf)
  const user = await env.DB.prepare(`SELECT ${col} AS bal FROM users WHERE id = ?`).bind(uid).first<{ bal: number }>();
  const existing = await env.DB.prepare(
    'SELECT leverage FROM positions WHERE user_id = ? AND symbol = ? AND side = ? ORDER BY opened_at LIMIT 1',
  )
    .bind(uid, c.symbol, c.side)
    .first<{ leverage: number }>();
  const effLev = existing ? existing.leverage : c.leverage; // 물타기 시 기존 포지션 레버리지 고정
  const available = (user?.bal ?? 0) + uPnL;
  const perUnit = price / effLev + price * feeRate; // 1코인당 드는 돈(증거금+수수료)
  const affordable = perUnit > 0 ? (available * 0.999) / perUnit : 0;
  const fillSize = Math.min(c.size, Math.max(0, affordable));
  if (!user || fillSize <= EPS) return; // 가용이 부족해 하나도 못 삼 → 조건 유지, 다음 평가 재시도

  const margin = (price * fillSize) / effLev;
  const notional = price * fillSize;
  const fee = notional * feeRate;
  // 잔고 차감(크로스 가드) · 이 주문의 체결 기록(선점) · 포지션 · 원장을 **한 batch** 로 — 가드 둘 중 하나라도 걸리면
  // (가용 부족·다른 평가가 먼저 처리) 통째로 되돌려져 조건은 그대로 남는다(§ _shared 가드 문장).
  await guardedBatch(env, [
    env.DB.prepare(`UPDATE users SET ${col} = ${col} - ? WHERE id = ? AND ${col} - ? >= ?`).bind(margin + fee, uid, margin + fee, -uPnL),
    guardStmt(env),
    ...conditionalFillStmts(env, uid, c, fillSize, now),
    // (예산 계량은 feeAccrualStmts 가 한다 — 여기 또 넣으면 이중 계산)
    ...feeAccrualStmts(env, uid, c.symbol, 'open', notional, feeRate, fee, now),
    ...positionAddStmts(env, { uid, symbol: c.symbol, side: c.side, price, size: fillSize, leverage: effLev, margin, stopLoss: null, takeProfit: null, now }),
    env.DB.prepare(
      'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, c.symbol, c.side, price, fillSize, effLev, 'open', null, now),
  ]);
}

// 반환값 = 이번에 받아온 마크가격 맵(loadState 로 넘겨 클라가 서버와 동일한 시세로 청산가/평가자산을
// 즉시 계산하게 한다 — 추가 fetch 없이 재사용). 포지션/미체결/조건부가 없으면 빈 맵.
export async function checkTriggers(
  env: Env,
  uid: string,
  seed?: Record<string, number>,
  budget: FillBudget = { q: ACTION_FILL_Q }, // 주문 액션 앞의 평가가 기본(§ ACTION_FILL_Q)
): Promise<Record<string, number>> {
  return (await scanTriggers(env, uid, seed, budget)).prices;
}

/** checkTriggers 가 읽은 그 유저의 계정 데이터. `null` 이면 "평가 중에 뭔가 바뀌었을 수 있다"는 뜻이라
 * 호출자가 다시 읽어야 한다(§ scanTriggers). */
export interface TriggerScan {
  prices: Record<string, number>;
  fresh: { positions: PositionRow[]; pendings: PendingRow[]; conditionals: ConditionalRow[] } | null;
}

/**
 * checkTriggers 의 본체 — 평가에 쓴 스냅샷까지 돌려준다.
 *
 * ⚠⚠ **왜 스냅샷을 돌려주나**(2026-09-02, 4차 다이어트): `/api/state` 폴링 하나가 positions·
 * pending_orders·conditional_orders 를 **각각 두 번** 읽고 있었다 — 트리거 평가(여기)가 한 번, 응답을
 * 만드는 `loadState` 가 한 번. 평가가 아무것도 안 바꿨다면 두 번째 읽기는 방금 읽은 것을 그대로 다시
 * 읽는 것뿐이다(§6 "같은 걸 한 요청 안에서 두 번 읽지 않는다").
 *
 * ⚠ 재사용 판정은 **"뭘 썼는지 추적"이 아니라 "쓸 수가 없었음"으로** 한다 — 쓰기 지점마다 플래그를
 * 세우는 방식은 새 트리거 기능을 추가할 때 한 곳만 빠뜨려도 응답이 조용히 낡는다. 대기 지정가도,
 * 조건부도, SL/TP 도 없으면 runTriggers 가 실행할 수 있는 쓰기는 강제청산뿐이고 그건 반환값으로 안다
 * → 그 경우에만 재사용한다. 나머지(뭔가 걸어둔 유저)는 예전처럼 다시 읽으므로 **무회귀**다.
 */
export async function scanTriggers(
  env: Env,
  uid: string,
  seed?: Record<string, number>,
  budget: FillBudget = { q: POLL_FILL_Q }, // 폴링이 기본(§ POLL_FILL_Q)
): Promise<TriggerScan> {
  const pendings = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ?').bind(uid).all<PendingRow>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results;
  const conditionals = await loadConditionals(env, uid);
  const fresh = { positions, pendings, conditionals };
  if (pendings.length === 0 && positions.length === 0 && conditionals.length === 0) {
    return { prices: { ...seed }, fresh };
  }

  const symbols = [
    ...new Set([...pendings.map((p) => p.symbol), ...positions.map((p) => p.symbol), ...conditionals.map((c) => c.symbol)]),
  ];
  const prices = await fetchPrices(env, symbols, seed);
  const liquidated = await runTriggers(env, uid, pendings, positions, conditionals, prices, undefined, budget);
  const canWrite =
    liquidated ||
    pendings.length > 0 ||
    conditionals.length > 0 ||
    positions.some((p) => p.stop_loss != null || p.take_profit != null);
  return { prices, fresh: canWrite ? null : fresh };
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
  budget: FillBudget = { q: POLL_FILL_Q },
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

  // ── 지정가 체결 ── long: 저가<=limit(싸게 매수), short: 고가>=limit(비싸게 매도)
  // ⚠ OX 는 **지금 호가창과 크로스하는 주문만** 매칭을 시도한다(2026-10-01). 매칭 함수는 주문·포지션·요율·사다리를
  // 각자 다시 읽으므로(3~4쿼리), 안 걸릴 주문까지 매 평가마다 부르면 대기 주문 몇 개로 요청당 쿼리 50 을 넘겼다(§6).
  // 사다리는 페어마다 한 번만 읽는다(§ spot.ts crossingOxPendings).
  // ⚠ 이번 구간에 걸린 SL/TP 몫을 **먼저 떼어 둔다**(§ FillBudget) — 지정가는 다음 평가로 미뤄도 지금 호가창에 다시 맞춰
  // 보면 되지만, SL/TP 는 "이 구간에 닿았다"는 사실이 다음 평가엔 사라질 수 있다(cron 은 다음 분의 경로를 따로 본다).
  // 지정가 체결은 남은 몫만 쓴다.
  const slTpCost = positions.reduce(
    (a, p) => a + (prices[p.symbol] != null && slTpHit(p, lowOf(p.symbol), highOf(p.symbol)) ? (isVirtualSymbol(p.symbol) ? HEAVY_FILL_Q : LIGHT_FILL_Q) : 0),
    0,
  );
  const reserved = Math.min(budget.q, slTpCost);
  budget.q -= reserved;
  // 사다리 읽기 1쿼리도 몫에서 뗀다 — 몫이 없으면 OX 대기 주문은 이번엔 통째로 건너뛴다(다음 평가에서).
  const oxPend = pendings.filter((p) => isVirtualSymbol(p.symbol) && prices[p.symbol] != null);
  const crossing = oxPend.length && spend(budget, 1) ? await crossingOxPendings(env, oxPend) : new Set<string>();
  // 이미 부분 체결된 주문의 **재**체결은 예산 차단 대상이다(§ _budget.ts 'nibble' — sweepRestingOxPendings 와 같은 규칙).
  // 걸릴 재체결이 있을 때만 계량기를 본다(흔한 경로는 조회 0).
  const refillBlocked =
    oxPend.some((p) => p.last_fill_at != null && crossing.has(p.id)) && (await autoWritesBlocked(env, 'nibble'));

  for (const p of pendings) {
    const mark = prices[p.symbol];
    if (mark == null) continue;

    // OX/USDT 는 봇 호가창에 walking 매칭(runMarketMaker 와 공유하는 실제 매칭 엔진). 있는 물량만
    // 실제 호가 가격에 체결, 잔량은 대기. reduce_only(지정가 청산)면 청산 매칭으로 분기. 실제 코인은 아래로.
    if (isVirtualSymbol(p.symbol)) {
      if (!crossing.has(p.id)) continue;
      // ⚠ 재체결 간격 하한은 여기에도 걸어야 한다(§ spot.ts PARTIAL_FILL_COOLDOWN_MS) — 이 경로는
      // sweepRestingOxPendings 와 **같은 주문을 각자** 매칭하므로, 여기만 빠뜨리면 하한이 통째로 무력화된다.
      // 첫 체결(last_fill_at == null)은 그대로 즉시 처리한다.
      if (p.last_fill_at != null && (refillBlocked || Date.now() - p.last_fill_at < PARTIAL_FILL_COOLDOWN_MS)) continue;
      if (!hasRoom(budget, HEAVY_FILL_Q)) continue; // 이 요청의 체결 몫이 바닥났다 — 다음 평가에서(§ FillBudget)
      // 여기 오는 주문도 **걸려 있던** 지정가라 taker 는 봇이다(§ spot.ts Aggressor) — 체결내역 라벨은
      // 유저 방향의 반대로 찍힌다. 장부(포지션·잔고·상대방)는 영향 없다.
      const got = p.reduce_only ? await matchReduceOnlyOxPending(env, p.id, 'bot') : await matchLimitPendingAgainstBook(env, p.id, 'bot');
      budget.q -= got > EPS ? HEAVY_FILL_Q : PROBE_Q;
      continue;
    }

    // 지정가 청산(reduce-only, 실제 코인) — 로컬 호가창이 없어 mark 가 지정가를 크로스하면 그 지정가에 청산.
    // 매도청산(side short)은 mark>=limit(가격이 오르면 롱 익절), 매수청산(side long)은 mark<=limit(가격이 내리면 숏 익절).
    if (p.reduce_only) {
      // 매도청산은 고가가, 매수청산은 저가가 지정가를 건드렸는지로 판정(체결가는 지정가 그대로).
      await settleReduceOnlyClose(env, uid, p, mark, p.side === 'short' ? highOf(p.symbol) : lowOf(p.symbol), budget);
      continue;
    }

    const fills = p.side === 'long' ? lowOf(p.symbol) <= p.limit_price : highOf(p.symbol) >= p.limit_price;
    if (fills && spend(budget, LIGHT_FILL_Q)) await settleLimitOpen(env, uid, p);
  }

  // ── SL/TP 트리거 ── (떼어 둔 몫을 돌려받아 쓴다)
  budget.q += reserved;
  for (const snap of positions) {
    if (prices[snap.symbol] == null) continue;
    // ⚠ 발동 여부를 **스냅샷으로 먼저** 본다 — 안 걸린 포지션 때문에 매 평가마다 다시 읽지 않게(요청당 쿼리 50, §6).
    if (!slTpHit(snap, lowOf(snap.symbol), highOf(snap.symbol))) continue;
    if (!spend(budget, isVirtualSymbol(snap.symbol) ? HEAVY_FILL_Q : LIGHT_FILL_Q)) continue; // 몫이 바닥났다 — 다음 평가에서
    // 같은 평가의 지정가 청산·물타기가 이 포지션을 바꿨을 수 있으니, 걸린 것만 최신 상태로 다시 읽어 그 값으로 판정·선점한다.
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(snap.id, uid)
      .first<PositionRow>();
    if (!pos) continue;
    const hit = slTpHit(pos, lowOf(pos.symbol), highOf(pos.symbol));
    if (!hit) continue;

    if (isVirtualSymbol(pos.symbol)) {
      // ⚠⚠ 가상 코인의 SL/TP 는 발동하면 **시장가로 봇 호가창에** 청산한다(스탑-마켓, 2026-10-01). 예전엔 SL/TP 가격에
      // 전량을 무한 유동성으로 정산하고 기준가까지 그 가격으로 옮겼다 — 큰 매수로 가격을 TP 까지 밀어 올리면 그 TP 가
      // 자기 매수로 발동해, 밀어 올린 꼭대기에서 전량을 충격 없이 되팔았다. 순환마다 이익이라 잔고가 1e55 까지 불었다(감사).
      // 호가창을 따라 내려가며 팔면 그 순환은 본전 − 수수료다(진입과 같은 깊이를 반대로 지나므로).
      await marketCloseOxPosition(env, uid, pos, pos.size);
      continue;
    }
    // 실제 코인 — 외부 시세라 자기 체결로 가격을 움직일 수 없다. TP 는 지정가처럼 그 가격에, SL 은 **SL 가격과 현재가 중
    // 불리한 쪽**에 체결한다(가격이 SL 을 뛰어넘어 갭으로 지나갔으면 현재가 — 실제 거래소의 스탑-마켓과 같다. 예전엔
    // 항상 SL 가격이라, 앱을 닫아둔 사이 크게 빠지면 SL 보다 훨씬 아래 가격을 SL 가격에 팔아 주는 공짜 보험이었다).
    const mark = prices[pos.symbol];
    const price = hit === 'tp' ? pos.take_profit! : pos.side === 'long' ? Math.min(pos.stop_loss!, mark) : Math.max(pos.stop_loss!, mark);
    await settleSlTpClose(env, uid, pos, price);
  }

  // ── 조건부(스탑) 주문 트리거 ── 트리거 가격을 넘어서면 시장가로 진입(있는 만큼만, 잔량은 조건 유지).
  for (const c of conditionals) {
    const mark = prices[c.symbol];
    if (mark == null) continue;
    await settleConditionalOrder(env, uid, c, mark, prices, lowOf(c.symbol), highOf(c.symbol), budget);
  }

  return false;
}
