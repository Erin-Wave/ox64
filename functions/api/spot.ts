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
  feeRateOf,
  feeAccrualStmts,
  vipOf,
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
// 호가창에 내려보내는 가격대 수. ⚠ 클라(OrderBook BOOK_DEPTH)가 이보다 많이 그리려 하면 그만큼은
// 빈 채로 남는다 — 표시 개수를 바꿀 땐 두 값을 같이 맞출 것.
const BOOK_LIMIT = 40;
const roundOx = (p: number) => Number((Math.round(p * 1e4) / 1e4).toFixed(4));

export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);
    try {
      await runMarketMaker(env);
    } catch (e) {
      // 봇 실패가 유저 요청을 막으면 안 되지만(다음 폴링에서 재시도), ⚠ 조용히 삼키면 봇이 몇 시간째
      // 죽어 있어도 아무도 모른다 — 실제로 배치 문장 수 초과로 호가가 안 깔리는데 화면상 멀쩡해 보여
      // 원인을 찾는 데 한참 걸렸다. 최소한 로그는 남긴다(wrangler tail / 대시보드에서 확인 가능).
      console.error('[ox64] runMarketMaker failed:', e instanceof Error ? e.message : e);
    }

    const url = new URL(request.url);
    if (url.searchParams.get('candles')) {
      const interval = url.searchParams.get('interval') || '1m';
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
      const endTime = Number(url.searchParams.get('endTime')) || undefined;
      return json({ candles: await loadSpotCandles(env, interval, limit, endTime) });
    }

    return json(await loadSpotMarket(env, sess.uid));
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

/** 한 묶음의 체결(OHLCV)을 모든 영속 인터벌의 캔들에 반영하는 upsert 문장들.
 * 버킷이 없으면 새로 만들고(open 은 이때만 기록), 있으면 high/low/close/volume 만 갱신(open 유지).
 * 모든 spot_trades INSERT 경로가 이 문장들을 같은 batch 에 함께 넣어 차트 히스토리를 영구 보존한다.
 * ⚠ 여기 넘기는 값은 반드시 같은 batch 에 INSERT 하는 spot_trades 들과 일치해야 한다 — 어긋나면
 * 캔들과 체결내역이 서로 다른 시장을 보여주게 된다(마켓메이커 한 틱은 여러 건을 찍으므로 그 묶음의
 * OHLC 를 그대로 넘긴다). now 가 과거면 이미 마감된 봉이 변조되므로 항상 현재 이후 시각일 것. */
function candleUpsertStmts(
  env: Env,
  bar: { open: number; high: number; low: number; close: number; volume: number },
  now: number,
): D1PreparedStatement[] {
  return CANDLE_INTERVALS.map(([code, sec]) => {
    const bucket = Math.floor(now / (sec * 1000)) * (sec * 1000);
    return env.DB.prepare(
      `INSERT INTO spot_candles (pair, interval, bucket, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(pair, interval, bucket) DO UPDATE SET
         high = MAX(spot_candles.high, excluded.high),
         low = MIN(spot_candles.low, excluded.low),
         close = excluded.close,
         volume = spot_candles.volume + excluded.volume`,
    ).bind(PAIR, code, bucket, bar.open, bar.high, bar.low, bar.close, bar.volume);
  });
}

