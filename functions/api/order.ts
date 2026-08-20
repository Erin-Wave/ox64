import {
  type Ctx,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  isSymbol,
  isVirtualSymbol,
  fetchPrice,
  loadState,
  unrealizedTotal,
  feeRateOf,
  feeAccrualStmts,
  repeatModeOf,
  effectiveCooldownMs,
  MIN_CONTINUOUS_COOLDOWN_MS,
  clampOrderSize,
  sizeEps,
  roundVirtual,
  type Env,
  type PositionRow,
  type PendingRow,
  type UserRow,
  type ConditionalRow,
} from '../_shared';
import { checkTriggers } from '../_trading';
import {
  matchLimitPendingAgainstBook,
  matchMarketOxOrder,
  marketCloseOxPosition,
  matchReduceOnlyOxPending,
  recordVirtualFill,
} from './spot';

// OX/USDT 는 진짜 상대 거래자가 없으니, 유저가 레버리지로 체결시킨 걸 합성 시장(호가창·체결내역·
// 다음 봇 기준가)에도 반영해준다 — 안 그러면 포지션 수량만 조용히 바뀌고 화면엔 아무 흔적도 안 남아
// "내 체결이 반영이 안 된다"는 혼란이 생긴다. 실패해도 유저의 실제 거래(잔고/포지션)는 이미
// 끝난 뒤라 조용히 무시한다(표시용 부가효과일 뿐).
async function reflectVirtualFill(env: Env, symbol: string, uid: string, price: number, takerSide: 'buy' | 'sell', size: number) {
  if (!isVirtualSymbol(symbol)) return;
  try {
    await recordVirtualFill(env, symbol, uid, price, takerSide, size);
  } catch {
    /* 표시용 부가효과 — 실패해도 무시 */
  }
}

/**
 * POST /api/order
 *   { action: 'open',       symbol, side, size, leverage, stopLoss?, takeProfit? }
 *   { action: 'close',      positionId, size? }   // size 생략/전체수량=전량 청산, 그보다 작으면 부분 청산
 *   { action: 'limitOpen',  symbol, side, size, leverage, limitPrice, stopLoss?, takeProfit? }
 *   { action: 'cancelLimit', pendingId }
 *   { action: 'setSlTp',    positionId, stopLoss: number|null, takeProfit: number|null }
 *
 * 체결가는 클라이언트가 아니라 **서버가 바이낸스에서 직접** 받아 사용한다.
 * 잔고/증거금/손익 계산·검증도 전부 서버에서 → 클라 조작 무의미.
 */
export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handle(request, env));
}

// long: stopLoss < 기준가 < takeProfit / short: stopLoss > 기준가 > takeProfit
function validSlTp(side: string, ref: number, stopLoss: number | null, takeProfit: number | null): boolean {
  if (stopLoss != null) {
    if (!isFinite(stopLoss) || stopLoss <= 0) return false;
    if (side === 'long' ? stopLoss >= ref : stopLoss <= ref) return false;
  }
  if (takeProfit != null) {
    if (!isFinite(takeProfit) || takeProfit <= 0) return false;
    if (side === 'long' ? takeProfit <= ref : takeProfit >= ref) return false;
  }
  return true;
}
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
/** 주문 수량 형식 검증 — **양수·유한(=숫자로 읽히는가)만** 본다. ⚠ 상한 초과는 여기서 거부하지 않는다
 * (예전엔 `size > MAX_ORDER_SIZE` 를 "수량 오류"로 반환해서, 자릿수를 길게 넣은 입력이 곧 에러가 되어
 * 주문 자체가 안 되는 것처럼 보였다) — 파싱 시점에 `clampOrderSize` 로 잘라 넘기고, 실제 한도는
 * 증거금 가드가 "증거금이 부족합니다"로(OX 는 감당 가능 수량 클램프로) 판정한다. */
function badSize(size: number): boolean {
  return !(size > 0) || !isFinite(size);
}

/** "증거금이 부족합니다" 를 **행동 가능한** 문구로 — 지금 이 가격·레버리지로 살 수 있는 최대 수량을
 * 같이 알려준다. 수량 칸에 자릿수를 크게 넣으면(888…888) 이제 "수량 오류" 가 아니라 이 메시지가
 * 뜨는데, 얼마면 되는지까지 보여야 유저가 바로 고칠 수 있다. 식·여유(0.1%)는 클라 슬라이더
 * (OrderPanel.applyPct)와 동일하다 — 1개당 드는 돈 = 가격/레버리지 + 가격×수수료율. */
function noMarginMsg(available: number, price: number, leverage: number, feeRate: number): string {
  const costPerUnit = price / leverage + price * feeRate;
  const max = costPerUnit > 0 ? (available * 0.999) / costPerUnit : 0;
  if (!(max > 0) || !isFinite(max)) return '증거금이 부족합니다';
  // 유효숫자 8자리(반올림 오차 1e-8 상대 → 위 0.1% 여유 안에 묻힌다), 아주 큰 값은 지수 표기.
  const n = max >= 1e15 ? max.toExponential(4) : String(Number(max.toPrecision(8)));
  return `증거금이 부족합니다 (최대 약 ${n} 개)`;
}

