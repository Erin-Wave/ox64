import {
  type Ctx,
  type Env,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  intervalSecFromCode,
  BOT_USER_IDS,
  type SpotOrderRow,
  type SpotTradeRow,
} from '../_shared';

/**
 * OX/USDT — 외부 시세가 없는 가상 코인. 실제 38종과 완전히 동일하게 `order.ts` 를 통해
 * 레버리지 롱/숏으로 거래된다(체결가만 이 파일의 봇이 만드는 내부가격, functions/_shared.ts
 * fetchPrice 참고). 이 파일은 이제 유저 액션이 아니라 두 가지만 담당한다:
 *   - GET /api/spot            — 호가창/체결내역 "표시용" 데이터(로그인만 확인, 유저별 데이터 없음)
 *   - GET /api/spot?candles=1  — spot_trades 를 버킷팅한 OHLCV 캔들
 *   - runMarketMaker()         — 봇 유저 2명이 서로/실유저 포지션의 참조가와 무관하게 자기들끼리
 *     지정가를 매칭시켜 합성 시세·호가·체결 테이프를 만드는 엔진(cron/ 이 주기 호출).
 */
const PAIR = 'OXUSDT';
const EPS = 1e-9; // 부동소수점 잔여수량 판정 오차

export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);
    try {
      await runMarketMaker(env);
    } catch {
      /* 봇 실패가 유저 요청을 막으면 안 됨 — 다음 폴링에서 재시도 */
    }

    const url = new URL(request.url);
    if (url.searchParams.get('candles')) {
      const interval = url.searchParams.get('interval') || '1m';
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
      return json({ candles: await loadSpotCandles(env, interval, limit) });
    }

    return json(await loadSpotMarket(env));
  });
}

