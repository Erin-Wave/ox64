/**
 * 봇 심리 모델 장기 시뮬레이션 — `npm run sim:bot`
 *
 * ⚠ **봇 심리 파라미터(functions/api/spot.ts REGIME_PARAMS / nextMarketState)를 건드렸다면 반드시 이걸
 * 돌릴 것.** 모델은 DB 접근이 없는 순수 함수라 그대로 떼어내 며칠치를 몇 초에 굴릴 수 있고, 그러지 않으면
 * "틱마다 미세하게 남은 편향"이 며칠 뒤 가격을 0 으로 붕괴시키거나 발산시킨다(실제로 초기 튜닝에서
 * 5일 만에 -40% 가 나왔다). 국면 bias 는 국면 점유율로 가중했을 때 합이 ~0 이어야 한다.
 *
 * 합격선(§ CLAUDE.md "장기 안정성"):
 *   - 5~20일 뒤 가격이 시작가의 대략 0.5~2배 안에 머문다(앵커 tether)
 *   - **추세효율 0.55 이상** — 30틱 창의 |순이동| / Σ|틱 이동|. 이게 낮으면 국면·추세가 아무리 있어도
 *     화면엔 방향 없는 진동만 보인다("사팔사팔", 2026-08-26 재설계 전 값이 0.28 이었다)
 *   - **국면 평균 수명 50틱 이상** — 8틱짜리 국면은 노이즈에 파묻혀 차트에 안 나타난다
 *   - 수익률 lag1 자기상관 ≈ +0.5(추세 지속), |수익률| lag1 자기상관 ≈ 0.4 이상(변동성 뭉침)
 *   - 1분봉 평균 고저폭 ≈ 2~3%, 틱 표준편차 ≈ 0.3% 이하(노이즈를 키워서 다이내믹을 만들면 안 된다)
 *   - 국면 점유율에 극단적 편중이 없고, capitulation 은 "가끔"(1% 미만) 나온다
 *   - **로그드리프트/틱 |값| 2e-6 이하** — 종가는 log-normal 이라 8회 평균으로도 2배씩 흔들리지만
 *     이 값은 표본이 수백만이라 SE 가 0.01e-6 수준이다. 편향은 여기서 본다(위험선 28e-6 = 5일에 2.4배).
 *     ⚠ 산술평균이 아니라 **산술평균 − 분산/2** 여야 한다 — 가격은 곱으로 누적되기 때문
 *   - **세션 활성도 평균 ~1.00** (§ sessionActivity) — 1 이 아니면 전체 변동성·거래량이 조용히 바뀐
 *     것이다. 기본 7일(정확히 한 주)이어야 이 값이 1 로 나온다(평일만 돌리면 1.08)
 *   - **코일 비 1 미만** — 오래 눌린 관망이 갓 시작한 관망보다 조용해야 "수축 후 확장"이 성립한다
 *   - 체결 테이프: **틱당 거래량 ~10만**(분포를 바꿔도 총량은 보존한다는 불변식),
 *     **상승틱 매수라벨 70%+ / 하락틱 20% 내외**(라벨과 가격의 인과가 살아있나),
 *     방향 전환율 25~40%(호가 바운스가 한 색 블록으로 뭉치지 않았나)
 *   - 호가창: **한쪽 레벨 22개**(슬롯 배정이 깨지면 조용히 줄어든다), **호가 지속 25% 안팎**
 *     (직전 틱과 가격·물량이 그대로인 레벨 — 0 에 가까우면 사다리가 매 틱 통째로 새로 태어나는 것이고,
 *     너무 높으면 최우선호가가 갱신되지 않는 것이다), **쪼개진 주문 30% 안팎**
 *     ⚠ **총 유동성·틱당 거래량은 이 시뮬로 판정하지 말 것** — 국면 궤적의 표본오차가 커서 같은 코드로도
 *     93k~111k 를 왕복한다. 크기 분포·호가 물량을 손봤으면 상태를 하나로 고정하고 `simulateTick` 만
 *     20만 번 돌려 개편 전 코드와 대조해야 한다(§ CLAUDE.md "평균 보존은 상태를 고정한 A/B 로 잰다").
 *     ⚠ "라벨-가격 불일치"는 0 이 목표가 **아니다** — 2026-09-07 이전엔 라벨을 가격 방향에서
 *     되짚었으니 정의상 0% 였을 뿐이다(동어반복). 지금은 방향이 가격을 만들므로, 시장이 흐름과
 *     반대로 걸어갈 때 생기는 10~20% 는 실제 거래소 데이터의 tick-rule 오분류율과 같은 값이다.
 */
