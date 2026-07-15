import {
  type Ctx,
  type Env,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  type UserRow,
  type SpotOrderRow,
  type SpotTradeRow,
} from '../_shared';

/**
 * OX/USDT — 외부 시세가 없는 예시용 가상 코인. 레버리지·마진 없이, 유저가 낸 지정가
 * 매수/매도 주문이 서로 직접 매칭되어 체결되는 실제 현물 주문매칭(리미트 오더북).
 * 가입 시 정해진 물량(SEED_OX, users.ox_balance DEFAULT)만 지급되고 이후로는 유저 간
 * 거래로만 이동한다(추가 발행 없음).
 *
 * GET  /api/spot         — 잔고 + 내 미체결 주문 + 호가(가격별 합산) + 최근 체결
 * POST /api/spot
 *   { action: 'place',  side: 'buy'|'sell', price, size }
 *   { action: 'cancel', orderId }
 */
const PAIR = 'OXUSDT';
const EPS = 1e-9; // 부동소수점 잔여수량 판정 오차

export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);
    const state = await loadSpotState(env, sess.uid);
    if (!state) return bad('unauthorized', 401);
    return json(state);
  });
}

export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handlePost(request, env));
}

async function loadSpotState(env: Env, uid: string) {
  const user = await env.DB.prepare('SELECT id, balance, ox_balance FROM users WHERE id = ?')
    .bind(uid)
    .first<UserRow>();
  if (!user) return null;

  const myOrders = (
    await env.DB.prepare(
      "SELECT * FROM spot_orders WHERE user_id = ? AND pair = ? AND status = 'open' ORDER BY created_at DESC",
    )
      .bind(uid, PAIR)
      .all<SpotOrderRow>()
  ).results;

  const bids = (
    await env.DB.prepare(
      "SELECT price, SUM(size) AS size FROM spot_orders WHERE pair = ? AND side = 'buy' AND status = 'open' GROUP BY price ORDER BY price DESC LIMIT 15",
    )
      .bind(PAIR)
      .all<{ price: number; size: number }>()
  ).results;
  const asks = (
    await env.DB.prepare(
      "SELECT price, SUM(size) AS size FROM spot_orders WHERE pair = ? AND side = 'sell' AND status = 'open' GROUP BY price ORDER BY price ASC LIMIT 15",
    )
      .bind(PAIR)
      .all<{ price: number; size: number }>()
  ).results;

  const trades = (
    await env.DB.prepare('SELECT * FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 30')
      .bind(PAIR)
      .all<SpotTradeRow>()
  ).results;

  return {
    usdtBalance: user.balance,
    oxBalance: user.ox_balance,
    myOrders: myOrders.map((o) => ({
      id: o.id,
      side: o.side,
      price: o.price,
      size: o.size,
      origSize: o.orig_size,
      createdAt: o.created_at,
    })),
    book: { bids, asks },
    trades: trades.map((t) => ({
      id: t.id,
      price: t.price,
      size: t.size,
      takerSide: t.taker_side,
      createdAt: t.created_at,
      isMe: t.buyer_id === uid || t.seller_id === uid,
    })),
  };
}