/** spot_trades 를 interval 버킷으로 묶어 OHLCV 캔들을 만든다(거래량이 적어 SQL 윈도우함수 대신 JS 로 처리). */
async function loadSpotCandles(env: Env, intervalCode: string, limit: number) {
  const sec = intervalSecFromCode(intervalCode);
  const bucketMs = sec * 1000;
  const trades = (
    await env.DB.prepare('SELECT price, size, created_at FROM spot_trades WHERE pair = ? ORDER BY created_at ASC LIMIT 5000')
      .bind(PAIR)
      .all<{ price: number; size: number; created_at: number }>()
  ).results;
  if (trades.length === 0) return [];

  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const t of trades) {
    const b = Math.floor(t.created_at / bucketMs) * bucketMs;
    const bucket = buckets.get(b);
    if (!bucket) {
      buckets.set(b, { open: t.price, high: t.price, low: t.price, close: t.price, volume: t.size });
    } else {
      bucket.high = Math.max(bucket.high, t.price);
      bucket.low = Math.min(bucket.low, t.price);
      bucket.close = t.price;
      bucket.volume += t.size;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([t, c]) => ({ time: Math.floor(t / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

/** 호가창·체결내역 "표시용" 데이터 — 특정 유저의 개인 데이터가 아니라 시장 전체를 보여준다. */
async function loadSpotMarket(env: Env) {
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
    book: { bids, asks },
    trades: trades.map((t) => ({
      id: t.id,
      price: t.price,
      size: t.size,
      takerSide: t.taker_side,
      createdAt: t.created_at,
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

// ── 마켓메이커 봇(합성 시세·호가·체결 생성) ──────────────────────────
// 예약된 봇 유저 2개가 폴링 시점마다(요청이 들어올 때만) 기준가를 랜덤워크로 살짝 움직이고
// 그 주변에 매수/매도 지정가를 소량 깔아둔다. 가끔 반대편 최우선호가를 즉시 크로스하는 주문을
// 내서(다른 봇 또는 실유저 호가와 매칭) 체결이 계속 발생하게 한다.
const BOT_TICK_MIN_MS = 3000;
const BOT_TICK_MAX_MS = 8000;

export async function runMarketMaker(env: Env): Promise<void> {
  const row = await env.DB.prepare('SELECT last_run, ref_price FROM spot_bot_state WHERE id = ?')
    .bind(PAIR)
    .first<{ last_run: number; ref_price: number }>();
  const now = Date.now();
  const last = row?.last_run ?? 0;
  const gate = BOT_TICK_MIN_MS + Math.random() * (BOT_TICK_MAX_MS - BOT_TICK_MIN_MS);
  if (now - last < gate) return;
  // 동시 요청이 겹쳐도 대략 한 번만 돌도록 먼저 last_run 을 찍어둔다(완벽한 락은 아니지만 폴링 간격상 충분).
  await env.DB.prepare(
    'INSERT INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_run = excluded.last_run',
  )
    .bind(PAIR, now, row?.ref_price ?? 1)
    .run();

  let ref = row?.ref_price;
  if (!ref) {
    const lastTrade = await env.DB.prepare('SELECT price FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 1')
      .bind(PAIR)
      .first<{ price: number }>();
    ref = lastTrade?.price ?? 1;
  }
  ref = Math.max(0.01, ref * (1 + (Math.random() - 0.5) * 0.012)); // ±0.6% 랜덤워크
  await env.DB.prepare('UPDATE spot_bot_state SET ref_price = ? WHERE id = ?').bind(ref, PAIR).run();

  const actor = BOT_USER_IDS[Math.floor(Math.random() * BOT_USER_IDS.length)];

  // ⚠ 호가창 역전 버그 수정: "초과분만 취소"하던 예전 방식은 같은 봇의 오래된 호가가 남아있다가
  // 랜덤워크로 기준가가 움직인 뒤 자기 자신의 새 주문과 가격이 역전돼도 셀프매칭 방지(user_id != ?)
  // 때문에 절대 안 맞물려서 그대로 살아남았다(집계에서 최우선매수 > 최우선매도로 보임). 그래서 매
  // 틱마다 이 액터의 기존 호가를 전부 취소·환불하고 새로 2개(매수/매도)만 깐다.
  const mine = (
    await env.DB.prepare("SELECT * FROM spot_orders WHERE user_id = ? AND pair = ? AND status = 'open'")
      .bind(actor, PAIR)
      .all<SpotOrderRow>()
  ).results;
  for (const o of mine) {
    const refund = o.side === 'buy' ? o.price * o.size : o.size;
    const col = o.side === 'buy' ? 'balance' : 'ox_balance';
    await env.DB.batch([
      env.DB.prepare("UPDATE spot_orders SET status = 'cancelled' WHERE id = ?").bind(o.id),
      env.DB.prepare(`UPDATE users SET ${col} = ${col} + ? WHERE id = ?`).bind(refund, actor),
    ]);
  }

  // 가끔 반대편 최우선호가를 즉시 크로스 — 다른 봇/실유저 호가와 체결시켜 최근체결·차트가 계속 움직이게 함.
  if (Math.random() < 0.5) {
    const crossSide = Math.random() < 0.5 ? 'buy' : 'sell';
    const bestOpp =
      crossSide === 'buy'
        ? await env.DB.prepare(
            "SELECT price FROM spot_orders WHERE pair = ? AND side = 'sell' AND status = 'open' AND user_id != ? ORDER BY price ASC LIMIT 1",
          )
            .bind(PAIR, actor)
            .first<{ price: number }>()
        : await env.DB.prepare(
            "SELECT price FROM spot_orders WHERE pair = ? AND side = 'buy' AND status = 'open' AND user_id != ? ORDER BY price DESC LIMIT 1",
          )
            .bind(PAIR, actor)
            .first<{ price: number }>();
    if (bestOpp) {
      const crossPrice = crossSide === 'buy' ? bestOpp.price * 1.002 : bestOpp.price * 0.998;
      await placeBotOrder(env, actor, crossSide, crossPrice, Number((2 + Math.random() * 10).toFixed(4)));
    }
  }

  // 기준가 주변에 패시브 호가를 새로 깐다.
  const spread = 0.003 + Math.random() * 0.005;
  const size = Number((5 + Math.random() * 40).toFixed(4));
  await placeBotOrder(env, actor, 'buy', Number((ref * (1 - spread)).toFixed(6)), size);
  await placeBotOrder(env, actor, 'sell', Number((ref * (1 + spread)).toFixed(6)), size);
}

/** 봇 전용 주문 배치(에스크로+매칭) — 봇은 잔고가 항상 충분하다. */
async function placeBotOrder(env: Env, uid: string, side: 'buy' | 'sell', price: number, size: number) {
  if (!(price > 0) || !(size > 0)) return;
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
    if (res[0].meta.changes !== 1) return; // 봇 잔고 바닥(거의 없음) — 이번 틱은 스킵
    await matchBuy(env, uid, orderId, price);
  } else {
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE users SET ox_balance = ox_balance - ? WHERE id = ? AND ox_balance >= ?').bind(size, uid, size),
      env.DB.prepare(
        'INSERT INTO spot_orders (id, user_id, pair, side, price, size, orig_size, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(orderId, uid, PAIR, 'sell', price, size, size, 'open', now),
    ]);
    if (res[0].meta.changes !== 1) return;
    await matchSell(env, uid, orderId, price);
  }
}