import {
  nextMarketState,
  simulateTick,
  sessionActivity,
  GAUGE_FULL,
  type BotState,
  type BotBook,
  type TapeTrade,
} from '../functions/api/spot';

const TICKS_PER_MIN = 20; // 접속 중 ~60/분, 유휴(cron) 12/분 사이의 대표값
const MS_PER_TICK = 60_000 / TICKS_PER_MIN;
// ⚠ 벽시계를 넘겨야 한다 — 모델이 하루 리듬(§ sessionActivity)을 타므로 `Date.now()` 로 고정해 돌리면
// 하루 중 한 시각의 성격만 측정하게 된다. 월요일 00:00 UTC 에서 출발해 틱마다 실제 시간만큼 흘린다.
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // 2026-01-05 = 월요일
// ⚠ 기본값이 **7일(정확히 한 주)** 이다 — 모델이 주말 한산함을 타므로 5일로 돌리면 평일만 보게 되어
// 세션 활성도 평균이 1.08 로 나오고(주 평균은 1.00) 변동성·거래량이 실제보다 높게 측정된다.
const DAYS = Number(process.env.SIM_DAYS) || 7;   // SIM_DAYS=21 처럼 늘려 더 긴 안정성 확인
const TICKS = Math.round(TICKS_PER_MIN * 60 * 24 * DAYS);
const RUNS = Number(process.env.SIM_RUNS) || 8;

interface RunStat {
  end: number;
  min: number;
  max: number;
  maxDrawdown: number;
  acf1: number;
  absAcf1: number;
  barRange: number;
  occupancy: Record<string, number>;
  capEvents: number;
  meanFear: number;
  meanGreed: number;
  hiFear: number;   // 공포 게이지가 0.75 를 넘는 틱 비율(투매 조건의 문턱)
  absMood: number;  // 평균 |sentiment| — 1 에 붙어 있으면 무드가 포화돼 신호 구실을 못 한다
  skew: number;     // 수익률 왜도 — 음수여야 "계단으로 오르고 엘리베이터로 떨어진다"가 성립
  bigDown: number;  // -0.5% 넘게 빠진 틱 비율
  bigUp: number;    // +0.5% 넘게 오른 틱 비율
  bookLean: number; // 공포 구간(공포>0.5)의 평균 매수/매도 사다리 두께 비 — 1 보다 작아야 매수벽이 걷힌 것
  // ── 2026-08-26 추가: "사팔사팔"을 숫자로 잡기 위한 지표 ──
  regimeLen: number;  // 국면 하나의 평균 수명(틱). 예전 모델은 ~10틱이라 차트에 방향이 안 보였다
  efficiency: number; // 추세 효율 = |구간 순이동| / Σ|틱 이동| (30틱 창). 0 에 가까우면 제자리 진동
  swings: number;     // 하루당 8% 이상짜리 지그재그 스윙 수(급등·급락 횟수)
  swingSize: number;  // 그 스윙들의 평균 크기
  bigSwing: number;   // 하루당 20% 이상짜리 스윙 수
  tickSd: number;     // 틱 수익률 표준편차(노이즈 크기)
  meanRet: number;    // 틱당 평균 수익률(산술) — 아래 로그드리프트의 원재료
  logEnd: number;     // ln(종가) — 로그로 평균해야 log-normal 분포의 중심이 제대로 나온다
  // ── 2026-09-07 추가: 하루 리듬이 실제로 살아있나 ──
  actMean: number;    // 세션 활성도 평균(반드시 ~1.00 — 아니면 전체 변동성이 조용히 바뀐 것이다)
  busySd: number;     // 활발한 시간대(활성도>1.2)의 틱 표준편차
  quietSd: number;    // 한산한 시간대(활성도<0.7)의 틱 표준편차 — busy 보다 확실히 작아야 한다
  busyVol: number;    // 활발한 시간대의 평균 거래량 배수
  quietVol: number;   // 한산한 시간대의 평균 거래량 배수
  coilRatio: number;  // 오래 눌린 관망(calm 300틱+)의 |ret| ÷ 갓 시작한 관망(60틱 이하) — 1 보다 작아야 수축이다
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb || 1);
}

