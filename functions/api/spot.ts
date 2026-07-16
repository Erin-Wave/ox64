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
  type PendingRow,
  type PositionRow,
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

/** 호가창·체결내역 "표시용" 데이터 — 특정 유저의 개인 데이터가 아니라 시장 전체를 보여준다.
 * ⚠ 유저가 OX 에 건 지정가 주문(pending_orders, "미체결" 탭)은 봇 호가(spot_orders)와 완전히
 * 다른 테이블이라 그냥 두면 호가창에 절대 안 나타난다("내가 건 매수가 호가에 안 보인다" 버그의
 * 근본 원인) — 그래서 두 테이블을 UNION 해서 같은 가격대끼리 합산한다. long 지정가=매수 호가,
 * short 지정가=매도 호가. pending_orders 는 취소/체결되면 즉시 그 행이 사라지므로(order.ts/
 * _trading.ts) 별도 동기화 없이 항상 최신 상태가 자동으로 반영된다. */
async function loadSpotMarket(env: Env) {
  const bids = (
    await env.DB.prepare(
      `SELECT price, SUM(size) AS size FROM (
         SELECT price, size FROM spot_orders WHERE pair = ? AND side = 'buy' AND status = 'open'
         UNION ALL
         SELECT limit_price AS price, size FROM pending_orders WHERE symbol = ? AND side = 'long'
       ) GROUP BY price ORDER BY price DESC LIMIT 15`,
    )
      .bind(PAIR, PAIR)
      .all<{ price: number; size: number }>()
  ).results;
  const asks = (
    await env.DB.prepare(
      `SELECT price, SUM(size) AS size FROM (
         SELECT price, size FROM spot_orders WHERE pair = ? AND side = 'sell' AND status = 'open'
         UNION ALL
         SELECT limit_price AS price, size FROM pending_orders WHERE symbol = ? AND side = 'short'
       ) GROUP BY price ORDER BY price ASC LIMIT 15`,
    )
      .bind(PAIR, PAIR)
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
const BOT_LEVELS_PER_SIDE = 4; // 봇 1명이 한 틱에 까는 매수/매도 각각의 호가 단계 수(호가창 깊이)

export async function runMarketMaker(env: Env): Promise<void> {
  const row = await env.DB.prepare('SELECT last_run, ref_price FROM spot_bot_state WHERE id = ?')
    .bind(PAIR)
    .first<{ last_run: number; ref_price: number }>();
  const now = Date.now();
  const last = row?.last_run ?? 0;

  // ⚠ 게이트(봇 재호가 주기)보다 먼저, 매 폴링마다 체결 가능한 유저 지정가를 시장가로 즉시 체결한다.
  // 이래야 주문 낸 유저의 개인 폴링에 의존하지 않고(백그라운드 탭·접속 종료여도) 시장이 그 가격을
  // 뚫는 순간 곧바로 체결·소멸돼 호가 역전이 남지 않는다("체결 안 됨/호가 역전"의 근본 해결).
  if (row?.ref_price) await fillMarketableOxLimits(env, row.ref_price);

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

  // 기준가 주변에 패시브 호가를 여러 단계(레벨)로 깐다 — 매 틱마다 이 액터의 호가를 전부 새로
  // 깔기 때문에(위 취소 로직) 레벨을 늘려도 역전 걱정 없이 호가창 깊이만 두꺼워진다.
  for (let level = 0; level < BOT_LEVELS_PER_SIDE; level++) {
    const spread = 0.003 + level * 0.004 + Math.random() * 0.003;
    const size = Number((5 + Math.random() * 40).toFixed(4));
    await placeBotOrder(env, actor, 'buy', Number((ref * (1 - spread)).toFixed(6)), size);
    await placeBotOrder(env, actor, 'sell', Number((ref * (1 + spread)).toFixed(6)), size);
  }
}

/** 유저가 OX 를 실제로 레버리지 거래(order.ts open/close)할 때 그 체결을 합성 시장에도 반영한다.
 * 이걸 안 하면 유저 입장에선 포지션 수량만 조용히 바뀌고 호가창·체결내역·다음 기준가엔 전혀
 * 안 보여서 "내가 산 게 반영이 안 된다"는 혼란이 생긴다 — 그래서 체결 테이프에 기록하고
 * 기준가(ref_price)도 이 체결가로 즉시 당겨준다(다음 봇 틱이 이 가격 기준으로 랜덤워크). */
export async function recordVirtualFill(
  env: Env,
  uid: string,
  price: number,
  takerSide: 'buy' | 'sell',
  size: number,
): Promise<void> {
  const now = Date.now();

  // ⚠ 체결 테이프에만 기록하고 호가창(spot_orders)은 그대로 두면 "체결은 찍히는데 호가는 그대로"인
  // 이상한 상태가 됨 — 실제 매칭처럼 반대편 최우선호가부터 이 체결수량만큼 소비(줄이거나 다 채움)한다.
  // 봇 잔고는 조정하지 않는다(봇은 경제적으로 의미 없는 무한 유동성 풀 — 다음 취소·재호가 때 자연히 정리됨).
  const oppositeSide = takerSide === 'buy' ? 'sell' : 'buy';
  const order = oppositeSide === 'sell' ? 'price ASC' : 'price DESC';
  let remaining = size;
  for (let i = 0; i < 50 && remaining > EPS; i++) {
    const maker = await env.DB.prepare(
      `SELECT * FROM spot_orders WHERE pair = ? AND side = ? AND status = 'open' ORDER BY ${order}, created_at ASC LIMIT 1`,
    )
      .bind(PAIR, oppositeSide)
      .first<SpotOrderRow>();
    if (!maker) break;
    const consumed = Math.min(maker.size, remaining);
    const makerRemaining = maker.size - consumed;
    await env.DB.prepare('UPDATE spot_orders SET size = ?, status = ? WHERE id = ?')
      .bind(makerRemaining, makerRemaining <= EPS ? 'filled' : 'open', maker.id)
      .run();
    remaining -= consumed;
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), PAIR, uid, uid, price, size, takerSide, now),
    env.DB.prepare(
      'INSERT INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ref_price = excluded.ref_price',
    ).bind(PAIR, now, price),
  ]);
}