// 매수 주문 체결 루프 — 상대(매도) 최우선호가(가격 낮은 순 → 시간 순)와 매칭.
// 체결가는 항상 먼저 있던(메이커) 주문의 가격. 테이커(이 매수 주문)가 자기 지정가보다
// 싸게 체결되면 그 차액을 즉시 환불(에스크로 시 자기 지정가 기준으로 전액을 미리 잠갔으므로).
async function matchBuy(env: Env, uid: string, orderId: string, limitPrice: number) {
  for (let i = 0; i < 200; i++) {
    const order = await env.DB.prepare('SELECT * FROM spot_orders WHERE id = ?').bind(orderId).first<SpotOrderRow>();
    if (!order || order.status !== 'open' || order.size <= EPS) return;
    // user_id != ? : 본인이 낸 반대편 주문과는 체결되지 않는다(셀프매칭 방지).
    const maker = await env.DB.prepare(
      "SELECT * FROM spot_orders WHERE pair = ? AND side = 'sell' AND status = 'open' AND price <= ? AND user_id != ? ORDER BY price ASC, created_at ASC LIMIT 1",
    )
      .bind(PAIR, limitPrice, uid)
      .first<SpotOrderRow>();
    if (!maker) return;

    const tradeSize = Math.min(order.size, maker.size);
    const tradePrice = maker.price;
    const refund = (limitPrice - tradePrice) * tradeSize;
    const buyerRemaining = order.size - tradeSize;
    const makerRemaining = maker.size - tradeSize;
    const now = Date.now();

    await env.DB.batch([
      env.DB
        .prepare('UPDATE spot_orders SET size = ?, status = ? WHERE id = ?')
        .bind(buyerRemaining, buyerRemaining <= EPS ? 'filled' : 'open', orderId),
      env.DB
        .prepare('UPDATE spot_orders SET size = ?, status = ? WHERE id = ?')
        .bind(makerRemaining, makerRemaining <= EPS ? 'filled' : 'open', maker.id),
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(refund, uid),
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(tradePrice * tradeSize, maker.user_id),
      env.DB.prepare('UPDATE users SET ox_balance = ox_balance + ? WHERE id = ?').bind(tradeSize, uid),
      env.DB.prepare(
        'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), PAIR, uid, maker.user_id, tradePrice, tradeSize, 'buy', now),
    ]);

    if (buyerRemaining <= EPS) return;
  }
}

// 매도 주문 체결 루프 — 상대(매수) 최우선호가(가격 높은 순 → 시간 순)와 매칭.
// 매도자는 OX 수량 그대로를 에스크로했으므로(가격 무관) 환불 계산이 필요 없다.
async function matchSell(env: Env, uid: string, orderId: string, limitPrice: number) {
  for (let i = 0; i < 200; i++) {
    const order = await env.DB.prepare('SELECT * FROM spot_orders WHERE id = ?').bind(orderId).first<SpotOrderRow>();
    if (!order || order.status !== 'open' || order.size <= EPS) return;
    // user_id != ? : 본인이 낸 반대편 주문과는 체결되지 않는다(셀프매칭 방지).
    const maker = await env.DB.prepare(
      "SELECT * FROM spot_orders WHERE pair = ? AND side = 'buy' AND status = 'open' AND price >= ? AND user_id != ? ORDER BY price DESC, created_at ASC LIMIT 1",
    )
      .bind(PAIR, limitPrice, uid)
      .first<SpotOrderRow>();
    if (!maker) return;

    const tradeSize = Math.min(order.size, maker.size);
    const tradePrice = maker.price;
    const sellerRemaining = order.size - tradeSize;
    const makerRemaining = maker.size - tradeSize;
    const now = Date.now();

    await env.DB.batch([
      env.DB
        .prepare('UPDATE spot_orders SET size = ?, status = ? WHERE id = ?')
        .bind(sellerRemaining, sellerRemaining <= EPS ? 'filled' : 'open', orderId),
      env.DB
        .prepare('UPDATE spot_orders SET size = ?, status = ? WHERE id = ?')
        .bind(makerRemaining, makerRemaining <= EPS ? 'filled' : 'open', maker.id),
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(tradePrice * tradeSize, uid),
      env.DB.prepare('UPDATE users SET ox_balance = ox_balance + ? WHERE id = ?').bind(tradeSize, maker.user_id),
      env.DB.prepare(
        'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), PAIR, maker.user_id, uid, tradePrice, tradeSize, 'sell', now),
    ]);

    if (sellerRemaining <= EPS) return;
  }
}

async function handlePost(request: Request, env: Env): Promise<Response> {
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

  if (body.action === 'place') {
    const side = body.side;
    const price = Number(body.price);
    const size = Number(body.size);
    if (side !== 'buy' && side !== 'sell') return bad('방향 오류');
    if (!(price > 0) || !isFinite(price)) return bad('가격 오류');
    if (!(size > 0) || !isFinite(size) || size > 1_000_000) return bad('수량 오류');

    const orderId = crypto.randomUUID();
    const now = Date.now();

    if (side === 'buy') {
      const cost = price * size;
      const res = await env.DB.batch([
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').bind(cost, uid, cost),
        env.DB.prepare(
          'INSERT INTO spot_orders (id, user_id, pair, side, price, size, orig_size, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ).bind(orderId, uid, PAIR, 'buy', price, size, size, 'open', now),
      ]);
      if (res[0].meta.changes !== 1) return bad('USDT 잔고가 부족합니다');
      await matchBuy(env, uid, orderId, price);
    } else {
      const res = await env.DB.batch([
        env.DB
          .prepare('UPDATE users SET ox_balance = ox_balance - ? WHERE id = ? AND ox_balance >= ?')
          .bind(size, uid, size),
        env.DB.prepare(
          'INSERT INTO spot_orders (id, user_id, pair, side, price, size, orig_size, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ).bind(orderId, uid, PAIR, 'sell', price, size, size, 'open', now),
      ]);
      if (res[0].meta.changes !== 1) return bad('OX 보유량이 부족합니다');
      await matchSell(env, uid, orderId, price);
    }

    return json(await loadSpotState(env, uid));
  }

  if (body.action === 'cancel') {
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const order = await env.DB.prepare('SELECT * FROM spot_orders WHERE id = ? AND user_id = ?')
      .bind(orderId, uid)
      .first<SpotOrderRow>();
    if (!order) return bad('주문을 찾을 수 없음', 404);
    if (order.status !== 'open') return bad('이미 종료된 주문입니다');

    const refundStmt =
      order.side === 'buy'
        ? env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(order.price * order.size, uid)
        : env.DB.prepare('UPDATE users SET ox_balance = ox_balance + ? WHERE id = ?').bind(order.size, uid);
    await env.DB.batch([
      env.DB.prepare("UPDATE spot_orders SET status = 'cancelled' WHERE id = ?").bind(orderId),
      refundStmt,
    ]);

    return json(await loadSpotState(env, uid));
  }

  return bad('알 수 없는 action');
}