/** 무한(반복) 조건부 옵션 파싱 — conditionalOpen/editConditional 이 공유한다.
 * 필드가 `undefined`(=아예 안 보냄)면 prev 값을 유지하고, `null`/`''` 이면 "해제"로 본다.
 * 검증 실패 시 사람이 읽을 에러 문구(string)를 반환한다. */
type RepeatOpts = { repeatMode: string; rearmPrice: number | null; cooldownMs: number; maxFills: number | null };
function parseRepeatOpts(
  body: Record<string, unknown>,
  triggerPrice: number,
  triggerDir: string,
  isOx: boolean,
  prev?: RepeatOpts,
): RepeatOpts | string {
  const base: RepeatOpts = prev ?? { repeatMode: 'continuous', rearmPrice: null, cooldownMs: 0, maxFills: null };

  let repeatMode = base.repeatMode;
  if (body.repeatMode !== undefined) {
    repeatMode = String(body.repeatMode);
    if (repeatMode !== 'continuous' && repeatMode !== 'rearm') return '반복 방식 오류';
  }

  let rearmPrice = base.rearmPrice;
  if (body.rearmPrice !== undefined) {
    rearmPrice = body.rearmPrice === null || body.rearmPrice === '' ? null : Number(body.rearmPrice);
  }
  if (rearmPrice != null) {
    if (!(rearmPrice > 0) || !isFinite(rearmPrice)) return '재무장 가격 오류';
    // 재무장은 "트리거 반대편으로 돌아오는 것"이라 트리거 가격보다 반대 방향이어야 한다.
    // below(이하로 떨어지면 진입) → 다시 오를 때 재무장이므로 재무장가 >= 트리거가.
    if (triggerDir === 'below' && rearmPrice < triggerPrice) return '재무장 가격은 트리거 가격 이상이어야 합니다';
    if (triggerDir === 'above' && rearmPrice > triggerPrice) return '재무장 가격은 트리거 가격 이하여야 합니다';
    if (isOx) rearmPrice = roundVirtual(rearmPrice);
  }

  // 클라는 사람이 읽기 쉬운 "초"로 보내고 서버는 ms 로 저장한다.
  // ⚠ `continuous` 는 **하한 5초**(MIN_CONTINUOUS_COOLDOWN_MS)를 강제한다 — 0(폴링마다 ≈1초)을 허용하면
  // 주문 하나가 월 4,650만 행을 써서 D1 포함분을 혼자 다 먹는다(§6 D1 예산, $47 청구 사건).
  // 여기서 저장값 자체를 하한으로 올려 UI 가 실제 동작과 어긋나지 않게 하고, 평가 시점에도 별도로
  // effectiveCooldownMs 로 한 번 더 막는다(하한 도입 전에 만들어진 기존 주문 방어).
  const minSec = MIN_CONTINUOUS_COOLDOWN_MS / 1000;
  let cooldownMs = base.cooldownMs;
  if (body.cooldownSec !== undefined) {
    const sec = body.cooldownSec === null || body.cooldownSec === '' ? minSec : Number(body.cooldownSec);
    if (!isFinite(sec) || sec < 0 || sec > 86400) return '재실행 간격은 0~86,400초';
    cooldownMs = Math.round(sec * 1000);
  }
  if (repeatMode === 'continuous') cooldownMs = effectiveCooldownMs(cooldownMs);

  let maxFills = base.maxFills;
  if (body.maxFills !== undefined) {
    maxFills = body.maxFills === null || body.maxFills === '' ? null : Math.round(Number(body.maxFills));
  }
  if (maxFills != null && (!(maxFills >= 1) || !isFinite(maxFills) || maxFills > 100000)) return '최대 실행 횟수는 1~100,000';

  return { repeatMode, rearmPrice, cooldownMs, maxFills };
}