/**
 * OX/USDT 지정가 하나가 지금 체결 가능(marketable)하면 시장가(ref)로 즉시 체결시켜 레버리지
 * 포지션을 연다. ⚠ 근본 문제였던 "두 개의 분리된 매칭 시스템"을 해소하는 핵심 함수 —
 * 예전엔 유저 지정가(pending_orders)를 그 유저 자신의 checkTriggers(폴링) 만 스칼라 ref 와
 * 비교해 체결했고, 봇 매칭엔진(matchBuy/matchSell)은 유저 지정가를 아예 안 봤다. 그래서
 * "내 매수(1.1111)보다 싼 매도(1.0919)가 계속 올라오는데 안 맞물리는" 호가 역전(크로스)이 났다.
 * 이 함수는 runMarketMaker(누구의 /api/spot 폴링·크론) 와 checkTriggers(그 유저 폴링) 양쪽에서
 * 호출돼, 체결 가능한 유저 지정가가 폴링 주체와 무관하게 즉시 체결·소멸되게 한다.
 *
 * - 체결 여부: long 은 ref<=limit(싸게 매수 가능), short 는 ref>=limit(비싸게 매도 가능).
 * - 체결가: 트레이더에게 항상 지정가만큼 유리하거나 같게(가격 개선) — long=min(limit,ref),
 *   short=max(limit,ref). limit 그대로 물리던(시장가보다 비싸게 물리는) 문제를 제거.
 * - 증거금: 생성 시 limit 기준으로 잠갔으므로, 실제 체결 증거금과의 차액을 환불(long)하거나
 *   추가 징수(short, 잔고 부족하면 개선 없이 limit 로 폴백)한다.
 * - 원자성: 먼저 pending 을 조건부 DELETE 해서 "선점"한다(changes!==1 이면 다른 경로가 이미
 *   체결/취소한 것 → 이중 체결 방지). 선점 후에만 포지션을 연다.
 */
