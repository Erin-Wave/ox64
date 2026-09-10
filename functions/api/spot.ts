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
  type SpotTradeRow,
  type PendingRow,
  type PositionRow,
  type D1PreparedStatement,
  feeRateOf,
  feeAccrualStmts,
  isVirtualSymbol,
  vipOf,
  sizeEps,
  roundVirtual,
  virtualTick,
  VIRTUAL_PRICE_MIN,
  VIRTUAL_PRICE_MAX,
} from '../_shared';
import { autoWritesBlocked, meterStmt } from '../_budget';

/**
 * 가상 코인(OX/USDT · EW/USDT) — 외부 시세가 없어 이 파일의 봇이 체결가를 만든다. 그 외에는 실제 38종과
 * 완전히 동일하게 `order.ts` 를 통해 레버리지 롱/숏으로 거래된다(functions/_shared.ts fetchPrice 참고).
 * 이 파일은 유저 액션이 아니라 두 가지만 담당한다:
 *   - GET /api/spot?pair=..            — 호가창/체결내역 "표시용" 데이터(로그인만 확인, 유저별 데이터 없음)
 *   - GET /api/spot?pair=..&candles=1  — OHLCV 캔들
 *   - runMarketMaker()                 — 봇 유저 2명이 합성 시세·호가·체결 테이프를 만드는 엔진(cron/ 이 주기 호출).
 *
 * ⚠ **페어는 전부 인자로 흐른다**(2026-07-31, 예전엔 `const PAIR='OXUSDT'` 모듈 상수였다). 봇 상태·호가
 * 사다리·캔들·체결 테이프는 전부 pair 로 키가 잡혀 있으므로, 새 가상 코인을 늘릴 때 필요한 건 아래
 * `VIRTUAL_PAIRS` 에 심볼을 넣고 `spot_bot_state` 에 시작가 행을 하나 만드는 것뿐이다. 새 코드를 쓸 땐
 * 절대 심볼을 하드코딩하지 말 것 — 그 순간 그 경로만 OX 전용이 되어 조용히 갈라진다.
 */
const EPS = 1e-9; // 부동소수점 잔여수량 판정 오차
// 호가창에 내려보내는 가격대 수 = 클라 표시 개수 상한(설정 5~50, `useChartStore.bookRows`)과 같은 값.
// ⚠ 클라가 이보다 많이 그리려 하면 그만큼은 빈 채로 남으므로 표시 상한을 올릴 땐 여기도 같이 올릴 것.
// 봇 사다리·유저 지정가를 메모리에서 합친 뒤 자르는 것이라 이 값을 올려도 D1 읽기·쓰기는 안 늘어난다.
const BOOK_LIMIT = 50;
// 가상 코인 최소 호가 단위 = **유효숫자 4자리**(가격대에 따라 틱이 10배씩 바뀐다: 0.9234→0.0001,
// 0.002434→0.000001, 123.4→0.1 — `_shared.roundVirtual`). 봇 기준가/호가/체결가를 전부 이 틱에
// 스냅해서, 실제 코인처럼 정해진 자릿수 이상으로는 호가·체결이 생기지 않게 한다.
// ⚠ 틱이 절대값이 아니라 가격 비례이므로, **가격 격자·자석 간격 같은 상수도 절대값으로 쓰면 안 된다**
// (0.05 같은 값은 가격이 1 근처일 때만 맞는다) — 전부 아래처럼 "틱 몇 개"로 표현할 것.
const roundOx = roundVirtual;

export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);

    const url = new URL(request.url);
    // ⚠ 페어는 반드시 화이트리스트로 검증한다 — 검증 없이 쓰면 임의 문자열로 spot_bot_state/spot_trades 에
    // 유령 페어를 만들 수 있다. 파라미터가 없으면 기본값(첫 가상 코인)으로 떨어져 구버전 클라와도 호환된다.
    const reqPair = url.searchParams.get('pair') || VIRTUAL_PAIRS[0];
    if (!VIRTUAL_PAIRS.includes(reqPair)) return bad('알 수 없는 페어');

    // ⚠ **캔들 조회는 마켓메이커를 굴리지 않는다**(2026-07-31). 예전엔 이 핸들러에 들어오면 종류 구분 없이
    // 봇을 한 틱 돌렸는데, 캔들은 차트가 읽어가는 조회일 뿐 시장을 움직일 이유가 없다. 그리고 가상 코인이
    // 둘이 된 뒤로 **심볼 드롭다운이 코인마다 24h 변동률용 캔들을 5초 주기로 긁으므로**(SymbolSelect),
    // 그대로 두면 드롭다운을 열어둔 것만으로 코인 수 × 요청 수만큼 봇이 돌아간다(코인 수에 비례해 늘어나는
    // 바로 그 낭비). 시장 클럭은 호가창 폴링(useSpotPoll → 아래 loadSpotMarket 경로)만 담당한다 —
    // 지금 보고 있는 코인은 그 폴링이 1초 주기로 돌므로 체결 지연도 그대로다.
    const wantCandles = url.searchParams.get('candles');
    let tickCtx: TickCtx | undefined; // 봇 틱이 이미 읽은 스냅샷(§ TickCtx) — 아래 호가창이 재사용
    if (!wantCandles) {
      try {
        tickCtx = await runMarketMaker(env, reqPair);
      } catch (e) {
        // 봇 실패가 유저 요청을 막으면 안 되지만(다음 폴링에서 재시도), ⚠ 조용히 삼키면 봇이 몇 시간째
        // 죽어 있어도 아무도 모른다 — 실제로 배치 문장 수 초과로 호가가 안 깔리는데 화면상 멀쩡해 보여
        // 원인을 찾는 데 한참 걸렸다. 최소한 로그는 남긴다(wrangler tail / 대시보드에서 확인 가능).
        console.error(`[ox64] runMarketMaker(${reqPair}) failed:`, e instanceof Error ? e.message : e);
      }
    }

    if (wantCandles) {
      const interval = url.searchParams.get('interval') || '1m';
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
      const endTime = Number(url.searchParams.get('endTime')) || undefined;
      return json({ candles: await loadSpotCandles(env, reqPair, interval, limit, endTime) });
    }

    return json(await loadSpotMarket(env, sess.uid, reqPair, tickCtx));
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
// ⚠ **저장은 1m/1h/1d 세 종류만** 한다(2026-07-31). 예전엔 15종을 전부 upsert 해서 체결 한 묶음마다
// 15문장이 나갔는데, 봇이 분당 12틱 이상 영구히 도니 그것만으로 하루 29만 write 였다. 나머지 인터벌
// (3m/5m/15m/30m, 2h/4h/6h/8h/12h, 3d/1w/1M)은 전부 이 셋의 **정수배**라 조회할 때 굴려서(rollup) 만들면
// 값이 정확히 같다 — 저장할 이유가 없다. 셋을 고른 기준: 각 그룹의 최소 단위여야 그 그룹 전체를 덮는다.
const PERSIST_INTERVALS: readonly [string, number][] = [
  ['1m', 60],
  ['1h', 3600],
  ['1d', 86400],
];

/** 한 묶음의 체결(OHLCV)을 모든 영속 인터벌의 캔들에 반영하는 upsert 문장들.
 * 버킷이 없으면 새로 만들고, 있으면 시각을 비교해 open/close 를 골라 넣고 high/low/volume 을 누적한다.
 * 모든 spot_trades INSERT 경로가 이 문장들을 같은 batch 에 함께 넣어 차트 히스토리를 영구 보존한다.
 * ⚠ 여기 넘기는 값은 반드시 같은 batch 에 INSERT 하는 spot_trades 들과 일치해야 한다 — 어긋나면
 * 캔들과 체결내역이 서로 다른 시장을 보여주게 된다(마켓메이커 한 틱은 여러 건을 찍으므로 그 묶음의
 * OHLC 를 그대로 넘긴다). now 가 과거면 이미 마감된 봉이 변조되므로 항상 현재 이후 시각일 것.
 * 이 경로는 유저 체결(한 순간에 끝난다)이라 시가·종가 시각이 둘 다 now 다. */
function candleUpsertStmts(
  env: Env,
  pair: string,
  bar: { open: number; high: number; low: number; close: number; volume: number },
  now: number,
): D1PreparedStatement[] {
  return PERSIST_INTERVALS.map(([code, sec]) => {
    const bucket = Math.floor(now / (sec * 1000)) * (sec * 1000);
    return env.DB.prepare(CANDLE_UPSERT_SQL).bind(pair, code, bucket, bar.open, bar.high, bar.low, bar.close, bar.volume, now, now);
  });
}

// ⚠ 누적 upsert 라 같은 버킷에 여러 번 써도 값이 맞는다(high/low 는 극값, volume 은 합). 이 성질 덕에
// "봇은 버킷이 닫힐 때 자기 몫을 한 번에" / "유저 체결은 그때그때" 따로 써도 결과가 정확히 합쳐진다.
//
// ⚠⚠ **open/close 는 "먼저 쓴 쪽"이 아니라 "먼저 체결된 쪽"이 이긴다**(2026-09-02 버그 수정).
// 예전엔 `open` 을 ON CONFLICT 에서 아예 건드리지 않아 **그 버킷에 먼저 INSERT 한 쪽이 시가를 가졌다**.
// 그건 봇이 틱마다 테이블을 쓰던 시절엔 맞는 근사였지만(봇이 초당 몇 번 도니 거의 항상 봇이 먼저였다),
// 2026-08-14 에 봇 캔들을 live_json 에 모았다가 **버킷이 닫힐 때만** flush 하게 바꾸면서 그 전제가 무너졌다 —
// 진행 중인 버킷엔 봇의 행이 아예 없으므로 **유저 체결이 항상 첫 INSERT**가 되고, 그 버킷의 시가가 통째로
// 유저의 체결가(시장가 walking 이라 슬리피지 포함)로 덮였다. 1m 뿐 아니라 1h·1d 도 같이 오염되고
// (그것들이 5m/4h 롤업의 원본이다), flush 가 open 을 안 건드리므로 그 오차가 **영구히 남았다**.
// 진짜 불변식은 "open = 그 버킷의 가장 이른 체결가 / close = 가장 늦은 체결가" 이고, 그걸 쓰는 주체가
// 둘(봇 flush / 유저 체결)이라 **시각을 같이 써야만** 가릴 수 있다 — 그게 open_at/close_at 이다.
// (컬럼을 늘려도 인덱스가 안 늘어 **쓰기 행 수는 그대로**다, §6 과금 모델.)
// ⚠ 마이그레이션 전 행은 open_at=0 이라 새 쓰기가 open 을 못 이긴다(= 예전 동작 유지). 배포 시점에
// 진행 중이던 버킷 하나만 해당되고 그 뒤로는 자연히 해소된다.
const CANDLE_UPSERT_SQL = `INSERT INTO spot_candles (pair, interval, bucket, open, high, low, close, volume, open_at, close_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(pair, interval, bucket) DO UPDATE SET
         open = CASE WHEN excluded.open_at < spot_candles.open_at THEN excluded.open ELSE spot_candles.open END,
         open_at = MIN(spot_candles.open_at, excluded.open_at),
         high = MAX(spot_candles.high, excluded.high),
         low = MIN(spot_candles.low, excluded.low),
         close = CASE WHEN excluded.close_at >= spot_candles.close_at THEN excluded.close ELSE spot_candles.close END,
         close_at = MAX(spot_candles.close_at, excluded.close_at),
         volume = spot_candles.volume + excluded.volume`;

// ── 진행 중(안 닫힌) 캔들 버킷 = spot_bot_state.live_json (2026-08-14, § D1 예산) ─────────────
// 봇은 초당 몇 번씩 도는데 그때마다 같은 1m/1h/1d 버킷을 다시 쓰는 건 "매 틱 갈아엎히는 집계"를 행으로
// 들고 있는 것이다(사다리·테이프와 정확히 같은 실수). 여기 누적했다가 **버킷이 닫힐 때만** 테이블로
// 넘긴다 → 1m 은 분당 1행, 1h 은 시간당 1행. 진행 중 버킷은 loadSpotCandles 가 읽을 때 붙여주므로
// 차트의 마지막 봉은 예전과 똑같이 실시간으로 움직인다.
/** 영속 캔들 한 행(읽기 경로). open_at/close_at 은 시가·종가가 찍힌 시각 — 진행 중 버킷을 병합할 때
 * "봇과 유저 중 누가 먼저/나중에 찍었나"를 가리는 데 쓴다(§ CANDLE_UPSERT_SQL). */
interface CandleRow {
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  open_at: number;
  close_at: number;
}

interface LiveBar {
  b: number; // 버킷 시작 시각(ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  // 시가/종가가 **찍힌 시각**(§ CANDLE_UPSERT_SQL). 같은 버킷을 유저 체결도 쓰기 때문에, flush 할 때
  // "봇의 첫 틱이 유저 체결보다 빨랐나"를 이 값으로 가린다 — 없으면 먼저 INSERT 한 쪽이 시가를 가져간다.
  ot?: number;
  ct?: number;
}
type LiveBars = Record<string, LiveBar>;

function parseLive(json: string | null | undefined): LiveBars {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as LiveBars;
    if (!v || typeof v !== 'object') return {};
    // 손상된 항목은 조용히 버린다 — 진행 중 봉 하나를 잃을 뿐이고, 다음 틱이 새로 시작한다.
    const out: LiveBars = {};
    for (const [code, b] of Object.entries(v)) {
      if (!b || typeof b.b !== 'number' || typeof b.c !== 'number') continue;
      // 옛 형식(시각 없음)은 "버킷 시작 시각에 열렸다"로 본다 — 봇 틱은 버킷 맨 앞부터 도니 그게 맞고,
      // 다음 틱이 곧바로 실제 값으로 덮는다(ct 는 매 틱 갱신).
      out[code] = { ...b, ot: typeof b.ot === 'number' ? b.ot : b.b, ct: typeof b.ct === 'number' ? b.ct : b.b };
    }
    return out;
  } catch {
    return {};
  }
}

/** 이 틱의 OHLCV 를 진행 중 버킷들에 누적한다. 버킷이 넘어갔으면 닫힌 버킷을 돌려준다(= 테이블로 넘길 것). */
function accrueLive(live: LiveBars, bar: { open: number; high: number; low: number; close: number; volume: number }, now: number): { code: string; bar: LiveBar }[] {
  const closed: { code: string; bar: LiveBar }[] = [];
  for (const [code, sec] of PERSIST_INTERVALS) {
    const bucket = Math.floor(now / (sec * 1000)) * (sec * 1000);
    const cur = live[code];
    if (!cur || cur.b !== bucket) {
      // ⚠ 과거 버킷일 때만 넘긴다 — 시계가 뒤로 가는 이상 상황에서 미래 버킷을 "닫힌 것"으로 쓰면
      // 이미 마감된 봉을 다시 건드리게 된다(§ 마감된 봉은 불변).
      if (cur && cur.b < bucket) closed.push({ code, bar: cur });
      live[code] = { b: bucket, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume, ot: now, ct: now };
    } else {
      cur.h = Math.max(cur.h, bar.high);
      cur.l = Math.min(cur.l, bar.low);
      cur.c = bar.close;
      cur.v += bar.volume;
      cur.ct = now;
    }
  }
  return closed;
}

/** 닫힌 버킷을 영속 캔들 테이블로 넘기는 문장(버킷 시각을 그 버킷 것으로 그대로 쓴다).
 *
 * ⚠ `guardLastRun` 을 주면 "그 값이 아직 `spot_bot_state.last_run` 일 때만" 반영된다(§ runBotTicks 커밋).
 * 봇 커밋은 `last_run` 가드 하나로 선점과 커밋을 겸하는데, **D1 batch 는 조건부 UPDATE 가 0행이어도
 * 나머지 문장을 그대로 커밋한다**(§4 editLimit 교훈) — 가드를 커밋에만 달면 경합에서 진 쪽의 캔들이
 * 이겼을 쪽 위에 한 번 더 더해져 그 봉의 거래량이 부풀고, 1h/1d 버킷은 그 오차가 영구히 남는다.
 * volume 이 누적(합)이라 멱등이 아니기 때문이다. 그래서 같은 가드를 이 문장에도 건다.
 * ⚠ `INSERT ... SELECT ... ON CONFLICT` 는 파서가 ON 을 조인으로 볼 수 있어 **WHERE 절이 반드시**
 * 있어야 한다(SQLite 문서의 우회법) — 여기선 그 WHERE 가 곧 가드다. */
function candleFlushStmt(env: Env, pair: string, code: string, b: LiveBar, guardLastRun?: number): D1PreparedStatement {
  const ot = b.ot ?? b.b;
  const ct = b.ct ?? b.b;
  if (guardLastRun === undefined) return env.DB.prepare(CANDLE_UPSERT_SQL).bind(pair, code, b.b, b.o, b.h, b.l, b.c, b.v, ot, ct);
  return env.DB.prepare(CANDLE_FLUSH_GUARDED_SQL).bind(pair, code, b.b, b.o, b.h, b.l, b.c, b.v, ot, ct, pair, guardLastRun);
}

const CANDLE_FLUSH_GUARDED_SQL = `INSERT INTO spot_candles (pair, interval, bucket, open, high, low, close, volume, open_at, close_at)
       SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM spot_bot_state WHERE id = ? AND last_run = ?)
       ON CONFLICT(pair, interval, bucket) DO UPDATE SET
         open = CASE WHEN excluded.open_at < spot_candles.open_at THEN excluded.open ELSE spot_candles.open END,
         open_at = MIN(spot_candles.open_at, excluded.open_at),
         high = MAX(spot_candles.high, excluded.high),
         low = MIN(spot_candles.low, excluded.low),
         close = CASE WHEN excluded.close_at >= spot_candles.close_at THEN excluded.close ELSE spot_candles.close END,
         close_at = MAX(spot_candles.close_at, excluded.close_at),
         volume = spot_candles.volume + excluded.volume`;

/** 읽기 경로용 — 진행 중 버킷을 (이미 읽어온) 영속 봉 배열 뒤에 병합한다.
 * ⚠ 같은 버킷의 행이 이미 있을 수 있다(그 사이 **유저 체결**이 직접 upsert 했을 때) → 겹치면 합친다.
 * 두 쪽은 서로 다른 체결 묶음이라 volume 은 더하는 게 맞다(중복 아님).
 * ⚠ open/close 는 **시각으로** 가린다 — 커밋 경로(CANDLE_UPSERT_SQL)와 정확히 같은 규칙이어야 한다.
 * 안 그러면 버킷이 닫히는 순간(진행 중 → 테이블) 시가가 바뀌어 보인다. 진행 중인 봉은 거의 항상 봇이
 * 먼저 열었으므로(봇 틱은 버킷 맨 앞부터 돈다) 유저가 그 버킷에 시장가를 내도 시가는 그대로 유지된다. */
function mergeLiveBar(asc: CandleRow[], live: LiveBar | undefined) {
  if (!live) return asc;
  const ot = live.ot ?? live.b;
  const ct = live.ct ?? live.b;
  const last = asc[asc.length - 1];
  if (last && last.bucket === live.b) {
    if (ot < last.open_at) {
      last.open = live.o;
      last.open_at = ot;
    }
    last.high = Math.max(last.high, live.h);
    last.low = Math.min(last.low, live.l);
    if (ct >= last.close_at) {
      last.close = live.c;
      last.close_at = ct;
    }
    last.volume += live.v;
    return asc;
  }
  if (last && live.b < last.bucket) return asc; // 이미 넘어간 버킷(경합) — 무시
  asc.push({ bucket: live.b, open: live.o, high: live.h, low: live.l, close: live.c, volume: live.v, open_at: ot, close_at: ct });
  return asc;
}

/** 단일 가격 체결용 단축(진입/청산 등 개별 체결 — OHLC 가 전부 같은 가격). */
function candleUpsertOne(env: Env, pair: string, price: number, size: number, now: number): D1PreparedStatement[] {
  return candleUpsertStmts(env, pair, { open: price, high: price, low: price, close: price, volume: size }, now);
}

/** 최근 체결을 interval 버킷으로 묶어 OHLCV 를 만든다(1s 등 단기 인터벌 + 영속 캔들 폴백 전용).
 * ⚠ 봇 합성 체결은 이제 테이블이 아니라 상태 행의 링 버퍼(tape_json)에 있다(§ 봇 합성 체결 테이프) —
 * 유저 체결(spot_trades)과 병합해서 버킷팅한다. 그래서 이 함수가 볼 수 있는 과거 범위는 링 버퍼 길이
 * ((TAPE_MAX ≈ 70초)로 제한되는데, <60s 인터벌은 애초에 과거 페이지가 없고(loadSpotCandles) 기본
 * 표시가 ~38봉이라 실사용엔 영향이 없다.
 * ⚠ 유저 체결 쪽은 반드시 "가장 최신"부터(DESC 로 뽑아 ASC 재정렬) — ASC LIMIT 이면 행이 한도를 넘는
 * 순간 새 거래가 창 밖으로 밀려 차트 마지막 봉이 멈춘다. */