async function handle(request: Request, env: Ctx['env']): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  const uid = sess.uid;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('invalid json');
  }

  // ⚠ 주문내역 증분 커서(§ _shared.loadState ordersSince). 액션 응답도 계정 상태를 통째로 돌려주는데,
  // 예전엔 여기에 커서를 안 실어서 **액션마다 주문 50행을 다시 읽었다** — prod 실측 하루 759회 × 50행 =
  // 3.8만 행으로, 폴링에서 없앤 낭비(2026-08-14)가 액션 경로에만 그대로 남아 있었다. 클라가 가진 마지막
  // 주문 시각을 보내면 그 이후만 읽는다(방금 체결된 주문은 당연히 그 이후라 응답에 포함된다).
  // 커서가 없으면(구버전 클라·최초) 전체를 주므로 무회귀다.
  const since = Number(body.ordersSince) || undefined;

  // 지정가/SL·TP/강제청산 체크는 각 액션 안에서 호출한다(수동 액션과 레이스 방지). 반환된 마크가격
  // 맵을 loadState 로 넘겨 클라가 서버와 동일 시세로 청산가/평가자산을 즉시 계산하게 한다.

  if (body.action === 'open') {
    const { symbol, side } = body;
    const size = clampOrderSize(Number(body.size));
    const leverage = Math.round(Number(body.leverage));
    if (!isSymbol(symbol)) return bad('알 수 없는 심볼');
    if (side !== 'long' && side !== 'short') return bad('방향 오류');
    if (badSize(size)) return bad('수량 오류');
    if (!(leverage >= 1 && leverage <= 200)) return bad('레버리지 1~200');

    const stopLoss = num(body.stopLoss);
    const takeProfit = num(body.takeProfit);

    // OX/USDT 시장가 = 봇 호가창을 walking 하며 "있는 물량만" 실제 호가 가격에 체결(잔량 버림).
    // 실제 코인 38종은 외부 시세로 즉시 전량 체결(아래 기존 경로). ⚠ 호가창을 무시하고 ref 한 값에
    // 전량 체결하던 게 "20만개가 최우선호가보다 싸게 즉시 체결"되던 버그의 원인 → 실제 매칭으로 교체.
    if (isVirtualSymbol(symbol)) {
      const marks = await checkTriggers(env, uid);
      const ref = await fetchPrice(env, symbol);
      if (!validSlTp(side, ref, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');
      // 크로스: 여유잔고 + 전 포지션 미실현손익까지 증거금으로 walking 체결에 쓸 수 있게 uPnL 을 넘긴다.
      const uPnL = await unrealizedTotal(env, uid, marks);
      const { filled, avgPrice } = await matchMarketOxOrder(env, symbol, uid, side, size, leverage, stopLoss, takeProfit, uPnL);
      if (!(filled > 0)) return bad('체결 가능한 호가 물량이 없습니다');
      marks[symbol] = avgPrice || ref;
      return json(await loadState(env, uid, marks, since));
    }

    // 실제 코인: 트리거 평가와 체결가 fetch 를 병렬로 돌려 롱/숏 버튼 지연을 줄인다.
    // 둘 다 끝난 뒤에야 잔고/기존포지션을 읽으므로(아래) 원자성 문제는 없다.
    const [marks, price] = await Promise.all([checkTriggers(env, uid), fetchPrice(env, symbol)]);

    const user = await env.DB.prepare('SELECT id, name, balance FROM users WHERE id = ?')
      .bind(uid)
      .first<UserRow>();
    if (!user) return bad('unauthorized', 401);

    // 크로스 마진 가용 증거금 = 여유잔고 + 전 포지션 미실현손익. 이익 중이면 그 미실현이익까지 새
    // 주문 증거금으로 쓸 수 있고(그때 balance 는 -uPnL 까지 음수 허용), 손실 중이면 가용이 줄어든다.
    // 잔고 차감 가드는 balance - margin >= -uPnL (⟺ available >= margin) 로 원자적으로 막는다.
    const uPnL = await unrealizedTotal(env, uid, marks);
    const available = user.balance + uPnL;
    // 수수료 = 명목금액(체결가×수량) × VIP 등급 수수료율. 진입 시엔 증거금과 **함께** 차감해야
    // 원자 가드가 성립한다(따로 빼면 증거금은 통과하고 수수료만 실패하는 틈이 생긴다).
    const feeRate = await feeRateOf(env, uid);
    const notional = price * size;
    const fee = notional * feeRate;

    // 같은 심볼·같은 방향으로 이미 보유 중인 포지션이 있으면 새 행을 또 만들지 않고 그 포지션에
    // 물타기/불타기 방식으로 합친다(평단가 재계산) — 거래소들의 "원웨이 모드"와 동일한 동작.
    // 레버리지는 최초 진입 때 값으로 고정(포지션 하나에 레버리지가 섞이면 증거금 계산이 불가능해짐).
    const existing = await env.DB.prepare(
      'SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?',
    )
      .bind(uid, symbol, side)
      .first<PositionRow>();

    const now = Date.now();
    const ordId = crypto.randomUUID();

    if (existing) {
      const addMargin = (price * size) / existing.leverage;
      if (addMargin + fee > available) return bad(noMarginMsg(available, price, existing.leverage, feeRate));

      const newSize = existing.size + size;
      const newEntry = (existing.entry_price * existing.size + price * size) / newSize;
      const finalSl = stopLoss != null ? stopLoss : existing.stop_loss;
      const finalTp = takeProfit != null ? takeProfit : existing.take_profit;
      if ((stopLoss != null || takeProfit != null) && !validSlTp(side, newEntry, finalSl, finalTp)) {
        return bad('SL/TP 값이 올바르지 않습니다');
      }

      const res = await env.DB.batch([
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance - ? >= ?').bind(
          addMargin + fee,
          uid,
          addMargin + fee,
          -uPnL,
        ),
        ...feeAccrualStmts(env, uid, symbol, 'open', notional, feeRate, fee, now),
        env.DB.prepare(
          'UPDATE positions SET entry_price = ?, size = ?, margin = ?, stop_loss = ?, take_profit = ? WHERE id = ? AND user_id = ?',
        ).bind(newEntry, newSize, existing.margin + addMargin, finalSl, finalTp, existing.id, uid),
        env.DB.prepare(
          'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(ordId, uid, symbol, side, price, size, existing.leverage, 'open', null, now),
      ]);
      if (res[0].meta.changes !== 1) return bad('증거금이 부족합니다');
      await reflectVirtualFill(env, symbol, uid, price, side === 'long' ? 'buy' : 'sell', size);

      marks[symbol] = price;
      return json(await loadState(env, uid, marks, since));
    }

    const margin = (price * size) / leverage;
    if (!validSlTp(side, price, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');
    if (margin + fee > available) return bad(noMarginMsg(available, price, leverage, feeRate));

    const posId = crypto.randomUUID();
    // 잔고 차감은 조건부 UPDATE 로 원자적 가드(balance - margin >= -uPnL ⟺ available >= margin, 크로스)
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance - ? >= ?').bind(
        margin + fee,
        uid,
        margin + fee,
        -uPnL,
      ),
      ...feeAccrualStmts(env, uid, symbol, 'open', notional, feeRate, fee, now),
      env.DB.prepare(
        'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(posId, uid, symbol, side, price, size, leverage, margin, now, stopLoss, takeProfit),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, symbol, side, price, size, leverage, 'open', null, now),
    ]);
    if (res[0].meta.changes !== 1) return bad('증거금이 부족합니다');
    await reflectVirtualFill(env, symbol, uid, price, side === 'long' ? 'buy' : 'sell', size);

    marks[symbol] = price;
    return json(await loadState(env, uid, marks, since));
  }

  if (body.action === 'close') {
    const marks = await checkTriggers(env, uid);
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(positionId, uid)
      .first<PositionRow>();
    if (!pos) return bad('포지션을 찾을 수 없음', 404);

    // 부분 청산: size 를 지정하면 그만큼만, 생략하면 전량.
    const reqSize = num(body.size);
    if (reqSize != null && !(reqSize > 0)) return bad('청산 수량 오류');
    // 오차는 크기 비례(sizeEps) — 수량이 1e15 개쯤 되면 화면 표기·재계산 왕복에서 생기는 오차 자체가
    // 1e-9 보다 커서, 고정 오차로 비교하면 "전량 청산"이 보유량 초과로 거부된다.
    if (reqSize != null && reqSize > pos.size + sizeEps(pos.size)) return bad('보유 수량보다 많습니다');
    const closeSize = reqSize == null ? pos.size : reqSize;

    // OX/USDT 시장가 청산 = 봇 호가창을 walking 하며 "있는 물량만" 실제 호가 가격에 청산(매물 없으면 부분).
    // ⚠ 예전엔 호가창 무관하게 ref 한 값에 전량 청산돼 "매물 없어도 전량 청산"되던 버그 → 진입과 대칭으로 교체.
    if (isVirtualSymbol(pos.symbol)) {
      const { filled, avgPrice } = await marketCloseOxPosition(env, uid, pos, closeSize);
      if (!(filled > 0)) return bad('청산할 수 있는 호가 물량이 없습니다');
      if (avgPrice > 0) marks[pos.symbol] = avgPrice;
      return json(await loadState(env, uid, marks, since));
    }

    // 실제 코인: 외부 시세로 즉시 청산(로컬 호가창이 없어 mark 정산이 표준, 유동성 사실상 무한).
    const isPartial = closeSize < pos.size - sizeEps(pos.size);
    const price = await fetchPrice(env, pos.symbol); // 서버 청산가
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (price - pos.entry_price) * closeSize * dir;
    const marginReleased = isPartial ? (pos.margin * closeSize) / pos.size : pos.margin;
    const now = Date.now();
    const ordId = crypto.randomUUID();
    // 청산 수수료는 환급액에서 뺀다(증거금 + 손익 − 수수료).
    const closeRate = await feeRateOf(env, uid);
    const closeNotional = price * closeSize;
    const closeFee = closeNotional * closeRate;

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(marginReleased + pnl - closeFee, uid),
      ...feeAccrualStmts(env, uid, pos.symbol, 'close', closeNotional, closeRate, closeFee, now),
      isPartial
        ? env.DB
            .prepare('UPDATE positions SET size = ?, margin = ? WHERE id = ? AND user_id = ?')
            .bind(pos.size - closeSize, pos.margin - marginReleased, positionId, uid)
        : env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(positionId, uid),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, pos.symbol, pos.side, price, closeSize, pos.leverage, 'close', pnl, now),
    ]);
    // 청산은 원래 방향의 반대 액션(롱 청산=매도, 숏 청산=매수)으로 시장에 반영.
    await reflectVirtualFill(env, pos.symbol, uid, price, pos.side === 'long' ? 'sell' : 'buy', closeSize);

    marks[pos.symbol] = price;
    return json(await loadState(env, uid, marks, since));
  }

  // 지정가 청산(reduce-only) — 포지션을 지정가에 청산 예약. 증거금을 새로 잠그지 않고(청산이므로),
  // pending_orders 에 reduce_only=1 로 쌓아둔다. 체결 시(OX=호가창 walking, 실제코인=mark 가 지정가 크로스)
  // 새 포지션을 열지 않고 대상 포지션을 그 수량만큼 줄인다(checkTriggers). 주문 방향(side)은 포지션 반대.
  if (body.action === 'limitClose') {
    const marks = await checkTriggers(env, uid);
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(positionId, uid)
      .first<PositionRow>();
    if (!pos) return bad('포지션을 찾을 수 없음', 404);

    const size = Number(body.size);
    let limitPrice = Number(body.limitPrice);
    if (!(size > 0) || !isFinite(size)) return bad('청산 수량 오류');
    if (!(limitPrice > 0) || !isFinite(limitPrice)) return bad('지정가 오류');
    if (isVirtualSymbol(pos.symbol)) limitPrice = roundVirtual(limitPrice); // 가상 코인 유효숫자 4자리 틱

    const closeSide = pos.side === 'long' ? 'short' : 'long'; // 롱 청산=매도(short), 숏 청산=매수(long)
    // ⚠ 청산 가능 수량 = 보유수량 − 이미 걸어둔 지정가 청산(reduce-only) 합. 예전엔 `size > pos.size` 로만
    // 검증해서, 100 짜리 포지션에 청산 예약 100 을 여러 번 쌓아 보유량을 초과하는 청산 주문이 가능했다
    // (원웨이 모드라 symbol+closeSide 의 reduce_only 는 전부 이 포지션이 대상). 예약분을 빼고 검증한다.
    const reservedRow = await env.DB.prepare(
      'SELECT COALESCE(SUM(size), 0) AS reserved FROM pending_orders WHERE user_id = ? AND symbol = ? AND side = ? AND reduce_only = 1',
    )
      .bind(uid, pos.symbol, closeSide)
      .first<{ reserved: number }>();
    const closable = pos.size - (reservedRow?.reserved ?? 0);
    if (size > closable + sizeEps(pos.size)) return bad('청산 가능 수량을 초과합니다 (이미 예약된 지정가 청산 포함)');

    const now = Date.now();
    const pendingId = crypto.randomUUID();
    // reduce_only=1, margin=0(증거금 안 잠금), SL/TP 없음(청산 주문엔 불필요).
    await env.DB.prepare(
      'INSERT INTO pending_orders (id, user_id, symbol, side, size, leverage, limit_price, margin, stop_loss, take_profit, created_at, reduce_only) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)',
    )
      .bind(pendingId, uid, pos.symbol, closeSide, size, pos.leverage, limitPrice, 0, null, null, now)
      .run();

    // OX 는 제출 즉시 봇 호가창에 매칭 시도(marketable 이면 바로 체결, 아니면 대기). 실제 코인은 checkTriggers 가
    // mark 가 지정가를 크로스할 때 체결한다.
    if (isVirtualSymbol(pos.symbol)) await matchReduceOnlyOxPending(env, pendingId);

    return json(await loadState(env, uid, marks, since));
  }

  if (body.action === 'limitOpen') {
    const marks = await checkTriggers(env, uid);
    const { symbol, side } = body;
    const size = clampOrderSize(Number(body.size));
    const leverage = Math.round(Number(body.leverage));
    let limitPrice = Number(body.limitPrice);
    if (!isSymbol(symbol)) return bad('알 수 없는 심볼');
    if (side !== 'long' && side !== 'short') return bad('방향 오류');
    if (badSize(size)) return bad('수량 오류');
    if (!(leverage >= 1 && leverage <= 200)) return bad('레버리지 1~200');
    if (!(limitPrice > 0) || !isFinite(limitPrice)) return bad('지정가 오류');
    // OX 는 4자리 틱(0.0001) 정합성 유지 — 유저가 더 세밀한 지정가를 넣어도 호가창/체결이 4자리를 넘지 않게.
    if (isVirtualSymbol(symbol)) limitPrice = roundVirtual(limitPrice);

    const stopLoss = num(body.stopLoss);
    const takeProfit = num(body.takeProfit);
    if (!validSlTp(side, limitPrice, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');

    const margin = (limitPrice * size) / leverage;
    const user = await env.DB.prepare('SELECT id, name, balance FROM users WHERE id = ?')
      .bind(uid)
      .first<UserRow>();
    if (!user) return bad('unauthorized', 401);
    // 크로스: 가용 = 여유잔고 + 전 포지션 미실현손익. 지정가도 이 가용 안에서 증거금을 잠근다.
    const uPnL = await unrealizedTotal(env, uid, marks);
    const available = user.balance + uPnL;
    if (margin > available) return bad(noMarginMsg(available, limitPrice, leverage, 0));

    const now = Date.now();
    const pendingId = crypto.randomUUID();
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance - ? >= ?').bind(
        margin,
        uid,
        margin,
        -uPnL,
      ),
      env.DB.prepare(
        'INSERT INTO pending_orders (id, user_id, symbol, side, size, leverage, limit_price, margin, stop_loss, take_profit, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(pendingId, uid, symbol, side, size, leverage, limitPrice, margin, stopLoss, takeProfit, now),
    ]);
    if (res[0].meta.changes !== 1) return bad('증거금이 부족합니다');

    // OX/USDT: 제출 즉시 봇 호가창에 walking 매칭한다 — 크로스되는 실제 물량만 실제 호가 가격에
    // 체결하고, 못 채운 잔량은 pending 에 그대로 남아 대기(다음 유동성/틱에서 이어서 체결). 실제
    // 거래소처럼 marketable 지정가가 호가창에 유령으로 남거나 유령가격에 전량 체결되지 않게 한다.
    if (isVirtualSymbol(symbol)) {
      await matchLimitPendingAgainstBook(env, pendingId);
    }

    return json(await loadState(env, uid, marks, since));
  }

  if (body.action === 'cancelLimit') {
    const marks = await checkTriggers(env, uid);
    const pendingId = typeof body.pendingId === 'string' ? body.pendingId : '';
    const pending = await env.DB.prepare('SELECT * FROM pending_orders WHERE id = ? AND user_id = ?')
      .bind(pendingId, uid)
      .first<PendingRow>();
    if (!pending) return bad('주문을 찾을 수 없음', 404);

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(pending.margin, uid),
      env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(pendingId, uid),
    ]);

    return json(await loadState(env, uid, marks, since));
  }

  // 미체결(지정가) 주문의 지정가·수량 수정. 진입 지정가는 증거금을 재계산해 델타만큼 잔고를 원자 조정
  // (추가 잠금은 크로스 가용 가드), reduce-only(지정가 청산)는 증거금이 없어 값만 갱신. 값 변경 후 OX 는
  // 새 가격으로 즉시 재매칭(marketable 이면 바로 체결). 취소 후 재주문 대신 한 번에 수정.
  if (body.action === 'editLimit') {
    const marks = await checkTriggers(env, uid);
    const pendingId = typeof body.pendingId === 'string' ? body.pendingId : '';
    const pending = await env.DB.prepare('SELECT * FROM pending_orders WHERE id = ? AND user_id = ?')
      .bind(pendingId, uid)
      .first<PendingRow>();
    if (!pending) return bad('주문을 찾을 수 없음', 404);

    let newLimit = body.limitPrice != null ? Number(body.limitPrice) : pending.limit_price;
    const newSize = clampOrderSize(body.size != null ? Number(body.size) : pending.size);
    if (!(newLimit > 0) || !isFinite(newLimit)) return bad('지정가 오류');
    if (badSize(newSize)) return bad('수량 오류');
    if (isVirtualSymbol(pending.symbol)) newLimit = roundVirtual(newLimit); // 가상 코인 유효숫자 4자리 틱

    if (pending.reduce_only) {
      // 지정가 청산 — 증거금 없음(margin=0), 값만 갱신. ⚠ 단, 대상 포지션의 청산 가능 수량을 초과하지
      // 않게 검증한다(이 주문 제외한 다른 예약분 + 이 주문의 newSize ≤ 보유수량). 포지션이 이미 없으면
      // 고아 주문이라 검증 스킵(다음 트리거에서 자동 정리됨).
      const posSide = pending.side === 'short' ? 'long' : 'short'; // 청산 대상 포지션 방향(주문 side 의 반대)
      const tgt = await env.DB.prepare('SELECT size FROM positions WHERE user_id = ? AND symbol = ? AND side = ?')
        .bind(uid, pending.symbol, posSide)
        .first<{ size: number }>();
      if (tgt) {
        const othersRow = await env.DB.prepare(
          'SELECT COALESCE(SUM(size), 0) AS reserved FROM pending_orders WHERE user_id = ? AND symbol = ? AND side = ? AND reduce_only = 1 AND id != ?',
        )
          .bind(uid, pending.symbol, pending.side, pendingId)
          .first<{ reserved: number }>();
        const closable = tgt.size - (othersRow?.reserved ?? 0);
        if (newSize > closable + sizeEps(tgt.size)) return bad('청산 가능 수량을 초과합니다 (이미 예약된 지정가 청산 포함)');
      }
      await env.DB.prepare('UPDATE pending_orders SET limit_price = ?, size = ? WHERE id = ? AND user_id = ?')
        .bind(newLimit, newSize, pendingId, uid)
        .run();
      if (isVirtualSymbol(pending.symbol)) await matchReduceOnlyOxPending(env, pendingId);
      return json(await loadState(env, uid, marks, since));
    }

    // 진입 지정가 — 증거금 재계산. delta(=신규-기존)만큼 잔고를 조정한다. 추가 잠금(delta>0)은 크로스
    // 가용(여유잔고+미실현손익)이 충분해야 한다. ⚠ 잔고 차감을 "먼저" 원자 가드로 확정하고, 성공했을
    // 때만 pending 을 수정한다 — batch 로 묶으면 잔고 가드가 0행 매칭(증거금 부족)이어도 pending UPDATE 는
    // 그대로 커밋돼 "증거금 없이 주문만 커지는" 상태가 된다(D1 batch 는 조건부 UPDATE 0행을 실패로 보지 않음).
    const newMargin = (newLimit * newSize) / pending.leverage;
    const delta = newMargin - pending.margin; // >0: 추가 잠금 / <0: 환불(가드 항상 통과)
    const uPnL = await unrealizedTotal(env, uid, marks);
    const charge = await env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance - ? >= ?')
      .bind(delta, uid, delta, -uPnL)
      .run();
    if (charge.meta.changes !== 1) return bad('증거금이 부족합니다');
    await env.DB.prepare('UPDATE pending_orders SET limit_price = ?, size = ?, margin = ? WHERE id = ? AND user_id = ?')
      .bind(newLimit, newSize, newMargin, pendingId, uid)
      .run();
    if (isVirtualSymbol(pending.symbol)) await matchLimitPendingAgainstBook(env, pendingId);

    return json(await loadState(env, uid, marks, since));
  }

  // 조건부(스탑) 주문 생성 — 증거금을 미리 잠그지 않고(스탑 관행), 트리거 가격을 넘어서면 시장가로
  // 진입한다(체결은 checkTriggers 의 settleConditionalOrder). 생성 직후 checkTriggers 를 한 번 돌려
  // "이미 트리거 조건을 만족하는" 스탑은 그 자리에서 바로 체결시킨다(거래소 동일).
  if (body.action === 'conditionalOpen') {
    const { symbol, side } = body;
    const size = clampOrderSize(Number(body.size));
    const leverage = Math.round(Number(body.leverage));
    let triggerPrice = Number(body.triggerPrice);
    const triggerDir = body.triggerDir;
    if (!isSymbol(symbol)) return bad('알 수 없는 심볼');
    if (side !== 'long' && side !== 'short') return bad('방향 오류');
    if (badSize(size)) return bad('수량 오류');
    if (!(leverage >= 1 && leverage <= 200)) return bad('레버리지 1~200');
    if (!(triggerPrice > 0) || !isFinite(triggerPrice)) return bad('트리거 가격 오류');
    if (triggerDir !== 'above' && triggerDir !== 'below') return bad('트리거 방향 오류');
    if (isVirtualSymbol(symbol)) triggerPrice = roundVirtual(triggerPrice); // 가상 코인 유효숫자 4자리 틱

    // ── 무한(반복) 조건부 ── 체결돼도 주문이 남는다. size 는 "1회 실행 수량"이 된다(차감하지 않음).
    const repeating = body.repeating === true || body.repeating === 1;
    const rep = parseRepeatOpts(body, triggerPrice, triggerDir, isVirtualSymbol(symbol));
    if (typeof rep === 'string') return bad(rep);

    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO conditional_orders (id, user_id, symbol, side, size, leverage, trigger_price, trigger_dir, created_at, repeating, armed, rearm_price, fill_count, max_fills, repeat_mode, cooldown_ms, last_fill_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        crypto.randomUUID(),
        uid,
        symbol,
        side,
        size,
        leverage,
        triggerPrice,
        triggerDir,
        now,
        repeating ? 1 : 0,
        1, // armed — 이미 조건을 만족하는 상태로 만들면 아래 checkTriggers 에서 곧바로 1회 실행된다
        rep.rearmPrice,
        0,
        rep.maxFills,
        rep.repeatMode,
        rep.cooldownMs,
        null,
      )
      .run();

    // 방금 넣은 조건부까지 포함해 평가(이미 트리거된 스탑이면 즉시 체결). marks 를 loadState 로 전달.
    const marks = await checkTriggers(env, uid);
    return json(await loadState(env, uid, marks, since));
  }

  // 조건부 주문 수정 — 트리거가/수량/조건(이상·이하)/레버리지 + 반복 설정을 취소 없이 바꾼다.
  // 증거금을 잠그지 않는 주문이라 editLimit 과 달리 잔고 정산이 없다(단순 UPDATE).
  if (body.action === 'editConditional') {
    const conditionalId = typeof body.conditionalId === 'string' ? body.conditionalId : '';
    const cond = await env.DB.prepare('SELECT * FROM conditional_orders WHERE id = ? AND user_id = ?')
      .bind(conditionalId, uid)
      .first<ConditionalRow>();
    if (!cond) return bad('주문을 찾을 수 없음', 404);
    const isOx = isVirtualSymbol(cond.symbol);

    // 안 보낸 필드는 기존 값 유지.
    let triggerPrice = body.triggerPrice != null && body.triggerPrice !== '' ? Number(body.triggerPrice) : cond.trigger_price;
    if (!(triggerPrice > 0) || !isFinite(triggerPrice)) return bad('트리거 가격 오류');
    if (isOx) triggerPrice = roundVirtual(triggerPrice);
    const size = clampOrderSize(body.size != null && body.size !== '' ? Number(body.size) : cond.size);
    if (badSize(size)) return bad('수량 오류');
    const triggerDir = body.triggerDir != null && body.triggerDir !== '' ? String(body.triggerDir) : cond.trigger_dir;
    if (triggerDir !== 'above' && triggerDir !== 'below') return bad('트리거 방향 오류');
    const leverage = body.leverage != null && body.leverage !== '' ? Math.round(Number(body.leverage)) : cond.leverage;
    if (!(leverage >= 1 && leverage <= 200)) return bad('레버리지 1~200');
    const repeating = body.repeating === undefined ? !!cond.repeating : body.repeating === true || body.repeating === 1;

    const rep = parseRepeatOpts(body, triggerPrice, triggerDir, isOx, {
      repeatMode: repeatModeOf(cond),
      rearmPrice: cond.rearm_price ?? null,
      cooldownMs: cond.cooldown_ms ?? 0,
      maxFills: cond.max_fills ?? null,
    });
    if (typeof rep === 'string') return bad(rep);
    const done = cond.fill_count ?? 0;
    if (rep.maxFills != null && rep.maxFills <= done)
      return bad(`최대 실행 횟수는 이미 실행한 횟수(${done}회)보다 커야 합니다`);

    // ⚠ armed=1 로 되살린다 — 재무장 대기 중에 조건을 고쳤는데 계속 잠들어 있으면 "수정했는데 안 걸린다"가 된다.
    const upd = await env.DB.prepare(
      'UPDATE conditional_orders SET trigger_price = ?, size = ?, trigger_dir = ?, leverage = ?, repeating = ?, repeat_mode = ?, rearm_price = ?, cooldown_ms = ?, max_fills = ?, armed = 1 WHERE id = ? AND user_id = ?',
    )
      .bind(
        triggerPrice,
        size,
        triggerDir,
        leverage,
        repeating ? 1 : 0,
        rep.repeatMode,
        rep.rearmPrice,
        rep.cooldownMs,
        rep.maxFills,
        conditionalId,
        uid,
      )
      .run();
    if (upd.meta.changes !== 1) return bad('주문을 찾을 수 없음', 404); // 그 사이 체결/취소됨

    // 수정 직후 재평가 — 새 조건을 이미 만족하면 그 자리에서 체결(conditionalOpen 과 동일).
    const marks = await checkTriggers(env, uid);
    return json(await loadState(env, uid, marks, since));
  }

  if (body.action === 'cancelConditional') {
    const marks = await checkTriggers(env, uid);
    const conditionalId = typeof body.conditionalId === 'string' ? body.conditionalId : '';
    const cond = await env.DB.prepare('SELECT id FROM conditional_orders WHERE id = ? AND user_id = ?')
      .bind(conditionalId, uid)
      .first<{ id: string }>();
    if (!cond) return bad('주문을 찾을 수 없음', 404);
    // 증거금을 잠그지 않았으므로 환불 없음, 행만 삭제.
    await env.DB.prepare('DELETE FROM conditional_orders WHERE id = ? AND user_id = ?').bind(conditionalId, uid).run();
    return json(await loadState(env, uid, marks, since));
  }

  if (body.action === 'setSlTp') {
    const marks = await checkTriggers(env, uid);
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(positionId, uid)
      .first<PositionRow>();
    if (!pos) return bad('포지션을 찾을 수 없음', 404);

    const stopLoss = num(body.stopLoss);
    const takeProfit = num(body.takeProfit);
    if (!validSlTp(pos.side, pos.entry_price, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');

    await env.DB.prepare('UPDATE positions SET stop_loss = ?, take_profit = ? WHERE id = ? AND user_id = ?')
      .bind(stopLoss, takeProfit, positionId, uid)
      .run();

    return json(await loadState(env, uid, marks, since));
  }

  return bad('알 수 없는 action');
}