export async function fillOxPending(env: Env, p: PendingRow, ref: number): Promise<boolean> {
  const isLong = p.side === 'long';
  const marketable = isLong ? ref <= p.limit_price : ref >= p.limit_price;
  if (!marketable || !(ref > 0)) return false;

  // 선점(claim): 이 DELETE 가 changes=1 인 경로만 체결을 진행한다(동시 요청 이중 체결 방지).
  const claim = await env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?')
    .bind(p.id, p.user_id)
    .run();
  if (claim.meta.changes !== 1) return false;

  // 물타기(병합) 시 레버리지는 기존 포지션 값으로 고정 — order.ts 의 open 병합과 동일. 증거금도
  // 그 레버리지(effLeverage) 기준으로 계산해야 값이 보존된다(신규면 지정가의 레버리지 그대로).
  const existing = await env.DB.prepare('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?')
    .bind(p.user_id, PAIR, p.side)
    .first<PositionRow>();
  const effLeverage = existing ? existing.leverage : p.leverage;

  const improved = isLong ? Math.min(p.limit_price, ref) : Math.max(p.limit_price, ref);

  // 체결가 = 개선가(improved). 필요한 증거금이 생성 시 잠근 것(p.margin)보다 크면(주로 short 가
  // 시장가로 더 비싸게 체결 → 명목가↑) 차액을 추가 징수하고, 잔고가 부족하면 가격개선을 포기하고
  // 잠근 증거금 그대로(fillPrice=limit, posMargin=p.margin) 체결한다(항상 값 보존·감당 가능).
  // 필요한 증거금이 잠근 것 이하이면(주로 long) 차액을 환불한다.
  let fillPrice = improved;
  let posMargin = (improved * p.size) / effLeverage;
  let refundInBatch = 0;
  if (posMargin <= p.margin) {
    refundInBatch = p.margin - posMargin;
  } else {
    const extra = posMargin - p.margin;
    const charged = await env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
      .bind(extra, p.user_id, extra)
      .run();
    if (charged.meta.changes !== 1) {
      fillPrice = p.limit_price;
      posMargin = p.margin;
    }
  }

  const now = Date.now();
  const ordId = crypto.randomUUID();

  const stmts = [];
  if (existing) {
    // 같은 심볼·방향 보유분과 병합(원웨이 모드).
    const newSize = existing.size + p.size;
    const newEntry = (existing.entry_price * existing.size + fillPrice * p.size) / newSize;
    const newMargin = existing.margin + posMargin;
    const finalSl = p.stop_loss != null ? p.stop_loss : existing.stop_loss;
    const finalTp = p.take_profit != null ? p.take_profit : existing.take_profit;
    stmts.push(
      env.DB.prepare(
        'UPDATE positions SET entry_price = ?, size = ?, margin = ?, stop_loss = ?, take_profit = ? WHERE id = ? AND user_id = ?',
      ).bind(newEntry, newSize, newMargin, finalSl, finalTp, existing.id, p.user_id),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, p.user_id, PAIR, p.side, fillPrice, p.size, existing.leverage, 'open', null, now),
    );
  } else {
    const posId = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(
        'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(posId, p.user_id, PAIR, p.side, fillPrice, p.size, p.leverage, posMargin, now, p.stop_loss, p.take_profit),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, p.user_id, PAIR, p.side, fillPrice, p.size, p.leverage, 'open', null, now),
    );
  }
  if (refundInBatch > 0) {
    stmts.push(env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(refundInBatch, p.user_id));
  }
  await env.DB.batch(stmts);

  try {
    await recordVirtualFill(env, p.user_id, fillPrice, isLong ? 'buy' : 'sell', p.size);
  } catch {
    /* 표시용 부가효과 — 실패해도 체결(위 배치)은 이미 확정 */
  }
  return true;
}

/** 전 유저의 OX 지정가 중 지금 체결 가능한 것을 시장가(ref)로 즉시 체결한다 — runMarketMaker 가
 * 매 틱 호출하므로, 주문 낸 유저가 접속/폴링 중이 아니어도 시장이 그 가격을 뚫으면 곧 체결된다. */
async function fillMarketableOxLimits(env: Env, ref: number): Promise<void> {
  if (!(ref > 0)) return;
  const pendings = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE symbol = ?').bind(PAIR).all<PendingRow>()
  ).results;
  for (const p of pendings) {
    try {
      await fillOxPending(env, p, ref);
    } catch {
      /* 한 건 실패해도 나머지는 계속 — 다음 틱에서 재시도 */
    }
  }
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