/** 단일 가격 체결용 단축(진입/청산 등 개별 체결 — OHLC 가 전부 같은 가격). */
function candleUpsertOne(env: Env, price: number, size: number, now: number): D1PreparedStatement[] {
  return candleUpsertStmts(env, { open: price, high: price, low: price, close: price, volume: size }, now);
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
async function loadSpotCandles(env: Env, intervalCode: string, limit: number, endTimeMs?: number) {
  const sec = intervalSecFromCode(intervalCode);
  const bucketMs = sec * 1000;
  // ⚠ 1s 등 <60s 는 영속 테이블이 없어(최신 거래 버킷팅) 과거 페이지가 존재하지 않는다 —
  // endTime 이 오면 빈 배열을 돌려줘서 클라가 "더 없음"으로 확정하게 한다(무한 재시도 방지).
  if (sec < 60) return endTimeMs ? [] : bucketTradesToCandles(env, bucketMs, limit);

  // endTimeMs 가 오면 그 시각 "이전" 봉만 — 차트에서 왼쪽으로 스크롤할 때 과거 구간을 이어 받는다.
  const rows = (
    await env.DB.prepare(
      endTimeMs
        ? 'SELECT bucket, open, high, low, close, volume FROM spot_candles WHERE pair = ? AND interval = ? AND bucket < ? ORDER BY bucket DESC LIMIT ?'
        : 'SELECT bucket, open, high, low, close, volume FROM spot_candles WHERE pair = ? AND interval = ? ORDER BY bucket DESC LIMIT ?',
    )
      .bind(...(endTimeMs ? [PAIR, intervalCode, endTimeMs, limit] : [PAIR, intervalCode, limit]))
      .all<{ bucket: number; open: number; high: number; low: number; close: number; volume: number }>()
  ).results;
  // 과거 페이지 요청인데 결과가 없으면 진짜로 더 없는 것 — 거래 버킷팅 폴백으로 최신 구간을
  // 돌려주면 클라가 "받았다"고 착각해 같은 구간을 무한히 다시 붙인다.
  if (rows.length === 0) return endTimeMs ? [] : bucketTradesToCandles(env, bucketMs, limit);

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
async function loadSpotMarket(env: Env, uid: string) {
  // `mine` = 그 가격대에 이 유저가 걸어둔 물량. 호가창에서 내 주문을 티나게 표시하려면 합계만으론
  // 알 수 없어서(봇 물량과 섞임) 유저 소유분을 따로 합산해 내려준다.
  const bids = (
    await env.DB.prepare(
      `SELECT price, SUM(size) AS size, SUM(mine) AS mine FROM (
         SELECT price, size, 0 AS mine FROM spot_orders WHERE pair = ? AND side = 'buy' AND status = 'open'
         UNION ALL
         SELECT limit_price AS price, size, CASE WHEN user_id = ? THEN size ELSE 0 END AS mine
           FROM pending_orders WHERE symbol = ? AND side = 'long'
       ) GROUP BY price ORDER BY price DESC LIMIT ${BOOK_LIMIT}`,
    )
      .bind(PAIR, uid, PAIR)
      .all<{ price: number; size: number; mine: number }>()
  ).results;
  const asks = (
    await env.DB.prepare(
      `SELECT price, SUM(size) AS size, SUM(mine) AS mine FROM (
         SELECT price, size, 0 AS mine FROM spot_orders WHERE pair = ? AND side = 'sell' AND status = 'open'
         UNION ALL
         SELECT limit_price AS price, size, CASE WHEN user_id = ? THEN size ELSE 0 END AS mine
           FROM pending_orders WHERE symbol = ? AND side = 'short'
       ) GROUP BY price ORDER BY price ASC LIMIT ${BOOK_LIMIT}`,
    )
      .bind(PAIR, uid, PAIR)
      .all<{ price: number; size: number; mine: number }>()
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
// 한 틱에 까는 매수/매도 각각의 호가 단계 수(호가창 깊이).
// ⚠ 봇 계정이 2개뿐이라 "여러 사람이 만든 시장"처럼 보이려면 계정 수가 아니라 **한 봇이 촘촘하게
// 여러 개를 까는 것**으로 밀도를 만들어야 한다(계정을 늘려도 spot_orders 행이 늘 뿐 화면상 차이는
// 같다 — 호가창은 가격대별 합계만 보여주므로). 8단계는 스프레드 근처 몇 줄만 차서 휑했다.
const BOT_LEVELS_PER_SIDE = 22;

// 봇 패시브 호가 1개를 INSERT 하는 문장(에스크로 없음).
function botQuoteStmt(env: Env, actor: string, side: 'buy' | 'sell', price: number, size: number, now: number): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO spot_orders (id, user_id, pair, side, price, size, orig_size, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(crypto.randomUUID(), actor, PAIR, side, price, size, size, 'open', now);
}

// ⚠ 한 틱에 찍는 합성 체결의 개수·크기 — 예전엔 5~45 짜리 1건이라 캔들 거래량이 수백에 그쳤다("봇이
// 쫄보"). 실제 시장처럼 보이도록 매 틱 여러 건을 큰 물량으로 찍는다(테이프도 붐비고 거래량도 유의미).
// 아래 심리 모델이 국면·변동성에 따라 이 값에 배수를 걸어 "패닉엔 거래량 폭증, 잔잔할 땐 한산"을 만든다.
const BOT_TRADES_PER_TICK_MIN = 3;
const BOT_TRADES_PER_TICK_MAX = 6;
const BOT_TRADE_SIZE_MIN = 1000;
const BOT_TRADE_SIZE_MAX = 8000;
const BOT_BURST_TICKS = 12; // cron 이 접속 유무와 무관하게 한 번에 몰아 돌리는 틱 수(시장이 계속 살아있게)

// ── 봇 매매 심리 모델 ─────────────────────────────────────────────────────
// ⚠ 예전 기준가는 `ref * (1 + (rand-0.5)*0.012)` 짜리 **IID 랜덤워크** 하나였다 — 추세도, 변동성 뭉침도,
// 과열도 공포도 없는 무특징 노이즈. 매 틱이 직전과 완전히 독립이라 차트에 읽을 구조가 아예 없었고
// ("사람 심리가 안 들어간 매매라 노잼"), 어떤 분석도 무의미했다. 지금은 실제 시장에서 관찰되는 정형화된
// 사실(stylized facts)을 작은 상태기계로 재현한다 — 상태는 spot_bot_state 행에 얹어 틱 사이에 지속된다:
//   1. 추세 지속(momentum)   — 수익률이 AR(1) 자기상관 → 한 번 잡힌 방향이 여러 틱 이어진다
//   2. 변동성 클러스터링      — vol 이 AR(1) → 잔잔한 구간과 거친 구간이 뭉치고, 드물게 "뉴스" 충격
//   3. 과열 후 평균회귀       — 적정가(anchor)에서 벌어질수록 되돌림이 제곱으로 강해진다(고점 공포/저점 매수)
//   4. 탐욕-공포 국면 전환    — calm→rally→euphoria→panic→… 하락이 상승보다 빠르고 거칠다(비대칭)
// 여기에 라운드넘버 자석(심리적 지지/저항), 팻테일(급등락), 그리고 거래량·체결 방향·호가 스프레드가
// 국면에 함께 반응하는 것까지 묶었다. 전부 결정론적 알고리즘이다(LLM 아님).
type Regime = 'calm' | 'rally' | 'euphoria' | 'pullback' | 'panic';

interface BotState {
  ref: number;
  drift: number;      // 추세 강도(틱당 기대수익률)
  vol: number;        // 변동성 배수
  sentiment: number;  // 군중 심리 -1(공포) ~ +1(탐욕)
  anchor: number;     // 완만히 따라오는 "적정가"
  regime: Regime;
  regimeTicks: number;
}

// 국면별 성격. bias=틱당 추가 드리프트, volMult=변동성 배수, sizeMult=거래량 배수,
// takerBias=체결 방향 편향(+면 매수 우위), minTicks=최소 지속 틱(국면이 1틱만에 튕기지 않게).
// ⚠ 비대칭: panic 은 euphoria 보다 |bias|·volMult·sizeMult 가 모두 크다 — 실제 시장처럼 "떨어질 땐
// 빠르고 거칠게, 오를 땐 느리게".
// ⚠ bias 는 국면 점유율(대략 calm 50% / rally 25% / pullback 16% / panic 6% / euphoria 3%)로 가중하면
// 합이 거의 0 이 되도록 맞춰져 있다 — 안 맞추면 틱마다 미세한 편향이 누적돼 며칠 만에 가격이 0 으로
// 붕괴하거나 발산한다(초기 튜닝에서 실제로 5일 만에 -40% 편향이 나왔다). 값을 바꿀 땐 반드시
// 시뮬레이션으로 장기 안정성을 다시 확인할 것.
const REGIME_PARAMS: Record<Regime, { bias: number; volMult: number; sizeMult: number; takerBias: number; minTicks: number }> = {
  calm:     { bias:  0,       volMult: 0.65, sizeMult: 0.55, takerBias:  0.02, minTicks: 8 },
  rally:    { bias:  0.0011,  volMult: 1.05, sizeMult: 1.10, takerBias:  0.20, minTicks: 6 },
  euphoria: { bias:  0.0030,  volMult: 1.80, sizeMult: 2.20, takerBias:  0.36, minTicks: 4 },
  pullback: { bias: -0.0007,  volMult: 1.20, sizeMult: 0.95, takerBias: -0.18, minTicks: 3 },
  panic:    { bias: -0.0036,  volMult: 2.60, sizeMult: 2.90, takerBias: -0.40, minTicks: 4 },
};

const ROUND_STEP = 0.05; // 라운드넘버 자석이 잡아당기는 심리적 가격대 간격

/**
 * 봇도 거래 수수료를 낸다 — 합성 체결(봇끼리)이든 유저 상대 체결이든.
 * ⚠ 봇 잔고(users.balance)는 어디서도 읽히지 않는 무한 풀이라 잔고에서 빼는 건 의미가 없지만,
 * **수수료 원장(fee_ledger)엔 반드시 남겨야 "플랫폼이 번 돈"이 온전해진다** — 시장 물량의 대부분이
 * 봇에서 나오는데 봇만 면제하면 원장이 실제 거래량과 동떨어진다. 요율은 유저와 똑같이 누적
 * 거래대금에서 파생(vipOf)하므로 봇도 거래가 쌓일수록 등급이 오른다(특혜 없음).
 * 여러 봇이 섞인 체결은 봇별 명목금액을 모아 한 번에 처리한다(read 1회 + 봇당 2문장).
 */
async function botFeeStmts(
  env: Env,
  notionalByBot: Map<string, number>,
  now: number,
): Promise<D1PreparedStatement[]> {
  const ids = [...notionalByBot.keys()].filter((id) => (notionalByBot.get(id) ?? 0) > EPS);
  if (ids.length === 0) return [];
  const rows = (
    await env.DB.prepare(`SELECT id, total_volume FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: string; total_volume: number }>()
  ).results;
  const volById = new Map(rows.map((r) => [r.id, r.total_volume ?? 0]));
  const out: D1PreparedStatement[] = [];
  for (const id of ids) {
    const notional = notionalByBot.get(id)!;
    const rate = vipOf(volById.get(id) ?? 0).rate;
    out.push(...feeAccrualStmts(env, id, PAIR, 'bot', notional, rate, notional * rate, now));
  }
  return out;
}

// ── 사람처럼 "떨어지는" 호가 가격·수량(price clustering) ──────────────────────
// ⚠ 예전엔 호가를 전부 `ref * (1 ± spread)` 로만 찍어서 1.4067 / 1.4074 / 1.4081 처럼 어중간한 값이
// 기계적으로 균일한 간격으로 늘어섰다 — 실제 호가창은 절대 그렇게 안 생겼다. 사람은 1.4000 / 1.4050
// 같은 **딱 떨어지는 가격**에 주문을 몰아 걸고, 그런 라운드 가격일수록 물량이 훨씬 크다(심리적 지지·
// 저항 "벽"). 수량도 4,712.3856 이 아니라 1,000 / 5,000 처럼 떨어지는 숫자를 넣는다.
// 격자가 굵을수록(=더 라운드한 가격) 그 자리에 붙는 물량 배수(sizeMult)가 크다.
const PRICE_GRIDS: readonly { step: number; sizeMult: number; pull: number }[] = [
  { step: 0.05, sizeMult: 7.0, pull: 0.95 }, // 1.40 / 1.45 — 대형 심리 가격, 두꺼운 벽
  { step: 0.01, sizeMult: 3.4, pull: 0.85 }, // 1.41 / 1.42
  { step: 0.005, sizeMult: 1.9, pull: 0.65 }, // 1.4050
  { step: 0.001, sizeMult: 1.3, pull: 0.8 }, // 1.4070 — 그나마 깔끔한 값
];

/**
 * 목표 호가를 사람이 좋아하는 라운드 가격으로 끌어당긴다.
 * ⚠ 매수는 내림(floor), 매도는 올림(ceil) — 항상 mid 에서 "멀어지는" 방향으로만 스냅되므로
 * 최우선매수 > 최우선매도로 역전될 수 없다(호가 역전 방지의 핵심).
 * depth(0=최우선호가 ~ 1=가장 깊은 레벨)가 클수록 굵은 격자까지 허용한다 — 최우선호가는 촘촘하게
 * 경쟁하고, 멀리 있는 주문일수록 라운드 가격에 뭉치는 실제 호가창의 모습.
 */
function humanQuotePrice(target: number, side: 'buy' | 'sell', depth: number): { price: number; sizeMult: number } {
  const tol = 0.0009 + depth * 0.0022; // 이만큼 넘게 끌려가야 하면 그 격자는 포기(사다리가 뭉개지지 않게)
  for (const g of PRICE_GRIDS) {
    // ⚠ price/step 을 그냥 floor/ceil 하면 정확히 격자 위에 있는 값이 한 칸 밀린다
    // (1.45/0.0001 = 14499.999999999998). 정수에서 1e-9 이내면 그 정수로 간주해 흡수한다.
    const ticks = target / g.step;
    const idx = side === 'buy' ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
    const snapped = idx * g.step;
    if (Math.abs(snapped - target) / target > tol) continue;
    if (Math.random() > g.pull * (0.6 + 0.7 * depth)) continue;
    return { price: roundOx(snapped), sizeMult: g.sizeMult };
  }
  return { price: roundOx(target), sizeMult: 1 }; // 어느 격자에도 안 붙으면 원래 값(어중간한 가격도 섞여야 자연스럽다)
}

/**
 * 주문 수량. ⚠ 예전엔 전부 1,000 / 5,000 처럼 딱 떨어지게 맞췄는데 그러면 그것대로 기계 같다 —
 * 실제 호가창은 여러 사람이 제각각 넣은 값이라 2,384 개 같은 어중간한 수량이 대부분이고, 딱 떨어지는
 * 수량은 가끔 섞일 뿐이다(가격과 달리 수량엔 라운드 넘버 심리가 약하다). 그래서 기본은 정수로만
 * 다듬고, 18% 만 눈에 띄게 떨어지는 수량으로 만든다.
 */
function humanSize(raw: number): number {
  const v = Math.max(1, raw);
  if (Math.random() < 0.18) {
    const step = v >= 20000 ? 5000 : v >= 8000 ? 1000 : v >= 2000 ? 500 : 100;
    return Math.max(step, Math.round(v / step) * step);
  }
  return Math.round(v);
}
// 적정가(anchor)가 아주 약하게 끌려가는 장기 기준선. 국면 bias 를 아무리 맞춰도 랜덤워크는 며칠 단위로
// 얼마든지 멀리 갈 수 있어서(0 에 붙거나 수십 배로 뜀), 반감기 ~14시간짜리 약한 복원력을 하나 둔다.
// 며칠 단위 추세는 그대로 살아있고 "몇 주 뒤 가격이 무의미해지는" 것만 막는다.
const BOT_BASE_PRICE = 1;
const BOT_BASE_PULL = 0.00002;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 표준정규 난수(Box-Muller) — 균등분포보다 꼬리가 있어 가격 움직임이 자연스럽다. */
function gauss(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 국면 전이 — 최소 지속시간을 지킨 뒤 심리/과열도에 따라 확률적으로 넘어간다.
 * 상승은 단계를 밟아 올라가지만(calm→rally→euphoria) 꼭대기에선 곧장 panic 으로 떨어질 수 있다. */
function nextRegime(s: BotState, stretch: number, sentiment: number): { regime: Regime; regimeTicks: number } {
  const age = s.regimeTicks + 1;
  if (age < REGIME_PARAMS[s.regime].minTicks) return { regime: s.regime, regimeTicks: age };
  const start = (regime: Regime) => ({ regime, regimeTicks: 0 });
  const roll = Math.random();
  switch (s.regime) {
    case 'calm':
      if (sentiment > 0.35 && roll < 0.26) return start('rally');
      if (sentiment < -0.35 && roll < 0.20) return start('pullback');
      if (roll < 0.04) return start(sentiment >= 0 ? 'rally' : 'pullback');
      break;
    case 'rally':
      if (stretch > 0.022 && sentiment > 0.42 && roll < 0.34) return start('euphoria'); // 과열 진입(추격매수)
      if (roll < 0.20) return start('pullback'); // 차익실현
      if (roll < 0.28) return start('calm');
      break;
    case 'euphoria':
      if (roll < 0.34) return start('panic'); // 꼭대기에서 곧장 급락 — 상승보다 하락이 빠르다
      if (roll < 0.56) return start('pullback');
      break;
    case 'pullback':
      if (stretch < -0.022 && sentiment < -0.42 && roll < 0.32) return start('panic'); // 투매 전환
      if (roll < 0.30) return start('calm');
      if (roll < 0.44) return start('rally'); // 저가 매수 유입
      break;
    case 'panic':
      if (roll < 0.30) return start('calm'); // 진정
      if (roll < 0.40) return start('rally'); // 데드캣 바운스
      break;
  }
  return { regime: s.regime, regimeTicks: age };
}

/** 한 틱의 시장 심리를 굴려 다음 상태와 이번 틱의 체결 성격을 만든다(순수 함수, DB 접근 없음). */
function nextMarketState(s: BotState): {
  next: BotState;
  ret: number;         // 이번 틱 수익률
  sizeMult: number;    // 거래량 배수
  buyProb: number;     // 체결이 매수(taker buy)일 확률
  spreadMult: number;  // 호가 스프레드 배수
} {
  const anchor = s.anchor > 0 ? s.anchor : s.ref;
  const stretch = (s.ref - anchor) / anchor; // 적정가 대비 과열(+)/과매도(-)

  // 1) 변동성 클러스터링 — 직전 변동성을 대부분 물려받고(AR(1)) 드물게 뉴스 충격으로 튄다.
  let vol = s.vol * 0.9 + 0.1 * Math.exp(gauss() * 0.45);
  if (Math.random() < 0.02) vol *= 1.8 + Math.random() * 1.4;
  vol = clamp(vol, 0.35, 4.5);

  // 2) 추세 지속 — 방향이 한 번 잡히면 감쇠하며 몇 틱 이어진다.
  const drift = s.drift * 0.86 + gauss() * 0.0007 * vol;

  // 3) 군중 심리 — 최근 추세와 과열도가 쌓여 탐욕/공포가 된다(국면 전이의 방아쇠).
  const sentiment = clamp(s.sentiment * 0.88 + 45 * drift + 3 * stretch, -1, 1);

  const { regime, regimeTicks } = nextRegime(s, stretch, sentiment);
  const P = REGIME_PARAMS[regime];

  // 4) 평균회귀 — 벌어질수록 제곱으로 강해진다(무한 발산 방지 + "너무 올랐다" 심리).
  const revert = -0.045 * stretch - 0.7 * stretch * Math.abs(stretch);

  // 5) 라운드넘버 자석 — 심리적 지지/저항 근처에서 잠시 머뭇거린다.
  const round = Math.round(s.ref / ROUND_STEP) * ROUND_STEP;
  const toRound = (round - s.ref) / s.ref;
  const magnet = Math.abs(toRound) < 0.004 ? toRound * 0.35 : 0;

  // 6) 이번 틱 수익률 + 팻테일(가끔 튀는 급등락)
  let ret = drift + revert + magnet + P.bias + gauss() * 0.0015 * vol * P.volMult;
  if (Math.random() < 0.03) ret *= 2 + Math.random() * 2;

  const ref = roundOx(clamp(s.ref * (1 + ret), 0.02, 1e6));

  // 7) 거래량은 움직임 크기와 국면에 반응한다 — 큰 봉엔 큰 거래량, 패닉엔 폭증.
  const intensity = clamp(0.5 + Math.abs(ret) / 0.003, 0.45, 6);
  const nextAnchor = anchor * 0.99 + ref * 0.01;
  return {
    next: {
      ref,
      drift,
      vol,
      sentiment,
      // 적정가는 가격을 느리게 따라가되(장기 추세 허용), 아주 약하게 기준선으로도 끌린다(무한 표류 방지).
      anchor: nextAnchor + (BOT_BASE_PRICE - nextAnchor) * BOT_BASE_PULL,
      regime,
      regimeTicks,
    },
    ret,
    sizeMult: P.sizeMult * intensity,
    buyProb: clamp(0.5 + P.takerBias + (ret >= 0 ? 0.22 : -0.22), 0.06, 0.94),
    spreadMult: 0.75 + 0.45 * vol, // 변동성이 크면 마켓메이커가 물러나 호가가 벌어진다
  };
}

/**
 * 마켓메이커 한 틱(requote): 봇 호가를 새로 깔고, 합성 체결을 여러 건 찍어 테이프/거래량을 만들고,
 * 유저 지정가 "벽"을 존중(클램프+소비)하고, 대기 중 유저 지정가를 walking 매칭한다. prev 상태에서
 * 심리 모델을 한 스텝 굴려 다음 상태를 반환. now 는 이 틱의 기준 시각(항상 현재 이후 — 과거면 마감된
 * 봉이 변조된다). 심리 상태는 갱신하지만 last_run 은 건드리지 않는다(게이트는 호출자 담당).
 */
async function marketMakerTick(env: Env, prev: BotState, now: number): Promise<BotState> {
  const step = nextMarketState(prev);
  const candidateRef = step.next.ref;
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

  // 기준가뿐 아니라 개별 합성 체결 가격도 같은 벽 안으로 가둔다 — 안 그러면 봉 안의 노이즈가 벽을 넘어
  // 찍혀서 "벽은 안 팔렸는데 차트 고가만 벽 너머"인 가짜 꼬리가 생긴다(가짜 high 버그와 같은 원리).
  function clampToWalls(p: number): number {
    if (wallAsk != null && p > wallAsk) return roundOx(wallAsk);
    if (wallBid != null && p < wallBid) return roundOx(wallBid);
    return p;
  }

  const stmts: D1PreparedStatement[] = [
    // ⚠ 매 틱 이 페어의 봇 호가를 "전부"(두 봇 모두) 비우고 한 액터가 일관된 사다리를 새로 깐다(호가 역전 방지).
    // spot_orders 엔 봇 호가만 있으니(유저 주문은 pending_orders) pair 전체를 지워도 유저 주문엔 영향 없다.
    env.DB.prepare("UPDATE spot_orders SET status = 'cancelled' WHERE pair = ? AND status = 'open'").bind(PAIR),
  ];
  // 기준가 주변에 여러 단계로 유동성을 깐다. 스프레드는 타이트하게(최우선호가가 mid 에 바싹) 잡되 깊은
  // 레벨로 갈수록 벌어지며 대량 주문엔 슬리피지가 생긴다. 물량을 크게 깔아 유저 주문이 시원하게 체결되게 한다.
  // ⚠ 변동성이 높은 국면(패닉/과열)에선 spreadMult 로 호가가 벌어진다 — 실제 마켓메이커가 리스크를 피해
  // 물러나는 행동이라, 거친 구간에 시장가로 들어가면 슬리피지가 커진다.
  // ⚠ 가격은 humanQuotePrice 로 라운드 가격에 끌어당기고(가격 군집), 그 자리엔 물량을 몇 배로 얹는다
  // (심리적 벽). 같은 가격으로 두 레벨이 겹치면 원래 목표가로 되돌려 사다리 깊이를 유지한다 —
  // 겹친 채 두면 호가창에 보이는 단계 수가 줄어든다(loadSpotMarket 이 가격별로 SUM 하므로).
  const usedPrices: Record<'buy' | 'sell', Set<number>> = { buy: new Set(), sell: new Set() };
  const placeQuote = (side: 'buy' | 'sell', target: number, depth: number) => {
    const q = humanQuotePrice(target, side, depth);
    const price = usedPrices[side].has(q.price) ? roundOx(target) : q.price;
    const sizeMult = usedPrices[side].has(q.price) ? 1 : q.sizeMult;
    usedPrices[side].add(price);
    stmts.push(botQuoteStmt(env, actor, side, price, humanSize((2000 + Math.random() * 8000) * sizeMult), now));
  };
  for (let level = 0; level < BOT_LEVELS_PER_SIDE; level++) {
    const depth = level / (BOT_LEVELS_PER_SIDE - 1);
    const spread = (0.0006 + level * 0.00055 + Math.random() * 0.0004) * step.spreadMult;
    placeQuote('buy', ref * (1 - spread), depth);
    placeQuote('sell', ref * (1 + spread), depth);
  }
  // 유저 벽에 눌렸으면(press) 그 벽 가격에 봇 호가를 하나 얹는다 — 아래 sweep 이 유저 벽을 그 가격에 소비.
  if (press === 'up') stmts.push(botQuoteStmt(env, actor, 'buy', ref, humanSize(2000 + Math.random() * 8000), now));
  else if (press === 'down') stmts.push(botQuoteStmt(env, actor, 'sell', ref, humanSize(2000 + Math.random() * 8000), now));

  // 합성 체결을 여러 건 찍는다. ⚠ 예전엔 전부 같은 가격(ref)이라 봉 안에 구조가 없었다(몸통만 있고
  // 꼬리가 없는 캔들) — 지금은 직전 기준가에서 새 기준가로 "걸어가면서" 노이즈를 얹어 찍으므로 봉마다
  // 시가/고가/저가/종가가 제대로 생긴다. 마지막 체결은 정확히 ref(=종가)로 맞춰 기준가와 어긋나지 않게.
  // 건수·크기는 심리 모델의 sizeMult(국면·움직임 크기)에 비례하고, 드물게 고래 물량이 섞인다.
  const nTrades = clamp(
    Math.round((BOT_TRADES_PER_TICK_MIN + Math.random() * (BOT_TRADES_PER_TICK_MAX - BOT_TRADES_PER_TICK_MIN)) * Math.sqrt(step.sizeMult)),
    2,
    12,
  );
  let volume = 0;
  let notionalSum = 0; // 봇 수수료 산정용(합성 체결의 명목금액 합)
  let high = ref;
  let low = ref;
  let open = ref;
  for (let i = 0; i < nTrades; i++) {
    const progress = (i + 1) / nTrades;
    const walk = prev.ref + (ref - prev.ref) * progress;
    const jitter = 1 + gauss() * 0.0005 * step.next.vol;
    // 체결도 호가창과 같은 이유로 라운드 가격에 몰린다 — 실제 시장에서 체결은 "거기 걸려 있던 호가"
    // 가격에 일어나는데, 그 호가들이 위 humanQuotePrice 로 라운드 가격에 뭉쳐 있기 때문. 테이프만
    // 어중간한 값이면 호가창과 따로 노는 시장으로 보인다. 마지막 체결은 기준가(=종가)와 정확히 일치시킨다.
    const raw = walk * jitter;
    const snapped = Math.random() < 0.65 ? Math.round(raw / 0.001) * 0.001 : raw;
    const price = i === nTrades - 1 ? ref : clampToWalls(roundOx(snapped));
    if (i === 0) open = price;
    high = Math.max(high, price);
    low = Math.min(low, price);

    let sz = (BOT_TRADE_SIZE_MIN + Math.random() * (BOT_TRADE_SIZE_MAX - BOT_TRADE_SIZE_MIN)) * step.sizeMult;
    if (Math.random() < 0.04) sz *= 2.5 + Math.random() * 4; // 가끔 고래가 크게 친다(팻테일 거래량)
    sz = humanSize(sz);
    volume += sz;
    notionalSum += price * sz;

    const takerSide = Math.random() < step.buyProb ? 'buy' : 'sell';
    stmts.push(
      env.DB.prepare(
        'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), PAIR, actor, actor, price, sz, takerSide, now + i),
    );
  }
  const next: BotState = { ...step.next, ref };
  stmts.push(
    env.DB.prepare(
      'UPDATE spot_bot_state SET ref_price=?, drift=?, vol=?, sentiment=?, anchor=?, regime=?, regime_ticks=? WHERE id=?',
    ).bind(next.ref, next.drift, next.vol, next.sentiment, next.anchor, next.regime, next.regimeTicks, PAIR),
  );
  // 영속 캔들: 이 틱이 찍은 체결들의 OHLCV 로 1회 갱신(위 spot_trades 들과 정확히 일치해야 한다).
  stmts.push(...candleUpsertStmts(env, { open, high, low, close: ref, volume }, now));
  // 봇도 수수료를 낸다 — 이 틱의 합성 체결 명목금액에 대해(같은 batch, 왕복 추가 없음).
  stmts.push(...(await botFeeStmts(env, new Map([[actor, notionalSum]]), now)));
  await env.DB.batch(stmts);

  // 방금 깐 유동성에 대기 중 유저 지정가를 walking 매칭(호가 역전/크로스 즉시 체결, 벽 소비 포함).
  await sweepRestingOxPendings(env);
  return next;
}

// 봇 심리 상태 행 ↔ BotState 변환. 컬럼이 전부 DEFAULT 를 갖고 있어 기존 행/신규 행 모두 안전하게
// 읽히고, 값이 비었거나(anchor=0=미초기화) 알 수 없는 regime 이면 안전한 기본값으로 떨어진다.
const BOT_STATE_COLS = 'last_run, ref_price, drift, vol, sentiment, anchor, regime, regime_ticks';
const REGIMES: readonly Regime[] = ['calm', 'rally', 'euphoria', 'pullback', 'panic'];

interface BotStateRow {
  last_run: number;
  ref_price: number;
  drift: number;
  vol: number;
  sentiment: number;
  anchor: number;
  regime: string;
  regime_ticks: number;
}

function toBotState(row: BotStateRow | null, ref: number): BotState {
  return {
    ref,
    drift: row?.drift ?? 0,
    vol: row && row.vol > 0 ? row.vol : 1,
    sentiment: row?.sentiment ?? 0,
    anchor: row?.anchor ?? 0,
    regime: REGIMES.includes(row?.regime as Regime) ? (row!.regime as Regime) : 'calm',
    regimeTicks: row?.regime_ticks ?? 0,
  };
}

/** 기준가 확보 — 상태 행이 없거나 0 이면 마지막 체결가로, 그것도 없으면 1 로 시작. */
async function resolveRef(env: Env, row: BotStateRow | null): Promise<number> {
  if (row?.ref_price) return row.ref_price;
  const lastTrade = await env.DB.prepare('SELECT price FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 1')
    .bind(PAIR)
    .first<{ price: number }>();
  return lastTrade?.price ?? 1;
}

/** 폴링(유저 접속) 시 호출 — 재호가 게이트를 통과할 때만 한 틱을 돈다. */
export async function runMarketMaker(env: Env): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${BOT_STATE_COLS} FROM spot_bot_state WHERE id = ?`)
    .bind(PAIR)
    .first<BotStateRow>();
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

  await marketMakerTick(env, toBotState(row, await resolveRef(env, row)), now);
}

/**
 * cron 전용 — 접속자가 없어도 시장이 계속 살아있도록 한 번에 여러 틱을 몰아 돈다(게이트 무시).
 * cron 이 1분마다 부르므로 그 사이의 거래량·가격 움직임을 여기서 만든다(예전엔 5분마다 1틱뿐이라
 * 아무도 안 볼 때 차트가 사실상 멈춰 있었다). 마지막에 last_run 을 갱신해 직후 폴링이 곧바로 겹쳐
 * requote 하지 않게 함.
 *
 * ⚠ 체결 시각은 절대 과거로 소급하지 않는다(마감된 봉이 변하던 버그). 예전엔 각 틱의 시각을
 * [now-55s, now] 에 퍼뜨려 "빈 봉"을 메웠는데(cron 이 5분 주기이던 시절의 잔재), cron 이 매 1분인
 * 지금은 그 소급분이 **이미 마감된 직전 분봉 버킷**에 upsert 돼 high/low/close/volume 이 계속 갱신됐다
 * → 차트(OX 는 1.5초마다 전체 setData)에서 "봉 마감됐는데 이전 봉이 막 바뀌는" 현상. 마감된 봉은
 * 불변이어야 하므로 모든 틱을 현재 시각 이후(now+i)에만 찍는다. cron 이 매 분 도는 이상 1분봉은
 * 어차피 매 봉 채워지므로 빈 봉도 안 생긴다.
 */
export async function runMarketMakerBurst(env: Env, ticks: number = BOT_BURST_TICKS): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${BOT_STATE_COLS} FROM spot_bot_state WHERE id = ?`).bind(PAIR).first<BotStateRow>();
  const ref0 = await resolveRef(env, row);
  // 상태 행이 아직 없으면 먼저 만든다 — marketMakerTick 의 심리상태 UPDATE 가 0행이 되어 국면이
  // 매 틱 초기화되는 걸 막는다(cron 이 유일한 클럭인 초기 상태에서 실제로 문제가 된다).
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?)')
      .bind(PAIR, 0, ref0)
      .run();
  }

  // 각 틱의 시각 = "그 틱을 실제로 실행하는 시점"(단조 증가). 버스트가 분 경계를 넘어가더라도
  // 소급 기록이 생기지 않는다. +10ms 는 틱 내부 체결(now+0..5)끼리 겹치지 않게 하는 최소 간격.
  let state = toBotState(row, ref0);
  let prevTs = 0;
  for (let i = 0; i < ticks; i++) {
    const ts = Math.max(Date.now(), prevTs + 10);
    prevTs = ts;
    state = await marketMakerTick(env, state, ts);
  }
  // 심리 상태는 각 틱이 이미 기록했으므로 여기선 last_run 만 갱신한다(직후 폴링이 곧바로 겹쳐 requote 하지 않게).
  await env.DB.prepare('UPDATE spot_bot_state SET last_run = ? WHERE id = ?').bind(Date.now(), PAIR).run();
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
    ...candleUpsertOne(env, price, size, now), // 영속 캔들 갱신
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
    ...candleUpsertOne(env, price, size, now), // 유저 매칭체결도 영속 캔들에 반영
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
  const limitFeeRate = await feeRateOf(env, first.user_id); // 이 주문 전체에 한 번만 확정
  let filled = 0;
  let cost = 0;
  let limitFeeTotal = 0;
  const limitMakerNotional = new Map<string, number>(); // 상대편 봇 수수료

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
    // 지정가도 체결 시점에 수수료를 뗀다. 증거금 환불(refund)과 상계해 한 번의 잔고 조정으로 처리 —
    // 두 문장으로 나누면 배치 안에서 순서에 따라 음수 잔고가 잠깐 보이거나 문장이 늘어날 뿐이다.
    const chunkFee = fillPrice * chunk * limitFeeRate;
    const net = refund - chunkFee;
    if (Math.abs(net) > EPS) {
      stmts.push(env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(net, p.user_id));
    }
    await env.DB.batch(stmts);
    filled += chunk;
    cost += fillPrice * chunk;
    limitFeeTotal += chunkFee;
    limitMakerNotional.set(maker.user_id, (limitMakerNotional.get(maker.user_id) ?? 0) + fillPrice * chunk);
  }

  if (filled > EPS) {
    // 체결 이력(주문내역)엔 이번 호출의 총 체결을 가중평균가로 1건 기록(칸별로 쪼개면 내역이 넘침).
    const done = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), first.user_id, PAIR, first.side, cost / filled, filled, effLev, 'open', null, done),
      // 잔고는 청크마다 상계 정산 — 여기선 누적 카운터+원장만(합계 1행)
      ...feeAccrualStmts(env, first.user_id, PAIR, 'open', cost, limitFeeRate, limitFeeTotal, done),
      ...(await botFeeStmts(env, limitMakerNotional, done)),
    ]);
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
  // 수수료율은 이 주문 전체에 한 번만 확정(청크마다 다시 읽으면 체결 도중 등급이 올라 청크별로
  // 요율이 달라지는 이상한 상태가 된다). 청크마다 증거금과 **함께** 차감해야 원자 가드가 성립한다.
  const feeRate = await feeRateOf(env, uid);
  let remaining = size;
  let filled = 0;
  let cost = 0;
  let feeTotal = 0;
  const makerNotional = new Map<string, number>(); // 상대편 봇도 수수료를 낸다(봇별 명목금액 집계)

  for (let i = 0; i < 500 && remaining > EPS; i++) {
    const maker = await bestBotMaker(env, side, null);
    if (!maker) break; // 유동성 소진

    let chunk = Math.min(remaining, maker.size);
    const price = maker.price;
    let margin = (price * chunk) / effLev;
    let chunkFee = price * chunk * feeRate;
    // 크로스: balance - (margin+수수료) >= -floorPnL (⟺ available >= margin+수수료). floorPnL>0(이익)
    // 이면 balance 가 음수까지 허용돼 미실현이익만큼 더 살 수 있고, floorPnL<0(손실)이면 덜 산다.
    let deduct = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance-? >= ?')
      .bind(margin + chunkFee, uid, margin + chunkFee, -floorPnL)
      .run();
    if (deduct.meta.changes !== 1) {
      // 전량 감당 불가 → 가용(여유잔고+미실현이익)으로 살 수 있는 만큼만.
      // ⚠ 1 코인당 드는 돈은 증거금(price/effLev)뿐 아니라 수수료(price*rate)도 포함해야 한다 —
      // 빼먹으면 딱 가용만큼 사려다 수수료 때문에 가드에 걸려 체결이 통째로 멈춘다.
      const u = await env.DB.prepare('SELECT balance FROM users WHERE id=?').bind(uid).first<{ balance: number }>();
      const perUnit = price / effLev + price * feeRate;
      const affordable = ((u?.balance ?? 0) + floorPnL) / perUnit;
      if (affordable <= EPS) break;
      chunk = Math.min(chunk, affordable);
      margin = (price * chunk) / effLev;
      chunkFee = price * chunk * feeRate;
      deduct = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance-? >= ?')
        .bind(margin + chunkFee, uid, margin + chunkFee, -floorPnL)
        .run();
      if (deduct.meta.changes !== 1) break;
    }

    const makerRem = maker.size - chunk;
    const claim = await env.DB.prepare("UPDATE spot_orders SET size=?, status=? WHERE id=? AND status='open' AND size>=?")
      .bind(makerRem, makerRem <= EPS ? 'filled' : 'open', maker.id, chunk - EPS)
      .run();
    if (claim.meta.changes !== 1) {
      // 선점 실패 → 방금 뺀 증거금+수수료를 그대로 환불(수수료만 남으면 체결 없이 돈이 새어나간다)
      await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(margin + chunkFee, uid).run();
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
    feeTotal += chunkFee;
    makerNotional.set(maker.user_id, (makerNotional.get(maker.user_id) ?? 0) + price * chunk);
  }

  if (filled > EPS) {
    const done = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, PAIR, side, cost / filled, filled, effLev, 'open', null, done),
      // 잔고는 청크마다 이미 정산됐으므로 여기선 누적 카운터+원장만(합계 1행 — 청크 수만큼 불어나지 않게)
      ...feeAccrualStmts(env, uid, PAIR, 'open', cost, feeRate, feeTotal, done),
      ...(await botFeeStmts(env, makerNotional, done)),
    ]);
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
  // 요율은 이 청산 전체에 한 번만 확정(청크마다 다시 읽으면 체결 도중 등급이 바뀔 수 있다).
  const closeFeeRate = await feeRateOf(env, uid);
  let closeFeeTotal = 0;
  const closeMakerNotional = new Map<string, number>(); // 상대편 봇 수수료

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
    const chunkFee = fillPrice * chunk * closeFeeRate; // 청산 수수료는 환급액에서 뺀다
    const newFilled = filled + chunk;
    const fullyClosed = newFilled >= pos.size - EPS;
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(chunkMargin + chunkPnl - chunkFee, uid),
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
    closeFeeTotal += chunkFee;
    closeMakerNotional.set(maker.user_id, (closeMakerNotional.get(maker.user_id) ?? 0) + fillPrice * chunk);
    if (fullyClosed) break;
  }

  if (filled > EPS) {
    if (pendingId) {
      if (filled >= pendingSize - EPS)
        await env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId).run();
      else await env.DB.prepare('UPDATE pending_orders SET size=? WHERE id=?').bind(pendingSize - filled, pendingId).run();
    }
    // 청산 체결 이력 1건(가중평균가·총 실현손익). side 는 포지션 방향(기존 close 기록과 동일 규약).
    const done = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, PAIR, pos.side, cost / filled, filled, pos.leverage, 'close', pnlTotal, done),
      // 잔고는 청크마다 이미 정산 — 여기선 누적 카운터+원장만(합계 1행)
      ...feeAccrualStmts(env, uid, PAIR, 'close', cost, closeFeeRate, closeFeeTotal, done),
      ...(await botFeeStmts(env, closeMakerNotional, done)),
    ]);
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
