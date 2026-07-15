import {
  type Ctx,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  isSymbol,
  fetchPrice,
  loadState,
  type PositionRow,
  type PendingRow,
  type UserRow,
} from '../_shared';
import { checkTriggers } from '../_trading';

/**
 * POST /api/order
 *   { action: 'open',       symbol, side, size, leverage, stopLoss?, takeProfit? }
 *   { action: 'close',      positionId }
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

    const price = await fetchPrice(symbol); // 서버 체결가
    const margin = (price * size) / leverage;
    const stopLoss = num(body.stopLoss);
    const takeProfit = num(body.takeProfit);
    if (!validSlTp(side, price, stopLoss, takeProfit)) return bad('SL/TP 값이 올바르지 않습니다');

    const user = await env.DB.prepare('SELECT id, name, balance FROM users WHERE id = ?')
      .bind(uid)
      .first<UserRow>();
    if (!user) return bad('unauthorized', 401);
    if (margin > user.balance) return bad('증거금이 부족합니다');

    const now = Date.now();
    const posId = crypto.randomUUID();
    const ordId = crypto.randomUUID();
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

    return json(await loadState(env, uid));
  }

  if (body.action === 'close') {
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(positionId, uid)
      .first<PositionRow>();
    if (!pos) return bad('포지션을 찾을 수 없음', 404);

    const price = await fetchPrice(pos.symbol); // 서버 청산가
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (price - pos.entry_price) * pos.size * dir;
    const now = Date.now();
    const ordId = crypto.randomUUID();

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(pos.margin + pnl, uid),
      env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(positionId, uid),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, pos.symbol, pos.side, price, pos.size, pos.leverage, 'close', pnl, now),
    ]);

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