function runOnce(): RunStat {
  let s: BotState = {
    ref: 1,
    drift: 0,
    vol: 1,
    sentiment: 0,
    anchor: 1,
    regime: 'calm',
    regimeTicks: 0,
    peak: 1,
    trough: 1,
  };
  const rets: number[] = [];
  const occupancy: Record<string, number> = {};
  let min = s.ref;
  let max = s.ref;
  let peakSoFar = s.ref;
  let maxDrawdown = 0;
  let capEvents = 0;
  let prevRegime = s.regime;
  let barHigh = s.ref;
  let barLow = s.ref;
  let barSum = 0;
  let bars = 0;
  let fearSum = 0;
  let greedSum = 0;
  let hiFear = 0;
  let moodSum = 0;
  let bigDown = 0;
  let bigUp = 0;
  let leanSum = 0;
  let leanN = 0;
  let regimeEpisodes = 1;
  // 추세 효율(구간 순이동 / 절대이동 합) — 30틱 창마다
  const EFF_WIN = 30;
  let effSum = 0;
  let effN = 0;
  let effStart = s.ref;
  let effAbs = 0;
  let effPrev = s.ref;
  // 지그재그 스윙 — 극값에서 SWING_TH 만큼 되돌리면 그 leg(직전 전환점→극값)을 스윙 하나로 센다
  const SWING_TH = 0.08;
  let zzPivot = s.ref; // 직전 전환점
  let zzExt = s.ref;   // 진행 중인 극값
  let zzDir = 1;       // 1=상승 leg, -1=하락 leg
  let swingSum = 0;
  let swingN = 0;
  let bigSwingN = 0;
  let actSum = 0;
  let busyS2 = 0;
  let busyN = 0;
  let quietS2 = 0;
  let quietN = 0;
  let busyVolSum = 0;
  let quietVolSum = 0;
  let oldCalm = 0;
  let oldCalmN = 0;
  let newCalm = 0;
  let newCalmN = 0;

  for (let t = 0; t < TICKS; t++) {
    const step = nextMarketState(s, T0 + t * MS_PER_TICK);
    s = step.next;
    rets.push(step.ret);
    occupancy[s.regime] = (occupancy[s.regime] ?? 0) + 1;
    actSum += step.activity;
    if (step.activity > 1.2) {
      busyS2 += step.ret * step.ret;
      busyVolSum += step.sizeMult;
      busyN++;
    } else if (step.activity < 0.7) {
      quietS2 += step.ret * step.ret;
      quietVolSum += step.sizeMult;
      quietN++;
    }
    if (s.regime === 'calm') {
      if (s.regimeTicks > 300) {
        oldCalm += Math.abs(step.ret);
        oldCalmN++;
      } else if (s.regimeTicks <= 60) {
        newCalm += Math.abs(step.ret);
        newCalmN++;
      }
    }
    if (s.regime === 'capitulation' && prevRegime !== 'capitulation') capEvents++;
    if (s.regime !== prevRegime) regimeEpisodes++;
    prevRegime = s.regime;
    effAbs += Math.abs(s.ref - effPrev);
    effPrev = s.ref;
    if ((t + 1) % EFF_WIN === 0) {
      if (effAbs > 0) {
        effSum += Math.abs(s.ref - effStart) / effAbs;
        effN++;
      }
      effStart = s.ref;
      effAbs = 0;
    }
    if (zzDir > 0) {
      if (s.ref > zzExt) zzExt = s.ref;
      else if (s.ref <= zzExt * (1 - SWING_TH)) {
        const size = (zzExt - zzPivot) / zzPivot;
        if (size > 0) {
          swingSum += size;
          swingN++;
          if (size > 0.2) bigSwingN++;
        }
        zzPivot = zzExt;
        zzExt = s.ref;
        zzDir = -1;
      }
    } else {
      if (s.ref < zzExt) zzExt = s.ref;
      else if (s.ref >= zzExt * (1 + SWING_TH)) {
        const size = (zzPivot - zzExt) / zzPivot;
        if (size > 0) {
          swingSum += size;
          swingN++;
          if (size > 0.2) bigSwingN++;
        }
        zzPivot = zzExt;
        zzExt = s.ref;
        zzDir = 1;
      }
    }
    min = Math.min(min, s.ref);
    max = Math.max(max, s.ref);
    peakSoFar = Math.max(peakSoFar, s.ref);
    maxDrawdown = Math.min(maxDrawdown, s.ref / peakSoFar - 1);
    if (step.ret < -0.005) bigDown++;
    if (step.ret > 0.005) bigUp++;
    const fear = Math.min(1, (s.peak - s.ref) / s.peak / GAUGE_FULL);
    if (fear > 0.5) {
      leanSum += step.bidDepthMult / step.askDepthMult;
      leanN++;
    }
    fearSum += fear;
    if (fear > 0.75) hiFear++;
    greedSum += Math.min(1, (s.ref - s.trough) / s.trough / GAUGE_FULL);
    moodSum += Math.abs(s.sentiment);
    barHigh = Math.max(barHigh, s.ref);
    barLow = Math.min(barLow, s.ref);
    if ((t + 1) % TICKS_PER_MIN === 0) {
      barSum += (barHigh - barLow) / barLow;
      bars++;
      barHigh = s.ref;
      barLow = s.ref;
    }
  }
  const shifted = rets.slice(1);
  const abs = rets.map(Math.abs);
  return {
    end: s.ref,
    min,
    max,
    maxDrawdown,
    acf1: corr(rets.slice(0, -1), shifted),
    absAcf1: corr(abs.slice(0, -1), abs.slice(1)),
    barRange: barSum / bars,
    occupancy,
    capEvents,
    meanFear: fearSum / TICKS,
    meanGreed: greedSum / TICKS,
    hiFear: hiFear / TICKS,
    absMood: moodSum / TICKS,
    skew: (() => {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
      return rets.reduce((a, b) => a + ((b - m) / sd) ** 3, 0) / rets.length;
    })(),
    bigDown: bigDown / TICKS,
    bigUp: bigUp / TICKS,
    bookLean: leanN ? leanSum / leanN : NaN,
    regimeLen: TICKS / regimeEpisodes,
    efficiency: effN ? effSum / effN : 0,
    swings: swingN / DAYS,
    swingSize: swingN ? swingSum / swingN : 0,
    bigSwing: bigSwingN / DAYS,
    tickSd: (() => {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
    })(),
    meanRet: rets.reduce((a, b) => a + b, 0) / rets.length,
    logEnd: Math.log(s.ref),
    actMean: actSum / TICKS,
    busySd: busyN ? Math.sqrt(busyS2 / busyN) : NaN,
    quietSd: quietN ? Math.sqrt(quietS2 / quietN) : NaN,
    busyVol: busyN ? busyVolSum / busyN : NaN,
    quietVol: quietN ? quietVolSum / quietN : NaN,
    coilRatio: oldCalmN && newCalmN ? oldCalm / oldCalmN / (newCalm / newCalmN) : NaN,
  };
}

