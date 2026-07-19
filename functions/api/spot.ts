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

// ── 영속 캔들(차트 히스토리 영구 보존) ────────────────────────────────
// ⚠ 예전엔 캔들을 매 요청마다 "최신 spot_trades 5000건"을 버킷팅해서 만들었다 — 총 거래가 5000건을
// 넘으면 오래된 거래가 읽기 창 밖으로 밀려나 옛 캔들이 통째로 사라지고(특히 큰 인터벌은 몇 봉밖에
// 안 남음), "시간이 지나면 차트 데이터가 지워지는" 문제가 있었다. 이제 모든 체결(봇 합성체결·유저
// 매칭체결·recordVirtualFill)이 candleUpsertStmts 로 인터벌별 집계 캔들을 spot_candles 에 누적 upsert 하고,
// 차트는 그 테이블에서 읽는다 → 거래가 아무리 쌓여도 히스토리가 영구 보존되고, 읽기도 인터벌+버킷
// 인덱스로 필요한 만큼만 가져와 가볍다. 1s(및 <60s)만 예외로 영속화하지 않고(단기 조회 전용, 영속
// 저장은 낭비) 최신 거래 버킷팅으로 처리한다.
const CANDLE_INTERVALS: readonly [string, number][] = [
  ['1m', 60], ['3m', 180], ['5m', 300], ['15m', 900], ['30m', 1800],
  ['1h', 3600], ['2h', 7200], ['4h', 14400], ['6h', 21600], ['8h', 28800], ['12h', 43200],
  ['1d', 86400], ['3d', 259200], ['1w', 604800], ['1M', 2592000],
];

/** 한 체결(price,size,now)을 모든 영속 인터벌의 캔들에 반영하는 upsert 문장들.
 * 버킷이 없으면 새로 만들고(open=high=low=close=price), 있으면 high/low/close/volume 만 갱신(open 유지).
 * 모든 spot_trades INSERT 경로가 이 문장들을 같은 batch 에 함께 넣어 차트 히스토리를 영구 보존한다. */
function candleUpsertStmts(env: Env, price: number, size: number, now: number): D1PreparedStatement[] {
  return CANDLE_INTERVALS.map(([code, sec]) => {
    const bucket = Math.floor(now / (sec * 1000)) * (sec * 1000);
    return env.DB.prepare(
      `INSERT INTO spot_candles (pair, interval, bucket, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(pair, interval, bucket) DO UPDATE SET
         high = MAX(spot_candles.high, excluded.high),
         low = MIN(spot_candles.low, excluded.low),
         close = excluded.close,
         volume = spot_candles.volume + excluded.volume`,
    ).bind(PAIR, code, bucket, price, price, price, price, size);
  });
}

/** 최신 spot_trades 를 interval 버킷으로 묶어 OHLCV 를 만든다(1s 등 단기 인터벌 + 영속 캔들 폴백 전용).
 * ⚠ 반드시 "가장 최신" 5000건(DESC 로 뽑아 ASC 재정렬) — ASC LIMIT 이면 총 거래가 5000건을 넘는 순간
 * 새 거래가 창 밖으로 밀려 차트 마지막 봉이 멈춘다. */
