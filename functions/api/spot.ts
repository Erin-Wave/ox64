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
  type D1PreparedStatement,
} from '../_shared';

/**
 * OX/USDT — 외부 시세가 없는 가상 코인. 실제 38종과 완전히 동일하게 `order.ts` 를 통해
 * 레버리지 롱/숏으로 거래된다(체결가만 이 파일의 봇이 만드는 내부가격, functions/_shared.ts
 * fetchPrice 참고). 이 파일은 이제 유저 액션이 아니라 두 가지만 담당한다:
 *   - GET /api/spot            — 호가창/체결내역 "표시용" 데이터(로그인만 확인, 유저별 데이터 없음)
 *   - GET /api/spot?candles=1  — spot_trades 를 버킷팅한 OHLCV 캔들
 *   - runMarketMaker()         — 봇 유저 2명이 합성 시세·호가·체결 테이프를 만드는 엔진(cron/ 이 주기 호출).
 */
const PAIR = 'OXUSDT';
const EPS = 1e-9; // 부동소수점 잔여수량 판정 오차
// OX/USDT 최소 호가 단위 = 0.0001(4자리). 봇 기준가/호가/체결가를 전부 이 틱에 스냅해서, 실제
// 코인처럼 정해진 소수 자릿수 이상으로는 호가·체결이 생기지 않게 한다(가상코인 소수점 무결성).
const roundOx = (p: number) => Number((Math.round(p * 1e4) / 1e4).toFixed(4));

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

/** spot_trades 를 interval 버킷으로 묶어 OHLCV 캔들을 만든다(거래량이 적어 SQL 윈도우함수 대신 JS 로 처리).
 * ⚠ 반드시 "가장 최신" 5000건을 읽어야 한다 — 예전엔 `ORDER BY created_at ASC LIMIT 5000`(가장 오래된
 * 5000건)이라, 총 거래가 5000건을 넘는 순간부터 새 거래가 이 창 밖으로 밀려나 차트가 그 시점에 멈춰버렸다
 * (OX 차트가 "고장난" 것처럼 마지막 봉이 갱신 안 되던 버그). 최신 5000건을 DESC 로 뽑아 다시 ASC 로 정렬해 버킷팅. */