/**
 * 체결 테이프(미세구조) 검증 — 가격 모델과 달리 여기선 `simulateTick` 을 그대로 돌려야 한다.
 * ⚠ 메인 루프에 섞지 않는다: 틱마다 테이프 배열(최대 700건)을 복사하므로 14만 틱을 돌리면 1억 번의
 * 복사가 난다. 미세구조는 정상성 지표라 2만 틱이면 충분하다.
 *
 * 보는 것: ①라벨과 가격 방향의 일치율(불일치가 크면 "색이 반대"로 읽힌다) ②호가 바운스가 실제로
 * 일어나는가(연속 두 체결의 방향이 바뀌는 비율) ③같은 방향이 이어지는 런 길이(주문 흐름 군집)
 * ④수량 자릿수 분포(개미~고래) ⑤틱당 건수와 거래량(캔들 거래량 불변 확인) ⑥꼬리(스톱헌팅) 빈도.
 */
function runTape(ticks = 20_000) {
  let s: BotState = { ref: 1, drift: 0, vol: 1, sentiment: 0, anchor: 1, regime: 'calm', regimeTicks: 0, peak: 1, trough: 1 };
  let tape: TapeTrade[] = [];
  // ⚠ 사다리도 틱 사이로 물려줘야 한다(2026-09-08) — 봇 호가는 매 틱 새로 태어나는 게 아니라 살아남은
  // 주문 위에 얹히므로(§ simulateTick keepResting), 빈 사다리를 매번 넘기면 지속성 지표가 0 으로 나온다.
  let book: BotBook = { owner: 'bot-mm-1', bids: [], asks: [] };
  let bookLevels = 0;   // 한쪽 평균 레벨 수 — BOT_LEVELS_PER_SIDE 를 유지해야 한다
  let bookLiq = 0;      // 한쪽 총 유동성(총량 보존 불변식 대조용)
  let bookSpread = 0;   // 최우선호가 스프레드
  let kept = 0;         // 직전 틱과 (가격·물량)이 **완전히 같은** 레벨 수 = 그 자리에 앉아 있는 주문
  let keptDen = 0;
  let sameSize = 0;     // 연속 두 체결이 같은 방향 + 비슷한 수량(= 쪼개진 주문) 인 비율
  let sizePairs = 0;
  let prevSize = 0;
  let prints = 0;
  let volume = 0;
  let up = 0;
  let down = 0;
  let flat = 0;
  let mislabel = 0;
  let flips = 0;
  let pairs = 0;
  let runLen = 0;
  let runs = 0;
  let curRun = 0;
  let prevSide: 'buy' | 'sell' | null = null;
  const digits: Record<number, number> = {};
  let wickSum = 0;
  let bigWick = 0;
  for (let t = 0; t < ticks; t++) {
    const now = T0 + t * MS_PER_TICK;
    const before = tape.length;
    const r = simulateTick(s, tape, book, [], now);
    const prevKeys = new Set(
      [...book.bids, ...book.asks].map((l) => `${l.price}:${l.size}`),
    );
    for (const l of [...r.book.bids, ...r.book.asks]) {
      keptDen++;
      if (prevKeys.has(`${l.price}:${l.size}`)) kept++;
    }
    bookLevels += (r.book.bids.length + r.book.asks.length) / 2;
    bookLiq += (r.book.bids.reduce((a, l) => a + l.size, 0) + r.book.asks.reduce((a, l) => a + l.size, 0)) / 2;
    if (r.book.bids.length && r.book.asks.length) bookSpread += r.book.asks[0].price / r.book.bids[0].price - 1;
    const fresh = r.tape.slice(Math.max(0, r.tape.length - (r.tape.length - before <= 0 ? 0 : r.tape.length - before)));
    let prevPx = s.ref;
    for (const x of fresh) {
      prints++;
      volume += x.size;
      const d = x.price - prevPx;
      if (d > 0) up++;
      else if (d < 0) down++;
      else flat++;
      if ((d > 0 && x.takerSide === 'sell') || (d < 0 && x.takerSide === 'buy')) mislabel++;
      if (prevSide) {
        pairs++;
        if (prevSide !== x.takerSide) flips++;
      }
      if (prevSide === x.takerSide) curRun++;
      else {
        if (curRun > 0) {
          runLen += curRun;
          runs++;
        }
        curRun = 1;
      }
      if (prevSide) {
        sizePairs++;
        if (prevSide === x.takerSide && Math.abs(x.size / Math.max(1, prevSize) - 1) < 0.25) sameSize++;
      }
      prevSide = x.takerSide;
      prevSize = x.size;
      prevPx = x.price;
      const dg = String(Math.round(x.size)).length;
      digits[dg] = (digits[dg] ?? 0) + 1;
    }
    // 꼬리 = 봉 몸통(|종가-시가|) 밖으로 삐져나온 부분
    const body = Math.abs(r.bar.close - r.bar.open);
    const wick = (r.bar.high - r.bar.low - body) / r.bar.close;
    wickSum += wick;
    if (wick > 0.006) bigWick++;
    s = r.next;
    tape = r.tape;
    book = r.book;
  }
  const dgTotal = Object.values(digits).reduce((a, b) => a + b, 0);
  return {
    perTick: prints / ticks,
    volPerTick: volume / ticks,
    meanSize: volume / prints,
    labelMismatch: mislabel / prints,
    upShare: up / prints,
    flatShare: flat / prints,
    flipRate: pairs ? flips / pairs : 0,
    runLen: runs ? runLen / runs : 0,
    wick: wickSum / ticks,
    bigWick: bigWick / ticks,
    bookLevels: bookLevels / ticks,
    bookLiq: bookLiq / ticks,
    bookSpread: bookSpread / ticks,
    restRate: keptDen ? kept / keptDen : 0,
    sliceShare: sizePairs ? sameSize / sizePairs : 0,
    digits: Object.entries(digits)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => `${k}자리 ${((v / dgTotal) * 100).toFixed(0)}%`)
      .join(' / '),
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
console.log(`틱 ${TICKS.toLocaleString()}개 = ${DAYS}일치 × ${RUNS}회 (틱 ${TICKS_PER_MIN}/분 가정)\n`);
const stats: RunStat[] = [];
for (let r = 0; r < RUNS; r++) {
  const st = runOnce();
  stats.push(st);
  console.log(
    `#${r + 1} 종가 ${st.end.toFixed(4)}  범위 ${st.min.toFixed(4)}~${st.max.toFixed(4)}  MDD ${pct(st.maxDrawdown)}  ` +
      `acf1 ${st.acf1.toFixed(3)}  |acf1| ${st.absAcf1.toFixed(3)}  1분봉폭 ${pct(st.barRange)}  투매 ${st.capEvents}회`,
  );
}

const avg = (f: (s: RunStat) => number) => stats.reduce((a, s) => a + f(s), 0) / stats.length;
const occ: Record<string, number> = {};
for (const s of stats) for (const [k, v] of Object.entries(s.occupancy)) occ[k] = (occ[k] ?? 0) + v;
const total = Object.values(occ).reduce((a, b) => a + b, 0);

console.log('\n── 평균 ──');
console.log(`종가 ${avg((s) => s.end).toFixed(4)} (시작 1.0000)  최저 ${avg((s) => s.min).toFixed(4)}  최고 ${avg((s) => s.max).toFixed(4)}`);
console.log(`MDD ${pct(avg((s) => s.maxDrawdown))}  수익률 acf1 ${avg((s) => s.acf1).toFixed(3)}  |수익률| acf1 ${avg((s) => s.absAcf1).toFixed(3)}`);
console.log(`1분봉 평균 고저폭 ${pct(avg((s) => s.barRange))}  투매 ${avg((s) => s.capEvents).toFixed(1)}회/${DAYS}일`);
console.log(
  `수익률 왜도 ${avg((s) => s.skew).toFixed(2)}  급락(-0.5%↓) ${pct(avg((s) => s.bigDown))} vs 급등(+0.5%↑) ${pct(avg((s) => s.bigUp))}  ` +
    `공포장 매수/매도 호가 두께비 ${avg((s) => s.bookLean).toFixed(2)}`,
);
console.log(
  `국면 평균 수명 ${avg((s) => s.regimeLen).toFixed(0)}틱  추세효율(30틱) ${avg((s) => s.efficiency).toFixed(3)}  ` +
    `틱 표준편차 ${pct(avg((s) => s.tickSd))}  스윙(8%+) ${avg((s) => s.swings).toFixed(1)}회/일(평균 ${pct(avg((s) => s.swingSize))})  ` +
    `대형스윙(20%+) ${avg((s) => s.bigSwing).toFixed(1)}회/일`,
);
console.log(
  `평균 공포 ${avg((s) => s.meanFear).toFixed(3)}  평균 탐욕 ${avg((s) => s.meanGreed).toFixed(3)}  ` +
    `공포>0.75 ${pct(avg((s) => s.hiFear))}  평균 |무드| ${avg((s) => s.absMood).toFixed(3)}`,
);
console.log(
  // ⚠ 편향은 **로그드리프트**(= 산술평균 − 분산/2)로 본다. 가격은 곱으로 누적되므로 실제 성장률은
  // 이 값이고, 산술평균만 보면 분산이 큰 모델이 항상 "상승 편향"처럼 보인다. 표본이 수백만이라
  // SE 가 0.01e-6 수준이어서 종가(log-normal, 8회 평균으로도 2배씩 흔들린다)보다 1000배 정밀하다.
  `로그드리프트/틱 ${((avg((s) => s.meanRet) - avg((s) => s.tickSd) ** 2 / 2) * 1e6).toFixed(2)}e-6 ` +
    `(편향 지표 — |값| 2 이하 권장, 위험선 28)  ` +
    `기하평균 종가 ${Math.exp(avg((s) => s.logEnd)).toFixed(4)}`,
);
console.log(
  `세션 활성도 평균 ${avg((s) => s.actMean).toFixed(3)}(반드시 ~1.00)  ` +
    `활발한 시간 틱sd ${pct(avg((s) => s.busySd))} vs 한산한 시간 ${pct(avg((s) => s.quietSd))}  ` +
    `거래량 배수 ${avg((s) => s.busyVol).toFixed(2)} vs ${avg((s) => s.quietVol).toFixed(2)}  ` +
    `코일(긴 관망/짧은 관망 변동성) ${avg((s) => s.coilRatio).toFixed(2)}`,
);
console.log(
  '국면 점유율: ' +
    Object.entries(occ)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${((v / total) * 100).toFixed(1)}%`)
      .join(' / '),
);

// ── 체결 테이프(미세구조) ──
const tp = runTape();
console.log('\n── 체결 테이프(미세구조, 2만 틱) ──');
console.log(
  `틱당 ${tp.perTick.toFixed(1)}건  평균수량 ${Math.round(tp.meanSize).toLocaleString()}  틱당 거래량 ${Math.round(
    tp.volPerTick,
  ).toLocaleString()}`,
);
console.log(
  `라벨-가격 불일치 ${pct(tp.labelMismatch)}  상승틱 비중 ${pct(tp.upShare)}  동가 ${pct(tp.flatShare)}  ` +
    `방향 전환율(호가 바운스) ${pct(tp.flipRate)}  같은 방향 평균 런 ${tp.runLen.toFixed(2)}건`,
);
console.log(`봉 꼬리 평균 ${pct(tp.wick)}  긴 꼬리(0.6%+) 틱 비율 ${pct(tp.bigWick)}`);
console.log(
  `쪼개진 주문(연속 같은 방향·비슷한 수량) ${pct(tp.sliceShare)}  ` +
    `호가 지속(직전 틱과 가격·물량이 그대로인 레벨) ${pct(tp.restRate)}  ` +
    `한쪽 레벨 ${tp.bookLevels.toFixed(1)}개  한쪽 유동성 ${Math.round(tp.bookLiq).toLocaleString()}  ` +
    `최우선 스프레드 ${pct(tp.bookSpread)}`,
);
console.log(`수량 자릿수: ${tp.digits}`);
// 하루 리듬을 눈으로 — KST 시각별 활성도
const byHour: string[] = [];
for (let h = 0; h < 24; h += 2) {
  const utc = Date.UTC(2026, 0, 5, (h + 15) % 24, 0, 0); // KST h 시 = UTC h-9
  byHour.push(`${String(h).padStart(2, '0')}시 ${sessionActivity(utc).toFixed(2)}`);
}
console.log(`KST 시각별 활성도(평일): ${byHour.join(' / ')}`);