async function bucketTradesToCandles(env: Env, pair: string, bucketMs: number, limit: number) {
  const [stateRow, userRows] = await Promise.all([
    env.DB.prepare('SELECT tape_json FROM spot_bot_state WHERE id = ?').bind(pair).first<{ tape_json: string | null }>(),
    // ⚠ 여기도 시간 범위를 건다 — 이 경로(<60s 인터벌)는 1초 폴링이라 `LIMIT 2000` 을 그대로 두면
    // 요청 하나가 2,000행이다(시간당 720만 행!). 볼 수 있는 과거가 어차피 테이프 길이(≈3분)로 제한돼
    // 있으므로(§ 봇 합성 체결 테이프) 그보다 넉넉한 창이면 표시 결과가 같다.
    env.DB.prepare(
      'SELECT price, size, created_at FROM (SELECT price, size, created_at FROM spot_trades WHERE pair = ? AND created_at > ? ORDER BY created_at DESC LIMIT 2000) ORDER BY created_at ASC',
    )
      .bind(pair, Date.now() - TRADE_VIEW_WINDOW_MS)
      .all<{ price: number; size: number; created_at: number }>(),
  ]);
  const trades = [
    ...parseTape(stateRow?.tape_json).map((t) => ({ price: t.price, size: t.size, created_at: t.createdAt })),
    ...userRows.results,
  ].sort((a, b) => a.created_at - b.created_at);
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
export async function loadSpotCandles(
  env: Env,
  pair: string,
  intervalCode: string,
  limit: number,
  endTimeMs?: number,
  liveCtx?: LiveBars | null,
) {
  const sec = intervalSecFromCode(intervalCode);
  const bucketMs = sec * 1000;
  // ⚠ 1s 등 <60s 는 영속 테이블이 없어(최신 거래 버킷팅) 과거 페이지가 존재하지 않는다 —
  // endTime 이 오면 빈 배열을 돌려줘서 클라가 "더 없음"으로 확정하게 한다(무한 재시도 방지).
  if (sec < 60) return endTimeMs ? [] : bucketTradesToCandles(env, pair, bucketMs, limit);

  // 저장하지 않는 인터벌은 **정수배가 되는 가장 큰 저장 인터벌**에서 굴려 만든다(§ PERSIST_INTERVALS).
  // 예: 15m ← 1m 15개, 4h ← 1h 4개, 1w ← 1d 7개. 그만큼 원본 봉을 더 읽어야 하므로 limit 에 배수를 건다.
  const src = [...PERSIST_INTERVALS].reverse().find(([, s]) => sec % s === 0) ?? PERSIST_INTERVALS[0];
  const [srcCode, srcSec] = src;
  const ratio = Math.max(1, Math.round(sec / srcSec));

  // endTimeMs 가 오면 그 시각 "이전" 봉만 — 차트에서 왼쪽으로 스크롤할 때 과거 구간을 이어 받는다.
  // ⚠ 진행 중(아직 안 닫힌) 봉은 테이블이 아니라 봇 상태 행에 있다(§ live_json) → 최신 페이지일 때만
  // 같이 읽어 뒤에 붙인다. 과거 페이지(endTimeMs)엔 해당 없음.
  const [rowsRes, liveRow] = await Promise.all([
    env.DB.prepare(
      endTimeMs
        ? 'SELECT bucket, open, high, low, close, volume, open_at, close_at FROM spot_candles WHERE pair = ? AND interval = ? AND bucket < ? ORDER BY bucket DESC LIMIT ?'
        : 'SELECT bucket, open, high, low, close, volume, open_at, close_at FROM spot_candles WHERE pair = ? AND interval = ? ORDER BY bucket DESC LIMIT ?',
    )
      .bind(...(endTimeMs ? [pair, srcCode, endTimeMs, limit * ratio] : [pair, srcCode, limit * ratio]))
      .all<CandleRow>(),
    // ⚠ 통합 폴링(`?tick=`)에선 봇 틱이 방금 읽고 쓴 값을 그대로 받는다(§ TickCtx) — 같은 요청 안에서
    // 같은 행을 두 번 읽지 않는다. 과거 페이지(endTimeMs)엔 진행 중 봉이 아예 관계없다.
    endTimeMs || liveCtx
      ? Promise.resolve(null)
      : env.DB.prepare('SELECT live_json FROM spot_bot_state WHERE id = ?').bind(pair).first<{ live_json: string | null }>(),
  ]);
  const live = endTimeMs ? undefined : (liveCtx ?? parseLive(liveRow?.live_json))[srcCode];
  const asc = mergeLiveBar(rowsRes.results.reverse(), live);
  // 과거 페이지 요청인데 결과가 없으면 진짜로 더 없는 것 — 거래 버킷팅 폴백으로 최신 구간을
  // 돌려주면 클라가 "받았다"고 착각해 같은 구간을 무한히 다시 붙인다.
  if (asc.length === 0) return endTimeMs ? [] : bucketTradesToCandles(env, pair, bucketMs, limit);
  if (ratio === 1) {
    return asc.map((r) => ({ time: Math.floor(r.bucket / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }
  // 롤업 — 원본 봉을 목표 버킷으로 묶는다(open=첫 봉, close=마지막 봉, high/low=극값, volume=합).
  // 원본이 시간순(asc)이라 open/close 가 자연히 맞는다.
  const merged = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const r of asc) {
    const b = Math.floor(r.bucket / bucketMs) * bucketMs;
    const cur = merged.get(b);
    if (!cur) {
      merged.set(b, { open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
    } else {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close;
      cur.volume += r.volume;
    }
  }
  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([t, c]) => ({ time: Math.floor(t / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

// ── 봇 호가 사다리 = spot_bot_state 의 JSON 한 칸(예전엔 spot_orders 44행) ──────────────────
// ⚠⚠ 왜 테이블이 아니라 한 칸인가: 사다리는 매 틱 통째로 새로 깔리는 **스냅샷**이지 이력이 아니다.
// 그런데 44개를 44행으로 쓰면 (a)틱마다 INSERT 44문장 + DELETE 1문장이 나가 **cron 1회가 D1 쿼리
// 한도(invocation당 1,000)의 950 을 먹어** 가상코인을 하나도 더 못 늘리고 (b)하루 172만 행을 쓰고
// 지우느라 월 rows written 포함분(5,000만)을 넘긴다. 사다리를 이 JSON 한 칸에 담으면 **봇이 이미
// 갱신하고 있던 상태 UPDATE 에 컬럼 하나가 붙을 뿐**이라 문장이 0 개 늘고(틱당 70→~25), 매칭 쪽도
// "스냅샷 읽어 메모리에서 walking" 이라는 기존 패턴을 그대로 쓴다.
// 형식: {"o":액터봇id,"b":[[가격,수량],...],"a":[...]} — b=매수(가격 내림차순), a=매도(오름차순).
export interface BookLevel {
  price: number;
  size: number;
}
export interface BotBook {
  owner: string; // 이 사다리를 깐 봇(체결 시 재고/현금/수수료 정산 대상)
  bids: BookLevel[];
  asks: BookLevel[];
}

function emptyBook(): BotBook {
  return { owner: BOT_USER_IDS[0], bids: [], asks: [] };
}

/** 저장된 JSON → 사다리. 컬럼이 비었거나(마이그레이션 직후) 깨졌으면 빈 호가창으로 떨어진다 —
 * 빈 호가창이어도 시장가는 합성 흡수로 체결되고 지정가는 대기하므로, 다음 재호가(<1초)면 복구된다. */
function parseBook(json: string | null | undefined): BotBook {
  if (!json) return emptyBook();
  try {
    const o = JSON.parse(json) as { o?: string; b?: [number, number][]; a?: [number, number][] };
    return {
      owner: o.o || BOT_USER_IDS[0],
      bids: (o.b ?? []).map(([price, size]) => ({ price, size })),
      asks: (o.a ?? []).map(([price, size]) => ({ price, size })),
    };
  } catch {
    return emptyBook();
  }
}

/** 사다리 → JSON. 다 소비된 레벨(수량 0)은 빼서 호가창에 유령 가격대가 남지 않게 한다. */
function serializeBook(b: BotBook): string {
  return JSON.stringify({
    o: b.owner,
    b: b.bids.filter((l) => l.size > EPS).map((l) => [l.price, l.size]),
    a: b.asks.filter((l) => l.size > EPS).map((l) => [l.price, l.size]),
  });
}

/** 테이커가 소비할 반대편 레벨들을 가격 우선순위 순으로. limitPrice 가 있으면 그보다 불리한 레벨은 제외
 * (매도호가를 살 땐 price<=limit, 매수호가에 팔 땐 price>=limit — 최우선호가보다 유리하게는 안 체결).
 * ⚠ 반환 배열의 원소는 `book` 안의 객체를 **그대로 참조**한다 — walking 하며 `level.size -= take` 로
 * 깎으면 그 결과가 serializeBook 에 그대로 반영된다(별도 인덱스 추적 불필요). */
function makerLevels(book: BotBook, makerSide: 'buy' | 'sell', limitPrice: number | null): BookLevel[] {
  const levels = makerSide === 'sell' ? book.asks : book.bids;
  const sorted = [...levels].sort((x, y) => (makerSide === 'sell' ? x.price - y.price : y.price - x.price));
  if (limitPrice == null) return sorted;
  return sorted.filter((l) => (makerSide === 'sell' ? l.price <= limitPrice : l.price >= limitPrice));
}

const BOOK_COLS = 'book_json, book_version, tape_json';
interface BookRow {
  book_json: string | null;
  book_version: number;
  tape_json: string | null;
}

/** 소비한 사다리를 되쓴다. ⚠ `book_version` 가드 — 그 사이 재호가가 새 사다리를 깔았으면 0행이 되어
 * **옛 사다리로 덮어쓰는 사고를 막는다**. 0행이어도 체결 자체는 그대로 성립한다(봇은 무한 유동성 풀이라
 * "물량이 모자라 못 판다"가 없다) — 예전 spot_orders 시절의 best-effort 소비와 같은 관용구다. */
function bookWriteStmt(env: Env, pair: string, book: BotBook, version: number): D1PreparedStatement {
  return env.DB.prepare('UPDATE spot_bot_state SET book_json=?, book_version=book_version+1 WHERE id=? AND book_version=?')
    .bind(serializeBook(book), pair, version);
}

// ── 봇 합성 체결 테이프 = spot_bot_state.tape_json 한 칸(2026-08-01, § D1 예산) ──────────
// ⚠⚠ **D1 청구서의 유일한 항목은 "rows written" 이고, 그 79% 가 이 테이프였다.** 실측
// (`npx wrangler d1 insights ox64 --sort-by writes --timePeriod 1d`, 2026-08-01): 하루 96만 행 중
// `spot_trades` INSERT 51만 + 보존기간 DELETE 25만 = **76만 행**. 원인은 튜닝이 아니라 구조다 — 봇은
// 분당 24틱 이상을 영구히 돌고 한 틱이 3~6건을 찍으므로 **초당 ~4.5행이 영원히 INSERT** 되고, 6시간 뒤
// 같은 수만큼 DELETE 된다. D1 은 한 문장을 "바뀐 행 1 + 갱신된 인덱스 항목 수"로 세므로(암묵 PK 인덱스 포함 — 실측: spot_trades 3, 인덱스
// 2개인 fee_ledger 4) 체결 한 건의 생애비용이 ~4.5 rows written 이다.
//
// 그런데 이 테이프를 실제로 읽는 곳은 (a)호가창 "체결" 탭 최근 30건 (b)1s 등 <60s 캔들 버킷팅뿐이고,
// 차트 히스토리는 `spot_candles` 가 따로 영구 보관한다 → 이건 **이력 테이블이 아니라 최근 N건짜리 링
// 버퍼**다. 행으로 쪼갤 이유가 없으므로 `book_json` 과 똑같이 상태 행의 JSON 한 칸에 담는다: 봇이 어차피
// 매 틱 UPDATE 하던 행이라 **테이프의 쓰기 비용이 통째로 0** 이 된다(rows written 은 행 수만 세고 바이트는
// 세지 않으므로, 10KB JSON 을 매 틱 덮어써도 1행이다). 보존기간 DELETE 도 함께 사라진다(링 버퍼는 넘치는
// 쪽이 자동으로 잘려나가므로 "누가 이 행을 지우는가" 문제 자체가 없다 — § 봇이 만드는 행은 쌓이면 안 된다).
//
// ⚠ **유저 체결은 계속 `spot_trades` 에 남긴다** — 사람이 내는 주문은 하루 수백 건 규모라 비용이 없고,
// 체결 원장으로서의 가치(누가 언제 무엇을)는 그대로다. 그래서 읽는 쪽은 **둘을 시간순으로 병합**한다
// (`mergeRecentTrades`). 새 체결 경로를 추가할 때: 봇이 만드는 것이면 테이프에, 유저 것이면 테이블에.
export interface TapeTrade {
  price: number;
  size: number;
  takerSide: 'buy' | 'sell' | null;
  createdAt: number;
}

// 링 버퍼 길이 — 1s 캔들이 이 테이프를 버킷팅해 만들어지므로 "몇 초치까지 그릴 수 있나"를 정한다.
// 봇이 초당 ~10건을 찍으므로 700건 ≈ 70초 ≈ 1s 봉 70개(차트 기본 표시가 ~38봉이라 넉넉하다. <60s 는
// 애초에 과거 페이지가 없어 스크롤로 더 받아올 수도 없다 — loadSpotCandles 참고).
// ⚠ 늘려도 rows written 은 그대로 1행이지만(비용 무관) 매 틱 직렬화/파싱하는 바이트가 커진다.
const TAPE_MAX = 700;

/** JSON → 테이프. 컬럼이 비었거나(마이그레이션 직후) 깨졌으면 빈 배열 — 봇이 다음 틱부터 다시 채운다. */
function parseTape(json: string | null | undefined): TapeTrade[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as [number, number, number, number][];
    if (!Array.isArray(arr)) return [];
    return arr.map(([price, size, taker, createdAt]) => ({
      price,
      size,
      takerSide: taker === 1 ? 'buy' : taker === 0 ? 'sell' : null,
      createdAt,
    }));
  } catch {
    return [];
  }
}

/** 테이프 → JSON(최근 TAPE_MAX 건만). 배열의 배열로 담아 키 이름이 매 건 반복되지 않게 한다. */
function serializeTape(trades: TapeTrade[]): string {
  return JSON.stringify(
    trades.slice(-TAPE_MAX).map((t) => [t.price, t.size, t.takerSide === 'buy' ? 1 : t.takerSide === 'sell' ? 0 : -1, t.createdAt]),
  );
}

// ── 유저 체결은 "한 줄"이 아니라 walking 한 만큼 여러 줄로 찍는다(2026-09-03) ─────────────
// ⚠ 예전엔 시장가 한 방을 **1건으로 집계**해 찍었다(체결 테이프에 "3,000,000개" 한 줄, 가격은 마지막
// 체결가). 실제 거래소는 maker 주문 하나하나가 별도 체결로 인쇄되므로 사다리를 walking 하면 그 단계
// 수만큼 줄이 생긴다("내 시장가가 체결창에 합쳐서 나온다" 제보). 집계했던 이유는 **순전히 비용**이다 —
// `spot_trades` INSERT 는 1건이 **3 rows written**(행 1 + 암묵 PK + 인덱스, §6 과금 모델)이라 실사다리
// 22단계 + 합성 24스텝을 전부 찍으면 체결 하나가 138행이 된다. 봇 테이프처럼 JSON 링 버퍼에 얹으면
// 공짜지만(§ 봇 합성 체결 테이프) 그 칸은 봇이 매 틱 통째로 덮어써서 **유저 체결이 몇 %는 사라진다** —
// 자기 매매가 체결창에 안 보이는 건 표시용 손실로 넘길 수 없다. 그래서 행으로 찍되 **줄 수를
// 상한으로 묶는다**: 작은 주문은 예전처럼 1~3줄이고, 아무리 큰 주문도 USER_PRINT_MAX 줄에서 멈춘다.
//
// ⚠⚠ **상한 6 → 20 (2026-09-07)**: 6줄은 사다리 22단계 + 합성 24스텝(최대 46개 가격대)을 8개씩 묶어
// 버려서, 대량 시장가의 체결창이 "가격이 걸어간 모습"이 아니라 뭉개진 6칸으로만 보였다("대량매매했을 때
// 6개까지밖에 안 뜬다"). 20줄이면 46개 가격대를 3개씩 묶는 정도라 sweep 의 모양이 그대로 남는다.
// ⚠ 비용은 이 줄 수에 그대로 비례하므로(줄 하나 = 3 rows written) 계량 단가도 **실제 찍은 줄 수**로
// 넘긴다(§ _budget.rowsForFill) — flat 단가를 20줄 기준으로 올리면 1~3줄뿐인 평범한 체결까지 3배로
// 과대 계상돼 차단선이 이유 없이 먼저 걸린다. 사람 손으로 내는 주문은 하루 수백 건 규모라(자동 반복
// 경로가 아니다) 실사용 증가분은 무료 한도(8만/일)의 1% 미만이다.
const USER_PRINT_MAX = 20;

/** walking 체결들을 화면에 찍을 프린트로 묶는다. 같은 가격은 한 줄로 합치고(사다리 한 단계 = 한 체결),
 * 그래도 상한을 넘으면 **연속 구간**을 가중평균가로 묶는다(가격이 걸어간 순서는 그대로 유지된다). */
function splitPrints(fills: { price: number; size: number }[], max = USER_PRINT_MAX): { price: number; size: number }[] {
  const merged: { price: number; size: number }[] = [];
  for (const f of fills) {
    if (!(f.size > EPS)) continue;
    const last = merged[merged.length - 1];
    if (last && last.price === f.price) last.size += f.size;
    else merged.push({ price: f.price, size: f.size });
  }
  if (merged.length <= max) return merged;
  // ⚠ 묶을 때는 **정확히 max 칸**으로 나눈다(2026-09-08). 예전엔 `per = ceil(n/max)` 로 구간 크기를 먼저
  // 정하고 그 크기로 잘랐는데, 그러면 줄 수가 `ceil(n/per)` 로 떨어져 **상한의 절반 언저리가 된다** —
  // 실측(prod 시장가 33건): 46개 가격대 → per=3 → **16줄**로, 상한을 6→20 으로 올렸는데도 20줄이
  // 나오는 경우가 없었다("20건인데 적게 나온다" 제보). n=21 이면 per=2 → 11줄로 절반이 되는 것도 같은 이유다.
  // 인덱스를 균등 분할하면 구간 크기가 1 차이로 섞이면서 줄 수는 항상 max 이다.
  const out: { price: number; size: number }[] = [];
  for (let k = 0; k < max; k++) {
    const chunk = merged.slice(Math.floor((k * merged.length) / max), Math.floor(((k + 1) * merged.length) / max));
    if (chunk.length === 0) continue; // merged.length > max 이라 생기지 않지만 방어적으로
    const size = chunk.reduce((a, c) => a + c.size, 0);
    const cost = chunk.reduce((a, c) => a + c.price * c.size, 0);
    out.push({ price: size > EPS ? roundOx(cost / size) : chunk[0].price, size });
  }
  return out;
}

/** 한 INSERT 문장에 넣는 체결 행 수 — **D1 바운드 파라미터 상한이 쿼리당 100개**라 8컬럼 × 12행 = 96 이 최대다. */
const TRADE_INSERT_ROWS = 12;

/** 프린트들을 `spot_trades` 행으로. ⚠ 시각을 1ms 씩 벌려 찍는다(마지막이 정확히 now) — 같은 ms 에 몰면
 * (a)정렬이 불안정해 walking 순서가 화면에서 뒤섞이고 (b)클라가 새 체결을 **시각**으로 식별하므로
 * (useTradingStore.dripTrades) 한 건만 새 것으로 보고 나머지를 흘려보내지 않는다. 1ms 씩이라 캔들
 * 버킷은 그대로다(§ 체결 시각은 소급하지 않는다 — 여기서도 미래로는 절대 안 찍는다).
 *
 * ⚠⚠ **한 줄에 한 문장이 아니라 다중행 INSERT 다(2026-09-08, "시장가가 가끔 씹힌다" 수정)**: 무료 플랜은
 * **invocation 하나당 D1 쿼리 50개**가 상한이고 `DB.batch` 는 문장 하나하나가 그 1개로 잡힌다(§6). 프린트
 * 상한을 6→20 으로 올린 순간 시장가 한 방의 문장 수가 그만큼 늘어, 실측 기준 한 요청이 47~51 쿼리가 되어
 * **주문 크기·보유 심볼 수에 따라 어떤 날은 넘고 어떤 날은 안 넘는** 상태가 됐다(= "가끔" 씹힌다). 넘으면
 * batch 가 통째로 던져지는데 잔고 차감(charge)은 그 앞에서 이미 확정되므로 **증거금만 나가고 포지션은 안
 * 생긴다** — 표시 문제가 아니라 돈 문제다. 다중행으로 묶으면 20줄이 **문장 2개**가 되어(행 수·과금은 동일)
 * 같은 요청이 30 쿼리 아래로 내려간다. ⚠ 줄 수를 더 늘리더라도 여기 문장 수는 12줄당 1개씩만 는다. */
function userTradeStmts(
  env: Env,
  pair: string,
  prints: { price: number; size: number }[],
  buyerId: string,
  sellerId: string,
  tapeSide: 'buy' | 'sell',
  now: number,
): D1PreparedStatement[] {
  const n = prints.length;
  const stmts: D1PreparedStatement[] = [];
  for (let off = 0; off < n; off += TRADE_INSERT_ROWS) {
    const chunk = prints.slice(off, off + TRADE_INSERT_ROWS);
    const binds: unknown[] = [];
    chunk.forEach((t, k) => {
      binds.push(crypto.randomUUID(), pair, buyerId, sellerId, t.price, t.size, tapeSide, now - (n - 1 - (off + k)));
    });
    stmts.push(
      env.DB.prepare(
        `INSERT INTO spot_trades (id,pair,buyer_id,seller_id,price,size,taker_side,created_at) VALUES ${chunk
          .map(() => '(?,?,?,?,?,?,?,?)')
          .join(',')}`,
      ).bind(...binds),
    );
  }
  return stmts;
}

/** 표시·버킷팅용 최근 체결 = 봇 테이프(JSON) + 유저 체결(spot_trades) 을 시간순으로 병합.
 * ⚠ 테이프 항목엔 행 id 가 없으므로 (시각, 인덱스) 로 합성 키를 만든다 — 리스트 렌더 key 용도라 유일하면 된다.
 *
 * ⚠⚠ **유저 체결은 상한에 걸려도 잘라내지 않는다(2026-09-08)**: 예전엔 둘을 합쳐 시간순 상위 `limit`(50)만
 * 남겼는데, 봇 한 틱이 몰리면(flurry) 프린트를 최대 40건까지 찍으므로 그 틱 하나가 창의 대부분을 먹고 **유저
 * 시장가 한 방의 프린트 16~20줄 중 뒤쪽이 통째로 잘려나갔다**. 게다가 클라는 새 체결을 시각으로만 식별해
 * (`t.time > lastAt`) **한 번 잘린 프린트는 다음 폴링에 다시 실려도 영영 화면에 안 나온다** — 자기 매매가
 * 체결창에서 사라지는 건 표시용 손실로 넘길 수 없다(§ userTradeStmts 와 같은 판단). 유저 체결은 위 SQL 이
 * 이미 `LIMIT 30` 으로 묶여 있으므로 전부 실어도 목록이 30+limit 을 넘지 않고, **테이프는 상태 행 안의 JSON
 * 이라 몇 건을 담든 D1 읽기가 늘지 않는다**(요청·쓰기 증가 0 — 응답 바이트만 조금 는다). */
function mergeRecentTrades(
  tape: TapeTrade[],
  userRows: SpotTradeRow[],
  limit: number,
): { id: string; price: number; size: number; takerSide: 'buy' | 'sell' | null; createdAt: number }[] {
  const userItems = userRows.map((r) => ({
    id: r.id,
    price: r.price,
    size: r.size,
    takerSide: (r.taker_side as 'buy' | 'sell' | null) ?? null,
    createdAt: r.created_at,
  }));
  // 테이프는 오래된 것부터 쌓이므로(append) 뒤쪽이 최신 — 남은 자리만큼 뒤에서 가져온다.
  const tapeItems = tape.map((t, i) => ({
    id: `t${t.createdAt}-${i}`,
    price: t.price,
    size: t.size,
    takerSide: t.takerSide,
    createdAt: t.createdAt,
  }));
  // ⚠ `slice(-0)` 은 배열 전체를 돌려준다 — room 이 0 이면 명시적으로 빈 배열이어야 한다.
  const room = Math.max(0, limit - userItems.length);
  return [...userItems, ...(room > 0 ? tapeItems.slice(-room) : [])].sort((a, b) => b.createdAt - a.createdAt);
}

/** 호가창·체결내역 "표시용" 데이터 — 특정 유저의 개인 데이터가 아니라 시장 전체를 보여준다.
 * ⚠ 유저가 OX 에 건 지정가 주문(pending_orders, "미체결" 탭)은 봇 호가(spot_orders)와 완전히
 * 다른 테이블이라 그냥 두면 호가창에 절대 안 나타난다("내가 건 매수가 호가에 안 보인다" 버그의
 * 근본 원인) — 그래서 두 테이블을 UNION 해서 같은 가격대끼리 합산한다. long 지정가=매수 호가,
 * short 지정가=매도 호가. pending_orders 는 취소/체결되면 즉시 그 행이 사라지므로(order.ts/
 * _trading.ts) 별도 동기화 없이 항상 최신 상태가 자동으로 반영된다. */
/** `pending_orders` 한 행(그 페어의 대기 지정가). 한 요청 안에서 **세 군데가 같은 목록을 쓴다** —
 * 봇 틱의 "유저 벽" 판정 · 재호가 직후 sweep · 호가창 표시. 예전엔 셋이 각자 같은 테이블을 다시 읽어
 * `?tick=` 요청 하나가 이 테이블을 **세 번 스캔**했다(§6 "같은 걸 반복해서 다시 읽지 않는다"). */
export interface PendingLite {
  id: string;
  user_id: string;
  side: string;
  price: number;
  size: number;
  reduce_only: number;
  last_fill_at: number | null;
}

/** 통합 폴링(`/api/state?tick=`) 한 요청 안에서 조회 결과를 물려주는 컨텍스트.
 *
 * ⚠ **`null` 은 "모른다"는 뜻이고, 받는 쪽은 그때만 D1 을 읽는다.** 봇 커밋이 경합에서 졌거나
 * sweep 이 실제로 체결을 냈으면 우리가 들고 있는 사다리·대기목록이 이미 낡았으므로 반드시 null 로
 * 되돌려야 한다 — 낡은 스냅샷을 그대로 그리면 호가창에 이미 체결된 물량이 1초 더 남는다. */
export interface TickCtx {
  book: BotBook | null;
  tape: TapeTrade[] | null;
  pendings: PendingLite[] | null;
  // ⚠ 아래 둘도 **같은 상태 행에서 나온다**(2026-09-02, 4차 다이어트). 예전엔 `?tick=` 요청 하나가
  // `spot_bot_state` 를 세 번 읽었다 — 봇 틱(전체 행) · loadSpotCandles(live_json) · fetchPrice(ref_price).
  // 봇 틱이 방금 읽고 쓴 값을 그대로 넘기면 뒤의 둘이 사라진다(값도 오히려 정확하다 — 재조회는 방금
  // 커밋한 값을 다시 읽는 것뿐이다).
  live: LiveBars | null; // 진행 중(안 닫힌) 캔들 버킷들 — 차트의 마지막 봉
  ref: number | null; // 이 틱 뒤의 기준가 = OX 체결가 소스
}

/** 대기 지정가 목록 → 가격대별 합계(봇의 "유저 벽" 판정용). 예전엔 이걸 SQL `GROUP BY` 로 따로 읽었다. */
function wallsOf(pendings: PendingLite[]): WallRow[] {
  const m = new Map<string, WallRow>();
  for (const p of pendings) {
    const k = `${p.side}|${p.price}`;
    const cur = m.get(k);
    if (cur) cur.size += p.size;
    else m.set(k, { side: p.side, price: p.price, size: p.size });
  }
  return [...m.values()];
}

export async function loadSpotMarket(env: Env, uid: string, pair: string, ctx?: TickCtx) {
  // `mine` = 그 가격대에 이 유저가 걸어둔 물량. 호가창에서 내 주문을 티나게 표시하려면 합계만으론
  // 알 수 없어서(봇 물량과 섞임) 유저 소유분을 따로 합산해 내려준다.
  // ⚠ 예전엔 봇 호가(spot_orders)와 유저 지정가(pending_orders)를 SQL 에서 UNION ALL 로 합쳤는데,
  // 봇 사다리가 JSON 한 칸으로 옮겨간 뒤로는 **봇 쪽은 메모리에서** 합친다(§ BotBook). 유저 지정가는
  // 여전히 테이블이라 SQL 로 가격대별 집계만 받아온다.
  // ⚠ `ctx` 가 있으면 **그 요청의 봇 틱이 이미 읽어둔 값**을 그대로 쓴다(2026-08-26) — 통합 폴링에서
  // 상태 행과 `pending_orders` 를 각각 두 번·세 번 읽던 것을 한 번으로 줄인다(§ PendingLite).
  const [stateRow, pendingRows, tradeRows] = await Promise.all([
    ctx?.book && ctx.tape
      ? Promise.resolve(null)
      : env.DB.prepare(`SELECT ${BOOK_COLS} FROM spot_bot_state WHERE id = ?`).bind(pair).first<BookRow>(),
    ctx?.pendings
      ? Promise.resolve(null)
      : env.DB
          .prepare(
            `SELECT side, limit_price AS price, SUM(size) AS size, SUM(CASE WHEN user_id = ? THEN size ELSE 0 END) AS mine
         FROM pending_orders WHERE symbol = ? GROUP BY side, limit_price`,
          )
          .bind(uid, pair)
          .all<{ side: string; price: number; size: number; mine: number }>(),
    // ⚠ **시간 범위를 함께 건다**(2026-08-14). 이 조회는 1초마다 도는데 `LIMIT 30` 만 있으면 인덱스를
    // 30행 걸어가므로 **항상 30행**을 읽는다(시간당 10.8만 행 — state 다음으로 큰 읽기였다). 그런데 이
    // 테이블에 남는 건 **유저 체결뿐**이고(봇 합성 체결은 tape_json 링 버퍼로 갔다, § 봇 합성 체결 테이프)
    // 아래 mergeRecentTrades 가 테이프와 합쳐 상위 30건만 쓰므로, 실제로 화면에 낄 수 있는 유저 체결은
    // 최근 것뿐이다. 범위를 주면 `(pair, created_at)` 인덱스가 그 구간만 읽어 평상시 0~3행이 된다.
    // LIMIT 은 그대로 둬서 **어떤 경우에도 예전보다 많이 읽지 않는다**(구간에 30건 넘게 있어도 30에서 멈춤).
    env.DB.prepare('SELECT * FROM spot_trades WHERE pair = ? AND created_at > ? ORDER BY created_at DESC LIMIT 30')
      .bind(pair, Date.now() - TRADE_VIEW_WINDOW_MS)
      .all<SpotTradeRow>(),
  ]);

  const book = ctx?.book ?? parseBook(stateRow?.book_json);
  // ctx 로 받은 원본 목록은 가격대별로 여기서 합산한다(SQL GROUP BY 를 대신).
  const userLevels =
    pendingRows?.results ??
    (() => {
      const m = new Map<string, { side: string; price: number; size: number; mine: number }>();
      for (const p of ctx!.pendings!) {
        const k = `${p.side}|${p.price}`;
        const cur = m.get(k);
        if (cur) {
          cur.size += p.size;
          cur.mine += p.user_id === uid ? p.size : 0;
        } else {
          m.set(k, { side: p.side, price: p.price, size: p.size, mine: p.user_id === uid ? p.size : 0 });
        }
      }
      return [...m.values()];
    })();
  // 같은 가격대는 봇/유저 물량을 합산해 한 줄로(예전 SQL 의 GROUP BY price 와 동일).
  const merge = (levels: BookLevel[], userSide: string, desc: boolean) => {
    const acc = new Map<number, { price: number; size: number; mine: number }>();
    const add = (price: number, size: number, mine: number) => {
      const cur = acc.get(price);
      if (cur) {
        cur.size += size;
        cur.mine += mine;
      } else {
        acc.set(price, { price, size, mine });
      }
    };
    for (const l of levels) if (l.size > EPS) add(l.price, l.size, 0);
    for (const p of userLevels) if (p.side === userSide) add(p.price, p.size, p.mine);
    return [...acc.values()].sort((a, b) => (desc ? b.price - a.price : a.price - b.price)).slice(0, BOOK_LIMIT);
  };
  const bids = merge(book.bids, 'long', true);
  const asks = merge(book.asks, 'short', false);

  return {
    book: { bids, asks },
    // 봇 합성 체결은 상태 행의 링 버퍼(tape_json), 유저 체결은 테이블 — 시간순으로 합쳐 최근 50건
    // (클라 표시 개수 상한과 동일). ⚠ 위 SQL 의 `LIMIT 30` 은 일부러 그대로 둔다 — 테이프는 상태 행 안의
    // JSON 이라 몇 건을 쓰든 읽기가 안 늘지만, 테이블 쪽을 늘리면 그만큼 D1 읽기가 늘어난다(1초 폴링).
    // 한 시간 안에 유저 체결이 30건을 넘는 드문 경우에만 그 뒤쪽이 목록에서 빠진다.
    trades: mergeRecentTrades(ctx?.tape ?? parseTape(stateRow?.tape_json), tradeRows.results, 50),
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
// ⚠ 봇 호가는 잔고 에스크로를 하지 않는다 — 호가를 걸 때 잠그고 취소할 때 환불하는 왕복이 틱마다
// 수십 번씩 나가는데, 봇은 무한 유동성 공급자라 "돈이 모자라 호가를 못 깐다"는 상태가 애초에 없다.
// 유저↔봇 체결의 물량 소비만 조건부 UPDATE 로 원자 처리하면 된다(matchLimitPendingAgainstBook 등).
// 단, **체결된 뒤의 재고/현금 정산은 한다**(botFillStmts) — 에스크로(사전 잠금)와 달리 이미 도는
// batch 에 문장 하나가 얹힐 뿐이라 왕복이 늘지 않고, 그래야 봇 잔고가 실제 매매를 반영한다.
// 정산에 잔고 가드는 없다(무한 풀 — 음수 허용). 봇은 랭킹에서 제외되므로 이 숫자가 순위를 흔들지 않는다.
// 재호가(requote) 주기 — 짧을수록 기준가·호가·체결 테이프가 자주 갱신되고, 크로스되는 유저 주문이
// 그만큼 빨리 체결된다(sweepRestingOxPendings 가 매 재호가 직후 도므로). 체결 딜레이를 줄이려고
// 3~8s → 0.9~2.2s → 0.45~1.1s 로 단계적으로 낮췄다 — runMarketMaker 는 /api/spot 폴링 시점에만 불리므로
// 실질 주기는 max(게이트, 폴링간격)이고, 프론트 폴링(useSpotPoll)도 1s 라 게이트가 그보다 낮으면
// 사실상 "매 폴링(1s)마다 재호가+대기 지정가 sweep" → OX 를 보고 있으면 지정가가 ~1초 안에 체결된다.
// ⚠ 상한은 프론트 폴링 간격(1s)보다 **낮게** 유지할 것. 1100ms 였을 때는 게이트가 1000ms 를 넘게
// 뽑히는 ~15% 의 폴링이 아무 일도 못 하고 돌아가(now-last < gate) 호가·체결·기준가가 그 초에 멈춰
// 보였다("1초마다 갱신"이 아니라 가끔 2초). 950ms 면 1초 폴링은 항상 통과한다. 하한(450ms)은 그대로 —
// 동시 접속이 많을 때의 **최대 틱 레이트(=쓰기 상한)** 를 정하는 값이라 건드리면 예산이 흔들린다.
const BOT_TICK_MIN_MS = 450;
const BOT_TICK_MAX_MS = 950;
// 한 틱에 까는 매수/매도 각각의 호가 단계 수(호가창 깊이).
// ⚠ 봇 계정이 2개뿐이라 "여러 사람이 만든 시장"처럼 보이려면 계정 수가 아니라 **한 봇이 촘촘하게
// 여러 개를 까는 것**으로 밀도를 만들어야 한다(계정을 늘려도 spot_orders 행이 늘 뿐 화면상 차이는
// 같다 — 호가창은 가격대별 합계만 보여주므로). 8단계는 스프레드 근처 몇 줄만 차서 휑했다.
const BOT_LEVELS_PER_SIDE = 22;

// ⚠ 한 틱에 찍는 합성 체결의 개수·평균 크기 — 예전엔 5~45 짜리 1건이라 캔들 거래량이 수백에 그쳤다
// ("봇이 쫄보"). 실제 시장처럼 보이도록 매 틱 여러 건을 찍는다(테이프도 붐비고 거래량도 유의미).
// 아래 심리 모델이 국면·변동성에 따라 이 값에 배수를 걸어 "패닉엔 거래량 폭증, 잔잔할 땐 한산"을 만든다.
//
// ⚠⚠ 크기는 **평균값 하나**만 정하고 실제 수량은 `orderSize` 의 계층 분포에서 뽑는다(2026-08-31).
// 예전엔 `uniform(1000, 8000)` 이라 체결 수량이 죄다 네 자리에 뭉쳐 있어서 **개미와 세력이 구분되지
// 않았다**("수량이 네 자리 아니면 다섯 자리로만 나온다" 제보) — 실제 테이프는 100개짜리와 20만개짜리가
// 섞여 흐른다. 겸사겸사 **건수를 2배로 늘리고 평균 크기를 절반으로** 낮췄다: 개미 체결이 실제로 보이려면
// 건수가 있어야 하고, 곱이 그대로라 **캔들 거래량(=차트 히스토그램 스케일)은 변하지 않는다**.
// 테이프는 링 버퍼 JSON 이라 건수를 늘려도 D1 쓰기·읽기는 그대로 1행이다(§6).
const BOT_TRADES_PER_TICK_MIN = 6;
const BOT_TRADES_PER_TICK_MAX = 14;
// ⚠ 2,250 이 아니라 2,370 인 이유: 건수 clamp 상한이 12 → 26 으로 바뀌어 거래량이 폭증하는 국면
// (sizeMult > 6.8)에서 옛 공식보다 5% 낮게 잘린다. 같은 심리 경로로 대조해 그만큼 올려 맞췄다
// (실측 틱당 거래량 전 95,049 → 후 94,9xx). 캔들 거래량이 배포 전후로 달라 보이면 안 된다.
const BOT_TRADE_MEAN = 2370;
// ── 체결 미세구조(테이프) 파라미터 ─────────────────────────────────────────
/** 한 틱이 찍을 수 있는 체결 건수 상한. 테이프는 상태 행의 JSON 링 버퍼라 **건수를 늘려도 D1 쓰기·읽기는
 * 1행 그대로**다(§6). 상한을 26 → 40 으로 올린 건 아래 군집(flurry)의 꼬리를 자르지 않기 위한 것이다
 * (자르면 평균이 깎여 캔들 거래량이 조용히 줄어든다). */
const PRINTS_PER_TICK_MAX = 40;
/** 체결 도착의 군집 — 낮은 확률로 몰리는 틱. ⚠ FLURRY_MEAN 으로 나눠 **기대 건수는 불변**으로 둔다. */
const FLURRY_CHANCE = 0.18;
const FLURRY_MULT = 2.05;
const LULL_MULT = 0.77;
const FLURRY_MEAN = FLURRY_CHANCE * FLURRY_MULT + (1 - FLURRY_CHANCE) * LULL_MULT;
/** 주문 쪼개기(아이스버그·TWAP) — 큰 주문 하나를 잘게 나눠 **같은 방향·비슷한 수량**으로 연달아 낸다.
 * 실제 테이프에서 "지금 누가 계속 사고 있다"를 알아보는 가장 흔한 단서다(2,384 / 2,391 / 2,384 / 2,370 …).
 * 예전엔 매 프린트가 완전히 독립 추출이라 고래 한 건 뒤에 개미 한 건이 오는 식이어서, 테이프를 아무리
 * 들여다봐도 **한 사람의 의도가 이어지는 모습**이 없었다(사람이 아니라 주사위가 내는 주문처럼 보였다).
 * ⚠⚠ 쪼갤지 말지는 **뽑힌 수량과 무관하게** 정해야 한다 — "큰 주문일 때만 쪼갠다"로 조건을 걸면 자식
 * 프린트의 주변분포가 큰 쪽으로 조건화돼(E[크기 | 큰 주문] > 평균) **캔들 거래량이 조용히 늘어난다**
 * (§ "평균 보존" 불변식). 무조건 뽑으면 각 프린트의 주변분포가 그대로 `orderSize` 라 총량이 정확히
 * 보존되고, 자식 절반은 개미 크기(= 손으로 여러 번 누르는 사람)·40건에 1건은 고래의 분할 매집이 된다.
 * ⚠ 예전의 `FLOW_PERSIST`(같은 방향이 이어질 확률 0.2)는 사실 이 현상의 **조잡한 대용품**이었다 —
 * "왜 같은 방향이 이어지는가"를 설명하지 못한 채 숫자만 있었다. 원인을 모델에 넣었으므로 그 상수는
 * 아예 지웠다(방향은 매 건 국면 편향 `buyProb` 에서 새로 뽑고, 이어짐은 부모 주문이 만든다). 실측
 * 전환율은 28.2% → 25.8% 로 실제 테이프 수준(25~40%)을 유지한다. */
const SLICE_CHANCE = 0.2;
const SLICE_MIN = 2;   // 자식 최소 건수
const SLICE_RAND = 4;  // 자식 수 = SLICE_MIN + floor(rand × SLICE_RAND)
const SLICE_JITTER = 0.12; // 자식끼리의 크기 흔들림(완전히 똑같으면 그것도 기계적이다)
/** 최우선 매수/매도호가의 half-spread — 사다리 최상단(level 0 ≈ 0.0008)과 같은 자리에 찍히게 맞춘다. */
const MICRO_HALF_SPREAD = 0.0006;
/** 큰 체결이 사다리를 파고드는 깊이 계수(수량 √배에 비례)와 그 상한. */
const MICRO_DIG = 0.0009;
const MICRO_DIG_MAX = 0.008;
/** 틱 안의 mid(호가 중간값)가 목표 가격 경로를 따라가는 속도.
 * ⚠⚠ mid 를 **상태로 들고 흐름이 밀도록** 해야 한다(2026-09-07). 처음엔 매 체결마다 목표 경로에서
 * 곧바로 `walk × (1 ± 스프레드)` 를 계산했는데, 그러면 큰 매수가 파고든 뒤 다음 작은 매수가 **더 낮은
 * 가격**에 찍혀 "상승틱인데 빨강"이 된다(실측 라벨-가격 불일치 18.7%). 실제 사다리는 소비된 만큼
 * 최우선호가가 밀려 있고 마커가 채워 넣을 때까지 그 자리를 유지한다 — 그래서 밀린 mid 를 들고 다니며
 * 목표 경로가 그걸 서서히 되돌리게 한다. 같은 방향 체결이 이어지면 가격은 **단조**로 걸어간다. */
const MICRO_MID_FOLLOW = 0.35;
/** 스톱 헌팅(꼬리) — 틱당 발생 확률과 크기(실효 변동성 배수). */
const HUNT_CHANCE = 0.012;
const HUNT_MIN = 0.0018;
const HUNT_RAND = 0.006;
/** 틱 내부 체결 시각을 펼 창(ms)과 틱 사이의 최소 간격. ⚠ **창 ≤ 간격** 이어야 한다 — 넘으면 다음 틱의
 * 체결과 시각이 뒤섞여 테이프 정렬이 깨진다(예전 `now + i` 는 건수가 11 을 넘으면 그렇게 됐다). */
const TICK_PRINT_SPAN_MS = 10;
const TICK_SPACING_MS = 10;
/** 틱 시각 출발점이 벽시계보다 앞설 수 있는 한도(§ runBotTicks). */
const TS_SEED_MAX_AHEAD_MS = 2000;
/** 호가 한 단계(가격대)의 평균 물량 — 이것도 여러 주문의 합으로 만든다(아래 placeQuote). */
const BOOK_LEVEL_MEAN = 6450;
// ── 호가창의 지속(resting)과 취소(cancel) ─────────────────────────────────────
/** 최우선호가 근처 / 가장 깊은 자리의 주문이 이 틱에 **취소·재호가될 확률**. 사람이 만드는 호가창엔
 * 성격이 다른 두 종류가 섞여 있다 — 초 단위로 넣고 빼는 마켓메이커(최우선호가 경쟁)와, 걸어두고
 * 기다리는 지정가(깊은 자리, 몇 분씩 그대로 앉아 있다). 예전엔 매 틱 사다리를 통째로 새로 뽑아서
 * 사실상 **둘 다 100%** 였다(§ simulateTick 사다리). */
const QUOTE_CHURN_TOP = 0.55;
/** 사다리의 기하 — 최우선호가 스프레드 / 레벨 간격 / 레벨마다 실리는 지터. ⚠ 슬롯 귀속 판정
 * (§ placeQuote)이 이 값들로 구간을 계산하므로 **한 곳에만** 적는다: 예전엔 목표가 계산과 최대 거리
 * 계산이 각자 0.0006/0.00055/0.0004 를 적고 있어서, 한쪽만 고치면 살아있는 주문이 조용히 버려진다. */
const SPREAD_BASE = 0.0006;
const LEVEL_STEP = 0.00055;
const LEVEL_JITTER = 0.0004;
const LEVEL_HALF_STEP = LEVEL_STEP / 2;
const QUOTE_CHURN_DEEP = 0.06;
/** 살아남은 주문의 물량이 조금 바뀔 확률·폭(일부 취소 / 같은 자리에 추가 주문).
 * ⚠ 배수의 평균이 정확히 1 이어야 총 유동성이 보존된다. */
const QUOTE_RESIZE_CHANCE = 0.3;
const QUOTE_RESIZE_RAND = 0.22;
const BOT_BURST_TICKS = 12; // cron 이 접속 유무와 무관하게 한 번에 몰아 돌리는 틱 수(시장이 계속 살아있게)
// ⚠ cron 백오프 — "마지막 재호가가 이만큼 이내면 유저 폴링이 클럭 역할을 하는 중"으로 본다.
// /api/spot 폴링은 1초 주기라 보고 있는 동안엔 last_run 이 항상 몇 초 이내다. 반대로 cron 이 직접 찍은
// last_run 은 다음 cron 때 60초 전이므로 두 경우가 섞이지 않는다.
const POLL_ACTIVE_MS = 20_000;
const BURST_MIN_TICKS = 4; // 폴링이 돌고 있을 때 cron 이 얹는 최소 틱(cron 라운드당 1틱)

/**
 * cron 이 이번 실행에서 마켓메이커에 쓸 총 틱 수 — 유저 폴링이 이미 클럭 역할을 하고 있으면 최소치로.
 * ⚠⚠ 이 판정은 **cron 실행당 정확히 한 번만** 해야 한다. 예전엔 `runMarketMakerBurst` 안에서 라운드마다
 * 했는데, 그 함수는 끝날 때 `last_run` 을 찍으므로 **다음 라운드가 "방금 누가 폴링했네"로 오판**해서
 * cron 이 아무도 없을 때도 스스로 물러났다(실측: 분당 12틱이어야 할 것이 4~9틱). 라운드 사이 간격이
 * 밀리초라 시각만으로는 "cron 자신"과 "유저 폴링"을 구분할 수 없다 — 그래서 루프 밖에서 한 번 정한다.
 */
export async function marketMakerTickBudget(env: Env, pair: string, budget: number): Promise<number> {
  const row = await env.DB.prepare('SELECT last_run FROM spot_bot_state WHERE id = ?').bind(pair).first<{ last_run: number }>();
  const idleMs = Date.now() - (row?.last_run ?? 0);
  return idleMs < POLL_ACTIVE_MS ? Math.min(budget, BURST_MIN_TICKS) : budget;
}

// ⚠ 봇이 시장을 만드는 가상 페어 목록 — **여기가 유일한 진실원본**이다. 새 가상 코인을 추가하려면
// (1) 이 배열에 심볼을 넣고 (2) `src/symbols.ts VIRTUAL_SYMBOLS` 에도 같은 심볼을 넣고 (3) D1 에
// `spot_bot_state` 시작가 행을 하나 만들면 끝이다(§5 마이그레이션). 봇 상태·사다리·캔들·체결·재고가
// 전부 pair 로 키가 잡혀 있어 그 외에 손댈 곳이 없다.
// ⚠ 동시에 **cron 틱 예산을 나누는 기준**이기도 하다(cron/index.ts MM_TICK_BUDGET) — 코인마다 틱을
// 곱하면 D1 쓰기와 invocation당 쿼리 수가 코인 수에 그대로 비례하기 때문.
export const VIRTUAL_PAIRS: readonly string[] = ['OXUSDT', 'EWUSDT'];

// ⚠ 체결 테이프(spot_trades) 보존 기간 — 예전엔 영구 보존이라 하루 ~10만 행씩 무한히 쌓였다(prod 실측
// 2026-07-31: 157만 행). 그런데 실제로 읽는 건 (a)호가창 체결내역 최근 30건 (b)1s 등 단기 캔들 버킷팅의
// 최신 5,000건 (c)기준가 폴백 1건뿐이고, 차트 히스토리는 영속 캔들(spot_candles)이 따로 들고 있어서
// 오래된 체결을 지워도 잃는 게 없다. 봇이 분당 ~70건을 찍으므로 5,000건 ≈ 70분 — 6시간이면 그 8배라
// 버킷팅이 창 밖으로 밀릴 위험이 없다.
const TRADE_RETENTION_MS = 6 * 3600 * 1000;
// 프루닝을 매 틱 넣으면 배치 문장만 늘어난다(지워지는 총량은 어차피 같다) — 가끔만 넣어 잘라낸다.
const TRADE_PRUNE_CHANCE = 0.05; // ≈20틱마다 1회

/** 체결내역을 **표시**하려고 `spot_trades` 를 읽을 때 거는 시간 범위(2026-08-14, 읽기 절감).
 * 이 테이블엔 유저 체결만 남고 봇 합성 체결은 tape_json 링 버퍼(≈90초치)에 있으므로, 화면(최근 30건 ·
 * <60s 캔들 버킷팅)에 낄 수 있는 유저 체결은 그 창 근처뿐이다.
 *
 * ⚠ **1시간 → 3분**(2026-08-20). 1시간짜리 창은 prod 에서 **폴링당 24행**을 읽어 하루 16.3만 행 =
 * **전체 읽기의 41%(1위)** 였는데, 그 24행 중 화면에 낄 수 있는 건 사실상 없었다: `mergeRecentTrades`
 * 는 테이프+테이블을 시간순으로 합쳐 **상위 50건만** 쓰고, 봇 테이프 혼자 초당 ~4.5건을 찍으므로 그
 * 50건은 **최근 11초** 안에서 끝난다(cron 만 도는 조용한 시장이라도 ~33초). 즉 그보다 오래된 유저 체결은
 * 읽어봐야 정렬에서 밀려 버려지는 행이었다. 3분이면 가장 조용한 시장 기준으로도 5배 여유다.
 * ⚠ 봇이 멈춰(예산 차단 등) 테이프가 낡으면 그 테이프의 옛 항목이 상위 50건을 차지하므로, 창을
 * 늘려도 유저 체결이 더 보이지는 않는다 — 창 길이로 해결되는 문제가 아니다. */
const TRADE_VIEW_WINDOW_MS = 3 * 60 * 1000;

// ── 봇 매매 심리 모델 ─────────────────────────────────────────────────────
// ⚠ 예전 기준가는 `ref * (1 + (rand-0.5)*0.012)` 짜리 **IID 랜덤워크** 하나였다 — 추세도, 변동성 뭉침도,
// 과열도 공포도 없는 무특징 노이즈. 매 틱이 직전과 완전히 독립이라 차트에 읽을 구조가 아예 없었고
// ("사람 심리가 안 들어간 매매라 노잼"), 어떤 분석도 무의미했다. 지금은 실제 시장에서 관찰되는 정형화된
// 사실(stylized facts)을 작은 상태기계로 재현한다 — 상태는 spot_bot_state 행에 얹어 틱 사이에 지속된다:
//   1. 추세 지속(momentum)   — 수익률이 AR(1) 자기상관 → 한 번 잡힌 방향이 여러 틱 이어진다
//   2. 변동성 클러스터링      — vol 이 AR(1) → 잔잔한 구간과 거친 구간이 뭉치고, 드물게 "뉴스" 충격
//   3. 과열 후 평균회귀       — 적정가(anchor)에서 벌어질수록 되돌림이 제곱으로 강해진다(고점 공포/저점 매수)
//   4. 탐욕-공포 국면 전환    — calm→rally→euphoria→panic→capitulation→… 하락이 상승보다 빠르고 거칠다
// 여기에 라운드넘버 자석(심리적 지지/저항), 팻테일(급등락), 그리고 거래량·체결 방향·호가 스프레드가
// 국면에 함께 반응하는 것까지 묶었다. 전부 결정론적 알고리즘이다(LLM 아님).
//
// ⚠ 2026-08-12 확장 — "탐욕과 공포를 더 반영해달라". 위 1~4 는 **가격의 통계적 성질**이지 사람의
// 행동이 아니었다: 군중 심리(sentiment)가 사실상 최근 수익률의 즉석 함수라 자기 관성이 없었고
// (=탐욕이 쌓였다 꺼지는 "무드"가 아니었다), 시장이 **최근 고점/저점을 기억하지 않아** 저항 돌파나
// 지지 붕괴 같은 사람이 읽는 사건이 아예 없었다. 그래서 다음 넷을 더했다:
//   5. 무드의 관성·군집(herding) — sentiment 가 자기 자신을 되먹임하되 극단에서 포화(logistic)
//   6. 고점/저점 기억(peak/trough) — 서서히 잊히는 최근 고점·저점. 탐욕/공포 게이지의 기준이자,
//      **돌파 추격(FOMO)·지지 붕괴 손절 연쇄(stop cascade)** 라는 두 사건의 방아쇠
//   7. 레버리지 효과 — 떨어질 때 변동성이 커진다(공포는 시끄럽고 탐욕은 조용하다)
//   8. 투매(capitulation) 국면 — 공포가 극단이면 panic 이 한 번 더 폭발했다가 3~5틱 만에 소진되고
//      반등한다(V 바닥). 여기에 호가 **깊이의 비대칭**(공포장엔 매수벽이 얇아지고 매도벽이 두꺼워진다)을
//      더해, 심리가 가격뿐 아니라 **유동성**으로도 드러나게 했다.
type Regime = 'calm' | 'rally' | 'euphoria' | 'pullback' | 'panic' | 'capitulation';

export interface BotState {
  ref: number;
  drift: number;      // 추세 강도(틱당 기대수익률)
  vol: number;        // 변동성 배수
  sentiment: number;  // 군중 심리 -1(공포) ~ +1(탐욕)
  anchor: number;     // 완만히 따라오는 "적정가"
  regime: Regime;
  regimeTicks: number;
  peak: number;       // 서서히 잊히는 최근 고점(저항·FOMO 기준, 0=미초기화)
  trough: number;     // 서서히 잊히는 최근 저점(지지·손절연쇄 기준, 0=미초기화)
}

// 국면별 성격. bias=틱당 추가 드리프트, volMult=변동성 배수, sizeMult=거래량 배수,
// takerBias=체결 방향 편향(+면 매수 우위), minTicks=최소 지속 틱(국면이 1틱만에 튕기지 않게),
// exit=최소 지속을 넘긴 뒤 매 틱 국면을 벗어날 기본 확률(평균 지속 ≈ minTicks + 1/exit),
// bidDepth/askDepth=호가 사다리 물량 배수(공포장엔 매수벽이 사라지고 매도벽이 쌓인다),
// spread=호가 스프레드 배수(거친 국면일수록 마켓메이커가 물러난다).
// ⚠ 비대칭: panic 은 euphoria 보다 |bias|·volMult·sizeMult 가 모두 크다 — 실제 시장처럼 "떨어질 땐
// 빠르고 거칠게, 오를 땐 느리게".
//
// ⚠⚠ **2026-08-26 재설계 — "국면이 10초짜리라 추세가 안 보였다"**. 예전 값은 minTicks 2~8 에 전이
// 확률이 매 틱 13~35% 라 **한 국면의 평균 수명이 ~10틱**이었다(접속 중이면 10초, cron 만 돌면 50초).
// 그 사이 rally 가 만드는 이동은 0.00085×10 ≈ 0.85% 인데 같은 시간의 노이즈가 그와 비슷하거나 커서,
// 국면은 이름만 있고 **차트에는 방향이 안 보였다** — 유저 표현으로 "사팔사팔 빠르게 하면서 느리게
// 상승추세거나 느리게 하락추세". 지금은 국면 수명을 **한 자릿수 배로** 늘리고(평균 60~180틱) bias 를
// 키워, 한 국면이 지나가면 봉 여러 개짜리 방향성 구간이 남는다.
// ⚠ bias 는 국면 점유율로 가중하면 합이 거의 0 이 되도록 맞춰져 있다 — 안 맞추면 틱마다 미세한 편향이
// 누적돼 며칠 만에 가격이 0 으로 붕괴하거나 발산한다(초기 튜닝에서 실제로 5일 만에 -40% 편향이 나왔다).
// 값을 바꿀 땐 반드시 시뮬레이션으로 장기 안정성을 다시 확인할 것(`npm run sim:bot`).
const REGIME_PARAMS: Record<
  Regime,
  { bias: number; volMult: number; sizeMult: number; takerBias: number; minTicks: number; exit: number; bidDepth: number; askDepth: number; spread: number }
> = {
  calm:         { bias:  0,       volMult: 0.72, sizeMult: 0.50, takerBias:  0.02, minTicks: 60, exit: 0.007, bidDepth: 1.10, askDepth: 1.10, spread: 0.90 },
  rally:        { bias:  0.00106, volMult: 1.05, sizeMult: 1.45, takerBias:  0.22, minTicks: 45, exit: 0.011, bidDepth: 1.30, askDepth: 0.80, spread: 0.95 },
  euphoria:     { bias:  0.0034,  volMult: 1.85, sizeMult: 3.10, takerBias:  0.40, minTicks: 20, exit: 0.022, bidDepth: 1.55, askDepth: 0.45, spread: 1.25 },
  pullback:     { bias: -0.00054, volMult: 1.25, sizeMult: 1.15, takerBias: -0.20, minTicks: 40, exit: 0.014, bidDepth: 0.85, askDepth: 1.20, spread: 1.05 },
  panic:        { bias: -0.0027,  volMult: 2.70, sizeMult: 3.60, takerBias: -0.46, minTicks: 16, exit: 0.045, bidDepth: 0.45, askDepth: 1.55, spread: 1.55 },
  capitulation: { bias: -0.0085,  volMult: 3.70, sizeMult: 6.00, takerBias: -0.66, minTicks: 6,  exit: 0.130, bidDepth: 0.25, askDepth: 1.85, spread: 2.10 },
};

// ── 시장의 하루 리듬(세션·주말) ─────────────────────────────────────────────
// ⚠ 여기까지의 모델은 **정상(stationary)** 이었다 — 새벽 4시의 시장과 저녁 11시의 시장이 통계적으로
// 완전히 같았다. 그런데 사람이 모여 만드는 시장에서 제일 먼저 눈에 띄는 규칙성이 바로 하루 리듬이다:
// 아시아·유럽·미국 세션이 열리고 **겹칠 때** 거래가 몰려 변동성이 커지고, 세션 사이의 빈 시간대엔
// 호가가 얇아지고 봉이 잔잔해진다(주말은 기관·알고리즘이 쉬어 통째로 한산하다). 이게 없으면 차트를
// 하루 내내 들여다봐도 "지금이 활발한 시간인가"라는 감각이 안 생기고, 모든 봉이 같은 성격이다.
//
// ⚠⚠ **방향(bias)은 절대 넣지 않는다.** 시간대에 편향을 주면 그게 하루 단위로 누적돼 장기 안정성
// (§ npm run sim:bot)이 통째로 무너진다. 세션이 바꾸는 건 **변동성·거래량·사건 발생률(활성도)** 뿐이다.
// ⚠ 프로파일은 **평균이 정확히 1** 이 되도록 정규화한다(SESSION_MEAN / WEEKDAY_FACTOR) — 안 그러면
// 전체 변동성이 조용히 바뀌어 1분봉 폭·틱 표준편차 같은 이미 튜닝된 지표가 다 어긋난다.
// ⚠ 상태 컬럼이 아니라 **벽시계(now)에서 파생**되므로 D1 읽기·쓰기 증가가 0 이다.
const SESSIONS: readonly { at: number; width: number; w: number }[] = [
  { at: 3.0, width: 3.2, w: 0.85 },  // 아시아(도쿄·홍콩 오전)  UTC 03 = KST 12
  { at: 9.0, width: 3.0, w: 1.0 },   // 유럽 개장                UTC 09 = KST 18
  { at: 14.5, width: 3.4, w: 1.45 }, // 유럽·미국 겹침(하루의 정점) UTC 14:30 = KST 23:30
  { at: 19.0, width: 2.6, w: 0.7 },  // 미국 후장                UTC 19 = KST 04
];
const SESSION_FLOOR = 0.42; // 아무 세션도 안 열린 "죽은 시간"의 바닥 활성도

/** 정규화 전 활성도. ⚠ 시계는 **원형**이다 — 23시와 1시는 22시간이 아니라 2시간 차이다. */
function sessionRaw(hourUtc: number): number {
  let v = SESSION_FLOOR;
  for (const g of SESSIONS) {
    let d = Math.abs(hourUtc - g.at);
    if (d > 12) d = 24 - d;
    v += g.w * Math.exp(-(d * d) / (2 * g.width * g.width));
  }
  return v;
}
const SESSION_MEAN = (() => {
  let sum = 0;
  for (let i = 0; i < 240; i++) sum += sessionRaw(i / 10);
  return sum / 240;
})();
const WEEKEND_FACTOR = 0.8;
const WEEKDAY_FACTOR = (7 - 2 * WEEKEND_FACTOR) / 5; // 주 평균이 1 이 되도록 평일에 되돌려 얹는다

/** 이 시각의 시장 활성도(평균 1, 대략 0.35 ~ 1.9). 변동성·거래량·사건 발생률에만 곱한다. */
export function sessionActivity(now: number): number {
  const d = new Date(now);
  const dow = d.getUTCDay();
  const base = sessionRaw(d.getUTCHours() + d.getUTCMinutes() / 60) / SESSION_MEAN;
  return base * (dow === 0 || dow === 6 ? WEEKEND_FACTOR : WEEKDAY_FACTOR);
}
// 활성도가 변동성·거래량에 실리는 비율. 실제 시장에서 **거래량이 변동성보다 훨씬 크게** 출렁이므로
// 거래량 쪽 계수를 더 크게 준다. 두 식 모두 act 의 평균이 1 이면 결과의 평균도 1 이다.
const SESSION_VOL_GAIN = 0.5;
const SESSION_FLOW_GAIN = 0.85;
/** ⚠ 세션·코일 배수는 **각각 평균 1** 인데도 곱의 평균은 1 을 넘는다 — 활성도가 변동성과 상관되어
 * 있어서(활발한 시간엔 |ret| 도 커서 `intensity` 가 같이 오른다) 상관항이 얹히기 때문이다. 실측
 * 틱당 거래량이 +21% 였다. 캔들 거래량 기대값을 보존해야 하므로(§ "평균 보존" 불변식 — 분포만 바꾸고
 * 총량은 건드리지 않는다) 그 상관분을 되돌린다. 크기 분포·세션 게인을 손보면 **이 값을 다시 잴 것**
 * (scripts/sim-bot.ts 의 "틱당 거래량"이 기준선 ~105,000 근처여야 한다). */
const FLOW_CORR_NORM = 0.823;

// ── 관망 → 수축 → 확장(coil) ────────────────────────────────────────────────
// 사람 시장은 조용할 때 **점점 더** 조용해진다(관망세가 길어지면 아무도 먼저 움직이지 않는다). 그리고
// 그렇게 눌린 에너지는 국면이 바뀌는 순간 한 방향으로 터진다 — 차트에서 "삼각수렴 후 급등/급락"으로
// 읽히는 바로 그 패턴이다. 예전엔 calm 이 60틱이든 600틱이든 성격이 똑같아서, 조용한 구간은 그냥
// 심심한 구간이었고 그 끝에 아무 사건도 없었다.
// ⚠ 새 상태가 필요 없다 — `regimeTicks`(국면 나이)가 이미 있다.
const COIL_MIN = 0.45; // calm 이 아주 길어졌을 때의 변동성 배수 하한
const COIL_HALF = 260; // 이 틱수만큼 지나면 수축이 절반쯤 진행된다
const COIL_RELEASE = 0.00085; // 코일이 풀릴 때 그 방향으로 drift 에 꽂히는 킥(총 이동 ≈ 17배)
const COIL_FULL_TICKS = 500; // 킥이 최대가 되는 코일 길이

// ── 저항·지지 — 사람은 "직전 고점/저점"을 기준으로 행동한다 ─────────────────
// ⚠ peak/trough 는 지금까지 **게이지(탐욕·공포)와 사건 방아쇠**로만 쓰였다. 그래서 가격이 직전 고점에
// 다가가도 아무 일이 없었고, 지나가도 아무 일이 없었다 — 사람이 차트에서 제일 많이 하는 행동(전 고점에서
// 팔고, 전 저점에서 사고, 뚫리면 따라가기)이 통째로 빠져 있었던 것이다. 여기서 둘을 실제 **마찰**로 만든다:
//   · 전 고점 아래로 다가갈수록 매도 압력(그 가격에 산 사람들의 본전 매도 = disposition effect)
//   · 전 저점 위로 다가갈수록 매수 압력(저가 매수 대기)
//   · 단 극값 **바로 앞**은 무저항 구간이다 — 거기까지 왔다는 건 저항이 이미 소진됐다는 뜻이고,
//     그래야 "저항선을 뚫으면 저항이 사라진다"(그리고 FOMO 추격이 붙는다)가 성립한다.
// ⚠ 구조가 대칭(위는 아래로, 아래는 위로)이라 장기 편향을 만들지 않는다. 대신 추세를 **늦추므로**
//   추세효율이 떨어질 수 있다 — 반드시 `npm run sim:bot` 으로 0.55 선을 다시 확인할 것.
const LEVEL_ZONE = 0.022; // 극값에서 이 비율 안쪽이 그 레벨의 영향권
const LEVEL_DEAD = 0.0012; // 극값 바로 앞의 무저항 구간(돌파 직전)
const LEVEL_FRICTION = 0.00105; // 영향권 한가운데에서 걸리는 최대 압력(틱당)

// ── 추세 · 되돌림 파라미터 ────────────────────────────────────────────
// ⚠⚠ **여기가 "사팔사팔"의 진짜 원인이었다**(2026-08-26). 예전엔 적정가(anchor) 대비 되돌림이
// `-0.045×stretch` 로 **반감기 15틱**이나 됐고 anchor 자체도 1%/틱로 따라와서, 국면 드리프트 g 가
// 실제로 가격에 남기는 몫은 `g×a/(k+a) = g×0.01/0.055 = g 의 18%` 뿐이었다. 즉 rally 든 panic 이든
// **82% 가 그 자리에서 취소**되고, 남은 건 매 틱 새로 뽑는 가우시안 노이즈뿐이라 차트가 방향 없이
// 잘게 떨렸다. 지금은 되돌림을 1/3 로 줄여(k=0.014) 드리프트의 **42%** 가 남게 하고, 대신
//  (a) 과열이 커질수록 급격히 세지는 2차항(REVERT_SQ)으로 발산을 막고
//  (b) anchor 를 기준선으로 당기는 장기 tether(BOT_BASE_PULL)를 비선형으로 만들어
//      "며칠짜리 큰 파도는 허용하되 몇 배로 튀지는 못하게" 한다.
const REVERT_LIN = 0.014;  // 적정가 대비 과열의 선형 되돌림(작을수록 추세가 오래 산다)
const REVERT_SQ = 0.30;    // 2차 되돌림 — 과열 ±10% 부근에서 급격히 브레이크가 걸린다
const ANCHOR_FOLLOW = 0.01; // 적정가가 현재가를 따라가는 속도(반감기 ≈ 69틱)
// 매 틱 새로 뽑는 순수 노이즈. ⚠ **이 값을 키우면 "사팔사팔"이 그대로 돌아온다** — 다이내믹함은
// 노이즈가 아니라 위 국면·추세·사건에서 나와야 한다(노이즈는 방향이 없어서 봉만 지저분해진다).
const TICK_NOISE = 0.00052;
// 추세(모멘텀)의 지속계수 — 예전 0.86(반감기 4.6틱)은 사실상 노이즈였다. 0.94 면 반감기 11틱이라
// 한 번 잡힌 방향이 봉 하나를 넘어 이어진다. ⚠ 1 미만이어야 발산하지 않는다.
const DRIFT_PERSIST = 0.94;
const DRIFT_NOISE = 0.00026;

// ── 탐욕/공포 게이지 · 기억 파라미터 ──────────────────────────────────
// 최근 고점/저점은 "완전히 잊히지 않되 영원히 남지도 않게" 지수적으로 현재가 쪽으로 흘러내린다.
// 반감기 ≈ 870틱(틱은 접속 중 ~60/분, 유휴 시 12/분이라 실시간으로 15분~1시간).
const EXTREME_DECAY = 0.005;
// 고점 대비 이만큼 빠지면 공포 게이지가 100%(반대로 저점 대비 이만큼 오르면 탐욕 100%).
// ⚠ 국면이 길어져 한 파도의 진폭이 커졌으므로 게이지 만점 기준도 6%→10%→**14%** 로 넓혔다. 좁게 두면
// 게이지가 늘 1 에 붙어(포화) 전이 확률·변동성·거래량이 전부 최대치로 걸리고, 그러면 panic 점유율이
// 폭증해 시장이 한쪽으로 굳는다(2026-08-12 튜닝에서 실제로 겪었다 — 목표는 평균 0.3 안팎).
export const GAUGE_FULL = 0.18;
// 무드의 군집(herding) — sentiment 가 자기 자신을 키우되 s(1-s²) 라 극단(±1)에선 0 이 되어 발산하지
// 않는다. 실효 지속계수는 최대 0.93+0.05 = 0.98 (< 1) 이라 수학적으로도 폭주가 불가능하다.
// ⚠ 지속계수를 0.90→0.93 으로 올렸다 — 무드가 국면보다 짧게 살면 국면이 길어져도 "다들 사는 중"이
//   중간에 식어버려 확신(conviction) 배수가 안 붙는다.
const MOOD_PERSIST = 0.91;
const HERD_GAIN = 0.05;
// 신고점 돌파 추격(FOMO)과 지지 붕괴 손절 연쇄 — **연쇄 쪽이 1.5배 크고 자주 터진다**(공포가 탐욕보다
// 빠르다). 둘 다 "그 방향으로 이미 쏠려 있을 때만" 발동해서, 평상시엔 아무 일도 일어나지 않는다.
// ⚠⚠ **킥은 이제 그 틱의 수익률이 아니라 `drift`(추세) 에 꽂힌다**(2026-08-26). 예전엔 한 틱만 튀고
// 끝나서 다음 봉이면 흔적도 없었다 — 사람이 "돌파했다"고 읽으려면 그 뒤로 몇 봉이 따라와야 한다.
// drift 는 DRIFT_PERSIST 로 감쇠하므로 킥 k 는 총 `k/(1-0.94) ≈ 17k` 만큼의 이동으로 풀린다.
const FOMO_CHANCE = 0.035;
const FOMO_KICK = 0.00075;
const CASCADE_CHANCE = 0.055;
const CASCADE_KICK = 0.00112;

// 라운드넘버 자석이 잡아당기는 심리적 가격대(틱 개수 — 절대값이면 가격대가 바뀔 때 무의미해진다).
// ⚠ 굵은 격자가 더 강하고 더 넓게 붙잡는다 — 1.00 은 1.003 보다 훨씬 중요한 자리다.
const ROUND_MAGNETS: readonly { ticks: number; pull: number; zone: number }[] = [
  { ticks: 500, pull: 0.3, zone: 0.006 }, // 1.00 / 1.05 — 큰 심리 가격
  { ticks: 50, pull: 0.22, zone: 0.0035 }, // 1.000 / 1.005
];

/** 한 주문에서 특정 봇이 상대편(maker)으로 잡은 체결의 합계 — 수수료(명목금액)와 재고(수량) 양쪽에 쓴다. */
interface BotFill {
  notional: number; // Σ 체결가×수량 — 수수료 산정 + 현금(USDT) 정산
  size: number; // Σ 체결 수량 — 재고(OX) 정산
}

/** walking 루프의 청크 하나를 봇별 합계에 누적(체결 1건마다 부기하면 원장·문장이 청크 수만큼 불어난다). */
function addBotFill(fills: Map<string, BotFill>, botId: string, notional: number, size: number): void {
  const cur = fills.get(botId) ?? { notional: 0, size: 0 };
  fills.set(botId, { notional: cur.notional + notional, size: cur.size + size });
}

/**
 * 봇 체결의 부기 — (1) 수수료 원장 + (2) 재고/현금 정산. 합성 체결(봇끼리)이든 유저 상대 체결이든.
 *
 * **수수료**: 시장 물량의 대부분이 봇에서 나오는데 봇만 면제하면 원장이 실제 거래량과 동떨어진다.
 * 요율은 유저와 똑같이 누적 거래대금에서 파생(vipOf)하므로 봇도 거래가 쌓일수록 등급이 오른다(특혜 없음).
 *
 * **재고/현금**(`botSide` = 이 체결에서 봇이 산 쪽인지 판 쪽인지):
 *   - 봇이 매도(sell) → USDT +명목금액, OX −수량   /  봇이 매수(buy) → USDT −명목금액, OX +수량
 *   - `null` 은 봇↔봇 합성 체결(양쪽이 같은 봇이라 재고·현금이 서로 상계) → 수수료만 기록.
 * ⚠ 예전엔 이 정산을 아예 안 해서 `users.balance`/`ox_balance` 가 구조 개편(2026-07-18) 시점 값에
 * **영구히 얼어붙어 있었다** — 봇이 아무리 사고팔아도 숫자가 그대로라 "봇 재고"라는 개념 자체가 없었다.
 * ⚠ **잔고 가드는 절대 붙이지 않는다**(조건부 UPDATE 아님) — 봇은 설계상 무한 유동성 공급자라
 * 현금/재고가 음수로 내려가도 체결은 계속돼야 한다. 가드를 붙이는 순간 대량 시장가 완결(SYNTH 경로)이
 * 봇 잔고 바닥에서 끊기고, 봇 호가 에스크로를 되살리는 꼴이라 틱마다 왕복이 폭증한다.
 * 음수는 정상이다 — 봇 재고는 "유저 전체 순포지션의 거울"이라 유저가 순매수면 봇 OX 가 마이너스로 간다.
 *
 * 여러 봇이 섞인 체결은 봇별로 모아 한 번에 처리한다(read 1회 + 봇당 2~3문장, 호출부 batch 에 얹힘).
 */
async function botFillStmts(
  env: Env,
  pair: string,
  fills: Map<string, BotFill>,
  botSide: 'buy' | 'sell' | null,
  now: number,
): Promise<D1PreparedStatement[]> {
  const ids = [...fills.keys()].filter((id) => (fills.get(id)?.notional ?? 0) > EPS);
  if (ids.length === 0) return [];
  const rows = (
    await env.DB.prepare(`SELECT id, total_volume FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: string; total_volume: number }>()
  ).results;
  const volById = new Map(rows.map((r) => [r.id, r.total_volume ?? 0]));
  const out: D1PreparedStatement[] = [];
  for (const id of ids) {
    const { notional, size } = fills.get(id)!;
    const rate = vipOf(volById.get(id) ?? 0).rate;
    const fee = notional * rate;
    // ⚠ 봇은 `fee_ledger` 에 행을 남기지 않는다(유저 체결은 그대로 남긴다) — 봇은 분당 12틱 이상 영구히
    // 돌아서 하루 2.9만 행씩 원장을 채우는데, 정작 그 행을 읽는 곳이 없다: 랭킹의 "거래소 수수료 수익"은
    // `users.total_fees` 를 집계하고(leaderboard.ts — 원장은 행이 너무 많아 5초 폴링으로 못 스캔한다)
    // 원장은 "유저별·심볼별 분해"용이라 봇 몫은 어차피 분해할 대상이 아니다. 총액은 아래 카운터에
    // 그대로 누적되므로 화면 숫자는 1원도 안 바뀐다.
    // 카운터(거래대금·수수료)와 재고/현금을 **한 문장으로 합친다** — 예전엔 (카운터 UPDATE + 원장 INSERT
    // + 현금/재고 UPDATE) 3문장이었다. 봇 행 하나를 두 번 UPDATE 할 이유가 없다.
    if (botSide) {
      const cash = (botSide === 'buy' ? -notional : notional) - fee; // 수수료는 사든 팔든 낸다
      const inv = botSide === 'buy' ? size : -size;
      out.push(
        env.DB.prepare(
          'UPDATE users SET total_volume = total_volume + ?, total_fees = total_fees + ?, balance = balance + ? WHERE id = ?',
        ).bind(notional, fee, cash, id),
      );
      // ⚠ 재고는 `users.ox_balance` 단일 컬럼이 아니라 **페어별 행**이다(2026-07-31) — 가상 코인이 둘
      // 이상이면 한 컬럼에 섞여 "어느 코인 재고인지" 구분이 사라진다(그러면 코인별 순포지션 거울이라는
      // 이 값의 유일한 의미가 없어진다). 잔고 가드는 여전히 붙이지 않는다 — 봇은 무한 유동성 공급자라
      // 재고가 음수로 내려가도 체결이 계속돼야 한다(유저가 순매수면 봇 재고는 자연히 마이너스다).
      out.push(
        env.DB.prepare(
          'INSERT INTO bot_inventory (pair, user_id, qty) VALUES (?,?,?) ON CONFLICT(pair, user_id) DO UPDATE SET qty = bot_inventory.qty + excluded.qty',
        ).bind(pair, id, inv),
      );
    } else {
      // 봇↔봇 합성 체결 — 재고·현금은 같은 계정 안에서 상계되므로 카운터만 움직인다.
      out.push(
        env.DB.prepare('UPDATE users SET total_volume = total_volume + ?, total_fees = total_fees + ? WHERE id = ?').bind(
          notional,
          fee,
          id,
        ),
      );
    }
  }
  return out;
}

// ── 사람처럼 "떨어지는" 호가 가격·수량(price clustering) ──────────────────────
// ⚠ 예전엔 호가를 전부 `ref * (1 ± spread)` 로만 찍어서 1.4067 / 1.4074 / 1.4081 처럼 어중간한 값이
// 기계적으로 균일한 간격으로 늘어섰다 — 실제 호가창은 절대 그렇게 안 생겼다. 사람은 1.4000 / 1.4050
// 같은 **딱 떨어지는 가격**에 주문을 몰아 걸고, 그런 라운드 가격일수록 물량이 훨씬 크다(심리적 지지·
// 저항 "벽"). 수량도 4,712.3856 이 아니라 1,000 / 5,000 처럼 떨어지는 숫자를 넣는다.
// 격자가 굵을수록(=더 라운드한 가격) 그 자리에 붙는 물량 배수(sizeMult)가 크다.
//
// ⚠ 격자 간격은 **틱 개수**로 적는다(절대값 금지) — 틱이 유효숫자 4자리라 가격대마다 10배씩 달라지고,
// 0.05 같은 절대값은 가격이 1 근처일 때만 "라운드 가격"이다(0.002 대에선 격자가 가격의 25배).
const PRICE_GRIDS: readonly { ticks: number; sizeMult: number; pull: number }[] = [
  { ticks: 50, sizeMult: 7.0, pull: 0.95 }, // 1.400 / 1.450 — 대형 심리 가격, 두꺼운 벽
  { ticks: 10, sizeMult: 3.4, pull: 0.85 }, // 1.410 / 1.420
  { ticks: 5, sizeMult: 1.9, pull: 0.65 }, // 1.405
];

/** 가격(격자 인덱스)에 묶인 결정론적 0~1 난수 — **같은 가격이면 언제나 같은 값**이다(xorshift 해시).
 * ⚠⚠ 여기서 `Math.random()` 을 쓰면 안 된다: 라운드 가격의 벽이 매 틱 주사위를 다시 굴려 **1초마다
 * 생겼다 사라진다**. 실제 시장의 1.4500 짜리 벽은 그 자리에 계속 있고, 그래서 사람이 "저 벽을 뚫으면
 * 간다"고 읽는다. 가격에서 파생하므로 상태 컬럼도 필요 없다(D1 비용 0). */
function priceHash(idx: number, salt: number): number {
  let h = (Math.imul(Math.round(idx), 2654435761) + Math.imul(salt, 40503)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 목표 호가를 사람이 좋아하는 라운드 가격으로 끌어당긴다.
 * ⚠ 매수는 내림(floor), 매도는 올림(ceil) — 항상 mid 에서 "멀어지는" 방향으로만 스냅되므로
 * 최우선매수 > 최우선매도로 역전될 수 없다(호가 역전 방지의 핵심).
 * depth(0=최우선호가 ~ 1=가장 깊은 레벨)가 클수록 굵은 격자까지 허용한다 — 최우선호가는 촘촘하게
 * 경쟁하고, 멀리 있는 주문일수록 라운드 가격에 뭉치는 실제 호가창의 모습.
 * ⚠ "그 격자에 붙을지"는 난수가 아니라 **가격 자체의 해시**로 정한다(§ priceHash) — 그래야 특정 가격이
 * 계속 벽이고 나머지는 계속 평범한 자리다(=사람이 기억하는 지지·저항). 대신 `depth` 는 문턱(tol)에만
 * 남긴다: 여기에도 depth 를 곱하면 같은 가격이 레벨에 따라 붙었다 말았다 해서 다시 깜빡인다.
 */
function humanQuotePrice(target: number, side: 'buy' | 'sell', depth: number): { price: number; sizeMult: number } {
  const tol = 0.0009 + depth * 0.0022; // 이만큼 넘게 끌려가야 하면 그 격자는 포기(사다리가 뭉개지지 않게)
  const tick = virtualTick(target);
  for (const g of PRICE_GRIDS) {
    const step = g.ticks * tick;
    // ⚠ price/step 을 그냥 floor/ceil 하면 정확히 격자 위에 있는 값이 한 칸 밀린다
    // (1.45/0.0001 = 14499.999999999998). 정수에서 1e-9 이내면 그 정수로 간주해 흡수한다.
    const ticks = target / step;
    const idx = side === 'buy' ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
    const snapped = idx * step;
    if (Math.abs(snapped - target) / target > tol) continue;
    if (priceHash(idx, g.ticks) > g.pull) continue;
    return { price: roundOx(snapped), sizeMult: g.sizeMult };
  }
  return { price: roundOx(target), sizeMult: 1 }; // 어느 격자에도 안 붙으면 원래 값(어중간한 가격도 섞여야 자연스럽다)
}

/**
 * 유저가 걸어둔 "벽"을 한 틱에 얼마나 소비할지.
 *
 * ⚠ 예전엔 벽 크기와 무관하게 항상 2,000~10,000 이라, 100만주 벽이면 뚫는 데 수십 분이 걸리고 그동안
 * 가격이 벽에 붙어 굳어버렸다(기준가가 벽 안으로 클램프되므로). 실제 시장에서 큰 벽은 "저항"이지
 * "무한 방벽"이 아니다 — 방향성이 강하면 큰 물량이 들어와 갉아먹고, 가끔은 고래가 한 번에 쓸어간다.
 *
 * 그래서 **벽 크기에 비례하는 비율**로 먹되,
 *  - 국면 공격성(`REGIME_PARAMS.sizeMult`: calm 0.55 ~ panic 2.9)과 군중 심리 강도로 배수를 걸고,
 *  - 낮은 확률로 "고래 스윕"이 터져 벽의 35~90% 를 한 틱에 쓸어간다.
 * 작은 벽은 기존과 같은 절대량(2,000~10,000)이 하한이라 잔챙이는 예전처럼 바로 정리된다.
 */
const WALL_BITE_MIN = 0.05; // 한 틱에 먹는 벽의 최소 비율(공격성 배수 적용 전)
const WALL_BITE_RAND = 0.07;
const WALL_WHALE_CHANCE = 0.06;
function wallAbsorbSize(wallSize: number, regime: Regime, sentiment: number): number {
  if (!(wallSize > 0)) return humanSize(2000 + Math.random() * 8000);
  const aggression = REGIME_PARAMS[regime].sizeMult * (0.7 + Math.abs(sentiment));
  let pct = (WALL_BITE_MIN + Math.random() * WALL_BITE_RAND) * aggression;
  if (Math.random() < WALL_WHALE_CHANCE) pct = 0.35 + Math.random() * 0.55; // 고래가 한 번에 쓸어감
  const floor = 2000 + Math.random() * 8000; // 작은 벽은 예전처럼 통째로
  return humanSize(Math.min(wallSize, Math.max(floor, wallSize * pct)));
}

/**
 * 주문 수량 하나를 "사람이 넣은 것처럼" 다듬는다. ⚠ 예전엔 전부 1,000 / 5,000 처럼 딱 떨어지게 맞췄는데
 * 그러면 그것대로 기계 같다 — 실제 호가창은 여러 사람이 제각각 넣은 값이라 2,384 개 같은 어중간한 수량이
 * 대부분이고, 딱 떨어지는 수량은 가끔 섞일 뿐이다(가격과 달리 수량엔 라운드 넘버 심리가 약하다).
 * ⚠ 라운드로 만들 확률은 **계층마다 다르다**(2026-08-31) — 개미는 "100개/500개"처럼 손으로 딱 떨어지게
 * 넣고, 세력·알고리즘은 큰 물량을 잘게 쪼개 넣으므로(아이스버그) 어중간한 수량이 나온다. 격자도 값 크기를
 * 따라가야 한다(140 개를 5,000 격자로 반올림하면 개미 주문이 통째로 사라진다).
 */
function humanSize(raw: number, roundProb = 0.18): number {
  const v = Math.max(1, raw);
  if (Math.random() < roundProb) {
    const step =
      v >= 20000 ? 5000 : v >= 8000 ? 1000 : v >= 2000 ? 500 : v >= 800 ? 100 : v >= 200 ? 50 : v >= 80 ? 10 : 5;
    return Math.max(step, Math.round(v / step) * step);
  }
  return Math.round(v);
}

// ── 개미 · 세력 · 고래 — 주문 크기의 계층 분포(2026-08-31) ────────────────────
// ⚠ 예전엔 체결도 호가도 `uniform(1000, 8000)` / `uniform(2000, 10000)` 한 줄이라 **모든 수량이 네다섯
// 자리에 뭉쳐 있었다**("수량이 네 자리 아니면 다섯 자리로만 나온다 — 개미와 세력이 구분이 안 된다" 제보).
// 실제 거래소의 주문 크기는 균등분포가 아니라 **멱함수(로그 스케일에서 넓게 퍼진) 분포**다: 건수의 절반
// 이상은 개미가 만들고, 거래량의 대부분은 소수의 세력·고래가 만든다. 그래서 계층을 먼저 뽑고(가중치 w)
// 그 계층 안에서 **로그균등**으로 배수를 뽑는다 — 로그균등이라 같은 계층 안에서도 자릿수가 흩어진다.
//
// lo/hi 는 "평균 대비 배수"라 이 표는 가격대·국면과 무관하게 재사용된다(호출자가 평균만 정한다).
// ⚠ 합이 정확히 1 이어야 한다(마지막 계층으로 폴백하므로 넘치면 그쪽이 조용히 커진다).
const SIZE_TIERS: readonly { w: number; lo: number; hi: number; round: number }[] = [
  { w: 0.56, lo: 0.012, hi: 0.16, round: 0.55 }, // 개미 — 건수는 절반 이상이지만 거래량 몫은 2%
  { w: 0.3, lo: 0.16, hi: 1.3, round: 0.3 },     // 일반 개인
  { w: 0.115, lo: 1.3, hi: 10, round: 0.12 },    // 세력(기관·알고리즘) — 거래량의 3분의 1
  { w: 0.025, lo: 10, hi: 70, round: 0.06 },     // 고래 — 40건에 1건인데 거래량의 절반을 만든다
];
// 로그균등 U(lo,hi) 의 기댓값은 (hi-lo)/ln(hi/lo). 계층 가중 평균이 1 이 되도록 나눠 주면 호출자가 준
// `mean` 이 실제 평균과 일치한다 — 이 정규화가 있어야 분포를 손봐도 **캔들 거래량이 흔들리지 않는다**.
const SIZE_TIER_MEAN = SIZE_TIERS.reduce((sum, t) => sum + (t.w * (t.hi - t.lo)) / Math.log(t.hi / t.lo), 0);

/** 평균이 `mean` 인 주문 수량 하나(계층 혼합 + 계층별 라운드 넘버 심리). */
function orderSize(mean: number): number {
  const u = Math.random();
  let acc = 0;
  let tier = SIZE_TIERS[SIZE_TIERS.length - 1];
  for (const t of SIZE_TIERS) {
    acc += t.w;
    if (u < acc) {
      tier = t;
      break;
    }
  }
  const mult = tier.lo * Math.pow(tier.hi / tier.lo, Math.random()); // 계층 안에서 로그균등
  return humanSize((mean * mult) / SIZE_TIER_MEAN, tier.round);
}
// 적정가(anchor)가 아주 약하게 끌려가는 장기 기준선. 국면 bias 를 아무리 맞춰도 랜덤워크는 며칠 단위로
// 얼마든지 멀리 갈 수 있어서(0 에 붙거나 수십 배로 뜀), 약한 복원력을 하나 둔다.
// ⚠ **비선형 tether**(2026-08-26): 예전엔 기준선까지의 거리에 비례하는 선형 복원이라, 되돌림을 약하게
// 만들어 추세가 길어진 지금은 며칠 단위로 몇 배씩 표류할 수 있다. 반대로 세게 걸면 며칠짜리 파도가
// 통째로 죽는다. 그래서 **로그 거리의 제곱으로** 세지게 했다 — ±30% 부근에선 거의 안 느껴지고(파도
// 허용), 2배/반토막으로 벌어지면 급격히 끌어당긴다(가격이 무의미해지는 것만 방지).
const BOT_BASE_PRICE = 1;
const BOT_BASE_PULL = 0.000012;
const BOT_BASE_PULL_CURVE = 2.5; // |log 거리| 가 커질수록 복원력이 세지는 정도
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 표준정규 난수(Box-Muller) — 균등분포보다 꼬리가 있어 가격 움직임이 자연스럽다. */
function gauss(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 국면 전이 — 최소 지속시간을 지킨 뒤 심리/과열도에 따라 확률적으로 넘어간다.
 * 상승은 단계를 밟아 올라가지만(calm→rally→euphoria) 꼭대기에선 곧장 panic 으로 떨어질 수 있다.
 *
 * ⚠ 전이 확률은 고정 상수가 아니라 **탐욕/공포 게이지의 함수**다(2026-08-12). 예전엔 "rally 에서
 * 20% 확률로 pullback" 처럼 무드와 무관한 주사위라, 국면 이름만 심리였지 정작 전환 시점은 심리와
 * 아무 상관이 없었다(무섭지 않은데 공포장이 시작되고, 다들 탐욕적인데 조용히 식었다). 지금은
 *  - 무드가 쏠린 쪽 국면이 훨씬 잘 열리고(군중이 방향을 정한다),
 *  - 탐욕이 달아오를수록 rally→euphoria 가 쉬워지고(추격매수),
 *  - **euphoria 는 오래 끌수록·많이 벌어질수록 무너지기 쉽다**(버블 피로 — 고정 34% 였을 땐 꼭대기가
 *    얼마나 높든 붕괴 확률이 같아서 "고점일수록 위험하다"는 감각이 없었다),
 *  - 공포가 극단이고 낙폭이 깊을 때만 panic→capitulation(투매)이 열린다.
 *
 * ⚠⚠ **확률의 기준선이 국면마다 하나(`REGIME_PARAMS.exit`)로 모였다**(2026-08-26). 예전엔 분기마다
 * 0.13·0.26·0.34 같은 숫자가 흩어져 있어서 "이 국면이 평균 몇 틱 사는가"를 읽을 수 없었고, 그래서
 * 아무도 그게 10틱짜리라는 걸 눈치채지 못했다. 지금은 평균 수명이 대략 `minTicks + 1/exit` 로 바로
 * 읽히고, 심리 배수는 그 기준선에 곱해진다. */
function nextRegime(
  s: BotState,
  stretch: number,
  sentiment: number,
  fear: number, // 0(평온) ~ 1(극단적 공포) — 최근 고점 대비 낙폭
  greed: number, // 0 ~ 1 — 최근 저점 대비 상승폭
  act: number, // 세션 활성도(평균 1) — 사람이 많이 붙어 있는 시간대에 국면이 더 잘 바뀐다
): { regime: Regime; regimeTicks: number } {
  const P = REGIME_PARAMS[s.regime];
  const age = s.regimeTicks + 1;
  if (age < P.minTicks) return { regime: s.regime, regimeTicks: age };
  const start = (regime: Regime) => ({ regime, regimeTicks: 0 });
  const roll = Math.random();
  // ⚠ 전이 확률의 **기준선 자체**에 활성도를 곱한다 — 새벽엔 국면이 그대로 흘러가고, 세션이 겹치는
  // 시간에 방향이 바뀐다. act 의 평균이 1 이라 **평균 국면 수명은 거의 그대로**이고 사건이 활발한
  // 시간대로 몰릴 뿐이다. ⚠ roll 자체를 스케일하면 안 된다 — 아래엔 roll 을 확률 문턱이 아니라
  // **분기 선택**(데드캣 바운스 vs 진정)에 쓰는 자리가 있어서 분포가 통째로 비뚤어진다.
  const exit = P.exit * clamp(act, 0.25, 2.5);
  switch (s.regime) {
    case 'calm': {
      // 조용한 장은 스스로 깨지지 않는다 — 무드가 한쪽으로 쏠려야 방향이 생긴다.
      const up = exit * (0.6 + 2.4 * Math.max(0, sentiment) + 1.5 * greed);
      const down = exit * (0.55 + 2.2 * Math.max(0, -sentiment) + 1.3 * fear);
      if (roll < up) return start('rally');
      if (roll < up + down) return start('pullback');
      break;
    }
    case 'rally': {
      // 과열 진입(추격매수) — 여기서 급등이 나온다. 적정가 위로 충분히 올라오고 무드가 탐욕일 때만.
      const heat = stretch > 0.010 && sentiment > 0.25 ? exit * (1.1 + 4.5 * greed) : 0;
      const cool = exit * (0.85 + 1.8 * fear);
      if (roll < heat) return start('euphoria');
      if (roll < heat + cool) return start(sentiment < -0.1 || fear > 0.3 ? 'pullback' : 'calm');
      break;
    }
    case 'euphoria': {
      // 버블 피로 — 오래 버틸수록, 적정가에서 멀어질수록 무너지기 쉽다.
      const fatigue = clamp(exit * (1 + 0.03 * age) + 1.4 * Math.max(0, stretch - 0.02), 0, 0.4);
      if (roll < fatigue) return start('panic'); // 꼭대기에서 곧장 급락 — 상승보다 하락이 빠르다
      if (roll < fatigue + exit) return start('pullback');
      break;
    }
    case 'pullback': {
      const crack = stretch < -0.015 && sentiment < -0.4 && fear > 0.45 ? exit * (0.4 + 1.5 * fear) : 0; // 투매 전환
      const heal = exit * (0.85 + 1.7 * greed);
      if (roll < crack) return start('panic');
      if (roll < crack + heal) return start(sentiment > 0.1 || greed > 0.3 ? 'rally' : 'calm');
      break;
    }
    case 'panic': {
      // 공포가 바닥까지 갔을 때만 열리는 마지막 단계 — 투매(항복). 짧고 격렬하다.
      const flush = fear > 0.8 && sentiment < -0.6 ? exit * 0.35 : 0;
      const settle = exit * (0.9 + 1.5 * greed);
      if (roll < flush) return start('capitulation');
      if (roll < flush + settle) return start(roll < flush + settle * 0.3 ? 'rally' : 'calm'); // 데드캣 바운스 / 진정
      break;
    }
    case 'capitulation':
      // 투매는 오래 못 간다 — 팔 사람이 다 팔고 나면 반등한다(V 바닥).
      if (roll < exit * 0.6) return start('rally'); // 안도 랠리
      if (roll < exit) return start('calm');
      break;
  }
  return { regime: s.regime, regimeTicks: age };
}

/** 한 틱의 시장 심리를 굴려 다음 상태와 이번 틱의 체결 성격을 만든다(순수 함수, DB 접근 없음).
 * ⚠ 순수 함수라 그대로 떼어내 장기 시뮬레이션을 돌릴 수 있다(`npm run sim:bot`) — 파라미터를 바꿨다면
 * 반드시 돌려서 장기 안정성(며칠 뒤 가격이 0 으로 붕괴하거나 발산하지 않는지)을 다시 확인할 것. */
export function nextMarketState(s: BotState, now: number = Date.now()): {
  next: BotState;
  ret: number;         // 이번 틱 수익률
  sizeMult: number;    // 거래량 배수
  buyProb: number;     // 체결이 매수(taker buy)일 확률
  spreadMult: number;  // 호가 스프레드 배수
  bidDepthMult: number; // 매수 사다리 물량 배수(공포장엔 매수벽이 사라진다)
  askDepthMult: number; // 매도 사다리 물량 배수(공포장엔 팔려는 물량이 쌓인다)
  activity: number;    // 세션 활성도(평균 1) — 체결 건수·사건 발생률에 쓴다
  volEff: number;      // 이번 틱의 실효 변동성(테이프 노이즈·스톱헌팅 크기 산정용)
} {
  // 하루 리듬 — 이 틱이 몇 시에 도는지가 성격을 바꾼다(§ sessionActivity). 방향은 절대 안 바꾼다.
  const act = sessionActivity(now);
  const anchor = s.anchor > 0 ? s.anchor : s.ref;
  const stretch = (s.ref - anchor) / anchor; // 적정가 대비 과열(+)/과매도(-)
  const peak = s.peak > 0 ? Math.max(s.peak, s.ref) : s.ref;
  const trough = s.trough > 0 ? Math.min(s.trough, s.ref) : s.ref;

  // 0) 탐욕/공포 게이지 — 사람이 실제로 보는 기준은 "적정가"가 아니라 **최근 고점과 저점**이다.
  //    고점 대비 얼마나 빠졌나 = 공포, 저점 대비 얼마나 올랐나 = 탐욕. 각각 0~1 로 정규화한다.
  const fear = clamp((peak - s.ref) / peak / GAUGE_FULL, 0, 1);
  const greed = clamp((s.ref - trough) / trough / GAUGE_FULL, 0, 1);

  // 1) 변동성 클러스터링 — 직전 변동성을 대부분 물려받고(AR(1)) 드물게 뉴스 충격으로 튄다.
  let vol = s.vol * 0.9 + 0.1 * Math.exp(gauss() * 0.45);
  if (Math.random() < 0.02) vol *= 1.8 + Math.random() * 1.4;
  vol = clamp(vol, 0.35, 4.5);
  // ⚠ 레버리지 효과 — 같은 크기라도 **떨어질 때가 오를 때보다 시끄럽다**. 공포 게이지로 이번 틱에만
  //    증폭하고(상태엔 안 저장) 넘긴다 — 저장하면 AR(1) 에 곱해져 공포가 이어지는 동안 기하급수로
  //    커지고 상한(clamp)에 붙어버린다.
  // 관망이 길어지면 스스로 더 조용해진다(코일) — 그 눌린 에너지는 아래에서 국면이 바뀔 때 터진다.
  const coil = s.regime === 'calm' ? COIL_MIN + (1 - COIL_MIN) / (1 + s.regimeTicks / COIL_HALF) : 1;
  const volEff = vol * (1 + 0.4 * fear) * (1 - SESSION_VOL_GAIN + SESSION_VOL_GAIN * act) * coil;

  // 2) 추세 지속(모멘텀) — 방향이 한 번 잡히면 감쇠하며 이어진다(반감기 ≈ 11틱).
  let drift = s.drift * DRIFT_PERSIST + gauss() * DRIFT_NOISE * vol;

  // 2b) 사건 — 최근 고점 돌파(FOMO 추격매수)와 최근 저점 붕괴(손절 연쇄). 실제 차트에서 사람이 읽는
  //     사건은 대부분 이 둘이다. ⚠ **연쇄가 추격보다 크고 자주** 터진다(계단으로 오르고 엘리베이터로
  //     떨어진다). 그 방향으로 이미 쏠려 있을 때만 발동하므로 평상시엔 아무 일도 안 일어난다.
  //     ⚠⚠ 킥은 `ret` 이 아니라 **`drift` 에 꽂는다**(2026-08-26) — 예전처럼 그 틱에만 더하면 한 틱
  //     튀고 끝나서 다음 봉이면 흔적이 없었다. drift 에 넣으면 감쇠하며 여러 틱 이어져 "돌파 후 추격"
  //     처럼 보인다(킥 k 는 총 k/(1-DRIFT_PERSIST) ≈ 17k 의 이동으로 풀린다).
  //     ⚠ 발동 확률에 **활성도와 게이지**를 곱한다(2026-09-07) — 사람이 몰려 있는 시간에, 그리고 이미
  //     탐욕/공포가 달아올랐을 때 돌파 추격과 손절 연쇄가 터진다. 새벽의 신고점은 조용히 지나간다.
  let event = 0;
  if (s.ref >= peak - EPS && s.sentiment > 0.22 && Math.random() < FOMO_CHANCE * act * (0.55 + 1.1 * greed)) {
    event = FOMO_KICK * (0.5 + Math.random()) * volEff;
  } else if (s.ref <= trough + EPS && s.sentiment < -0.22 && Math.random() < CASCADE_CHANCE * act * (0.55 + 1.1 * fear)) {
    event = -CASCADE_KICK * (0.5 + Math.random()) * volEff;
  }
  drift = clamp(drift + event, -0.02, 0.02); // 안전장치 — 사건이 겹쳐도 틱당 2% 를 넘지 않는다

  // 3) 군중 심리 — 최근 추세·과열도·고저점 대비 위치가 쌓여 탐욕/공포가 된다(국면 전이의 방아쇠).
  //    ⚠ 여기에 **군집(herding)** 을 더했다: 무드는 자기 자신을 되먹여 한 번 쏠리면 한동안 유지된다
  //    (s(1-s²) 라 극단에선 0 이 되어 포화 — 실효 지속계수 ≤ 0.98 이므로 발산 불가).
  const herd = HERD_GAIN * s.sentiment * (1 - s.sentiment * s.sentiment);
  const sentiment = clamp(s.sentiment * MOOD_PERSIST + herd + 45 * drift + 1.6 * stretch + 0.05 * (greed - 1.2 * fear), -1, 1);

  const { regime, regimeTicks } = nextRegime(s, stretch, sentiment, fear, greed, act);
  const P = REGIME_PARAMS[regime];

  // 코일 해제 — 오래 눌려 있던 관망이 깨지는 순간 그 방향으로 추세가 실린다(수축 후 확장).
  // ⚠ FOMO 킥과 같은 이유로 `drift` 에 꽂는다 — 한 틱만 튀면 다음 봉에 흔적이 없다.
  if (s.regime === 'calm' && regime !== 'calm') {
    const dir = P.bias !== 0 ? Math.sign(P.bias) : sentiment >= 0 ? 1 : -1;
    drift = clamp(drift + dir * COIL_RELEASE * Math.min(1, s.regimeTicks / COIL_FULL_TICKS), -0.02, 0.02);
  }

  // 4) 평균회귀 — 벌어질수록 제곱으로 강해진다(무한 발산 방지 + "너무 올랐다" 심리).
  //    ⚠ 선형항이 예전의 1/3 이다(§ REVERT_LIN) — 이게 강하면 국면 드리프트가 그 자리에서 취소돼
  //    추세가 안 보이고 노이즈만 남는다.
  const revert = -REVERT_LIN * stretch - REVERT_SQ * stretch * Math.abs(stretch);

  // 5) 라운드넘버 자석 — 심리적 지지/저항 근처에서 잠시 머뭇거린다.
  //    단 무드가 극단이면 그런 자리는 그냥 뚫고 지나간다(확신에 찬 군중은 저항을 안 본다).
  //    ⚠ 격자가 **둘**이다(2026-09-07): 1.00/1.05 같은 큰 자리가 1.002/1.003 보다 훨씬 강하게 붙잡는다
  //    (예전엔 50틱 격자 하나뿐이라 "큰 자리"라는 개념이 없었다).
  const doubt = 1 - Math.abs(sentiment);
  let magnet = 0;
  for (const g of ROUND_MAGNETS) {
    const stepPx = g.ticks * virtualTick(s.ref);
    const toRound = (Math.round(s.ref / stepPx) * stepPx - s.ref) / s.ref;
    if (Math.abs(toRound) < g.zone) magnet += toRound * g.pull * doubt;
  }

  // 5b) 전 고점·전 저점의 마찰(§ LEVEL_ZONE) — 사람이 차트에서 제일 많이 하는 행동.
  const gapUp = (peak - s.ref) / s.ref; // 전 고점까지 남은 거리(>0 이면 고점 아래)
  const gapDown = (s.ref - trough) / s.ref;
  let level = 0;
  if (gapUp > LEVEL_DEAD && gapUp < LEVEL_ZONE) level -= LEVEL_FRICTION * (1 - gapUp / LEVEL_ZONE) * doubt;
  if (gapDown > LEVEL_DEAD && gapDown < LEVEL_ZONE) level += LEVEL_FRICTION * (1 - gapDown / LEVEL_ZONE) * doubt;

  // 6) 확신(conviction) — 국면 드리프트는 군중이 그 방향으로 쏠려 있을수록 세진다. 같은 rally 라도
  //    "다들 사고 있는 rally"가 더 가파르다.
  const conviction = 1 + 0.9 * clamp(sentiment * Math.sign(P.bias), 0, 1);

  // 7) 이번 틱 수익률 + 팻테일(가끔 튀는 급등락). 팻테일도 비대칭이다 — 공포장의 급락(투매 flush)이
  //    탐욕장의 급등(숏스퀴즈)보다 크고 잦다.
  //    ⚠ 순수 노이즈(TICK_NOISE)는 방향이 없어서 키워봐야 봉만 지저분해진다 — 다이내믹함은 위의
  //    drift·국면 bias·사건에서 나온다.
  let ret = drift + revert + magnet + level + P.bias * conviction + gauss() * TICK_NOISE * volEff * P.volMult;
  if (Math.random() < 0.025) ret *= 2 + Math.random() * 2;
  if (fear > 0.5 && Math.random() < 0.008) ret -= (0.004 + 0.009 * Math.random()) * volEff;
  else if (greed > 0.6 && Math.random() < 0.005) ret += (0.004 + 0.007 * Math.random()) * volEff;

  // ⚠ 다음 기준가. 클램프는 **시세 범위가 아니라 0·Infinity 만 막는 안전장치**다
  //   (§ _shared.VIRTUAL_PRICE_MIN). 예전 하한 0.0001 은 "소수 4자리 고정" 시절 틱 최소값의
  //   잔재라, 대량 매도로 가격이 내려가면 거기서 딱 멈춰 아무리 팔아도 더 안 떨어졌다(제보).
  //   실사용엔 여기 닿기 한참 전에 BOT_BASE_PULL 이 기준선으로 되돌린다.
  const ref = roundOx(clamp(s.ref * (1 + ret), VIRTUAL_PRICE_MIN, VIRTUAL_PRICE_MAX));

  // 8) 거래량은 움직임 크기와 국면에 반응한다 — 큰 봉엔 큰 거래량, 패닉엔 폭증(공포가 거래를 만든다).
  //    ⚠ 탐욕 쪽에도 배수를 준다(2026-08-26) — "급등하면 매수도 많이 붙어야" 급등처럼 보인다. 예전엔
  //    공포에만 배수가 붙어서 상승장은 조용하고 하락장만 시끄러웠다.
  const intensity = clamp(0.5 + Math.abs(ret) / 0.003, 0.45, 6);
  const nextAnchor = anchor * (1 - ANCHOR_FOLLOW) + ref * ANCHOR_FOLLOW;
  // 적정가는 가격을 느리게 따라가되(장기 추세 허용), 기준선에서 멀어질수록 **제곱으로** 세지는 약한
  // 복원력에 끌린다(§ BOT_BASE_PULL) — ±30% 파도는 그대로 두고 몇 배 표류만 막는다.
  const dev = Math.log(nextAnchor / BOT_BASE_PRICE);
  const tether = clamp(BOT_BASE_PULL * dev * (1 + BOT_BASE_PULL_CURVE * Math.abs(dev)), -0.01, 0.01);
  // 호가 깊이의 비대칭 — 공포장엔 매수벽이 걷히고 매도벽이 쌓인다(그래서 같은 크기 시장가 매도라도
  // 패닉 때 훨씬 깊게 파고든다). 탐욕장은 반대. 심리가 가격뿐 아니라 유동성으로도 드러나는 부분이다.
  const lean = clamp(sentiment, -1, 1);
  return {
    next: {
      ref,
      drift,
      vol,
      sentiment,
      anchor: nextAnchor * (1 - tether),
      regime,
      regimeTicks,
      // 고점/저점 기억은 새 극값이면 즉시 갱신되고, 아니면 현재가 쪽으로 서서히 잊힌다.
      peak: Math.max(ref, peak - (peak - ref) * EXTREME_DECAY),
      trough: Math.min(ref, trough + (ref - trough) * EXTREME_DECAY),
    },
    ret,
    // 거래량은 세션 리듬을 **변동성보다 크게** 탄다(§ SESSION_FLOW_GAIN) — 새벽엔 호가도 체결도 한산하다.
    sizeMult:
      P.sizeMult *
      intensity *
      (1 + 0.5 * fear + 0.4 * greed) *
      (1 - SESSION_FLOW_GAIN + SESSION_FLOW_GAIN * act) *
      coil *
      FLOW_CORR_NORM,
    buyProb: clamp(0.5 + P.takerBias + 0.18 * lean + (ret >= 0 ? 0.18 : -0.18), 0.05, 0.95),
    // 변동성이 크면 마켓메이커가 물러나 호가가 벌어진다(국면 배수까지 곱하되 상한을 둔다 — 안 두면
    // 투매 때 깊은 레벨이 몇 %씩 벌어져 시장가 슬리피지가 비현실적으로 커진다).
    spreadMult: clamp((0.75 + 0.45 * volEff) * P.spread, 0.6, 3.2),
    bidDepthMult: clamp(P.bidDepth * (1 + 0.35 * lean), 0.2, 2.2),
    askDepthMult: clamp(P.askDepth * (1 - 0.35 * lean), 0.2, 2.2),
    activity: act,
    volEff,
  };
}

/**
 * 마켓메이커 한 틱(requote): 봇 호가를 새로 깔고, 합성 체결을 여러 건 찍어 테이프/거래량을 만들고,
 * 유저 지정가 "벽"을 존중(클램프+소비)하고, 대기 중 유저 지정가를 walking 매칭한다. prev 상태에서
 * 심리 모델을 한 스텝 굴려 다음 상태를 반환. now 는 이 틱의 기준 시각(항상 현재 이후 — 과거면 마감된
 * 봉이 변조된다). 심리 상태는 갱신하지만 last_run 은 건드리지 않는다(게이트는 호출자 담당).
 */
/** 유저 지정가 "벽" 조회 결과(가격대별 합계) — 한 실행 동안 바뀌지 않으므로 호출자가 1회만 읽어 넘긴다. */
interface WallRow {
  side: string;
  price: number;
  size: number;
}

/** 한 틱의 결과. ⚠ D1 을 전혀 건드리지 않는다(§ 봇 틱은 메모리에서, 커밋은 한 번에). */
interface TickResult {
  next: BotState;
  tape: TapeTrade[];
  book: BotBook;
  /** 이 틱이 찍은 합성 체결들의 OHLCV(캔들 누적용). */
  bar: { open: number; high: number; low: number; close: number; volume: number };
  /** 합성 체결 명목금액 합(봇 수수료 산정용). */
  notional: number;
  actor: string;
}

/**
 * 봇 한 틱 — **순수 함수**다(2026-08-14, 무료 플랜 전환 ③④).
 *
 * 예전엔 이 함수가 직접 D1 을 읽고(벽 조회) 쓰고(batch) 대기 지정가 sweep 까지 돌려서 **틱 하나가
 * D1 쿼리 ~14개**를 먹었다. cron 은 한 번에 24틱을 도니 invocation 당 ~400쿼리 — Workers **무료 플랜의
 * invocation당 D1 쿼리 한도 50** 을 8배 넘긴다(유료는 1,000이라 안 보였다). 게다가 틱마다 상태 행과
 * 캔들 3행을 다시 써서 쓰기의 63%가 여기서 나왔다.
 *
 * 지금은 계산만 하고 아무것도 안 쓴다 → 호출자(runBotTicks)가 N틱을 메모리에서 이어 돌린 뒤
 * **결과를 단일 batch 로 한 번만** 커밋한다. 틱 수를 늘려도 D1 왕복·쓰기가 안 늘어나므로
 * 가격 경로의 촘촘함(=품질)과 비용이 분리된다.
 *
 * ⚠ **순서가 뒤집혀 있다(2026-09-08)**: 체결(테이프)을 먼저 찍고 **그 결과로** 사다리를 만든다.
 * 사다리가 이전 틱의 사다리를 물려받기 때문이다(§ keepResting) — 이번 틱에 가격이 지나간 자리의
 * 호가는 "체결된 것"이라 사라져야 하고, 그걸 알려면 이번 틱의 고가·저가가 먼저 있어야 한다.
 * ⚠ 그래서 `prevBook` 을 받는다. 호출자는 직전 틱이 만든 사다리(첫 틱이면 D1 의 `book_json`)를
 * 그대로 넘겨야 한다 — **유저 체결이 파먹은 자리가 그 안에 남아 있어야** 시장충격이 호가창에 남는다.
 */
export function simulateTick(
  prev: BotState,
  prevTape: TapeTrade[],
  prevBook: BotBook,
  wallRows: WallRow[],
  now: number,
): TickResult {
  // ⚠ 벽시계를 심리 모델에 넘긴다 — 하루 리듬(§ sessionActivity)이 이 값으로 결정된다.
  const step = nextMarketState(prev, now);
  const candidateRef = step.next.ref;
  const actor = BOT_USER_IDS[Math.floor(Math.random() * BOT_USER_IDS.length)];

  // ⚠ 유저가 걸어둔 지정가 "벽"을 존중한다(가짜 high 버그 수정). 랜덤워크 기준가가 유저의 최우선 매도벽
  // 위로 올라가거나 최우선 매수벽 아래로 내려가면, 실제 시장이라면 그 벽을 먼저 소비해야 하므로 기준가·
  // 합성체결을 벽 너머에 찍으면 안 된다. → 기준가를 [최우선 매수벽, 최우선 매도벽] 안으로 클램프하고,
  // 벽에 눌리면(press) 그 벽 가격에 봇 호가를 하나 놓아 아래 sweep 이 벽을 실제 체결로 조금씩 소비하게 한다.
  // ⚠ 가격뿐 아니라 **그 가격의 총 물량**까지 받아온다 — 벽을 얼마나 물어뜯을지가 벽 크기에 비례해야
  // 하기 때문(아래 wallAbsorbSize). 예전엔 가격만 알아서 100만주 벽이든 5천주 벽이든 똑같이 5천주씩만
  // 먹었고, 그래서 큰 벽 앞에서 몇십 분씩 가격이 굳어버렸다("봇이 쫄보라 큰 벽을 못 뚫는 느낌").
  // ⚠ 벽 목록은 **틱마다가 아니라 실행마다** 읽는다(호출자가 넘겨준다) — 한 invocation 안에서는 유저
  // 주문이 새로 들어올 수 없어 값이 안 변하는데, 틱마다 읽으면 그것만으로 쿼리가 틱 수만큼 늘어난다.
  // 단, 어느 호가가 "벽"인지는 그 틱의 기준가(prev.ref)에 따라 달라지므로 **판정은 매 틱 다시** 한다.
  let wallAsk: number | null = null;
  let wallAskSize = 0;
  let wallBid: number | null = null;
  let wallBidSize = 0;
  // ⚠ **marketable 주문은 벽으로 취급하지 않는다**(2026-07-24 버그 수정). 벽은 현재가 너머의 저항/지지
  // (매도벽=현재가 이상, 매수벽=현재가 이하)여야 한다 — 유저가 현재가보다 낮게 건 매도(=지금 팔겠다는
  // marketable 청산/지정가)나 현재가보다 높게 건 매수를 벽으로 잡으면, 기준가를 그 주문 가격으로 끌어내려
  // /끌어올려 **시장이 그 주문 쪽으로 통째로 끌려가고**(예: 시세 1.0 인데 0.5 청산 예약 하나에 시장이 0.5 로
  // 붕괴), 사다리가 그 가격에 깔려 정작 그 주문이 크로스가 안 돼 거의 안 팔리는 교착이 생긴다. marketable
  // 주문은 벽에서 빼면 아래 sweep 이 정상 사다리에 walking 체결한다. 비-marketable 벽(진짜 저항/지지)은
  // 그대로 존중 → "가짜 high"(벽 너머 유령체결) 방지 로직은 유지된다.
  for (const r of wallRows) {
    if (r.side === 'short' && r.price >= prev.ref && (wallAsk == null || r.price < wallAsk)) {
      wallAsk = r.price;
      wallAskSize = r.size;
    } else if (r.side === 'long' && r.price <= prev.ref && (wallBid == null || r.price > wallBid)) {
      wallBid = r.price;
      wallBidSize = r.size;
    }
  }
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
  // ── 이번 틱의 체결(테이프) ─ ⚠ 사다리보다 **먼저** 계산한다(§ 함수 주석: 지나간 자리의 호가는 체결된다)
  // 합성 체결을 여러 건 찍는다. ⚠ 예전엔 전부 같은 가격(ref)이라 봉 안에 구조가 없었다(몸통만 있고
  // 꼬리가 없는 캔들) — 지금은 직전 기준가에서 새 기준가로 "걸어가면서" 노이즈를 얹어 찍으므로 봉마다
  // 시가/고가/저가/종가가 제대로 생긴다. 마지막 체결은 정확히 ref(=종가)로 맞춰 기준가와 어긋나지 않게.
  // 건수·크기는 심리 모델의 sizeMult(국면·움직임 크기)에 비례한다 — 건수는 √배, 평균 크기는 1배로
  // 나눠 걸어서 거래량이 sizeMult^1.5 로 반응한다(패닉엔 "자주 그리고 크게" 체결된다).
  // ⚠ 개별 수량은 여기서 정하지 않는다 — 계층 분포(orderSize)가 개미/세력/고래를 섞는다.
  // ⚠ 체결은 **균일하게 도착하지 않는다**(2026-09-07) — 조용하다가 한꺼번에 몰린다(주문 흐름의 군집).
  // 예전엔 건수가 매 틱 6~14 균등분포라 테이프가 기계적으로 일정한 속도로 흘렀다. 지금은 낮은 확률로
  // "몰리는 틱"이 있고 평상시는 그보다 한산하다 — **가중평균이 1** 이라(FLURRY_MEAN) 캔들 거래량
  // 기대값은 그대로다(분포만 바뀐다).
  const flurry =
    Math.random() < FLURRY_CHANCE ? FLURRY_MULT * (0.8 + 0.4 * Math.random()) : LULL_MULT * (0.85 + 0.3 * Math.random());
  const nTrades = clamp(
    Math.round(
      ((BOT_TRADES_PER_TICK_MIN + Math.random() * (BOT_TRADES_PER_TICK_MAX - BOT_TRADES_PER_TICK_MIN)) *
        Math.sqrt(step.sizeMult) *
        flurry) /
        FLURRY_MEAN,
    ),
    2,
    PRINTS_PER_TICK_MAX,
  );
  const tradeMean = BOT_TRADE_MEAN * step.sizeMult;
  // ── 스톱 헌팅(유동성 사냥) ────────────────────────────────────────────────
  // 낮은 확률로 한 틱 안에서 한쪽을 훅 찔렀다가 되돌아온다 → 봉에 **긴 꼬리**가 남는다. 방향은
  // **군중과 반대**다(다들 롱이면 아래를 찔러 손절을 털고 올라온다) — 실제 시장에서 사람들이 제일
  // 억울해하는 그 움직임이고, 이게 없으면 봉이 죄다 몸통뿐이다.
  // ⚠ 기준가(ref=종가)는 건드리지 않는다 — 장기 안정성(§ npm run sim:bot)과 완전히 분리되고, 트리거
  // 판정(SL/TP·조건부)도 기준가 경로만 보므로 "꼬리에 스탑이 털렸다"는 논란이 생기지 않는다. 예전
  // jitter 가 만들던 봉 고저와 성격이 같다(테이프에 실제로 찍힌 체결이라 유령 가격도 아니다).
  const huntRoll = nTrades >= 5 && Math.random() < HUNT_CHANCE * (0.6 + 0.9 * Math.abs(prev.sentiment));
  const huntDir = prev.sentiment >= 0 ? -1 : 1;
  const huntMag = huntRoll ? (HUNT_MIN + Math.random() * HUNT_RAND) * step.volEff : 0;
  const huntLen = huntRoll ? 1 + Math.floor(Math.random() * 3) : 0;
  const huntAt = huntRoll ? 1 + Math.floor(Math.random() * Math.max(1, nTrades - 1 - huntLen)) : -1;
  let volume = 0;
  let notionalSum = 0; // 봇 수수료 산정용(합성 체결의 명목금액 합)
  let high = ref;
  let low = ref;
  let open = ref;
  // 이번 틱의 체결은 행이 아니라 링 버퍼에 얹힌다(§ 봇 합성 체결 테이프). 호출자가 준 배열을 복사해
  // 쓰는 이유: 이 batch 가 실패하면 호출자의 테이프가 오염되지 않아야 다음 틱이 깨끗한 상태로 재시도한다.
  const tape = prevTape.slice();
  // ⚠ 라벨(taker 방향)과 가격은 **절대 독립적으로 뽑지 않는다**. 2026-08-19 에 라벨을
  // `Math.random() < buyProb` 로 가격과 무관하게 뽑아서 상승틱의 38.9%가 빨강, 하락틱의 43.1%가 초록으로
  // 찍힌 적이 있다(실측 9.4만 건 — "체결 롱숏 색깔이 반대인 것 같다" 제보). 그때는 가격에서 라벨을
  // 되짚어(tick rule) 고쳤고, 아래에서는 한 걸음 더 가서 **방향이 가격을 만들도록** 인과를 바로 세웠다.
  let prevPrinted = prev.ref; // 첫 체결은 직전 기준가와 비교 — 테이프가 틱 경계에서 끊기지 않게
  // ⚠⚠ **가격은 "누가 호가를 때렸나"에서 나온다**(2026-09-07 재설계). 예전엔 체결가를 `walk × 가우시안
  // 지터`로 뽑고 그 방향에서 라벨을 되짚었다(tick rule) — 라벨 자체는 맞았지만 **원인과 결과가 뒤바뀐**
  // 모델이라 테이프가 호가창과 따로 놀았다: 체결가가 최우선 매수/매도호가와 아무 관계 없는 값이라
  // 매수·매도가 번갈아 찍히는 **호가 바운스**(실제 테이프의 지배적인 모습)가 아예 없었고, 세력이
  // 사다리를 훑고 올라가는 모습도 안 보였다. 지금은 순서를 뒤집었다:
  //   ① 이번 체결의 **테이커 방향**을 먼저 뽑는다(국면 편향 + 주문 흐름의 자기상관)
  //   ② 매수면 그 시점 최우선 **매도호가**에, 매도면 최우선 **매수호가**에 찍는다(= 호가 바운스)
  //   ③ 수량이 클수록 사다리를 더 깊이 파고든다(시장충격)
  // 라벨은 이제 되짚은 추정이 아니라 **원인 그 자체**이고, 결과적으로 tick rule 과도 거의 일치한다
  // (걷는 폭이 스프레드보다 큰 대형 봉에서만 어긋난다).
  // ⚠ 그래도 라벨을 가격과 **독립적으로** 뽑아선 안 된다(2026-08-19 의 그 버그) — 여기선 방향이 가격을
  // 만들기 때문에 종속성이 유지된다. 새 체결 경로를 추가할 때 이 인과를 끊지 말 것.
  // 첫 프린트가 곧바로 다시 뽑으므로 이 초기값 자체는 쓰이지 않는다(쪼개진 주문이 아닐 때는 매 건 새로 뽑는다).
  let flowSide: 'buy' | 'sell' = Math.random() < step.buyProb ? 'buy' : 'sell';
  const half = MICRO_HALF_SPREAD * step.spreadMult; // 최우선호가의 half-spread(사다리 최상단과 같은 값)
  let mid = prev.ref; // 호가 중간값 — 흐름이 밀고(시장충격) 목표 경로가 되돌린다(§ MICRO_MID_FOLLOW)
  // ⑤ 주문 쪼개기(§ SLICE_CHANCE) — 지금 "쪼개진 주문"을 흘려보내는 중인지. 진행 중이면 방향과 수량이
  //    그 부모 주문에 묶인다(같은 사람이 같은 의도로 계속 내는 주문이라 방향·크기가 이어진다).
  let sliceLeft = 0;
  let sliceSize = 0;
  let sliceSide: 'buy' | 'sell' = 'buy';
  for (let i = 0; i < nTrades; i++) {
    const progress = (i + 1) / nTrades;
    const walk = prev.ref + (ref - prev.ref) * progress;
    // ① 테이커 방향 + ⑤ 주문 쪼개기 — 쪼개진 주문이 흐르는 중이면 방향·수량이 부모에 묶이고, 아니면
    //    새로 뽑는다(그때 낮은 확률로 새 부모 주문이 시작된다).
    // ⚠ 수량을 **가격보다 먼저** 뽑는다 — 큰 체결일수록 사다리를 깊이 파고들어 가격을 밀어낸다.
    //   개미 체결은 최우선호가 하나를 먹고 끝이라 가격이 거의 안 움직이고, 고래가 들어오면 여러 단계를
    //   관통해 봉에 꼬리가 남는다(예전엔 크기와 가격이 독립이라 20만개가 찍혀도 차트는 아무 일 없었다).
    let sz: number;
    if (sliceLeft > 0) {
      flowSide = sliceSide;
      sz = humanSize(sliceSize * (1 + (Math.random() - 0.5) * 2 * SLICE_JITTER), 0.05);
      sliceLeft--;
    } else {
      flowSide = Math.random() < step.buyProb ? 'buy' : 'sell';
      sz = orderSize(tradeMean);
      // ⚠ 쪼갤지 말지는 **뽑힌 수량과 무관하게** 정한다(§ SLICE_CHANCE) — 크기로 조건을 걸면 자식
      //   프린트의 주변분포가 큰 쪽으로 조건화돼 캔들 거래량이 조용히 늘어난다.
      if (Math.random() < SLICE_CHANCE) {
        sliceSide = flowSide;
        sliceSize = sz;
        sliceLeft = SLICE_MIN - 1 + Math.floor(Math.random() * SLICE_RAND);
      }
    }
    const dig = Math.min(MICRO_DIG_MAX, MICRO_DIG * Math.max(0, Math.sqrt(sz / tradeMean) - 0.6)); // ③ 파고든 깊이
    const dir = flowSide === 'buy' ? 1 : -1;
    // ③ 파고든 만큼 **mid 자체가 밀린다**(사다리가 소비됐다) — 그리고 목표 경로가 서서히 되돌린다.
    //    그래서 고래가 훑고 간 자리엔 꼬리가 남고, 같은 방향이 이어지는 동안엔 가격이 단조로 걸어간다.
    mid += (walk - mid) * MICRO_MID_FOLLOW + dir * dig * mid;
    // ② 호가 바운스 — 매수는 매도호가에(mid 위), 매도는 매수호가에(mid 아래). 잔잔한 구간에선 두 가격
    //    사이를 딸깍딸깍 왕복하고, 한쪽 흐름이 몰리면 그 방향으로 계단처럼 걸어간다.
    let raw = mid * (1 + dir * half);
    // 스톱 헌팅 구간이면 군중 반대편으로 훅 찔린다(삼각 프로파일이라 꼬리가 뾰족하게 생긴다).
    if (huntRoll && i >= huntAt && i < huntAt + huntLen) {
      const shape = 1 - Math.abs((i - huntAt + 0.5) / huntLen - 0.5) * 1.2;
      raw *= 1 + huntDir * huntMag * Math.max(0.2, shape);
    }
    // 체결도 호가창과 같은 이유로 라운드 가격에 몰린다 — 실제 시장에서 체결은 "거기 걸려 있던 호가"
    // 가격에 일어나는데, 그 호가들이 위 humanQuotePrice 로 라운드 가격에 뭉쳐 있기 때문. 테이프만
    // 어중간한 값이면 호가창과 따로 노는 시장으로 보인다. 스냅 격자는 위 PRICE_GRIDS 의 가장 촘촘한
    // 격자(5틱)와 맞춘다. 마지막 체결은 기준가(=종가)와 정확히 일치시킨다.
    const tapeStep = 5 * virtualTick(raw);
    const snapped = Math.random() < 0.65 ? Math.round(raw / tapeStep) * tapeStep : raw;
    const price = i === nTrades - 1 ? ref : clampToWalls(roundOx(snapped));
    if (i === 0) open = price;
    high = Math.max(high, price);
    low = Math.min(low, price);

    volume += sz;
    notionalSum += price * sz;

    // 마지막 한 건만은 가격이 기준가로 강제되므로(위) 그 건은 가격 방향에서 라벨을 되짚는다 — 강제된
    // 가격에 흐름 방향을 그대로 붙이면 "값은 내렸는데 초록"이 될 수 있다.
    const takerSide: 'buy' | 'sell' =
      i === nTrades - 1 ? (price > prevPrinted ? 'buy' : price < prevPrinted ? 'sell' : flowSide) : flowSide;
    prevPrinted = price;
    // ⚠ 틱 내부 체결 시각을 **그 틱의 10ms 창 안에** 고르게 편다. 예전엔 `now + i` 라 건수가 11 을
    // 넘기면 다음 틱의 시각(최소 +10ms)을 넘어서서 테이프 정렬이 틱 경계에서 뒤섞였다.
    tape.push({ price, size: sz, takerSide, createdAt: now + Math.round((i * (TICK_PRINT_SPAN_MS - 1)) / Math.max(1, nTrades - 1)) });
  }

  // ── 사다리는 매 틱 다시 태어나지 않는다 — 살아남은 주문 위에 새 호가를 얹는다(2026-09-08) ──────
  // ⚠⚠ 예전엔 매 틱 44개 레벨의 **가격과 물량을 전부 새로 뽑았다**(그 전엔 "spot_orders 전 행 DELETE +
  // 44행 INSERT" 였고, 사다리를 book_json 한 칸으로 옮겨 비용은 0 이 됐지만 **내용은 여전히 매 틱
  // 통째로 새것**이었다). 그래서 호가창을 1초마다 보면 44줄의 숫자가 전부 바뀌었다 — 실제 호가창은
  // 절대 그렇게 안 생긴다. 진짜 시장의 호가엔 성격이 다른 두 종류가 섞여 있다: 초 단위로 넣고 빼는
  // 마켓메이커(최우선호가 경쟁)와, 걸어두고 기다리는 지정가(깊은 자리 — 몇 분씩 그대로 앉아 있다).
  // 게다가 통째로 새로 깔면 **유저가 대량 체결로 파먹은 자리가 1초 뒤 감쪽같이 복구**돼서 시장충격이
  // 호가창에 전혀 남지 않았다(내가 벽을 먹었는데 다음 폴링에 벽이 그대로 있다).
  // 그래서 이전 사다리를 물려받아 세 규칙으로 굴린다 — 상태는 이미 매 틱 쓰던 `book_json` 하나뿐이라
  // **D1 읽기·쓰기 증가가 0** 이다(§6 "봇 경로에서 행을 남기는 설계를 피할 것"):
  //   ① 이번 틱에 가격이 지나간 자리의 호가는 **체결된 것**이므로 사라진다(매수는 저가 이상, 매도는 고가 이하)
  //   ② 남은 주문은 mid 에 가까울수록 잘 취소된다(§ QUOTE_CHURN_TOP — 최우선호가는 거의 매 틱 재호가되고
  //      멀리 걸어둔 주문은 인내심이 있다). 거친 국면일수록 전체적으로 더 자주 넣고 뺀다.
  //   ③ 사다리의 **슬롯마다** "그 자리에 이미 앉아 있는 주문"을 찾아 쓰고, 없는 자리에만 새로 깐다
  //      → 레벨 수와 총 유동성은 예전과 같은데(둘 다 실측 대조) 가격 간격만 불규칙해진다 — 어떤 자리는
  //      비고, 라운드 가격의 벽은 여러 틱 동안 같은 자리에 남는다(§ priceHash 로 벽 위치 자체도 고정).
  //      ⚠ "살아남은 주문을 먼저 다 앉히고 남은 자리에 새 호가"로 짜면 안 된다 — mid 쪽 생존자가 정원
  //      (22)을 먹어치워 **깊은 레벨이 아예 안 깔리고** 총 유동성이 실측 35% 빠졌다(§ placeQuote).
  // ⚠ 호가 역전은 여전히 **원천적으로** 불가능하다: 살아남는 매수는 전부 이번 틱 저가보다 아래
  //   (< low ≤ ref), 살아남는 매도는 전부 고가보다 위(> high ≥ ref)이고, 새 호가는 ref 기준 양쪽으로만
  //   깔린다(humanQuotePrice 의 floor/ceil 규칙). 즉 "체결된 자리는 사라진다"가 곧 역전 방지다.
  const book: BotBook = { owner: actor, bids: [], asks: [] };
  // 기준가 주변에 여러 단계로 유동성을 깐다. 스프레드는 타이트하게(최우선호가가 mid 에 바싹) 잡되 깊은
  // 레벨로 갈수록 벌어지며 대량 주문엔 슬리피지가 생긴다. 물량을 크게 깔아 유저 주문이 시원하게 체결되게 한다.
  // ⚠ 변동성이 높은 국면(패닉/과열)에선 spreadMult 로 호가가 벌어진다 — 실제 마켓메이커가 리스크를 피해
  // 물러나는 행동이라, 거친 구간에 시장가로 들어가면 슬리피지가 커진다.
  // ⚠ 가격은 humanQuotePrice 로 라운드 가격에 끌어당기고(가격 군집), 그 자리엔 물량을 몇 배로 얹는다
  // (심리적 벽). 같은 가격으로 두 레벨이 겹치면 mid 에서 한 틱씩 더 밀어 사다리 깊이를 유지한다 —
  // 겹친 채 두면 호가창에 보이는 단계 수가 줄어든다(loadSpotMarket 이 가격별로 SUM 하므로).
  const usedPrices: Record<'buy' | 'sell', Set<number>> = { buy: new Set(), sell: new Set() };
  // 사다리가 덮는 최대 거리(가장 깊은 레벨) — 이 밖으로 밀려난 옛 주문은 마켓메이커가 거둬 다시 깐다.
  const maxSpread = (SPREAD_BASE + (BOT_LEVELS_PER_SIDE - 1) * LEVEL_STEP + LEVEL_JITTER) * step.spreadMult;
  // 거친 국면일수록 호가를 전반적으로 더 자주 넣고 뺀다(마켓메이커가 리스크를 피해 물러났다 들어온다).
  const churnMult = clamp(step.spreadMult, 0.7, 2.2);
  /** 규칙 ①② — 이전 사다리에서 "아직 살아있는" 주문만 골라 남긴다(가격 우선순위 순서 유지). */
  const survivors = (side: 'buy' | 'sell'): BookLevel[] => {
    const out: BookLevel[] = [];
    for (const l of side === 'buy' ? prevBook.bids : prevBook.asks) {
      if (!(l.size > EPS) || !(l.price > 0)) continue;
      if (side === 'buy' ? l.price >= low : l.price <= high) continue; // ① 가격이 지나갔다 = 체결됐다
      const dist = Math.abs(l.price / ref - 1) / maxSpread;
      if (!(dist <= 1)) continue; // 사다리 범위 밖(가격이 멀리 갔다) — 재호가 대상
      const churn = QUOTE_CHURN_DEEP + (QUOTE_CHURN_TOP - QUOTE_CHURN_DEEP) * (1 - dist);
      if (Math.random() < churn * churnMult) continue; // ② 취소·재호가
      // 남아 있는 주문도 가끔 일부만 취소되거나 같은 자리에 물량이 더 붙는다(배수 평균 1 = 총량 보존).
      const size =
        Math.random() < QUOTE_RESIZE_CHANCE ? l.size * (1 + (Math.random() - 0.5) * 2 * QUOTE_RESIZE_RAND) : l.size;
      if (!(size > EPS)) continue;
      out.push({ price: l.price, size: Math.max(1, Math.round(size)) });
    }
    return out;
  };
  const resting: Record<'buy' | 'sell', BookLevel[]> = { buy: survivors('buy'), sell: survivors('sell') };
  // 슬롯 하나가 자기 것으로 인정하는 가격 폭(= 레벨 간격의 절반).
  // ⚠ 귀속 판정은 **지터를 뺀 슬롯 중심**(LEVEL_STEP 격자)으로 해야 한다 — 목표가에는 매 틱 0~LEVEL_JITTER
  // 의 지터가 실려서, 그 값을 중심으로 잡으면 인접 슬롯 사이에 최대 간격의 73%짜리 **틈**이 생기고 그 틈에
  // 떨어진 살아있는 주문이 통째로 버려진다(실측: 지속 33% → 8%, 레벨 22 → 16.6).
  const slotBand = LEVEL_HALF_STEP * step.spreadMult * ref;
  /** 규칙 ③ — 이 슬롯 자리에 **이미 앉아 있는 주문**이 있으면 그대로 쓴다(새로 깔지 않는다). */
  const claimResting = (side: 'buy' | 'sell', level: number): boolean => {
    // 이 슬롯이 가져갈 |가격 − ref| 구간. 최우선호가 슬롯은 안쪽이 열려 있고(더 타이트한 주문도 여기 귀속),
    // 가장 깊은 슬롯은 바깥이 열려 있다(사다리 끝 바깥의 잔여 주문까지 흡수 — 이미 maxSpread 로 걸렀다).
    const center = (SPREAD_BASE + level * LEVEL_STEP + LEVEL_JITTER / 2) * step.spreadMult * ref;
    const lo = level === 0 ? 0 : center - slotBand;
    const hi = level === BOT_LEVELS_PER_SIDE - 1 ? Infinity : center + slotBand;
    const pool = resting[side];
    for (let i = 0; i < pool.length; i++) {
      const l = pool[i];
      const d = Math.abs(l.price - ref);
      if (d < lo || d > hi) continue;
      pool.splice(i, 1);
      if (usedPrices[side].has(l.price)) return false; // 앞 슬롯이 이미 쓴 가격(있을 수 없지만 방어)
      usedPrices[side].add(l.price);
      (side === 'buy' ? book.bids : book.asks).push(l);
      return true;
    }
    return false;
  };
  // ⚠ 겹칠 땐 **mid 에서 한 틱씩 더 멀리** 민다(예전엔 원래 목표가로 되돌렸다). 유효숫자 4자리 틱은
  // 가격대에 따라 굵어서(1.05 근처면 0.001) 레벨 간 목표 간격이 한 틱보다 좁아질 수 있고, 그러면
  // 되돌린 목표가도 이미 쓴 가격이라 사다리가 몇 단계로 뭉개진다.
  const placeQuote = (side: 'buy' | 'sell', target: number, level: number) => {
    const dst = side === 'buy' ? book.bids : book.asks;
    if (dst.length >= BOT_LEVELS_PER_SIDE) return;
    const depth = level / (BOT_LEVELS_PER_SIDE - 1);
    const q = humanQuotePrice(target, side, depth);
    let price = q.price;
    let sizeMult = q.sizeMult;
    if (usedPrices[side].has(price)) {
      const dir = side === 'buy' ? -1 : 1;
      let p = price;
      while (usedPrices[side].has(p) && p > 0) p = roundOx(p + dir * virtualTick(p));
      if (!(p > 0)) return; // 매수 사다리가 0 아래로 갈 정도면 그 레벨은 그냥 생략
      price = p;
      sizeMult = 1;
    }
    usedPrices[side].add(price);
    // ⚠ 물량에 **국면별 깊이 배수**를 건다(2026-08-12) — 예전엔 양쪽이 항상 같은 두께라, 패닉이든
    // 광기든 호가창은 똑같이 생겼고 심리는 가격에서만 보였다. 지금은 공포장이면 매수벽이 걷히고
    // (시장가 매도가 훨씬 깊게 파고든다) 매도벽이 쌓인다 — 탐욕장은 반대.
    const depthMult = side === 'buy' ? step.bidDepthMult : step.askDepthMult;
    // ⚠ 한 가격대의 물량은 "그 자리에 걸린 **여러 주문의 합**"이다(호가창은 가격별 SUM 만 보여준다).
    // 그래서 1~3명이 각자 계층 분포(orderSize)에서 뽑은 수량을 합친다 — 어떤 자리는 개미 하나뿐이라
    // 얇고(수백 개) 어떤 자리는 세력이 껴서 두껍다(수만~수십만). 예전엔 전 레벨이 2,000~10,000 균등이라
    // 호가창이 어디를 봐도 같은 자릿수였고, 시장가가 어느 구간을 지나든 저항이 똑같았다.
    // 깊은 레벨일수록 대기 물량이 두껍다(depthTilt) — 평균이 1 이라 **총 유동성은 예전과 같다**.
    const depthTilt = 0.6 + 0.8 * depth;
    const orders = 1 + Math.floor(Math.random() * 3);
    let size = 0;
    for (let i = 0; i < orders; i++) size += orderSize((BOOK_LEVEL_MEAN * sizeMult * depthMult * depthTilt) / orders);
    dst.push({ price, size });
  };
  // 1차 — 슬롯마다 살아있는 주문을 배정한다. ⚠⚠ 새 호가보다 **먼저** 해야 한다: 라운드 가격 격자가
  // 고정돼 있어서(§ priceHash) 새 호가가 살아있는 주문과 같은 가격에 내려앉기 쉽고, 순서를 섞으면 그
  // 주문이 "이미 쓴 가격"으로 밀려 통째로 버려진다(실측: 틱당 생존 19.8 중 13.4 가 그렇게 사라져
  // 지속률이 33% → 7% 로 주저앉았다).
  const filled: Record<'buy' | 'sell', boolean[]> = { buy: [], sell: [] };
  for (let level = 0; level < BOT_LEVELS_PER_SIDE; level++) {
    filled.buy[level] = claimResting('buy', level);
    filled.sell[level] = claimResting('sell', level);
  }
  // 2차 — 빈 자리에만 새 호가를 깐다.
  for (let level = 0; level < BOT_LEVELS_PER_SIDE; level++) {
    const spread = (SPREAD_BASE + level * LEVEL_STEP + Math.random() * LEVEL_JITTER) * step.spreadMult;
    if (!filled.buy[level]) placeQuote('buy', ref * (1 - spread), level);
    if (!filled.sell[level]) placeQuote('sell', ref * (1 + spread), level);
  }
  // 유저 벽에 눌렸으면(press) 그 벽 가격에 봇 호가를 얹는다 — 아래 sweep 이 유저 벽을 그 가격에 소비.
  // 물량은 **벽 크기에 비례**한다(wallAbsorbSize) — 고정 크기면 큰 벽을 영원히 못 뚫는다.
  if (press === 'up') {
    book.bids.push({ price: ref, size: wallAbsorbSize(wallAskSize, step.next.regime, step.next.sentiment) });
  } else if (press === 'down') {
    book.asks.push({ price: ref, size: wallAbsorbSize(wallBidSize, step.next.regime, step.next.sentiment) });
  }
  // 가격 우선순위대로 정렬해 둔다 — 매칭(makerLevels)도 호가창 표시도 이 순서를 그대로 쓴다.
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
  const next: BotState = { ...step.next, ref };
  return { next, tape, book, bar: { open, high, low, close: ref, volume }, notional: notionalSum, actor };
}

// 봇 심리 상태 행 ↔ BotState 변환. 컬럼이 전부 DEFAULT 를 갖고 있어 기존 행/신규 행 모두 안전하게
// 읽히고, 값이 비었거나(anchor=0=미초기화) 알 수 없는 regime 이면 안전한 기본값으로 떨어진다.
const BOT_STATE_COLS =
  'last_run, ref_price, drift, vol, sentiment, anchor, regime, regime_ticks, peak, trough, book_json, tape_json, live_json, pend_notional, pend_rows, pend_ticks';
const REGIMES: readonly Regime[] = ['calm', 'rally', 'euphoria', 'pullback', 'panic', 'capitulation'];

interface BotStateRow {
  last_run: number;
  ref_price: number;
  drift: number;
  vol: number;
  sentiment: number;
  anchor: number;
  regime: string;
  regime_ticks: number;
  peak: number;   // 최근 고점 기억(0=미초기화 → 현재가로 시작)
  trough: number; // 최근 저점 기억(0=미초기화)
  book_json: string | null; // 봇 호가 사다리(§ BotBook) — 게이트에 막힌 폴링도 이 값으로 호가창을 그린다
  tape_json: string | null; // 봇 합성 체결 링 버퍼(§ 봇 합성 체결 테이프) — 틱이 이어받아 append 한다
  live_json: string | null; // 진행 중(안 닫힌) 캔들 버킷들(§ live_json) — 닫힐 때만 spot_candles 로 넘어간다
  pend_notional: number;    // 아직 봇 수수료 카운터에 안 넘긴 합성체결 명목금액
  pend_rows: number;        // 아직 usage_meter 에 안 넘긴 예상 쓰기 행 수
  pend_ticks: number;       // 마지막 정산 이후 돈 틱 수
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
    peak: row?.peak ?? 0,
    trough: row?.trough ?? 0,
  };
}

/** 기준가 확보 — 상태 행이 없거나 0 이면 마지막 체결가로, 그것도 없으면 1 로 시작. */
async function resolveRef(env: Env, pair: string, row: BotStateRow | null): Promise<number> {
  if (row?.ref_price) return row.ref_price;
  const lastTrade = await env.DB.prepare('SELECT price FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 1')
    .bind(pair)
    .first<{ price: number }>();
  return lastTrade?.price ?? 1;
}

/** 봇 정산 주기 — 이 틱 수마다 봇 수수료 카운터·예산 계량기를 **한 번에** 넘긴다(§ pend_* 컬럼).
 * 틱마다 쓰면 그 둘만으로 봇 틱이 3행이 된다(상태 1 + 카운터 1 + 계량기 1). 값 자체는 상태 행에
 * 누적되므로(어차피 매번 쓰는 그 1행) **총액은 정확하고 반영이 최대 이 틱 수만큼 늦을 뿐**이다.
 * 120틱 ≈ cron 만 돌 때 5분, 유저가 보고 있을 때 2분. */
const BOT_ACCRUAL_TICKS = 120;

/** 봇 한 커밋이 D1 에 남기는 행 수(예산 계량용 보수적 추정, § _budget.ts 과금 모델).
 * ⚠ 단위가 "틱"이 아니라 "커밋"이다 — 버스트는 틱을 몇 개 돌든 상태 행을 한 번만 쓴다. */
const ROWS_PER_BOT_COMMIT = 1; // 상태 행 UPDATE(사다리·테이프·진행중 캔들·누적분이 전부 여기 들어있다)
const ROWS_PER_CANDLE_FLUSH = 2; // 닫힌 버킷을 넘길 때 — 새 버킷이면 행 1 + PK 인덱스 1
const ROWS_PER_BOT_ACCRUAL = 4; // 정산 시 usage_meter 1 + 봇 2명 카운터 2 (+여유 1)

/**
 * 봇 틱 N 회를 **메모리에서 이어 돌리고 결과를 단일 batch 로 한 번만 커밋**한다(2026-08-14).
 *
 * 예전엔 틱마다 (벽 조회 + 상태/캔들 batch + 봇 카운터 SELECT + 대기 지정가 sweep) = D1 쿼리 ~14개가
 * 나갔다. 그래서 cron 1회(24틱)가 ~400쿼리 — Workers **무료 플랜의 invocation당 D1 쿼리 한도 50** 을
 * 8배 초과였고, 쓰기도 틱당 6행이라 전체 쓰기의 63%를 봇이 만들었다.
 *
 * 지금은 틱 수와 무관하게 **읽기 2회(상태·벽) + 쓰기 batch 1회 + sweep 1회**다. 그 결과:
 *   · invocation 쿼리 수가 틱 수에 비례하지 않는다 → 무료 한도 안에 들어온다
 *   · 가격 경로의 촘촘함(품질)과 D1 비용이 분리된다 → 틱을 더 돌려도 공짜다
 *   · 반환한 가격 경로(path)로 트리거를 여러 지점에서 평가할 수 있다(cron 이 이걸 쓴다)
 *
 * ⚠ 벽(유저 지정가)은 이 실행 동안 바뀔 수 없으므로 한 번만 읽어 전 틱이 공유한다. 어느 호가가
 * 그 틱의 "벽"인지는 기준가에 따라 달라지므로 판정 자체는 simulateTick 이 매 틱 다시 한다.
 * ⚠ 체결 시각은 절대 과거로 소급하지 않는다(마감된 봉이 변하던 버그) — 각 틱의 시각은 그 틱을 실제로
 * 실행하는 시점(단조 증가)이고, `TICK_SPACING_MS` 는 틱 내부 체결끼리 겹치지 않게 하는 최소 간격이다.
 */
async function runBotTicks(
  env: Env,
  pair: string,
  row: BotStateRow | null,
  ref0: number,
  ticks: number,
): Promise<{ path: number[]; ctx: TickCtx }> {
  const nothing: TickCtx = { book: null, tape: null, pendings: null, live: null, ref: null };
  if (ticks <= 0) return { path: [], ctx: nothing };
  // ⚠ 상태 행이 아직 없으면 먼저 만든다 — 아래 커밋은 `last_run` 가드가 붙은 UPDATE 라 행이 없으면
  // 0행이 되어 봇이 영원히 시작하지 못한다(가상 코인을 새로 개설한 직후가 정확히 그 상태다).
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?)')
      .bind(pair, 0, ref0)
      .run();
  }
  // 이 실행이 "선점"한 시점 = 우리가 읽은 last_run. 커밋이 이 값을 가드로 써서, 그 사이 다른 요청이
  // 커밋했으면(값이 바뀌었으면) 이번 틱을 조용히 버린다(§ 커밋 = 선점).
  const guard = row?.last_run ?? 0;
  // ⚠ 이 한 번의 조회가 **셋을 먹여 살린다**(2026-08-26): 벽 판정 · 아래 sweep · 호출자의 호가창 표시.
  // 예전엔 셋이 각자 `pending_orders WHERE symbol=?` 를 읽어 `?tick=` 요청 하나가 같은 테이블을 세 번
  // 스캔했다. 집계(GROUP BY)를 메모리로 옮겨도 **읽는 행 수는 같다** — SQLite 는 집계하려고 어차피
  // 그 행들을 다 훑기 때문(§6 과금 모델). 즉 순수하게 쿼리 2개와 스캔 2번이 사라진다.
  const pendings = (
    await env.DB.prepare(
      'SELECT id, user_id, side, limit_price AS price, size, reduce_only, last_fill_at FROM pending_orders WHERE symbol=?',
    )
      .bind(pair)
      .all<PendingLite>()
  ).results;
  const wallRows = wallsOf(pendings);

  let state = toBotState(row, ref0);
  let tape = parseTape(row?.tape_json);
  const live = parseLive(row?.live_json);
  // ⚠ 이전 사다리를 읽어 첫 틱에 물려준다(2026-09-08) — 봇 호가는 매 틱 새로 태어나는 게 아니라
  // **살아남은 주문 위에 새 호가가 얹히기** 때문이다(§ simulateTick keepResting). 이 값에는 그 사이
  // 유저 체결이 파먹은 자리(bookWriteStmt)가 반영돼 있어서, 시장충격이 호가창에 그대로 남는다.
  // 추가 읽기는 없다 — `book_json` 은 어차피 이 행에서 같이 읽어온 컬럼이다(§ BOT_STATE_COLS).
  let carried: BotBook = parseBook(row?.book_json);
  let book: BotBook | null = null;
  let notional = 0;
  const closed: { code: string; bar: LiveBar }[] = [];
  const path: number[] = []; // 이 실행이 지나온 기준가들 — 트리거를 여러 지점에서 평가하는 데 쓴다
  // ⚠ 틱 시각의 출발점은 0 이 아니라 **테이프의 마지막 체결 시각**이다(2026-09-07). 버스트는 틱을 몇 개
  // 돌든 실제로는 몇 ms 밖에 안 걸리므로 `prevTs + TICK_SPACING_MS` 로 앞당겨 찍는데(과거로 소급하면
  // 마감된 봉이 변한다), 그러면 12틱 버스트의 마지막 체결이 벽시계보다 ~120ms 앞에 놓인다. 그 직후
  // 들어온 폴링이 `Date.now()` 에서 다시 시작하면 그 구간이 **테이프에서 시각 역행**으로 남는다
  // (prod 실측 700건 중 14건 — 목록 순서가 어긋나고 클라의 새 체결 식별(dripTrades)이 몇 건을 놓친다).
  // 마지막 체결 시각에서 이어 붙이면 전역 단조가 보장된다. ⚠ 미래로 폭주하지 않게 상한을 둔다 —
  // 어떤 이유로든 먼 미래 시각이 한 번 들어오면 그 뒤 모든 틱이 거기에 묶여버린다.
  let prevTs = Math.min(tape[tape.length - 1]?.createdAt ?? 0, Date.now() + TS_SEED_MAX_AHEAD_MS);
  let lastTs = Date.now();
  for (let i = 0; i < ticks; i++) {
    const ts = Math.max(Date.now(), prevTs + TICK_SPACING_MS);
    prevTs = ts;
    lastTs = ts;
    const r = simulateTick(state, tape, carried, wallRows, ts);
    state = r.next;
    tape = r.tape;
    carried = r.book;
    book = r.book;
    notional += r.notional;
    closed.push(...accrueLive(live, r.bar, ts));
    path.push(r.next.ref);
  }
  if (!book) return { path, ctx: { book: null, tape: null, pendings, live: null, ref: null } };

  const stmts: D1PreparedStatement[] = [];
  // 닫힌 버킷만 테이블로 넘긴다(진행 중 버킷은 아래 상태 행에 그대로 남아 조회 때 병합된다).
  for (const c of closed) stmts.push(candleFlushStmt(env, pair, c.code, c.bar, guard));

  let pendNotional = (row?.pend_notional ?? 0) + notional;
  let pendRows = (row?.pend_rows ?? 0) + ROWS_PER_BOT_COMMIT + closed.length * ROWS_PER_CANDLE_FLUSH;
  let pendTicks = (row?.pend_ticks ?? 0) + ticks;
  if (pendTicks >= BOT_ACCRUAL_TICKS) {
    pendRows += ROWS_PER_BOT_ACCRUAL;
    stmts.push(meterStmt(env, pendRows));
    // 봇도 수수료를 낸다(§ 봇도 거래 수수료를 낸다). ⚠ 명목금액은 두 봇에 **균등 분배** 한다 — 틱마다
    // 랜덤 액터에게 몰아주면 누적 거래대금이 한쪽으로 쏠려 두 봇의 VIP 요율이 갈린다(예전에 synthMaker
    // 가 1번 봇 하드코딩이라 700배까지 벌어진 적이 있다). 재고/현금 정산은 없다(botSide=null) —
    // 합성 체결은 봇↔봇이라 같은 계정 안에서 상계되고 수수료만 실제로 나간다.
    const share = pendNotional / BOT_USER_IDS.length;
    stmts.push(
      ...(await botFillStmts(env, pair, new Map(BOT_USER_IDS.map((id) => [id, { notional: share, size: 0 }])), null, lastTs)),
    );
    pendNotional = 0;
    pendRows = 0;
    pendTicks = 0;
  }
  // 보존 기간을 넘긴 옛 체결 정리(같은 batch — 왕복 추가 없음). 봇 체결이 테이프로 옮겨간 뒤로는
  // **유저 체결만** 남으므로 지울 게 거의 없다 — 그래도 남겨두는 이유는 이 테이블이 다시 무한히 자라지
  // 않게 하는 보험이다(§ 봇이 만드는 행은 쌓이면 안 된다).
  if (Math.random() < TRADE_PRUNE_CHANCE) {
    stmts.push(
      env.DB.prepare('DELETE FROM spot_trades WHERE pair = ? AND created_at < ?').bind(pair, lastTs - TRADE_RETENTION_MS),
    );
  }
  // 심리 상태 + 사다리 + 체결 테이프 + **진행 중 캔들 + 미정산 누적분**을 한 문장으로. 전부 "매 틱
  // 통째로 교체되는 스냅샷"이라 한 행에 담는 게 맞다(§ BotBook, § 봇 합성 체결 테이프, § live_json).
  // 그래서 **봇 커밋 하나의 쓰기 비용이 이 1행**이다. book_version 을 올려 이 순간 진행 중이던
  // 소비(bookWriteStmt)가 옛 사다리로 덮어쓰지 못하게 한다. last_run 도 여기서 함께 찍는다(직후 폴링이
  // 곧바로 겹쳐 requote 하지 않게 — 예전엔 버스트가 이걸 위해 UPDATE 를 한 번 더 날렸다).
  // ⚠⚠ **커밋이 곧 선점이다**(2026-08-20, D1 쓰기 다이어트). 예전엔 게이트를 통과한 직후 `last_run` 만
  // 찍는 **선점(claim) UPDATE 를 따로** 날려 동시 폴링의 중복 requote 를 막았다 — 그게 틱당 쓰기 1행
  // 추가였고, prod 실측 **하루 4,688행 = 전체 쓰기의 19%** 였다(같은 행을 1초에 두 번 쓴 셈).
  // 틱 계산은 순수 함수(simulateTick)라 **쓰기 직전에 판정해도 똑같이 막힌다**: 겹친 두 요청이 같은
  // 상태에서 각자 계산하고, 먼저 커밋한 쪽만 이 `last_run` 가드를 통과한다(진 쪽은 0행 → 아래에서
  // 폐기). 진 쪽이 버린 틱은 이긴 쪽이 같은 시작 상태에서 만든 틱으로 대체되므로 잃는 것도 없다.
  // ⚠ 같은 가드를 위 캔들 flush 에도 걸었다 — batch 는 0행 UPDATE 를 실패로 보지 않으므로(§4) 가드를
  // 커밋에만 달면 경합에서 진 쪽의 캔들만 반영돼 그 봉의 거래량이 부푼다(volume 은 누적이라 멱등이 아니고,
  // 1h/1d 버킷은 그 오차가 영구히 남는다).
  // ⚠ 반대로 **계량기(meterStmt)·봇 수수료(botFillStmts)·보존기간 DELETE 는 일부러 가드를 걸지 않았다** —
  //   · 계량기·봇 수수료: 진 쪽이 더한 만큼 **과대 계상**된다(진 쪽의 pend_* 리셋은 커밋되지 않으므로
  //     같은 몫이 나중에 한 번 더 계량된다). 예산 계량은 과소평가만 위험하고 과대평가는 안전한 방향이며,
  //     확률도 "경합 × 120틱마다 1회" 라 무시할 수준이다. 가드를 붙이면 문장이 복잡해지는 값이 아니다.
  //   · DELETE: 같은 조건을 두 번 실행해도 결과가 같다(멱등).
  stmts.push(
    env.DB.prepare(
      'UPDATE spot_bot_state SET last_run=?, ref_price=?, drift=?, vol=?, sentiment=?, anchor=?, regime=?, regime_ticks=?, peak=?, trough=?, book_json=?, tape_json=?, live_json=?, pend_notional=?, pend_rows=?, pend_ticks=?, book_version=book_version+1 WHERE id=? AND last_run=?',
    ).bind(
      lastTs,
      state.ref,
      state.drift,
      state.vol,
      state.sentiment,
      state.anchor,
      state.regime,
      state.regimeTicks,
      state.peak,
      state.trough,
      serializeBook(book),
      serializeTape(tape),
      JSON.stringify(live),
      pendNotional,
      pendRows,
      pendTicks,
      pair,
      guard,
    ),
  );
  const res = await env.DB.batch(stmts);
  // 커밋이 0행이면 그 사이 다른 요청(폴링·cron)이 같은 상태에서 먼저 커밋한 것 -> 이번 틱은 없던 일이다.
  // 지나온 가격 경로도 빈 배열로 돌려야 한다: 커밋되지 않은 가격으로 트리거를 판정하면(cron 이 이
  // 반환값을 쓴다) 실제로 존재한 적 없는 딥/스파이크로 조건부·SL/TP 가 체결된다.
  if (res[res.length - 1]?.meta.changes !== 1) return { path: [], ctx: { book: null, tape: null, pendings, live: null, ref: null } };

  // 방금 깐 유동성에 대기 중 유저 지정가를 walking 매칭(호가 역전/크로스 즉시 체결, 벽 소비 포함).
  // ⚠ 틱마다가 아니라 **커밋 뒤 한 번** — 호가창은 이 커밋으로 한 번 바뀌므로 그 이상은 낭비였다
  // (예전엔 버스트 12틱이면 sweep 도 12번 돌아 쿼리를 그만큼 먹었다).
  // ⚠ 대기 주문이 하나도 없으면 sweep 자체를 건너뛴다 — 위 조회가 이미 "없다"를 알려줬으므로 예전처럼
  // 같은 테이블을 다시 읽어 빈 목록을 확인할 이유가 없다(가장 흔한 경로가 쿼리 0개가 된다).
  const touched = pendings.length > 0 && (await sweepRestingOxPendings(env, pair, pendings));
  // sweep 이 실제로 체결을 냈으면 우리가 든 사다리·대기목록은 이미 낡았다 → 호출자가 다시 읽게 한다.
  // ⚠ sweep 이 체결을 냈으면 사다리·대기목록은 이미 낡았고(호출자가 다시 읽는다) 기준가도 그 체결로
  // 옮겨갔다 → 둘 다 버린다. **진행 중 캔들(live)만은 그대로 유효하다** — 체결은 `spot_candles` 에
  // 직접 쓰지 이 칸을 건드리지 않고, 그 테이블 쪽은 어차피 조회할 때 새로 읽기 때문이다.
  return {
    path,
    ctx: touched ? { book: null, tape: null, pendings: null, live, ref: null } : { book, tape, pendings, live, ref: state.ref },
  };
}

/** 폴링(유저 접속) 시 호출 — 재호가 게이트를 통과할 때만 한 틱을 돈다.
 *
 * ⚠ 반환값은 **이 요청이 이미 읽어둔 시장 스냅샷**(§ TickCtx)이다. 통합 폴링(`/api/state?tick=`)이
 * 이걸 `loadSpotMarket` 에 그대로 넘겨 상태 행과 대기 주문을 다시 읽지 않게 한다 — 게이트에 막힌
 * 폴링(가장 흔한 경로)도 여기서 읽은 행 하나로 호가창까지 그려진다. */
export async function runMarketMaker(env: Env, pair: string): Promise<TickCtx> {
  const row = await env.DB.prepare(`SELECT ${BOT_STATE_COLS} FROM spot_bot_state WHERE id = ?`)
    .bind(pair)
    .first<BotStateRow>();
  const now = Date.now();
  const last = row?.last_run ?? 0;

  // 게이트에 막혔거나 예산이 걸렸으면 틱은 없지만 **방금 읽은 행이 곧 현재 시장**이라 그대로 넘긴다
  // (대기 주문은 안 읽었으므로 pendings=null → 호가창 쪽에서만 읽는다).
  const asRead: TickCtx = {
    book: parseBook(row?.book_json),
    tape: parseTape(row?.tape_json),
    pendings: null,
    live: parseLive(row?.live_json),
    ref: row?.ref_price ?? null,
  };
  const gate = BOT_TICK_MIN_MS + Math.random() * (BOT_TICK_MAX_MS - BOT_TICK_MIN_MS);
  if (now - last < gate) return asRead; // 재호가 주기 전 — 아무것도 안 함(가장 흔한 경로: state read 1회뿐)
  // ⚠ 이번 달 D1 쓰기 예산을 넘겼으면 봇을 돌리지 않는다(§ _budget.ts) — 시장이 멈추는 건 아프지만
  // 예상 못 한 청구서보다는 낫다. 게이트를 통과한 틱에서만 물어보므로 조회가 폴링마다 늘지 않는다.
  if (await autoWritesBlocked(env, 'bot')) return asRead;

  // ⚠ 선점(claim)용 UPDATE 는 없다 — 커밋 자체가 `last_run` 가드로 선점을 겸한다(§ runBotTicks 커밋).
  // 예전엔 여기서 last_run 만 찍는 조건부 upsert 를 한 번 더 날렸고, 그게 하루 4,688행이었다.
  return (await runBotTicks(env, pair, row, await resolveRef(env, pair, row), 1)).ctx;
}

/**
 * cron 전용 — 접속자가 없어도 시장이 계속 살아있도록 한 번에 여러 틱을 몰아 돈다(게이트 무시).
 * cron 이 1분마다 부르므로 그 사이의 거래량·가격 움직임을 여기서 만든다(예전엔 5분마다 1틱뿐이라
 * 아무도 안 볼 때 차트가 사실상 멈춰 있었다).
 *
 * 반환값 = 이 버스트가 지나온 **기준가 경로**. cron 이 이걸 트리거 평가에 넘겨 그 1분 안의 딥/스파이크를
 * 조건부가 놓치지 않게 한다(§ cron: 가격 경로 샘플링).
 */
export async function runMarketMakerBurst(env: Env, pair: string, ticks: number = BOT_BURST_TICKS): Promise<number[]> {
  // 예산 초과면 이번 버스트는 통째로 건너뛴다(§ _budget.ts) — 버스트당 1회만 판정하면 되므로
  // 틱마다 조회가 붙지 않는다. 트리거 sweep(강제청산·지정가·SL/TP)은 **막지 않는다**: 그건 돈이 걸린
  // 기능이라 멈추면 유저 손실로 이어지고, 애초에 폭주하지도 않는다.
  if (await autoWritesBlocked(env, 'bot')) return [];
  const row = await env.DB.prepare(`SELECT ${BOT_STATE_COLS} FROM spot_bot_state WHERE id = ?`).bind(pair).first<BotStateRow>();
  // ⚠ 상태 행이 없을 때의 부트스트랩은 runBotTicks 안으로 옮겼다 — 폴링 경로도 커밋이 가드 UPDATE 가
  // 되면서 같은 처리가 필요해졌고, 두 곳에 두면 한쪽만 고쳐질 여지가 생긴다.
  return (await runBotTicks(env, pair, row, await resolveRef(env, pair, row), ticks)).path;
}

/** 유저가 OX 를 실제로 레버리지 거래(order.ts open/close)할 때 그 체결을 합성 시장에도 반영한다.
 * 이걸 안 하면 유저 입장에선 포지션 수량만 조용히 바뀌고 호가창·체결내역·다음 기준가엔 전혀
 * 안 보여서 "내가 산 게 반영이 안 된다"는 혼란이 생긴다 — 그래서 체결 테이프에 기록하고
 * 기준가(ref_price)도 이 체결가로 즉시 당겨준다(다음 봇 틱이 이 가격 기준으로 랜덤워크). */
export async function recordVirtualFill(
  env: Env,
  pair: string,
  uid: string,
  price: number,
  takerSide: 'buy' | 'sell',
  size: number,
): Promise<void> {
  price = roundOx(price); // 체결내역/기준가도 4자리 틱 유지
  const now = Date.now();

  // ⚠ 체결 테이프에만 기록하고 호가창은 그대로 두면 "체결은 찍히는데 호가는 그대로"인 이상한 상태가
  // 됨 — 실제 매칭처럼 반대편 최우선호가부터 이 체결수량만큼 소비(줄이거나 다 채움)한다.
  // ⚠ 예전엔 이걸 "최우선호가 SELECT → UPDATE" 를 최대 50번 **왕복**하며 했다(체결 1건에 D1 쿼리 100개).
  // 지금은 사다리가 JSON 한 칸이라 한 번 읽어 메모리에서 깎고 아래 batch 에 되쓰기 1문장만 얹는다.
  const oppositeSide: 'buy' | 'sell' = takerSide === 'buy' ? 'sell' : 'buy';
  const bookRow = await env.DB.prepare(`SELECT ${BOOK_COLS} FROM spot_bot_state WHERE id=?`).bind(pair).first<BookRow>();
  const book = parseBook(bookRow?.book_json);
  const fills = new Map<string, BotFill>(); // 상대편이 된 봇들(재고/현금/수수료 정산용)
  let remaining = size;
  for (const level of makerLevels(book, oppositeSide, null)) {
    if (remaining <= EPS) break;
    const consumed = Math.min(level.size, remaining);
    level.size -= consumed;
    // 재고 정산은 유저가 실제로 정산받은 가격(price)으로 — 호가창 소비는 "그만큼 물량이 나갔다"는 표시일 뿐,
    // 유저의 손익은 이미 이 price 로 확정돼 있어서 레벨 가격으로 부기하면 양쪽 장부가 어긋난다.
    addBotFill(fills, book.owner, price * consumed, consumed);
    remaining -= consumed;
  }
  // 호가창이 얇아 다 못 채운 잔량도 체결 자체는 성립한 물량이다(봇이 무한 풀로 받아준 셈) — 한 봇 앞으로 단다.
  if (remaining > EPS) {
    addBotFill(fills, BOT_USER_IDS[Math.floor(Math.random() * BOT_USER_IDS.length)], price * remaining, remaining);
  }

  await env.DB.batch([
    bookWriteStmt(env, pair, book, bookRow?.book_version ?? 0),
    env.DB.prepare(
      'INSERT INTO spot_trades (id, pair, buyer_id, seller_id, price, size, taker_side, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), pair, uid, uid, price, size, takerSide, now),
    env.DB.prepare(
      'INSERT INTO spot_bot_state (id, last_run, ref_price) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ref_price = excluded.ref_price',
    ).bind(pair, now, price),
    ...candleUpsertOne(env, pair, price, size, now), // 영속 캔들 갱신
    // 이 경로(호가창 walking 을 안 타는 SL/TP 정산 등)의 상대편도 봇이다 — 재고/현금/수수료를 똑같이 정산한다.
    ...(await botFillStmts(env, pair, fills, oppositeSide, now)),
  ]);
}

// ── OX/USDT 실제 호가창 매칭 엔진 ───────────────────────────────────────────
// ⚠ 근본 재설계: 예전엔 유저 주문을 호가창과 무관하게 스칼라 ref 한 값에 "전량" 체결해서
// (1) 있지도 않은 물량이 즉시 체결되고 (2) 최우선 호가보다 유리한 유령가격에 체결되는 심각한
// 버그가 있었다. 이제 유저 주문은 봇이 실제로 깐 호가(spot_orders)를 가격-시간 우선순위로
// walking 하며 체결한다 — 있는 물량만, 실제 호가 가격에, 최우선호가보다 유리하게는 절대 안 체결.
// 못 채운 잔량은 지정가면 호가창에 남아 대기(다음 유동성에 매칭), 시장가면 버린다.
// 체결된 물량만큼 상대(봇)의 재고/현금도 정산한다(botFillStmts) — 잔고 가드는 없다(무한 유동성 풀).

// 체결분을 유저 OX 레버리지 포지션에 반영하는 문장(positions 테이블만). 물타기면 병합.
function oxPositionStmts(
  env: Env,
  pair: string,
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
    ).bind(crypto.randomUUID(), uid, pair, side, price, size, effLev, margin, now, sl, tp),
  ];
}

// ── 시장가 잔량 흡수용 합성 유동성(스냅샷 매칭) ─────────────────────────────
// ⚠ 봇 호가창은 한 틱 스냅샷이라 22단계 × 2천~1만 = 최대 십수만 개뿐이다. 봇은 설계상 "무한 유동성
// 공급자"이므로, 시장가는 실제 사다리를 다 먹은 뒤에도 봇이 잔량을 받아줘야 한다(예전엔 사다리 소진 시
// break → **부분 체결 후 멈춤**, 유저가 버튼을 계속 눌러야 했다). ⚠ 핵심 재설계(2026-07-24): 예전엔
// **청크마다 DB batch/claim 을 remote D1 로 왕복**해서, 대량 주문이 수십~수백 왕복이 나고 리쿼트와 경합해
// claim 실패로 스핀하며 정체됐다(체결이 조금씩·느리게·심하면 멈춤). 이제 matchMarketOxOrder·
// closePositionAgainstBook 은 봇 호가를 **스냅샷 1회**로 읽어 **메모리에서 walking** 하고 결과를 **단일
// batch**로 적용한다(왕복이 주문 크기와 무관하게 상수). 합성 흡수도 메모리에서 잔량을 SYNTH_STEPS 로
// 균등 분할하고, 시장충격은 스텝이 진행될수록 선형으로 커지되 SYNTH_MAX_IMPACT 로 상한 — 봇은 "깊은
// 유동성 풀"이라 대량이라도 슬리피지가 완만하다. 작은 잔량은 청크 하한(SYNTH_CHUNK_MIN)으로 스텝이 준다.
// 지정가(limitPrice != null) 청산은 합성 안 함 — 크로스 호가 없으면 잔량은 대기하는 게 맞다.
const SYNTH_STEPS = 24; // 합성 흡수를 나누는 고정 스텝 수
const SYNTH_MAX_IMPACT = 0.03; // 합성 구간 누적 시장충격 상한(3%)
const SYNTH_CHUNK_MIN = 50_000; // 합성 청크 최소 크기(작은 잔량은 이 크기로 몇 스텝만에 끝남)
const MAKER_SNAPSHOT_LIMIT = 60; // 스냅샷으로 읽어오는 봇 호가 레벨 수(실제 사다리는 ~22 + 벽)
// ⚠ 유저 시장가 체결이 적정가(anchor)를 끌어당기는 비율 — "매수하면 오르고 유지된다"의 핵심.
// 예전엔 유저 체결이 ref 만 밀고 anchor 는 그대로라, 다음 봇 틱의 평균회귀(적정가 대비 과열도로 되돌림)가
// 그 움직임을 통째로 되돌려서 "긁었는데 오히려 급락"으로 보였다. 실제 시장에서 대량 주문은 정보/수요라
// 적정가 자체를 옮긴다 — 유저 체결가 방향으로 anchor 를 절반쯤 당겨 시장충격이 "굳게" 한다(나머지 절반은
// 평균회귀로 서서히 되돌아옴 = 현실적인 임팩트 감쇠). 봇 전용 시뮬레이션엔 이 경로가 없어 장기 안정성엔
// 영향 없음(BOT_BASE_PULL 이 anchor 를 기준선으로 약하게 tether). 봇↔봇 합성체결엔 적용 안 함.
const ANCHOR_TRADE_PULL = 0.5;

/** 이 체결을 **덮친 쪽**(taker). 유저가 시장가/marketable 지정가로 들어가면 'user', 이미 걸려 있던
 * 유저 지정가를 봇 호가가 덮치면 'bot' — **체결내역 라벨(매수/매도 색)만** 이걸로 뒤집힌다(포지션·잔고·
 * 상대방 기록은 유저가 실제로 사고판 방향 그대로다). 실제 거래소와 같은 규칙: 내 매수 지정가가 상대의
 * 시장가 매도에 채워지면 그 체결은 테이프에 '매도'로 뜬다. */
export type Aggressor = 'user' | 'bot';
/** taker 방향 = 유저가 사고파는 방향(유저가 덮쳤을 때) 또는 그 반대(봇이 덮쳤을 때). */
const takerSideOf = (userSide: 'buy' | 'sell', aggressor: Aggressor): 'buy' | 'sell' =>
  aggressor === 'user' ? userSide : userSide === 'buy' ? 'sell' : 'buy';

/**
 * 유저 지정가(pending_orders) 하나를 봇 호가창에 walking 매칭한다(신규 제출·대기 중 공용).
 * 증거금은 생성 시 limit_price 로 잠갔으므로 실제 체결가(더 유리)와의 차액을 환불(매수)하거나
 * 드물게 소량 추가징수(현재가 아래 매도 등, 잔고 부족 시 limit 가로 폴백)한다. 못 채운 잔량은
 * pending 에 그대로 남아 대기 → 다음 유동성/틱에서 이어서 체결(runMarketMaker·checkTriggers 가 호출).
 */
export async function matchLimitPendingAgainstBook(env: Env, pendingId: string, aggressor: Aggressor = 'user'): Promise<void> {
  const p = await env.DB.prepare('SELECT * FROM pending_orders WHERE id=?').bind(pendingId).first<PendingRow>();
  // 페어는 주문 행에서 온다 — 호출부가 심볼을 따로 넘길 필요가 없고, 잘못된 페어로 매칭될 수도 없다.
  if (!p || !isVirtualSymbol(p.symbol)) return;
  const pair = p.symbol;
  if (p.size <= EPS) {
    await env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId).run();
    return;
  }
  const isLong = p.side === 'long';
  const makerSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy'; // 봇이 잡는 쪽(롱이면 봇이 매도)
  const userSide: 'buy' | 'sell' = isLong ? 'buy' : 'sell'; // 유저가 실제로 사고파는 방향(장부·상대방 기록용)
  const tapeSide = takerSideOf(userSide, aggressor); // 체결내역에 찍히는 taker 방향

  // ── 1) 필요한 값을 한 번에 확보. ⚠ 예전엔 **청크마다** pending 재조회 + 최우선호가 SELECT + 봇호가
  //        claim + 포지션 SELECT + batch 를 최대 500회 왕복해서, 체결 하나가 D1 쿼리 수백 개를 먹었다
  //        (invocation당 1,000 한도를 혼자 태울 수 있었다). 지금은 시장가 경로와 같은 "스냅샷 → 메모리
  //        walking → 단일 batch" 패턴이다. ──
  const [existing, limitFeeRate, bookRow] = await Promise.all([
    env.DB.prepare('SELECT * FROM positions WHERE user_id=? AND symbol=? AND side=?')
      .bind(p.user_id, pair, p.side)
      .first<PositionRow>(),
    feeRateOf(env, p.user_id), // 이 주문 전체에 한 번만 확정(청크마다 읽으면 도중에 등급이 바뀐다)
    env.DB.prepare(`SELECT ${BOOK_COLS} FROM spot_bot_state WHERE id=?`).bind(pair).first<BookRow>(),
  ]);
  const effLev = existing ? existing.leverage : p.leverage; // 물타기 시 기존 레버리지 고정
  const book = parseBook(bookRow?.book_json);

  // ── 2) 지정가를 크로스하는 레벨만, 있는 물량만 메모리에서 walking(최우선호가보다 유리하게는 안 삼). ──
  let filled = 0;
  let cost = 0;
  let openPx = 0;
  let high = 0;
  let low = Infinity;
  let lastPx = 0;
  let remaining = p.size;
  let walked: { price: number; size: number }[] = []; // 체결 테이프에 찍을 실제 체결들(가격대별)
  for (const level of makerLevels(book, makerSide, p.limit_price)) {
    if (remaining <= EPS) break;
    const take = Math.min(remaining, level.size);
    if (take <= EPS) continue;
    level.size -= take;
    remaining -= take;
    filled += take;
    cost += level.price * take;
    walked.push({ price: level.price, size: take });
    if (openPx === 0) openPx = level.price;
    high = Math.max(high, level.price);
    low = Math.min(low, level.price);
    lastPx = level.price;
  }
  if (filled <= EPS) return; // 크로스되는 봇 호가 없음 → 잔량은 그대로 대기

  // ── 3) 이 pending 을 **원자적으로 선점**(claim-first). 예전엔 청크마다 봇 호가를 claim 해서 이중체결이
  //        간접적으로 막혔는데, 한 방에 체결하는 지금은 pending 쪽을 직접 잠가야 한다 — 안 그러면 유저
  //        폴링과 cron sweep 이 같은 주문을 동시에 집어 두 번 체결한다. 실패하면 다른 경로가 이미
  //        처리한 것이므로 조용히 빠진다(사다리는 아직 안 썼으므로 부작용 없음). ──
  const locked = (p.limit_price * filled) / p.leverage; // 이 체결분에 대해 주문 시점에 잠가둔 증거금
  const newPendingSize = p.size - filled;
  const claim =
    newPendingSize <= sizeEps(p.size) // 잔량 판정도 수량 비례(대량 주문의 먼지 잔량이 영원히 남지 않게)
      ? await env.DB.prepare('DELETE FROM pending_orders WHERE id=? AND size=?').bind(pendingId, p.size).run()
      : // ⚠ 부분 체결이면 시각도 같이 찍는다 — 재체결 간격 하한 판정용(§ PARTIAL_FILL_COOLDOWN_MS).
        // 어차피 쓰는 UPDATE 에 컬럼 하나가 붙을 뿐이라 쓰기 비용은 그대로 1행이다.
        await env.DB.prepare('UPDATE pending_orders SET size=?, margin=?, last_fill_at=? WHERE id=? AND size=?')
          .bind(newPendingSize, Math.max(0, p.margin - locked), Date.now(), pendingId, p.size)
          .run();
  if (claim.meta.changes !== 1) return; // 그 사이 다른 경로가 체결/취소함

  // ── 4) 증거금 정산 — 잠근 금액(지정가 기준)과 실제 체결가 기준 증거금의 차액. 청크마다 하던 계산을
  //        합계로 옮겼을 뿐 선형이라 결과는 같다. ──
  let fillAvg = cost / filled;
  let posMargin = cost / effLev;
  let feeTotal = cost * limitFeeRate;
  let refund = locked - posMargin; // 매수는 ≥0(체결가≤지정가) 환불 / 드물게 <0 이면 추가 증거금 필요
  if (refund < -EPS) {
    const extra = -refund;
    const charged = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?')
      .bind(extra, p.user_id, extra)
      .run();
    if (charged.meta.changes !== 1) {
      // 추가 증거금 감당 불가 → 지정가로 체결(정확히 잠근 만큼이라 항상 감당 가능)
      fillAvg = p.limit_price;
      cost = p.limit_price * filled;
      posMargin = locked;
      feeTotal = cost * limitFeeRate;
      walked = [{ price: p.limit_price, size: filled }]; // 전량 지정가로 정산됐으니 테이프도 그 가격 한 줄
    }
    refund = 0;
  }

  // ── 5) 나머지를 단일 batch 로. ──
  const now = Date.now();
  const closePx = roundOx(lastPx);
  const prints = splitPrints(walked);
  const stmts: D1PreparedStatement[] = [
    bookWriteStmt(env, pair, book, bookRow?.book_version ?? 0),
    ...oxPositionStmts(env, pair, existing, p.user_id, p.side, fillAvg, filled, effLev, posMargin, p.stop_loss, p.take_profit, now),
    // 체결 테이프는 walking 한 가격대별로 여러 줄(상한 USER_PRINT_MAX), 캔들은 walking 구간의 OHLC.
    ...userTradeStmts(env, pair, prints, isLong ? p.user_id : book.owner, isLong ? book.owner : p.user_id, tapeSide, now),
    env.DB.prepare(
      'INSERT INTO spot_bot_state (id,last_run,ref_price) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ref_price=excluded.ref_price',
    ).bind(pair, now, closePx),
    ...candleUpsertStmts(env, pair, { open: openPx, high, low, close: closePx, volume: filled }, now),
    // 체결 이력(주문내역)엔 이번 호출의 총 체결을 가중평균가로 1건 기록.
    env.DB.prepare('INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
      crypto.randomUUID(),
      p.user_id,
      pair,
      p.side,
      fillAvg,
      filled,
      effLev,
      'open',
      null,
      now,
    ),
    ...feeAccrualStmts(env, p.user_id, pair, 'open', cost, limitFeeRate, feeTotal, now, prints.length),
  ];
  // 지정가도 체결 시점에 수수료를 뗀다. 증거금 환불(refund)과 상계해 한 번의 잔고 조정으로 처리 —
  // 두 문장으로 나누면 배치 안에서 순서에 따라 음수 잔고가 잠깐 보이거나 문장이 늘어날 뿐이다.
  const net = refund - feeTotal;
  if (Math.abs(net) > EPS) {
    stmts.push(env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(net, p.user_id));
  }
  // 유저가 롱(매수)이면 봇이 판 쪽(sell) — 봇 현금 +, 재고 −.
  const limitMakerFills = new Map<string, BotFill>();
  addBotFill(limitMakerFills, book.owner, cost, filled);
  stmts.push(...(await botFillStmts(env, pair, limitMakerFills, makerSide, now)));
  await env.DB.batch(stmts);
}

/**
 * OX 시장가 주문 — 봇 호가창을 가격 제한 없이 walking 하며 있는 만큼만 체결(잔량은 버림).
 * 증거금은 체결분마다 실제 체결가 기준으로 조건부 차감(잔고 부족하면 감당 가능한 만큼만). 체결 총량 반환.
 */
export async function matchMarketOxOrder(
  env: Env,
  pair: string,
  uid: string,
  side: string,
  size: number,
  leverage: number,
  sl: number | null,
  tp: number | null,
  floorPnL = 0, // 크로스 가용 = 여유잔고 + floorPnL(전 포지션 미실현손익). balance 는 -floorPnL 까지 허용.
): Promise<{ filled: number; avgPrice: number; reason?: 'liquidity' | 'margin' }> {
  const isLong = side === 'long';
  const openMakerSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy'; // 봇이 잡는 쪽(롱 진입이면 봇이 매도)
  const openAdverse = isLong ? 1 : -1; // 사면 위로, 팔면 아래로 시장충격

  // ── 1) 필요한 값을 몇 번의 read 로 한 번에 확보(예전엔 청크마다 read/batch 왕복이라 대량이 느리고
  //        리쿼트와 경합해 정체됐다). 수수료율은 주문 전체에 한 번만 확정(청크마다 등급이 바뀌지 않게). ──
  const existing0 = await env.DB.prepare('SELECT * FROM positions WHERE user_id=? AND symbol=? AND side=?')
    .bind(uid, pair, side)
    .first<PositionRow>();
  const effLev = existing0 ? existing0.leverage : leverage; // 물타기 시 기존 레버리지 고정
  // ⚠ 잔고와 요율은 **같은 users 행**이라 한 번에 읽는다 — 예전엔 feeRateOf(total_volume) 와 balance 를
  // 따로 읽어 같은 행을 두 번 조회했다(§6 "같은 걸 한 요청 안에서 두 번 읽지 않는다"). 무료 플랜은
  // invocation 당 쿼리가 50 뿐이라 이런 한 개가 실제로 체결 성패를 가른다(§ userTradeStmts).
  const me = await env.DB.prepare('SELECT balance, total_volume FROM users WHERE id=?')
    .bind(uid)
    .first<{ balance: number; total_volume: number }>();
  const feeRate = vipOf(me?.total_volume ?? 0).rate;
  const bal0 = me?.balance ?? 0;
  // 기준가·적정가와 **봇 사다리를 같은 한 행에서** 함께 읽는다(예전엔 호가창을 따로 SELECT 했다).
  const st = await env.DB.prepare(`SELECT ref_price, anchor, ${BOOK_COLS} FROM spot_bot_state WHERE id=?`)
    .bind(pair)
    .first<{ ref_price: number; anchor: number } & BookRow>();
  const est = st?.ref_price ?? 1;

  // 감당 가능 수량으로 목표를 먼저 클램프(부풀린 평단→즉시 강제청산 방지, 기존 로직 유지).
  const perUnitEst = est / effLev + est * feeRate;
  const affordableUnits = perUnitEst > 0 ? ((bal0 + floorPnL) * 0.999) / perUnitEst : 0;
  const target = Math.min(size, Math.max(0, affordableUnits));
  if (target <= EPS) return { filled: 0, avgPrice: 0, reason: 'margin' };

  // ── 2) 위에서 함께 읽어온 봇 사다리를 메모리에서 walking(청크마다 왕복하지 않는다). ──
  const book = parseBook(st?.book_json);
  type MemFill = { level: BookLevel | null; makerUserId: string; price: number; size: number };
  const planned: MemFill[] = [];
  let remaining = target;
  for (const level of makerLevels(book, openMakerSide, null).slice(0, MAKER_SNAPSHOT_LIMIT)) {
    if (remaining <= EPS) break;
    const take = Math.min(remaining, level.size);
    if (take <= EPS) continue;
    planned.push({ level, makerUserId: book.owner, price: level.price, size: take });
    remaining -= take;
  }
  // 실제 사다리를 다 먹으면 봇 무한 유동성(합성)으로 잔량 흡수 — 고정 스텝·상한 시장충격(슬리피지 완만).
  // ⚠ 램프의 **기준은 사다리를 다 먹은 지점**(마지막 체결가)이지 주문 전 기준가가 아니다. 예전엔 `est`
  // 에서 다시 시작해서, 사다리 위쪽(예 1.156)까지 먹고도 합성 첫 스텝이 1.130 으로 **되돌아갔다** —
  // 체결을 1건으로 집계해 찍던 시절엔 안 보였지만, 이제 walking 을 가격대별로 찍으므로 체결창에 가격이
  // 위아래로 튀는 게 그대로 드러난다(실제 거래소의 한 번의 sweep 은 절대 되돌아가지 않는다).
  if (remaining > EPS) {
    const synthBase = planned.length ? planned[planned.length - 1].price : est;
    const synthChunk = Math.max(SYNTH_CHUNK_MIN, remaining / SYNTH_STEPS);
    for (let idx = 1; remaining > EPS && idx <= SYNTH_STEPS * 4; idx++) {
      const impact = Math.min(SYNTH_MAX_IMPACT, (SYNTH_MAX_IMPACT * idx) / SYNTH_STEPS);
      const price = roundOx(Math.max(VIRTUAL_PRICE_MIN, synthBase * (1 + openAdverse * impact)));
      const take = Math.min(remaining, synthChunk);
      planned.push({ level: null, makerUserId: BOT_USER_IDS[idx % BOT_USER_IDS.length], price, size: take });
      remaining -= take;
    }
  }

  // ── 3) 가용 증거금 안에서 정밀 정산(사다리를 위로 갈수록 가격이 올라 실제 비용이 est 추정보다 크므로
  //        마지막 체결은 감당 가능한 만큼만 잘라낸다). 봇별 정산·소비할 실제 호가·OHLC 를 함께 누적.
  //  ⚠ budget 은 가용의 딱 100% 가 아니라 아주 살짝 아래로 둔다 — 감당분에 정확히 맞추면 아래 charge 의
  //     원자 가드(balance - 총비용 >= -floorPnL)가 부동소수 오차로 실패해 체결이 통째로 0 이 된다. ──
  const avail = bal0 + floorPnL;
  const budget = avail * (1 - 1e-6);
  let filled = 0;
  let cost = 0;
  let feeTotal = 0;
  let spent = 0;
  let openPx = 0;
  let high = 0;
  let low = Infinity;
  let lastPx = est;
  const makerFills = new Map<string, BotFill>();
  const settled: { price: number; size: number }[] = []; // 체결 테이프에 찍을 실제 체결들(가격대별)
  for (const f of planned) {
    const perUnit = f.price / effLev + f.price * feeRate;
    let sz = f.size;
    if (spent + sz * perUnit > budget) {
      const afford = (budget - spent) / perUnit;
      if (afford <= EPS) break;
      sz = Math.min(sz, afford);
    }
    if (sz <= EPS) break;
    spent += sz * perUnit;
    filled += sz;
    cost += f.price * sz;
    feeTotal += f.price * sz * feeRate;
    if (openPx === 0) openPx = f.price;
    high = Math.max(high, f.price);
    low = Math.min(low, f.price);
    lastPx = f.price;
    addBotFill(makerFills, f.makerUserId, f.price * sz, sz);
    settled.push({ price: f.price, size: sz });
    if (f.level) f.level.size -= sz; // 실제 사다리 물량 소비(참조라 그대로 book 에 반영된다)
    if (sz < f.size - EPS) break; // 가용 소진 — 여기서 멈춤
  }
  if (filled <= EPS) return { filled: 0, avgPrice: 0, reason: 'liquidity' };

  const avgPrice = cost / filled;
  const totalMargin = cost / effLev; // Σ(price*size)/effLev
  const newRef = roundOx(lastPx);
  const anchor0 = st?.anchor && st.anchor > 0 ? st.anchor : est;
  const newAnchor = roundOx(anchor0 + (newRef - anchor0) * ANCHOR_TRADE_PULL); // 유저 임팩트가 적정가를 끌어당김
  const now = Date.now();

  // ── 4) 잔고를 **먼저** 원자 가드로 확정(charge-first) — batch 안에 조건부 UPDATE 를 넣으면 0행이어도
  //        나머지가 커밋돼 "증거금 없이 포지션만" 생긴다(D1 batch 함정). target 을 이미 감당분으로 잘랐으니 통과. ──
  const charge = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance-? >= ?')
    .bind(totalMargin + feeTotal, uid, totalMargin + feeTotal, -floorPnL)
    .run();
  // ⚠ 여기서 0행이면 "호가가 없어서"가 아니라 **읽은 뒤 잔고가 바뀌어서**다(동시 폴링의 트리거 체결·
  // 강제청산 등). 호출부가 "체결 가능한 호가 물량이 없습니다" 라고만 답하면 원인을 완전히 오해하게 되므로
  // 사유를 구분해 돌려준다.
  if (charge.meta.changes !== 1) return { filled: 0, avgPrice: 0, reason: 'margin' }; // 레이스로 가용 부족 → 다음 시도

  // ── 5) 나머지를 단일 batch 로 적용(포지션 병합 + 소비한 실제 호가 + 체결테이프 + 기준가/적정가 + 캔들 + 부기). ──
  const stmts: D1PreparedStatement[] = [];
  // 소비한 사다리를 best-effort 로 되쓴다(그 사이 재호가가 있었으면 0행이어도 무방 — 봇은 무한 유동성이라
  // 환불/재시도 없이 체결은 그대로 성립. 이 best-effort 가 예전 claim-실패-스핀 정체를 없앤 그 원칙이다).
  stmts.push(bookWriteStmt(env, pair, book, st?.book_version ?? 0));
  stmts.push(...oxPositionStmts(env, pair, existing0, uid, side, avgPrice, filled, effLev, totalMargin, sl, tp, now));
  // 체결 테이프는 **walking 한 가격대별로 여러 줄**(§ userTradeStmts) — 예전엔 1건으로 집계해서 큰
  // 시장가가 "한 줄에 몇 백만 개"로 찍혔다. 봇 상대라 counterparty 는 표시용.
  const prints = splitPrints(settled);
  stmts.push(...userTradeStmts(env, pair, prints, isLong ? uid : BOT_USER_IDS[0], isLong ? BOT_USER_IDS[0] : uid, isLong ? 'buy' : 'sell', now));
  stmts.push(
    env.DB.prepare(
      'INSERT INTO spot_bot_state (id,last_run,ref_price,anchor) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET ref_price=excluded.ref_price, anchor=excluded.anchor',
    ).bind(pair, now, newRef, newAnchor),
  );
  stmts.push(...candleUpsertStmts(env, pair, { open: openPx, high, low, close: newRef, volume: filled }, now));
  stmts.push(
    env.DB.prepare('INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
      crypto.randomUUID(),
      uid,
      pair,
      side,
      avgPrice,
      filled,
      effLev,
      'open',
      null,
      now,
    ),
  );
  stmts.push(...feeAccrualStmts(env, uid, pair, 'open', cost, feeRate, feeTotal, now, prints.length));
  stmts.push(...(await botFillStmts(env, pair, makerFills, openMakerSide, now)));
  await env.DB.batch(stmts);
  return { filled, avgPrice };
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
  aggressor: Aggressor = 'user',
): Promise<{ filled: number; avgPrice: number }> {
  const pair = pos.symbol; // 페어는 포지션 행에서 온다(호출부가 따로 넘기지 않는다)
  const closeTaker = pos.side === 'long' ? 'short' : 'long'; // 청산 방향(롱 청산=매도=short, 봇 매수호가 소비)
  const userSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy'; // 유저가 실제로 사고파는 방향(롱 청산=매도)
  const tapeSide = takerSideOf(userSide, aggressor); // ⚠ 체결내역 라벨만 aggressor 로 뒤집힌다(장부는 userSide)
  const makerSide: 'buy' | 'sell' = closeTaker === 'long' ? 'sell' : 'buy';
  const dir = pos.side === 'long' ? 1 : -1;
  const adverse = closeTaker === 'long' ? 1 : -1; // 사면(숏청산) 위로, 팔면(롱청산) 아래로 시장충격
  const marginPerUnit = pos.size > EPS ? pos.margin / pos.size : 0;
  // 요율은 이 청산 전체에 한 번만 확정(청크마다 다시 읽으면 체결 도중 등급이 바뀔 수 있다).
  const closeFeeRate = await feeRateOf(env, uid);

  // ── 1) 봇 호가 사다리를 스냅샷으로 한 번에 읽어 메모리에서 walking(청크마다 왕복하지 않는다 —
  //        예전엔 대량 청산이 청크마다 batch/claim 왕복이라 느리고 리쿼트와 경합해 정체됐다). ──
  // 기준가·적정가와 봇 사다리를 같은 한 행에서 함께 읽는다(예전엔 호가창을 따로 SELECT 했다).
  const st = await env.DB.prepare(`SELECT ref_price, anchor, ${BOOK_COLS} FROM spot_bot_state WHERE id=?`)
    .bind(pair)
    .first<{ ref_price: number; anchor: number } & BookRow>();
  const est = st?.ref_price ?? pos.entry_price;
  const book = parseBook(st?.book_json);

  type MemFill = { level: BookLevel | null; makerUserId: string; price: number; size: number };
  const planned: MemFill[] = [];
  let remaining = Math.min(closeSize, pos.size);
  // 지정가 청산이면 그 가격보다 불리한 레벨은 makerLevels 가 걸러낸다(롱 청산은 ≥limit 매수호가만 소비).
  for (const level of makerLevels(book, makerSide, limitPrice).slice(0, MAKER_SNAPSHOT_LIMIT)) {
    if (remaining <= EPS) break;
    const take = Math.min(remaining, level.size);
    if (take <= EPS) continue;
    level.size -= take; // 소비 반영(참조)
    planned.push({ level, makerUserId: book.owner, price: level.price, size: take });
    remaining -= take;
  }
  // 시장가 청산은 봇 무한 유동성으로 잔량 흡수. ⚠ 지정가 청산(limitPrice != null)은 크로스되는 호가가
  // 없으면 잔량을 대기시킨다(합성 안 함 — 기존 동작 유지).
  if (remaining > EPS && limitPrice == null) {
    // ⚠ 진입과 같은 규칙 — 램프 기준은 사다리를 다 먹은 지점(마지막 체결가)이다(위 matchMarketOxOrder 참고).
    const synthBase = planned.length ? planned[planned.length - 1].price : est;
    const synthChunk = Math.max(SYNTH_CHUNK_MIN, remaining / SYNTH_STEPS);
    for (let idx = 1; remaining > EPS && idx <= SYNTH_STEPS * 4; idx++) {
      const impact = Math.min(SYNTH_MAX_IMPACT, (SYNTH_MAX_IMPACT * idx) / SYNTH_STEPS);
      const price = roundOx(Math.max(VIRTUAL_PRICE_MIN, synthBase * (1 + adverse * impact)));
      const take = Math.min(remaining, synthChunk);
      planned.push({ level: null, makerUserId: BOT_USER_IDS[idx % BOT_USER_IDS.length], price, size: take });
      remaining -= take;
    }
  }

  // ── 2) 메모리에서 정산(청산은 잔고를 환급하므로 감당 제약 없음 — 계획대로 전량 체결). ──
  let filled = 0;
  let cost = 0;
  let pnlTotal = 0;
  let closeFeeTotal = 0;
  let openPx = 0;
  let high = 0;
  let low = Infinity;
  let lastPx = est;
  const closeMakerFills = new Map<string, BotFill>();
  for (const f of planned) {
    filled += f.size;
    cost += f.price * f.size;
    pnlTotal += (f.price - pos.entry_price) * f.size * dir;
    closeFeeTotal += f.price * f.size * closeFeeRate;
    if (openPx === 0) openPx = f.price;
    high = Math.max(high, f.price);
    low = Math.min(low, f.price);
    lastPx = f.price;
    addBotFill(closeMakerFills, f.makerUserId, f.price * f.size, f.size);
  }
  if (filled <= EPS) return { filled: 0, avgPrice: 0 };

  const avgPrice = cost / filled;
  // ⚠ 전량 판정 오차는 **수량 비례**(sizeEps) — 1e15 개를 여러 청크로 walking 하면 합산 오차가 0.1~1 단위로
  // 나와서, 고정 1e-9 로 비교하면 전량을 청산해도 "먼지 잔량"이 남은 것으로 보고 포지션이 안 지워진다
  // (청산 버튼을 눌러도 수량이 0 이 안 됨). 전량이면 증거금도 비율 계산이 아니라 잠긴 전액을 그대로 환급한다
  // (비율 계산의 반올림 손실이 잔고에 남지 않게).
  const fullyClosed = filled >= pos.size - sizeEps(pos.size);
  const marginReleased = fullyClosed ? pos.margin : marginPerUnit * filled;
  const newRef = roundOx(lastPx);
  const anchor0 = st?.anchor && st.anchor > 0 ? st.anchor : est;
  const newAnchor = roundOx(anchor0 + (newRef - anchor0) * ANCHOR_TRADE_PULL); // 유저 청산 임팩트도 적정가를 끌어당김
  const now = Date.now();

  // ── 3) 단일 batch 로 적용(잔고 환급 + 포지션 축소/삭제 + 소비 호가 + 테이프 + 기준가/적정가 + 캔들 +
  //        pending 갱신 + 주문기록 + 부기). 환급은 조건부가 아니라 batch 에 넣어도 안전. ──
  const stmts: D1PreparedStatement[] = [];
  stmts.push(env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(marginReleased + pnlTotal - closeFeeTotal, uid));
  stmts.push(
    fullyClosed
      ? env.DB.prepare('DELETE FROM positions WHERE id=? AND user_id=?').bind(pos.id, uid)
      : env.DB.prepare('UPDATE positions SET size=?, margin=? WHERE id=? AND user_id=?').bind(pos.size - filled, pos.margin - marginReleased, pos.id, uid),
  );
  // 소비한 사다리를 best-effort 로 되쓴다(재호가가 끼었으면 0행 — 봇은 무한 유동성이라 체결은 성립).
  stmts.push(bookWriteStmt(env, pair, book, st?.book_version ?? 0));
  // 청산도 walking 한 가격대별로 여러 줄(§ userTradeStmts) — 진입과 같은 규칙.
  const prints = splitPrints(planned.map((f) => ({ price: f.price, size: f.size })));
  stmts.push(...userTradeStmts(env, pair, prints, userSide === 'buy' ? uid : book.owner, userSide === 'buy' ? book.owner : uid, tapeSide, now));
  stmts.push(
    env.DB.prepare(
      'INSERT INTO spot_bot_state (id,last_run,ref_price,anchor) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET ref_price=excluded.ref_price, anchor=excluded.anchor',
    ).bind(pair, now, newRef, newAnchor),
  );
  stmts.push(...candleUpsertStmts(env, pair, { open: openPx, high, low, close: newRef, volume: filled }, now));
  if (pendingId) {
    stmts.push(
      filled >= pendingSize - sizeEps(pendingSize)
        ? env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId)
        : // 부분 체결 시각도 함께(재체결 간격 하한 판정용, § PARTIAL_FILL_COOLDOWN_MS) — 같은 1행 UPDATE.
          env.DB.prepare('UPDATE pending_orders SET size=?, last_fill_at=? WHERE id=?').bind(pendingSize - filled, now, pendingId),
    );
  }
  stmts.push(
    env.DB.prepare('INSERT INTO orders (id,user_id,symbol,side,price,size,leverage,kind,pnl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
      crypto.randomUUID(),
      uid,
      pair,
      pos.side,
      avgPrice,
      filled,
      pos.leverage,
      'close',
      pnlTotal,
      now,
    ),
  );
  stmts.push(...feeAccrualStmts(env, uid, pair, 'close', cost, closeFeeRate, closeFeeTotal, now, prints.length));
  stmts.push(...(await botFillStmts(env, pair, closeMakerFills, makerSide, now))); // 롱 청산이면 유저가 팔고 봇이 산다(makerSide='buy')
  await env.DB.batch(stmts);

  return { filled, avgPrice };
}

/** OX 시장가 청산 — 봇 호가창을 walking 하며 있는 물량만큼만 청산(매물 없으면 부분). order.ts close 액션이 호출. */
export function marketCloseOxPosition(env: Env, uid: string, pos: PositionRow, closeSize: number) {
  return closePositionAgainstBook(env, uid, pos, closeSize, null, null, 0);
}

/** OX 지정가 청산(reduce-only) 대기 주문 하나를 봇 호가창에 매칭한다(제출 직후·재호가 sweep·checkTriggers 공용).
 * 청산 대상 포지션이 이미 없으면(전량청산·강제청산됨) 고아 pending 을 정리한다. */
export async function matchReduceOnlyOxPending(env: Env, pendingId: string, aggressor: Aggressor = 'user'): Promise<void> {
  const p = await env.DB.prepare('SELECT * FROM pending_orders WHERE id=?').bind(pendingId).first<PendingRow>();
  if (!p || !isVirtualSymbol(p.symbol) || !p.reduce_only) return;
  const pair = p.symbol;
  const posSide = p.side === 'short' ? 'long' : 'short'; // 청산 대상 포지션 방향(주문 side 의 반대)
  const pos = await env.DB.prepare('SELECT * FROM positions WHERE user_id=? AND symbol=? AND side=?')
    .bind(p.user_id, pair, posSide)
    .first<PositionRow>();
  if (!pos) {
    await env.DB.prepare('DELETE FROM pending_orders WHERE id=?').bind(pendingId).run(); // 청산할 포지션 없음 → 정리
    return;
  }
  await closePositionAgainstBook(env, p.user_id, pos, Math.min(p.size, pos.size), p.limit_price, pendingId, p.size, aggressor);
}

/** 대기 중인 전 유저의 OX 지정가(진입·청산)를 봇 호가창에 매칭 — runMarketMaker 가 재호가 직후 호출하므로,
 * 주문 낸 유저가 접속/폴링 중이 아니어도 유동성이 크로스되면 실제 호가 가격에 이어서 체결된다. */
/** ⚠ **이미 부분 체결된** 지정가를 다시 체결하기까지의 최소 간격(2026-08-14, 무료 플랜 전환 ④).
 *
 * 시장이 한 번에 소화 못 하는 큰 지정가는 봇이 재호가할 때마다 조금씩 계속 체결된다 — 합성 유동성은
 * 매 틱 되살아나므로 **영원히** 그렇다. 그런데 그 한 번 한 번이 (포지션+주문+원장+체결테이프+캔들+
 * 봇정산) ~20행짜리 체결 batch 다. prod 실측: 주문 **하나**가 하루 3,000건을 체결해 하루 6만 행을 썼다.
 * 이건 봇 사다리·체결 테이프와 같은 부류의 구조적 낭비다(무한히 반복되는데 아무도 한도를 안 정했다).
 *
 * 한 번에 다 체결되는 보통 주문은 그 자리에서 행이 삭제되므로 이 하한을 **한 번도 만나지 않는다** —
 * 영향을 받는 건 "시장 깊이보다 큰 주문"뿐이고, 그런 주문이 천천히 채워지는 건 실제 시장의 정상 동작이다.
 */
export const PARTIAL_FILL_COOLDOWN_MS = 5_000;

/** ⚠ 한 요청에서 이 sweep 이 실제로 체결시키는 대기 주문 수 상한(2026-09-08).
 *
 * 체결 하나가 (포지션+주문+원장+체결테이프+캔들+봇정산) 문장 십수 개짜리 batch 라, 크로스된 지정가가
 * 여러 개면 **한 invocation 이 무료 플랜의 D1 쿼리 상한(50)을 그대로 넘긴다** — 넘는 순간 그 뒤 모든
 * 바인딩 호출이 던져지므로 봇 커밋도 응답 생성도 함께 죽어 `/api/state?tick=` 이 통째로 500 이 된다
 * (지금은 대기 주문이 없어 안 터졌을 뿐인 잠복 함정이다). 넘긴 주문은 다음 틱(≈1초 뒤)에 이어서
 * 체결되고, **첫 체결은 항상 우선**이라 "방금 낸 주문이 즉시 체결되는 체감"은 그대로 유지된다. */
const MAX_SWEEP_FILLS = 2;

async function sweepRestingOxPendings(env: Env, pair: string, pendings: PendingLite[]): Promise<boolean> {
  const now = Date.now();
  let touched = false;
  let fills = 0;
  // 이미 부분 체결된 주문이 하나라도 있으면 예산을 확인한다(없으면 조회조차 안 한다 — 흔한 경로가 공짜).
  const nibbling = pendings.some((p) => p.last_fill_at != null);
  const throttled = nibbling && (await autoWritesBlocked(env, 'nibble'));
  // 첫 체결(아직 한 번도 안 채워진 주문)을 앞세운다 — 상한에 걸려 미뤄지는 건 "이미 조금씩 채워지는 중"인 쪽이어야 한다.
  for (const p of [...pendings].sort((a, b) => (a.last_fill_at == null ? 0 : 1) - (b.last_fill_at == null ? 0 : 1))) {
    if (fills >= MAX_SWEEP_FILLS) break; // 나머지는 다음 틱에서(§ MAX_SWEEP_FILLS)
    // ⚠ 첫 체결은 절대 늦추지 않는다(last_fill_at == null) — 유저가 방금 낸 주문이 즉시 체결되는 체감은
    // 이 사이트가 여러 번 튜닝해온 핵심이다. 하한은 **재체결**에만 건다.
    if (p.last_fill_at != null) {
      if (throttled) continue; // 오늘 예산이 위험 — 재체결만 쉰다(신규 주문·청산·강제청산은 그대로)
      if (now - p.last_fill_at < PARTIAL_FILL_COOLDOWN_MS) continue;
    }
    try {
      // ⚠ 여기서 체결되는 주문은 **이미 걸려 있던**(resting) 유저 지정가다 — 그걸 덮친 건 방금 깔린 봇
      // 호가이므로 taker 는 봇이고 유저는 maker 다. 그래서 체결내역 라벨은 유저 방향의 **반대**로 찍힌다
      // (실제 거래소도 그렇다: 내 매수 지정가가 시장가 매도에 채워지면 그 체결은 '매도'로 뜬다).
      touched = true; // 매칭을 시도한 순간부터 사다리·대기목록 스냅샷은 못 믿는다(호출자가 다시 읽는다)
      fills++;
      if (p.reduce_only) await matchReduceOnlyOxPending(env, p.id, 'bot');
      else await matchLimitPendingAgainstBook(env, p.id, 'bot');
    } catch {
      /* 한 건 실패해도 나머지는 계속 — 다음 틱에서 재시도 */
    }
  }
  return touched;
}