async function bucketTradesToCandles(env: Env, bucketMs: number, limit: number) {
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

/** OX 캔들 로드. 1m 이상은 영속 테이블(spot_candles)에서 읽어 히스토리가 시간이 지나도 사라지지 않게
 * 한다. 1s(및 <60s)는 단기 조회라 최신 거래 버킷팅. 영속 테이블이 아직 빈 인터벌(신규 배포 직후,
 * 거래가 아직 안 쌓인 상태)은 거래 버킷팅으로 폴백해 차트가 비지 않게 한다. */
async function loadSpotCandles(env: Env, intervalCode: string, limit: number) {
  const sec = intervalSecFromCode(intervalCode);
  const bucketMs = sec * 1000;
  if (sec < 60) return bucketTradesToCandles(env, bucketMs, limit);

  const rows = (
    await env.DB.prepare(
      'SELECT bucket, open, high, low, close, volume FROM spot_candles WHERE pair = ? AND interval = ? ORDER BY bucket DESC LIMIT ?',
    )
      .bind(PAIR, intervalCode, limit)
      .all<{ bucket: number; open: number; high: number; low: number; close: number; volume: number }>()
  ).results;
  if (rows.length === 0) return bucketTradesToCandles(env, bucketMs, limit);

  return rows
    .reverse()
    .map((r) => ({ time: Math.floor(r.bucket / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
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
// 재호가(requote) 주기 — 짧을수록 기준가·호가·체결 테이프가 자주 갱신되고, 크로스되는 유저 주문이
// 그만큼 빨리 체결된다(sweepRestingOxPendings 가 매 재호가 직후 도므로). 체결 딜레이를 줄이려고
// 예전(3~8s)보다 크게 낮췄다 — runMarketMaker 는 /api/spot 폴링 시점에만 불리므로 실질 주기는
// max(게이트, 폴링간격)이고, 프론트 폴링도 함께 1.5s 로 낮춰 유저가 OX 를 볼 때 ~1~2s 마다 갱신된다.
const BOT_TICK_MIN_MS = 900;
const BOT_TICK_MAX_MS = 2200;
const BOT_LEVELS_PER_SIDE = 8; // 한 틱에 까는 매수/매도 각각의 호가 단계 수(호가창 깊이)

// 봇 패시브 호가 1개를 INSERT 하는 문장(에스크로 없음).
function botQuoteStmt(env: Env, actor: string, side: 'buy' | 'sell', price: number, size: number, now: number): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO spot_orders (id, user_id, pair, side, price, size, orig_size, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(crypto.randomUUID(), actor, PAIR, side, price, size, size, 'open', now);
}

// ⚠ 한 틱에 찍는 합성 체결의 개수·크기 — 예전엔 5~45 짜리 1건이라 캔들 거래량이 수백에 그쳤다("봇이
// 쫄보"). 실제 시장처럼 보이도록 매 틱 여러 건을 큰 물량으로 찍는다(테이프도 붐비고 거래량도 유의미).
const BOT_TRADES_PER_TICK_MIN = 3;
const BOT_TRADES_PER_TICK_MAX = 6;
const BOT_TRADE_SIZE_MIN = 1000;
const BOT_TRADE_SIZE_MAX = 8000;
const BOT_BURST_TICKS = 12; // cron 이 접속 유무와 무관하게 한 번에 몰아 돌리는 틱 수(시장이 계속 살아있게)

/**
 * 마켓메이커 한 틱(requote): 봇 호가를 새로 깔고, 큰 합성 체결을 여러 건 찍어 테이프/거래량을 만들고,
 * 유저 지정가 "벽"을 존중(클램프+소비)하고, 대기 중 유저 지정가를 walking 매칭한다. prevRef 기준으로
 * 랜덤워크한 새 ref 를 반환. now 는 이 틱의 기준 시각(cron 버스트는 조금씩 다른 값을 넘겨 캔들이 최근
 * 시간대에 자연스럽게 퍼지게 한다). ref_price 는 갱신하지만 last_run 은 건드리지 않는다(게이트는 호출자 담당).
 */
async function marketMakerTick(env: Env, prevRef: number, now: number): Promise<number> {
  const candidateRef = roundOx(Math.max(0.01, prevRef * (1 + (Math.random() - 0.5) * 0.012))); // ±0.6% 랜덤워크(4자리 틱 스냅)
  const actor = BOT_USER_IDS[Math.floor(Math.random() * BOT_USER_IDS.length)];

  // ⚠ 유저가 걸어둔 지정가 "벽"을 존중한다(가짜 high 버그 수정). 랜덤워크 기준가가 유저의 최우선 매도벽
  // 위로 올라가거나 최우선 매수벽 아래로 내려가면, 실제 시장이라면 그 벽을 먼저 소비해야 하므로 기준가·
  // 합성체결을 벽 너머에 찍으면 안 된다. → 기준가를 [최우선 매수벽, 최우선 매도벽] 안으로 클램프하고,
  // 벽에 눌리면(press) 그 벽 가격에 봇 호가를 하나 놓아 아래 sweep 이 벽을 실제 체결로 조금씩 소비하게 한다.
  const walls = await env.DB.prepare(
    "SELECT MIN(CASE WHEN side='short' THEN limit_price END) AS ask, MAX(CASE WHEN side='long' THEN limit_price END) AS bid FROM pending_orders WHERE symbol=?",
  )
    .bind(PAIR)
    .first<{ ask: number | null; bid: number | null }>();
  const wallAsk = walls?.ask ?? null;
  const wallBid = walls?.bid ?? null;
  let ref = candidateRef;
  let press: 'up' | 'down' | null = null;
  if (wallAsk != null && ref > wallAsk) {
    ref = roundOx(wallAsk);
    press = 'up'; // 매도벽에 눌림 — 봇이 벽 가격에 매수호가를 놓아 벽을 소비
  } else if (wallBid != null && ref < wallBid) {
    ref = roundOx(wallBid);
    press = 'down'; // 매수벽에 눌림 — 봇이 벽 가격에 매도호가를 놓아 벽을 소비
  }

  const stmts: D1PreparedStatement[] = [
    // ⚠ 매 틱 이 페어의 봇 호가를 "전부"(두 봇 모두) 비우고 한 액터가 일관된 사다리를 새로 깐다(호가 역전 방지).
    // spot_orders 엔 봇 호가만 있으니(유저 주문은 pending_orders) pair 전체를 지워도 유저 주문엔 영향 없다.
    env.DB.prepare("UPDATE spot_orders SET status = 'cancelled' WHERE pair = ? AND status = 'open'").bind(PAIR),
  ];
  // 기준가 주변에 여러 단계로 유동성을 깐다. 스프레드는 타이트하게(최우선호가가 mid 에 바싹) 잡되 깊은
  // 레벨로 갈수록 벌어지며 대량 주문엔 슬리피지가 생긴다. 물량을 크게 깔아 유저 주문이 시원하게 체결되게 한다.
  for (let level = 0; level < BOT_LEVELS_PER_SIDE; level++) {
    const spread = 0.0012 + level * 0.0016 + Math.random() * 0.0008;
    const buySize = Number((2000 + Math.random() * 8000).toFixed(4));
    const sellSize = Number((2000 + Math.random() * 8000).toFixed(4));
    stmts.push(botQuoteStmt(env, actor, 'buy', roundOx(ref * (1 - spread)), buySize, now));
    stmts.push(botQuoteStmt(env, actor, 'sell', roundOx(ref * (1 + spread)), sellSize, now));
  }
  // 유저 벽에 눌렸으면(press) 그 벽 가격에 봇 호가를 하나 얹는다 — 아래 sweep 이 유저 벽을 그 가격에 소비.
  if (press === 'up') stmts.push(botQuoteStmt(env, actor, 'buy', ref, Number((2000 + Math.random() * 8000).toFixed(4)), now));
  else if (press === 'down') stmts.push(botQuoteStmt(env, actor, 'sell', ref, Number((2000 + Math.random() * 8000).toFixed(4)), now));

  // 합성 체결을 여러 건(버스트) 큰 물량으로 찍는다 — 예전 1건(5~45)이 거래량 ~300 밖에 안 되던 원인.
  // 체결가=ref, 방향은 ref 진행 방향으로 편향(70%)하되 섞어 테이프가 자연스럽게. 캔들은 총량으로 1회 upsert.
  const nTrades = BOT_TRADES_PER_TICK_MIN + Math.floor(Math.random() * (BOT_TRADES_PER_TICK_MAX - BOT_TRADES_PER_TICK_MIN + 1));
  const upBias = ref >= prevRef;
  let vol = 0;
  for (let i = 0; i < nTrades; i++) {
    const sz = Number((BOT_TRADE_SIZE_MIN + Math.random() * (BOT_TRADE_SIZE_MAX - BOT_TRADE_SIZE_MIN)).toFixed(4));
    vol += sz;
    const takerSide = Math.random() < 0.7 ? (upBias ? 'buy' : 'sell') : upBias ? 'sell' : 'buy';
    stmts.push(
      env.DB.prepare(
        'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), PAIR, actor, actor, ref, sz, takerSide, now + i),
    );
  }
  stmts.push(env.DB.prepare('UPDATE spot_bot_state SET ref_price = ? WHERE id = ?').bind(ref, PAIR));
  stmts.push(...candleUpsertStmts(env, ref, vol, now)); // 영속 캔들: 이 틱 버스트의 총 거래량으로 1회 갱신
  await env.DB.batch(stmts);

  // 방금 깐 유동성에 대기 중 유저 지정가를 walking 매칭(호가 역전/크로스 즉시 체결, 벽 소비 포함).
  await sweepRestingOxPendings(env);
  return ref;
}

/** 폴링(유저 접속) 시 호출 — 재호가 게이트를 통과할 때만 한 틱을 돈다. */
export async function runMarketMaker(env: Env): Promise<void> {
  const row = await env.DB.prepare('SELECT last_run, ref_price FROM spot_bot_state WHERE id = ?')
    .bind(PAIR)
    .first<{ last_run: number; ref_price: number }>();
  const now = Date.now();
  const last = row?.last_run ?? 0;

  const gate = BOT_TICK_MIN_MS + Math.random() * (BOT_TICK_MAX_MS - BOT_TICK_MIN_MS);
  if (now - last < gate) return; // 재호가 주기 전 — 아무것도 안 함(가장 흔한 경로: state read 1회뿐)

  // 재호가 틱을 원자적으로 선점(동시 폴링이 겹쳐도 이 틱은 한 번만 requote) — 조건부 upsert.
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
  await marketMakerTick(env, prevRef, now);
}

/**
 * cron 전용 — 접속자가 없어도 시장이 계속 살아있도록 한 번에 여러 틱을 몰아 돈다(게이트 무시).
 * cron 이 1분마다 부르므로 그 사이의 거래량·가격 움직임을 여기서 만든다(예전엔 5분마다 1틱뿐이라
 * 아무도 안 볼 때 차트가 사실상 멈춰 있었다). 각 틱의 체결 시각을 최근 구간에 조금씩 퍼뜨려 캔들이
 * 한 봉에만 뭉치지 않게 한다. 마지막에 last_run 을 갱신해 직후 폴링이 곧바로 겹쳐 requote 하지 않게 함.
 */
export async function runMarketMakerBurst(env: Env, ticks: number = BOT_BURST_TICKS, spanMs: number = 55000): Promise<void> {
  const row = await env.DB.prepare('SELECT ref_price FROM spot_bot_state WHERE id = ?').bind(PAIR).first<{ ref_price: number }>();
  let ref = row?.ref_price ?? 0;
  if (!ref) {
    const lastTrade = await env.DB.prepare('SELECT price FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 1')
      .bind(PAIR)
      .first<{ price: number }>();
    ref = lastTrade?.price ?? 1;
  }
  const base = Date.now();
  for (let i = 0; i < ticks; i++) {
    // 체결 시각을 [base-spanMs, base] 에 고르게 퍼뜨려 최근 캔들들을 채운다(빈 봉 방지).
    const ts = base - spanMs + Math.floor(((i + 1) / ticks) * spanMs);
    ref = await marketMakerTick(env, ref, ts);
  }
  await env.DB.prepare(
    'INSERT INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_run = excluded.last_run, ref_price = excluded.ref_price',
  )
    .bind(PAIR, Date.now(), ref)
    .run();
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
    ...candleUpsertStmts(env, price, size, now), // 영속 캔들 갱신
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
    ...candleUpsertStmts(env, price, size, now), // 유저 매칭체결도 영속 캔들에 반영
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

/**
 * OX 포지션을 봇 호가창에 walking 매칭해 청산한다(시장가 청산·지정가 청산 공용의 핵심).
 * ⚠ 예전엔 OX 청산이 호가창을 무시하고 `fetchPrice`(ref) 한 값에 **전량** 정산돼, 매물이 없어도(호가창이
 * 얇아도) 전 물량이 즉시 청산되는 버그가 있었다. 이제 진입(matchMarketOxOrder)과 대칭으로 **있는 물량만**
 * 실제 호가 가격에 청산하고, 매물이 부족하면 그만큼만(부분) 청산하고 나머지는 포지션에 남긴다.
 * - limitPrice=null : 시장가 청산(가격 제한 없이 walking).
 * - limitPrice!=null: 지정가 청산(그 가격보다 불리하게는 체결 안 함 — 롱 청산은 ≥limit 매수호가만 소비).
 * - pendingId!=null : 지정가 청산의 대기 주문(pending_orders) — 체결분만큼 줄이거나(부분) 삭제(완료).
 * PnL·증거금 환급은 실제 체결가(가중평균) 기준으로 청크마다 정산한다. 반환: { filled, avgPrice }.
 */
async function closePositionAgainstBook(
  env: Env,
  uid: string,
  pos: PositionRow,
  closeSize: number,
  limitPrice: number | null,
  pendingId: string | null,
  pendingSize: number,
): Promise<{ filled: number; avgPrice: number }> {
  const closeTaker = pos.side === 'long' ? 'short' : 'long'; // 청산 방향(롱 청산=매도=short, 봇 매수호가 소비)
  const tapeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy'; // 체결내역 taker 방향(롱 청산=매도)
  const dir = pos.side === 'long' ? 1 : -1;
  const marginPerUnit = pos.size > EPS ? pos.margin / pos.size : 0;
  let remaining = Math.min(closeSize, pos.size);
  let filled = 0;
  let cost = 0;
  let pnlTotal = 0;

  for (let i = 0; i < 500 && remaining > EPS; i++) {
    const maker = await bestBotMaker(env, closeTaker, limitPrice);
    if (!maker) break; // 크로스되는 호가 없음 → 남은 수량은 미청산(시장가면 버려지고, 지정가면 pending 에 대기)

    const chunk = Math.min(remaining, maker.size);
    const makerRem = maker.size - chunk;
    const claim = await env.DB.prepare("UPDATE spot_orders SET size=?, status=? WHERE id=? AND status='open' AND size>=?")
      .bind(makerRem, makerRem <= EPS ? 'filled' : 'open', maker.id, chunk - EPS)
      .run();
    if (claim.meta.changes !== 1) continue; // 다른 경로가 먼저 선점 → 재시도

    const fillPrice = maker.price;
    const chunkPnl = (fillPrice - pos.entry_price) * chunk * dir;
    const chunkMargin = marginPerUnit * chunk;
    const newFilled = filled + chunk;
    const fullyClosed = newFilled >= pos.size - EPS;
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(chunkMargin + chunkPnl, uid),
      fullyClosed
        ? env.DB.prepare('DELETE FROM positions WHERE id=? AND user_id=?').bind(pos.id, uid)
        : env.DB.prepare('UPDATE positions SET size=?, margin=? WHERE id=? AND user_id=?')
            .bind(pos.size - newFilled, pos.margin - marginPerUnit * newFilled, pos.id, uid),
      ...spotTradeStmts(
        env,
        tapeSide === 'buy' ? uid : maker.user_id,
        tapeSide === 'buy' ? maker.user_id : uid,
        fillPrice,
        chunk,
        tapeSide,
        now,
      ),
    ]);
    filled = newFilled;
    remaining -= chunk;
    cost += fillPrice * chunk;
    pnlTotal += chunkPnl;
    if (fullyClosed) break;
  }

  if (filled > EPS) {
    if (pendingId) {
      if (filled >= pendingSize - EPS)
        await env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId).run();
      else await env.DB.prepare('UPDATE pending_orders SET size=? WHERE id=?').bind(pendingSize - filled, pendingId).run();
    }
    // 청산 체결 이력 1건(가중평균가·총 실현손익). side 는 포지션 방향(기존 close 기록과 동일 규약).
    await env.DB.prepare(
      'INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, PAIR, pos.side, cost / filled, filled, pos.leverage, 'close', pnlTotal, Date.now()).run();
  }
  return { filled, avgPrice: filled > EPS ? cost / filled : 0 };
}

/** OX 시장가 청산 — 봇 호가창을 walking 하며 있는 물량만큼만 청산(매물 없으면 부분). order.ts close 액션이 호출. */
export function marketCloseOxPosition(env: Env, uid: string, pos: PositionRow, closeSize: number) {
  return closePositionAgainstBook(env, uid, pos, closeSize, null, null, 0);
}

/** OX 지정가 청산(reduce-only) 대기 주문 하나를 봇 호가창에 매칭한다(제출 직후·재호가 sweep·checkTriggers 공용).
 * 청산 대상 포지션이 이미 없으면(전량청산·강제청산됨) 고아 pending 을 정리한다. */
export async function matchReduceOnlyOxPending(env: Env, pendingId: string): Promise<void> {
  const p = await env.DB.prepare('SELECT * FROM pending_orders WHERE id=?').bind(pendingId).first<PendingRow>();
  if (!p || p.symbol !== PAIR || !p.reduce_only) return;
  const posSide = p.side === 'short' ? 'long' : 'short'; // 청산 대상 포지션 방향(주문 side 의 반대)
  const pos = await env.DB.prepare('SELECT * FROM positions WHERE user_id=? AND symbol=? AND side=?')
    .bind(p.user_id, PAIR, posSide)
    .first<PositionRow>();
  if (!pos) {
    await env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId).run(); // 청산할 포지션 없음 → 정리
    return;
  }
  await closePositionAgainstBook(env, p.user_id, pos, Math.min(p.size, pos.size), p.limit_price, pendingId, p.size);
}

/** 대기 중인 전 유저의 OX 지정가(진입·청산)를 봇 호가창에 매칭 — runMarketMaker 가 재호가 직후 호출하므로,
 * 주문 낸 유저가 접속/폴링 중이 아니어도 유동성이 크로스되면 실제 호가 가격에 이어서 체결된다. */
async function sweepRestingOxPendings(env: Env): Promise<void> {
  const pendings = (
    await env.DB.prepare('SELECT id, reduce_only FROM pending_orders WHERE symbol=?')
      .bind(PAIR)
      .all<{ id: string; reduce_only: number }>()
  ).results;
  for (const p of pendings) {
    try {
      if (p.reduce_only) await matchReduceOnlyOxPending(env, p.id);
      else await matchLimitPendingAgainstBook(env, p.id);
    } catch {
      /* 한 건 실패해도 나머지는 계속 — 다음 틱에서 재시도 */
    }
  }
}
