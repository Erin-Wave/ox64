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
  type Env,
  type PositionRow,
  type PendingRow,
  type UserRow,
} from '../_shared';
import { checkTriggers } from '../_trading';
import { matchLimitPendingAgainstBook, matchMarketOxOrder, recordVirtualFill } from './spot';

// OX/USDT 는 진짜 상대 거래자가 없으니, 유저가 레버리지로 체결시킨 걸 합성 시장(호가창·체결내역·
// 다음 봇 기준가)에도 반영해준다 — 안 그러면 포지션 수량만 조용히 바뀌고 화면엔 아무 흔적도 안 남아
// "내 체결이 반영이 안 된다"는 혼란이 생긴다. 실패해도 유저의 실제 거래(잔고/포지션)는 이미
// 끝난 뒤라 조용히 무시한다(표시용 부가효과일 뿐).
async function reflectVirtualFill(env: Env, symbol: string, uid: string, price: number, takerSide: 'buy' | 'sell', size: number) {
  if (!isVirtualSymbol(symbol)) return;
  try {
    await recordVirtualFill(env, uid, price, takerSide, size);
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

async function handle(request: Request, env: Ctx['env']): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  const uid = sess.uid;

  // 지정가/SL/TP 체결 체크 — 수동 액션과 레이스 방지 위해 여기서도 먼저 평가
  await checkTriggers(env, uid);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('invalid json');
  }

  if (body.action === 'open') {
    const { symbol, side } = body;
    const size = Number(body.size);
    const leverage = Math.round(Number(body.leverage));
    if (!isSymbol(symbol)) return bad('알 수 없는 심볼');
    if (side !== 'long' && side !== 'short') return bad('방향 오류');
    if (!(size > 0) || !isFinite(size) || size > 1_000_000) return bad('수량 오류');
    if (!(leverage >= 1 && leverage <= 125)) return bad('레버리지 1~125');

    const stopLoss = num(body.stopLoss);
    const takeProfit = num(body.takeProfit);

    // OX/USDT 시장가 = 봇 호가창을 walking 하며 "있는 물량만" 실제 호가 가격에 체결(잔량 버림).
    // 실제 코인 38종은 외부 시세로 즉시 전량 체결(아래 기존 경로). ⚠ 호가창을 무시하고 ref 한 값에
    // 전량 체결하던 게 "20만개가 최우선호가보다 싸게 즉시 체결"되던 버그의 원인 → 실제 매칭으로 교체.
    if (isVirtualSymbol(symbol)) {
      const ref = await fetchPrice(env, symbol);
      if (!validSlTp(side, ref, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');
      const { filled } = await matchMarketOxOrder(env, uid, side, size, leverage, stopLoss, takeProfit);
      if (!(filled > 0)) return bad('체결 가능한 호가 물량이 없습니다');
      return json(await loadState(env, uid));
    }

    const price = await fetchPrice(env, symbol); // 서버 체결가

    const user = await env.DB.prepare('SELECT id, name, balance FROM users WHERE id = ?')
      .bind(uid)
      .first<UserRow>();
    if (!user) return bad('unauthorized', 401);

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
      if (addMargin > user.balance) return bad('증거금이 부족합니다');

      const newSize = existing.size + size;
      const newEntry = (existing.entry_price * existing.size + price * size) / newSize;
      const finalSl = stopLoss != null ? stopLoss : existing.stop_loss;
      const finalTp = takeProfit != null ? takeProfit : existing.take_profit;
      if ((stopLoss != null || takeProfit != null) && !validSlTp(side, newEntry, finalSl, finalTp)) {
        return bad('SL/TP 값이 올바르지 않습니다');
      }

      const res = await env.DB.batch([
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').bind(
          addMargin,
          uid,
          addMargin,
        ),
        env.DB.prepare(
          'UPDATE positions SET entry_price = ?, size = ?, margin = ?, stop_loss = ?, take_profit = ? WHERE id = ? AND user_id = ?',
        ).bind(newEntry, newSize, existing.margin + addMargin, finalSl, finalTp, existing.id, uid),
        env.DB.prepare(
          'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(ordId, uid, symbol, side, price, size, existing.leverage, 'open', null, now),
      ]);
      if (res[0].meta.changes !== 1) return bad('증거금이 부족합니다');
      await reflectVirtualFill(env, symbol, uid, price, side === 'long' ? 'buy' : 'sell', size);

      return json(await loadState(env, uid));
    }

    const margin = (price * size) / leverage;
    if (!validSlTp(side, price, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');
    if (margin > user.balance) return bad('증거금이 부족합니다');

    const posId = crypto.randomUUID();
    // 잔고 차감은 조건부 UPDATE 로 원자적 가드(balance >= margin)
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').bind(
        margin,
        uid,
        margin,
      ),
      env.DB.prepare(
        'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(posId, uid, symbol, side, price, size, leverage, margin, now, stopLoss, takeProfit),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, symbol, side, price, size, leverage, 'open', null, now),
    ]);
    if (res[0].meta.changes !== 1) return bad('증거금이 부족합니다');
    await reflectVirtualFill(env, symbol, uid, price, side === 'long' ? 'buy' : 'sell', size);

    return json(await loadState(env, uid));
  }

  if (body.action === 'close') {
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(positionId, uid)
      .first<PositionRow>();
    if (!pos) return bad('포지션을 찾을 수 없음', 404);

    // 부분 청산: size 를 지정하면 그만큼만, 생략하면 전량.
    const reqSize = num(body.size);
    if (reqSize != null && !(reqSize > 0)) return bad('청산 수량 오류');
    if (reqSize != null && reqSize > pos.size + 1e-9) return bad('보유 수량보다 많습니다');
    const closeSize = reqSize == null ? pos.size : reqSize;
    const isPartial = closeSize < pos.size - 1e-9;

    const price = await fetchPrice(env, pos.symbol); // 서버 청산가
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (price - pos.entry_price) * closeSize * dir;
    const marginReleased = isPartial ? (pos.margin * closeSize) / pos.size : pos.margin;
    const now = Date.now();
    const ordId = crypto.randomUUID();

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(marginReleased + pnl, uid),
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

    return json(await loadState(env, uid));
  }

  if (body.action === 'limitOpen') {
    const { symbol, side } = body;
    const size = Number(body.size);
    const leverage = Math.round(Number(body.leverage));
    const limitPrice = Number(body.limitPrice);
    if (!isSymbol(symbol)) return bad('알 수 없는 심볼');
    if (side !== 'long' && side !== 'short') return bad('방향 오류');
    if (!(size > 0) || !isFinite(size) || size > 1_000_000) return bad('수량 오류');
    if (!(leverage >= 1 && leverage <= 125)) return bad('레버리지 1~125');
    if (!(limitPrice > 0) || !isFinite(limitPrice)) return bad('지정가 오류');

    const stopLoss = num(body.stopLoss);
    const takeProfit = num(body.takeProfit);
    if (!validSlTp(side, limitPrice, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');

    const margin = (limitPrice * size) / leverage;
    const user = await env.DB.prepare('SELECT id, name, balance FROM users WHERE id = ?')
      .bind(uid)
      .first<UserRow>();
    if (!user) return bad('unauthorized', 401);
    if (margin > user.balance) return bad('증거금이 부족합니다');

    const now = Date.now();
    const pendingId = crypto.randomUUID();
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').bind(
        margin,
        uid,
        margin,
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

    return json(await loadState(env, uid));
  }

  if (body.action === 'cancelLimit') {
    const pendingId = typeof body.pendingId === 'string' ? body.pendingId : '';
    const pending = await env.DB.prepare('SELECT * FROM pending_orders WHERE id = ? AND user_id = ?')
      .bind(pendingId, uid)
      .first<PendingRow>();
    if (!pending) return bad('주문을 찾을 수 없음', 404);

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(pending.margin, uid),
      env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(pendingId, uid),
    ]);

    return json(await loadState(env, uid));
  }

  if (body.action === 'setSlTp') {
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

    return json(await loadState(env, uid));
  }

  return bad('알 수 없는 action');
}