async function loadSpotCandles(env: Env, intervalCode: string, limit: number) {
  const sec = intervalSecFromCode(intervalCode);
  const bucketMs = sec * 1000;
  const trades = (
    await env.DB.prepare(
      'SELECT price, size, created_at FROM (SELECT price, size, created_at FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 5000) ORDER BY created_at ASC',
    )
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

// ── 마켓메이커 봇(합성 시세·호가·체결 생성) ──────────────────────────
// 예약된 봇 유저 2명이 폴링 시점마다(요청이 들어올 때만) 기준가를 랜덤워크로 살짝 움직이고 그
// 주변에 매수/매도 지정가 사다리를 깐다. 유저 주문은 이 호가를 실제로 walking 매칭한다.
//
// ⚠ DB I/O 최소화(재작성): 예전엔 한 틱에 봇 호가 16개를 "개별 batch 로 취소"(16 왕복)하고 다시
// 16개를 "개별 placeBotOrder"(각각 매칭 SELECT 2회+쓰기 = 32 왕복)로 깔아 한 틱에 수십~100+
// 문장/수십 왕복이 나갔다. 지금은 (취소 1문 + 사다리 16문 + 합성체결 1문 + 기준가 1문)을 단 하나의
// batch(왕복 1회)로 처리한다. 게이트 통과(재호가) 틱이 아니면 DB read 1회로 즉시 반환한다.
//
// ⚠ 봇 호가는 잔고 에스크로를 하지 않는다 — 봇 잔고(users.balance/ox_balance)는 랭킹에서 제외되고
// 시세는 spot_bot_state, 호가는 spot_orders 에서 읽으므로 "어디서도 읽히지 않는 write-only" 값이었다.
// 부기를 유지하느라 취소마다 환불·체결마다 정산하던 왕복이 순수 낭비여서 전부 제거했다(무한 유동성 풀).
// 유저↔봇 체결의 물량 소비만 조건부 UPDATE 로 원자 처리하면 되고(matchLimitPendingAgainstBook 등),
// 봇 잔고 숫자는 무의미하다.
const BOT_TICK_MIN_MS = 3000;
const BOT_TICK_MAX_MS = 8000;
const BOT_LEVELS_PER_SIDE = 8; // 한 틱에 까는 매수/매도 각각의 호가 단계 수(호가창 깊이)

// 봇 패시브 호가 1개를 INSERT 하는 문장(에스크로 없음).
function botQuoteStmt(env: Env, actor: string, side: 'buy' | 'sell', price: number, size: number, now: number): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO spot_orders (id, user_id, pair, side, price, size, orig_size, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(crypto.randomUUID(), actor, PAIR, side, price, size, size, 'open', now);
}

export async function runMarketMaker(env: Env): Promise<void> {
  const row = await env.DB.prepare('SELECT last_run, ref_price FROM spot_bot_state WHERE id = ?')
    .bind(PAIR)
    .first<{ last_run: number; ref_price: number }>();
  const now = Date.now();
  const last = row?.last_run ?? 0;

  const gate = BOT_TICK_MIN_MS + Math.random() * (BOT_TICK_MAX_MS - BOT_TICK_MIN_MS);
  if (now - last < gate) return; // 재호가 주기 전 — 아무것도 안 함(가장 흔한 경로: state read 1회뿐)

  // 재호가 틱을 원자적으로 선점(동시 폴링이 겹쳐도 이 틱은 한 번만 requote) — 조건부 upsert.
  // 최초(행 없음)엔 INSERT 로 changes=1, 이미 다른 요청이 last_run 을 옮겼으면 WHERE 불일치로 changes=0.
  const claim = await env.DB.prepare(
    'INSERT INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_run = excluded.last_run WHERE spot_bot_state.last_run = ?',
  )
    .bind(PAIR, now, row?.ref_price ?? 1, last)
    .run();
  if (claim.meta.changes !== 1) return; // 다른 요청이 이 틱을 이미 선점 — 중복 requote 방지

  let prevRef = row?.ref_price ?? 0;
  if (!prevRef) {
    const lastTrade = await env.DB.prepare('SELECT price FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 1')
      .bind(PAIR)
      .first<{ price: number }>();
    prevRef = lastTrade?.price ?? 1;
  }
  const ref = roundOx(Math.max(0.01, prevRef * (1 + (Math.random() - 0.5) * 0.012))); // ±0.6% 랜덤워크(4자리 틱 스냅)
  const actor = BOT_USER_IDS[Math.floor(Math.random() * BOT_USER_IDS.length)];

  // === 단일 batch: (1) 이 페어의 봇 호가 전부 취소  (2) 새 양방향 사다리 호가  (3) 합성 체결 1건
  //                (4) 기준가 갱신 — 전부 왕복 1회로 끝낸다. ===
  const stmts: D1PreparedStatement[] = [
    // ⚠ 매 틱 이 페어의 봇 호가를 "전부"(두 봇 모두) 비우고 한 액터가 일관된 사다리를 새로 깐다.
    // 액터 것만 취소하면 다른 봇의 오래된 호가가 남아, 랜덤워크로 기준가가 움직인 뒤 호가 역전
    // (최우선매수 > 최우선매도)이 생긴다 — 예전엔 봇끼리 크로스 매칭이 이걸 정리했지만 그 왕복을
    // 없앴으므로, 아예 전체를 비우고 다시 까는 게 가장 싸고 확실하다(user 주문은 pending_orders 라
    // spot_orders 엔 봇 호가만 있으니 pair 전체를 지워도 유저 주문엔 영향 없음). batch 원자성으로
    // 호가창이 빈 순간이 노출되지 않는다(취소+재호가가 한 스냅샷).
    env.DB.prepare("UPDATE spot_orders SET status = 'cancelled' WHERE pair = ? AND status = 'open'").bind(PAIR),
  ];
  // 기준가 주변에 여러 단계로 유동성을 깐다. 스프레드는 실거래소처럼 타이트하게(최우선호가가 mid 에
  // 바싹 붙게) 잡아 시장가 체결이 mid 근처에서 이뤄지게 하되, 깊은 레벨로 갈수록 벌어지며 대량 주문엔
  // 슬리피지가 생긴다. 물량을 크게 깔아(2000~10000) 유저 주문이 시원하게 체결되게 한다.
  for (let level = 0; level < BOT_LEVELS_PER_SIDE; level++) {
    const spread = 0.0012 + level * 0.0016 + Math.random() * 0.0008;
    const buySize = Number((2000 + Math.random() * 8000).toFixed(4));
    const sellSize = Number((2000 + Math.random() * 8000).toFixed(4));
    stmts.push(botQuoteStmt(env, actor, 'buy', roundOx(ref * (1 - spread)), buySize, now));
    stmts.push(botQuoteStmt(env, actor, 'sell', roundOx(ref * (1 + spread)), sellSize, now));
  }
  // 합성 체결 1건 — 봇끼리 크로스 주문을 내고 매칭하던(호가 1개 더 깔고 매칭 왕복) 예전 방식을 대체.
  // 체결 테이프·차트가 계속 움직이게 하되 왕복 없이 batch 안에서 끝낸다. 체결가=새 기준가(mid),
  // 색상은 기준가가 오르면 매수/내리면 매도.
  const tradeSize = Number((5 + Math.random() * 40).toFixed(4));
  const takerSide = ref >= prevRef ? 'buy' : 'sell';
  stmts.push(
    env.DB.prepare(
      'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), PAIR, actor, actor, ref, tradeSize, takerSide, now),
  );
  stmts.push(env.DB.prepare('UPDATE spot_bot_state SET ref_price = ? WHERE id = ?').bind(ref, PAIR));
  await env.DB.batch(stmts);

  // 방금 깐 신선한 유동성에 대기 중 유저 지정가를 이어서 매칭(walking) — 봇이 유저 매수보다 싼
  // 매도를 깔면 같은 틱에 소비돼 호가 역전이 화면에 안 남는다. 주문 낸 유저의 접속/폴링과 무관하게 진행.
  // (게이트 전 sweep 은 제거했다 — 호가창은 이 requote 틱에만 바뀌므로 매 폴링 sweep 은 낭비였고,
  //  유저 본인 pending 은 checkTriggers 5초 폴링이 별도로 훑는다.)
  await sweepRestingOxPendings(env);
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
  price = roundOx(price); // 체결내역/기준가도 4자리 틱 유지
  const now = Date.now();

  // ⚠ 체결 테이프에만 기록하고 호가창(spot_orders)은 그대로 두면 "체결은 찍히는데 호가는 그대로"인
  // 이상한 상태가 됨 — 실제 매칭처럼 반대편 최우선호가부터 이 체결수량만큼 소비(줄이거나 다 채움)한다.
  // 봇 잔고는 조정하지 않는다(무한 유동성 풀 — 다음 취소·재호가 때 자연히 정리됨).
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

// ── OX/USDT 실제 호가창 매칭 엔진 ───────────────────────────────────────────
// ⚠ 근본 재설계: 예전엔 유저 주문을 호가창과 무관하게 스칼라 ref 한 값에 "전량" 체결해서
// (1) 있지도 않은 물량이 즉시 체결되고 (2) 최우선 호가보다 유리한 유령가격에 체결되는 심각한
// 버그가 있었다. 이제 유저 주문은 봇이 실제로 깐 호가(spot_orders)를 가격-시간 우선순위로
// walking 하며 체결한다 — 있는 물량만, 실제 호가 가격에, 최우선호가보다 유리하게는 절대 안 체결.
// 못 채운 잔량은 지정가면 호가창에 남아 대기(다음 유동성에 매칭), 시장가면 버린다. 봇은 무한
// 유동성 풀이라 체결 시 상대(봇) 잔고를 따로 정산하지 않는다(봇 잔고는 어디서도 읽히지 않음).

// 체결분을 유저 OX 레버리지 포지션에 반영하는 문장(positions 테이블만). 물타기면 병합.
function oxPositionStmts(
  env: Env,
  existing: PositionRow | null,
  uid: string,
  side: string,
  price: number,
  size: number,
  effLev: number,
  margin: number,
  sl: number | null,
  tp: number | null,
  now: number,
): D1PreparedStatement[] {
  if (existing) {
    const newSize = existing.size + size;
    const newEntry = (existing.entry_price * existing.size + price * size) / newSize;
    const finalSl = sl != null ? sl : existing.stop_loss;
    const finalTp = tp != null ? tp : existing.take_profit;
    return [
      env.DB.prepare(
        'UPDATE positions SET entry_price=?, size=?, margin=?, stop_loss=?, take_profit=? WHERE id=? AND user_id=?',
      ).bind(newEntry, newSize, existing.margin + margin, finalSl, finalTp, existing.id, uid),
    ];
  }
  return [
    env.DB.prepare(
      'INSERT INTO positions (id,user_id,symbol,side,entry_price,size,leverage,margin,opened_at,stop_loss,take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, PAIR, side, price, size, effLev, margin, now, sl, tp),
  ];
}

// 체결 테이프 기록 + 기준가(ref)를 체결가로 갱신.
function spotTradeStmts(
  env: Env,
  buyerId: string,
  sellerId: string,
  price: number,
  size: number,
  takerSide: 'buy' | 'sell',
  now: number,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      'INSERT INTO spot_trades (id,pair,buyer_id,seller_id,price,size,taker_side,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), PAIR, buyerId, sellerId, price, size, takerSide, now),
    env.DB.prepare(
      'INSERT INTO spot_bot_state (id,last_run,ref_price) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ref_price=excluded.ref_price',
    ).bind(PAIR, now, price),
  ];
}

// 반대편 봇 호가 중 최우선(가격-시간 우선) 하나. limitPrice 가 있으면 그 가격까지만 크로스.
async function bestBotMaker(env: Env, takerSide: string, limitPrice: number | null): Promise<SpotOrderRow | null> {
  const makerSide = takerSide === 'long' ? 'sell' : 'buy';
  const ordDir = takerSide === 'long' ? 'ASC' : 'DESC';
  if (limitPrice == null) {
    return env.DB.prepare(
      `SELECT * FROM spot_orders WHERE pair=? AND side=? AND status='open' ORDER BY price ${ordDir}, created_at ASC LIMIT 1`,
    ).bind(PAIR, makerSide).first<SpotOrderRow>();
  }
  const cmp = takerSide === 'long' ? 'price<=?' : 'price>=?';
  return env.DB.prepare(
    `SELECT * FROM spot_orders WHERE pair=? AND side=? AND status='open' AND ${cmp} ORDER BY price ${ordDir}, created_at ASC LIMIT 1`,
  ).bind(PAIR, makerSide, limitPrice).first<SpotOrderRow>();
}

/**
 * 유저 지정가(pending_orders) 하나를 봇 호가창에 walking 매칭한다(신규 제출·대기 중 공용).
 * 증거금은 생성 시 limit_price 로 잠갔으므로 실제 체결가(더 유리)와의 차액을 환불(매수)하거나
 * 드물게 소량 추가징수(현재가 아래 매도 등, 잔고 부족 시 limit 가로 폴백)한다. 못 채운 잔량은
 * pending 에 그대로 남아 대기 → 다음 유동성/틱에서 이어서 체결(runMarketMaker·checkTriggers 가 호출).
 */
export async function matchLimitPendingAgainstBook(env: Env, pendingId: string): Promise<void> {
  const first = await env.DB.prepare('SELECT * FROM pending_orders WHERE id=?').bind(pendingId).first<PendingRow>();
  if (!first || first.symbol !== PAIR) return;
  const isLong = first.side === 'long';
  const existing0 = await env.DB.prepare('SELECT leverage FROM positions WHERE user_id=? AND symbol=? AND side=?')
    .bind(first.user_id, PAIR, first.side)
    .first<{ leverage: number }>();
  const effLev = existing0 ? existing0.leverage : first.leverage;
  let filled = 0;
  let cost = 0;

  for (let i = 0; i < 500; i++) {
    // iter 0 은 위에서 이미 읽은 first 를 재사용(중복 read 제거), 이후엔 동시 체결 반영 위해 재조회.
    const p = i === 0 ? first : await env.DB.prepare('SELECT * FROM pending_orders WHERE id=?').bind(pendingId).first<PendingRow>();
    if (!p) break;
    if (p.size <= EPS) {
      await env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId).run();
      break;
    }
    const maker = await bestBotMaker(env, p.side, p.limit_price);
    if (!maker) break; // 크로스되는 봇 호가 없음 → 잔량 대기

    const chunk = Math.min(p.size, maker.size);
    // 봇 maker 원자적 선점(동시 매칭 이중소비 방지)
    const makerRem = maker.size - chunk;
    const claim = await env.DB.prepare("UPDATE spot_orders SET size=?, status=? WHERE id=? AND status='open' AND size>=?")
      .bind(makerRem, makerRem <= EPS ? 'filled' : 'open', maker.id, chunk - EPS)
      .run();
    if (claim.meta.changes !== 1) continue; // 다른 경로가 먼저 가져감 → 재시도

    const existing = await env.DB.prepare('SELECT * FROM positions WHERE user_id=? AND symbol=? AND side=?')
      .bind(p.user_id, PAIR, p.side)
      .first<PositionRow>();

    const lockedForChunk = (p.limit_price * chunk) / p.leverage;
    let fillPrice = maker.price;
    let posMargin = (fillPrice * chunk) / effLev;
    let refund = lockedForChunk - posMargin; // 매수는 ≥0(체결가≤지정가) 환불 / 드물게 <0 이면 추가 필요
    if (refund < -EPS) {
      const extra = -refund;
      const charged = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?')
        .bind(extra, p.user_id, extra)
        .run();
      if (charged.meta.changes !== 1) {
        // 추가 증거금 감당 불가 → 지정가로 체결(정확히 잠근 만큼, 항상 감당 가능)
        fillPrice = p.limit_price;
        posMargin = lockedForChunk;
      }
      refund = 0;
    }

    const newPendingSize = p.size - chunk;
    const newPendingMargin = Math.max(0, p.margin - lockedForChunk);
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [
      newPendingSize <= EPS
        ? env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId)
        : env.DB.prepare('UPDATE pending_orders SET size=?, margin=? WHERE id=?').bind(newPendingSize, newPendingMargin, pendingId),
      ...oxPositionStmts(env, existing, p.user_id, p.side, fillPrice, chunk, effLev, posMargin, p.stop_loss, p.take_profit, now),
      ...spotTradeStmts(
        env,
        isLong ? p.user_id : maker.user_id,
        isLong ? maker.user_id : p.user_id,
        fillPrice,
        chunk,
        isLong ? 'buy' : 'sell',
        now,
      ),
    ];
    if (refund > EPS) stmts.push(env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(refund, p.user_id));
    await env.DB.batch(stmts);
    filled += chunk;
    cost += fillPrice * chunk;
  }

  if (filled > EPS) {
    // 체결 이력(주문내역)엔 이번 호출의 총 체결을 가중평균가로 1건 기록(칸별로 쪼개면 내역이 넘침).
    await env.DB.prepare(
      'INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), first.user_id, PAIR, first.side, cost / filled, filled, effLev, 'open', null, Date.now()).run();
  }
}

/**
 * OX 시장가 주문 — 봇 호가창을 가격 제한 없이 walking 하며 있는 만큼만 체결(잔량은 버림).
 * 증거금은 체결분마다 실제 체결가 기준으로 조건부 차감(잔고 부족하면 감당 가능한 만큼만). 체결 총량 반환.
 */
export async function matchMarketOxOrder(
  env: Env,
  uid: string,
  side: string,
  size: number,
  leverage: number,
  sl: number | null,
  tp: number | null,
  floorPnL = 0, // 크로스 가용 = 여유잔고 + floorPnL(전 포지션 미실현손익). balance 는 -floorPnL 까지 허용.
): Promise<{ filled: number; avgPrice: number }> {
  const isLong = side === 'long';
  const existing0 = await env.DB.prepare('SELECT leverage FROM positions WHERE user_id=? AND symbol=? AND side=?')
    .bind(uid, PAIR, side)
    .first<{ leverage: number }>();
  const effLev = existing0 ? existing0.leverage : leverage;
  let remaining = size;
  let filled = 0;
  let cost = 0;

  for (let i = 0; i < 500 && remaining > EPS; i++) {
    const maker = await bestBotMaker(env, side, null);
    if (!maker) break; // 유동성 소진

    let chunk = Math.min(remaining, maker.size);
    const price = maker.price;
    let margin = (price * chunk) / effLev;
    // 크로스: balance - margin >= -floorPnL (⟺ available >= margin). floorPnL>0(이익)이면 balance 가
    // 음수까지 허용돼 미실현이익만큼 더 살 수 있고, floorPnL<0(손실)이면 가용이 줄어 덜 산다.
    let deduct = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance-? >= ?')
      .bind(margin, uid, margin, -floorPnL)
      .run();
    if (deduct.meta.changes !== 1) {
      // 전량 감당 불가 → 가용(여유잔고+미실현이익)으로 살 수 있는 만큼만
      const u = await env.DB.prepare('SELECT balance FROM users WHERE id=?').bind(uid).first<{ balance: number }>();
      const affordable = (((u?.balance ?? 0) + floorPnL) * effLev) / price;
      if (affordable <= EPS) break;
      chunk = Math.min(chunk, affordable);
      margin = (price * chunk) / effLev;
      deduct = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance-? >= ?')
        .bind(margin, uid, margin, -floorPnL)
        .run();
      if (deduct.meta.changes !== 1) break;
    }

    const makerRem = maker.size - chunk;
    const claim = await env.DB.prepare("UPDATE spot_orders SET size=?, status=? WHERE id=? AND status='open' AND size>=?")
      .bind(makerRem, makerRem <= EPS ? 'filled' : 'open', maker.id, chunk - EPS)
      .run();
    if (claim.meta.changes !== 1) {
      await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(margin, uid).run(); // 선점 실패 → 차감 환불
      continue;
    }

    const existing = await env.DB.prepare('SELECT * FROM positions WHERE user_id=? AND symbol=? AND side=?')
      .bind(uid, PAIR, side)
      .first<PositionRow>();
    const now = Date.now();
    await env.DB.batch([
      ...oxPositionStmts(env, existing, uid, side, price, chunk, effLev, margin, sl, tp, now),
      ...spotTradeStmts(env, isLong ? uid : maker.user_id, isLong ? maker.user_id : uid, price, chunk, isLong ? 'buy' : 'sell', now),
    ]);
    remaining -= chunk;
    filled += chunk;
    cost += price * chunk;
  }

  if (filled > EPS) {
    await env.DB.prepare(
      'INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, PAIR, side, cost / filled, filled, effLev, 'open', null, Date.now()).run();
  }
  return { filled, avgPrice: filled > EPS ? cost / filled : 0 };
}

/** 대기 중인 전 유저의 OX 지정가를 봇 호가창에 매칭 — runMarketMaker 가 재호가 직후 호출하므로,
 * 주문 낸 유저가 접속/폴링 중이 아니어도 유동성이 크로스되면 실제 호가 가격에 이어서 체결된다. */
async function sweepRestingOxPendings(env: Env): Promise<void> {
  const pendings = (
    await env.DB.prepare('SELECT id FROM pending_orders WHERE symbol=?').bind(PAIR).all<{ id: string }>()
  ).results;
  for (const p of pendings) {
    try {
      await matchLimitPendingAgainstBook(env, p.id);
    } catch {
      /* 한 건 실패해도 나머지는 계속 — 다음 틱에서 재시도 */
    }
  }
}
