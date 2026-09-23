/**
 * 봇 심리 모델 장기 시뮬레이션 — `npm run sim:bot`
 *
 * ⚠ **봇 심리 파라미터(functions/api/spot.ts REGIME_PARAMS / nextMarketState / 관심도)를 건드렸다면 반드시
 * 이걸 돌릴 것.** 모델은 DB 접근이 없는 순수 함수라 그대로 떼어내 며칠치를 몇 초에 굴릴 수 있고, 그러지
 * 않으면 "틱마다 미세하게 남은 편향"이 며칠 뒤 가격을 0 으로 붕괴시키거나 발산시킨다. 2026-09-23 에 기준선
 * tether 를 없앴으므로 **편향 = 그대로 추세**다(되돌려줄 힘이 없다) — 로그드리프트 줄을 반드시 볼 것.
 *
 * 모델이 두 시계로 돈다(§ spot.ts 관심도): 가격·국면·심리는 **business time**(h = 경과초/3 × 관심도),
 * 관심도 자신은 **벽시계**. 그래서 지표도 둘로 나눠 본다.
 *
 * ① business time 지표 — 관심도가 그 위를 얼마나 빨리 흐르든 **예전 모델과 모양이 같아야** 한다(진폭만
 *    MOVE_SCALE 배). business time 1단위마다 가격을 표본으로 뽑아(틱 안은 로그 선형 보간) 잰다:
 *   - **추세효율 0.55 이상** — 30단위 창의 |순이동| / Σ|이동|. 낮으면 "사팔사팔"
 *   - **국면 평균 수명 50단위 이상**, 수익률 acf1 ≈ +0.5, |수익률| acf1 ≈ 0.4 이상
 *   - **되돌려주는 몫 55% 미만**(분산비 60 → 1800단위)
 *   - 국면 점유율(business time 가중): calm ~39 / rally ~23 / pullback ~23 / panic ~9 / euphoria ~5 / capitulation <1
 *   - 평균 공포 ~0.3
 *   - **로그드리프트/단위 |값| 0.5e-6 이하**(편향). ⚠ 표본오차가 크다 — 판정은 `SIM_RUNS=24` 이상으로.
 * ② 벽시계 지표 — 유저가 실제로 보는 시장:
 *   - 관심도: 중앙값 ~0.2~0.3, 한산(<0.25)이 시간의 절반 안팎, 과열(>2) 몇 %. 뉴스 하루 ~10회
 *   - 1분봉 폭: 한산할 때 0.1~0.4%, 과열 때 몇 %. 시간봉 폭 중앙값 ~1.5~4%, 일간 범위 ~10~30%
 *   - 분당 거래량 p90/p10 이 수십 배(몰렸다 식는다), 분당 거래량 acf1 0.6+ (뭉친다),
 *     |1분 수익률| 과 거래량의 상관 0.4+ (거래량과 변동성이 같이 온다)
 *   - **가격 수준 독립성** — 시작가 0.2 / 1 / 5 에서 하루 뒤 평균 수익률이 셋 다 0 근처(± 표준오차).
 *     예전 tether 는 5 에서 뚜렷이 빠지고 0.2 에서 뚜렷이 올랐다("1 이상이면 무조건 하락")
 *   - 세션 활성도 평균 ~1.00 — 기본 7일(정확히 한 주)이어야 1 로 나온다
 * ③ 틱 간격 불변성 — `SIM_DT=1`(폴링) / `3` / `5`(cron) 로 돌려 ② 의 벽시계 지표가 같아야 한다.
 *    예전엔 보고 있을 때(1초 틱)가 안 볼 때보다 5배 빨리 돌았다.
 * ④ 체결 테이프(`simulateTick`, 1초 틱): 체결 없는 초의 비율(한산할 때 절반 이상), 초당 체결 건수 분포,
 *    호가 지속률(한산할 때 높고 과열 때 낮다), 라벨-가격 인과(상승틱 매수라벨 70%+), 호가 역전 0.
 *    ⚠ 총 유동성·틱당 거래량은 이 시뮬로 판정하지 말 것 — 국면 궤적의 표본오차가 커서 같은 코드로도
 *    ±10% 를 왕복한다. 크기 분포·호가 물량을 손봤으면 상태를 고정하고 `simulateTick` 만 20만 번 돌려
 *    개편 전 코드와 대조한다(docs/VIRTUAL_COIN.md "평균 보존은 상태를 고정한 A/B 로 잰다").
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

// 틱 간격(초) — 3 이면 예전 sim 의 "분당 20틱"과 같다. 1 = 유저 폴링, 5 = cron 버스트.
const DT = Number(process.env.SIM_DT) || 1;
const MS_PER_TICK = DT * 1000;
const TICKS_PER_MIN = Math.round(60 / DT);
// ⚠ 벽시계를 넘겨야 한다 — 모델이 하루 리듬(§ sessionActivity)을 타므로 `Date.now()` 로 고정해 돌리면
// 하루 중 한 시각의 성격만 측정하게 된다. 월요일 00:00 UTC 에서 출발해 틱마다 실제 시간만큼 흘린다.
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // 2026-01-05 = 월요일
// ⚠ 기본값이 **7일(정확히 한 주)** 이다 — 모델이 주말 한산함을 타므로 5일로 돌리면 평일만 보게 된다.
const DAYS = Number(process.env.SIM_DAYS) || 7;
const TICKS = Math.round((DAYS * 86400) / DT);
const RUNS = Number(process.env.SIM_RUNS) || 8;
const REGIMES = ['calm', 'rally', 'pullback', 'panic', 'euphoria', 'capitulation'];

const fresh = (p0 = 1): BotState => ({
  ref: p0,
  drift: 0,
  vol: 1,
  sentiment: 0,
  anchor: p0,
  regime: 'calm',
  regimeTicks: 0,
  peak: p0,
  trough: p0,
  interest: 0,
  hype: 0,
});

/**
 * 가격 수준 독립성 — 시작가만 바꿔(0.2 / 1 / 5) 하루를 돌리고 평균 로그수익률을 본다. tether 가 있던 예전
 * 모델은 5 에서 시작하면 뚜렷이 빠지고 0.2 에서 시작하면 뚜렷이 올랐다("1 이상이면 무조건 하락"). 지금은
 * 셋 다 0 근처여야 한다(± 표준오차). ⚠ 한 경로 안에서 "가격 수준 vs 이후 수익률" 상관을 재면 안 된다 —
 * 경로 평균을 같은 표본에서 빼므로 순수 랜덤워크도 음의 상관이 나온다(Kendall 편향).
 */
function runLevel(p0: number, runs: number, days = 1) {
  const out: number[] = [];
  for (let r = 0; r < runs; r++) {
    let s = fresh(p0);
    const n = Math.round((days * 86400) / DT);
    for (let t = 0; t < n; t++) s = nextMarketState(s, T0 + r * 3_600_000 * 7 + t * MS_PER_TICK, DT).next;
    out.push(Math.log(s.ref / p0));
  }
  const m = mean(out);
  return { m, se: Math.sqrt(varOf(out) / out.length) };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const varOf = (a: number[]): number => {
  const m = mean(a);
  return a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length;
};
const quant = (a: number[], q: number): number => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : NaN;
};
const median = (a: number[]) => quant(a, 0.5);
/** q 개 비중첩 블록 합의 분산 ÷ (q × 원소 분산) = 분산비. */
function varianceRatio(r: number[], q: number): number {
  const blocks: number[] = [];
  for (let i = 0; i + q <= r.length; i += q) {
    let sum = 0;
    for (let j = i; j < i + q; j++) sum += r[j];
    blocks.push(sum);
  }
  return blocks.length > 1 ? varOf(blocks) / (q * varOf(r)) : NaN;
}
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
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

interface RunStat {
  end: number;
  min: number;
  max: number;
  maxDrawdown: number;
  capEvents: number;
  // ── business time ──
  units: number;       // 흐른 business time 총량
  bAcf1: number;
  bAbsAcf1: number;
  bSd: number;         // 단위당 수익률 표준편차
  bMean: number;       // 단위당 산술평균 수익률
  efficiency: number;
  vr60: number;
  vr1800: number;
  regimeLen: number;   // 국면 평균 수명(단위)
  occB: Record<string, number>; // business time 가중 점유율
  occW: Record<string, number>; // 벽시계 점유율
  meanFear: number;
  meanGreed: number;
  swingsPerDay: number;
  swingSize: number;
  skew: number;
  // ── 벽시계 ──
  intMean: number;
  intMedian: number;
  intP10: number;
  intP90: number;
  quietShare: number;  // 관심도 < 0.25
  hotShare: number;    // 관심도 > 2
  newsPerDay: number;
  fomoPerDay: number;  // 돌파 추격(FOMO) 사건
  cascadePerDay: number; // 손절 연쇄 사건
  bar1m: number;       // 1분봉 평균 고저폭
  bar1mQuiet: number;  // 관심도 < 0.25 인 분의 1분봉 폭
  bar1mHot: number;    // 관심도 > 2 인 분의 1분봉 폭
  bar1h: number;       // 1시간봉 고저폭 중앙값
  bar1hP90: number;
  dayRange: number;    // 일간 고저폭 평균
  daySd: number;       // 일간 로그수익률 표준편차(근사 — 하루 단위 수익률의 sd)
  volP10: number;      // 분당 기대 거래량 분위수(상대값)
  volP50: number;
  volP90: number;
  volAcf1: number;
  volRetCorr: number;  // |1분 수익률| 과 분당 거래량의 상관
  actMean: number;
}

function runOnce(): RunStat {
  let s = fresh();
  const occB: Record<string, number> = {};
  const occW: Record<string, number> = {};
  let min = s.ref;
  let max = s.ref;
  let peakSoFar = s.ref;
  let maxDrawdown = 0;
  let capEvents = 0;
  let prevRegime = s.regime;
  let regimeEpisodes = 1;
  let unitsTotal = 0;
  let fearSum = 0;
  let greedSum = 0;
  let actSum = 0;
  let newsN = 0;
  let fomoN = 0;
  let cascadeN = 0;
  const ints: number[] = [];
  // business time 표본 — 단위를 넘을 때마다 로그 가격을 보간해 뽑는다
  const bLog: number[] = [0];
  let bNext = 1;
  // 분·시간·일 봉
  const bar1m: number[] = [];
  const bar1mInt: number[] = [];
  const vol1m: number[] = [];
  const ret1m: number[] = [];
  let mHi = s.ref;
  let mLo = s.ref;
  let mOpen = s.ref;
  let mVol = 0;
  let mInt = 0;
  const bar1h: number[] = [];
  let hHi = s.ref;
  let hLo = s.ref;
  const dayRanges: number[] = [];
  const dayRets: number[] = [];
  let dHi = s.ref;
  let dLo = s.ref;
  let dOpen = s.ref;
  // 지그재그 스윙(8%×MOVE 기준이 아니라 벽시계 가격의 5% — 사람이 "한 번 크게 움직였다"고 읽는 크기)
  const SWING_TH = 0.05;
  let zzPivot = s.ref;
  let zzExt = s.ref;
  let zzDir = 1;
  let swingSum = 0;
  let swingN = 0;

  for (let t = 0; t < TICKS; t++) {
    const now = T0 + t * MS_PER_TICK;
    const prevRef = s.ref;
    const step = nextMarketState(s, now, DT);
    s = step.next;
    const h = step.h;
    unitsTotal += h;
    occB[s.regime] = (occB[s.regime] ?? 0) + h;
    occW[s.regime] = (occW[s.regime] ?? 0) + 1;
    ints.push(step.interest);
    actSum += step.activity;
    if (step.news > 0) newsN++;
    if (step.event > 0) fomoN++;
    else if (step.event < 0) cascadeN++;
    if (s.regime === 'capitulation' && prevRegime !== 'capitulation') capEvents++;
    if (s.regime !== prevRegime) regimeEpisodes++;
    prevRegime = s.regime;
    // business time 표본(로그 선형 보간)
    const l0 = Math.log(prevRef);
    const l1 = Math.log(s.ref);
    const u0 = unitsTotal - h;
    while (bNext <= unitsTotal) {
      const f = h > 0 ? (bNext - u0) / h : 1;
      bLog.push(l0 + (l1 - l0) * f);
      bNext++;
    }
    fearSum += Math.min(1, (s.peak - s.ref) / s.peak / GAUGE_FULL) * h;
    greedSum += Math.min(1, (s.ref - s.trough) / s.trough / GAUGE_FULL) * h;
    min = Math.min(min, s.ref);
    max = Math.max(max, s.ref);
    peakSoFar = Math.max(peakSoFar, s.ref);
    maxDrawdown = Math.min(maxDrawdown, s.ref / peakSoFar - 1);
    // 기대 거래량(체결 건수 × 크기 — simulateTick 과 같은 비례식)
    mVol += h * step.sizeMult ** 1.5 * Math.min(1.4, Math.max(0.7, step.interest ** 0.2));
    mInt += step.interest;
    mHi = Math.max(mHi, s.ref);
    mLo = Math.min(mLo, s.ref);
    hHi = Math.max(hHi, s.ref);
    hLo = Math.min(hLo, s.ref);
    dHi = Math.max(dHi, s.ref);
    dLo = Math.min(dLo, s.ref);
    if (zzDir > 0) {
      if (s.ref > zzExt) zzExt = s.ref;
      else if (s.ref <= zzExt * (1 - SWING_TH)) {
        swingSum += (zzExt - zzPivot) / zzPivot;
        swingN++;
        zzPivot = zzExt;
        zzExt = s.ref;
        zzDir = -1;
      }
    } else {
      if (s.ref < zzExt) zzExt = s.ref;
      else if (s.ref >= zzExt * (1 + SWING_TH)) {
        swingSum += (zzPivot - zzExt) / zzPivot;
        swingN++;
        zzPivot = zzExt;
        zzExt = s.ref;
        zzDir = 1;
      }
    }
    if ((t + 1) % TICKS_PER_MIN === 0) {
      bar1m.push((mHi - mLo) / mLo);
      bar1mInt.push(mInt / TICKS_PER_MIN);
      vol1m.push(mVol);
      ret1m.push(Math.abs(Math.log(s.ref / mOpen)));
      mHi = mLo = mOpen = s.ref;
      mVol = 0;
      mInt = 0;
    }
    if ((t + 1) % (TICKS_PER_MIN * 60) === 0) {
      bar1h.push((hHi - hLo) / hLo);
      hHi = hLo = s.ref;
    }
    if ((t + 1) % (TICKS_PER_MIN * 1440) === 0) {
      dayRanges.push((dHi - dLo) / dLo);
      dayRets.push(Math.log(s.ref / dOpen));
      dHi = dLo = dOpen = s.ref;
    }
  }
  const bRet: number[] = [];
  for (let i = 1; i < bLog.length; i++) bRet.push(bLog[i] - bLog[i - 1]);
  const bAbs = bRet.map(Math.abs);
  // 추세효율(30단위 창)
  let effSum = 0;
  let effN = 0;
  for (let i = 0; i + 30 <= bRet.length; i += 30) {
    let net = 0;
    let absSum = 0;
    for (let j = i; j < i + 30; j++) {
      net += bRet[j];
      absSum += Math.abs(bRet[j]);
    }
    if (absSum > 0) {
      effSum += Math.abs(net) / absSum;
      effN++;
    }
  }
  const bMean = mean(bRet);
  const bSd = Math.sqrt(varOf(bRet));
  const vr60 = varianceRatio(bRet, 60);
  const vr1800 = varianceRatio(bRet, 1800);
  const quietBars = bar1m.filter((_, i) => bar1mInt[i] < 0.25);
  const hotBars = bar1m.filter((_, i) => bar1mInt[i] > 2);
  const volMed = median(vol1m) || 1;
  return {
    end: s.ref,
    min,
    max,
    maxDrawdown,
    capEvents,
    units: unitsTotal,
    bAcf1: corr(bRet.slice(0, -1), bRet.slice(1)),
    bAbsAcf1: corr(bAbs.slice(0, -1), bAbs.slice(1)),
    bSd,
    bMean,
    efficiency: effN ? effSum / effN : 0,
    vr60,
    vr1800,
    regimeLen: unitsTotal / regimeEpisodes,
    occB,
    occW,
    meanFear: fearSum / unitsTotal,
    meanGreed: greedSum / unitsTotal,
    swingsPerDay: swingN / DAYS,
    swingSize: swingN ? swingSum / swingN : 0,
    skew: (() => {
      const m = bMean;
      return bRet.reduce((a, b) => a + ((b - m) / bSd) ** 3, 0) / bRet.length;
    })(),
    intMean: mean(ints),
    intMedian: median(ints),
    intP10: quant(ints, 0.1),
    intP90: quant(ints, 0.9),
    quietShare: ints.filter((x) => x < 0.25).length / ints.length,
    hotShare: ints.filter((x) => x > 2).length / ints.length,
    newsPerDay: newsN / DAYS,
    fomoPerDay: fomoN / DAYS,
    cascadePerDay: cascadeN / DAYS,
    bar1m: mean(bar1m),
    bar1mQuiet: mean(quietBars),
    bar1mHot: mean(hotBars),
    bar1h: median(bar1h),
    bar1hP90: quant(bar1h, 0.9),
    dayRange: mean(dayRanges),
    daySd: Math.sqrt(varOf(dayRets)),
    volP10: quant(vol1m, 0.1) / volMed,
    volP50: 1,
    volP90: quant(vol1m, 0.9) / volMed,
    volAcf1: corr(vol1m.slice(0, -1), vol1m.slice(1)),
    volRetCorr: corr(ret1m, vol1m),
    actMean: actSum / TICKS,
  };
}

/**
 * 체결 테이프·호가창(미세구조) — `simulateTick` 을 그대로 돌린다(1초 틱 = 유저 폴링과 같은 조건).
 * ⚠ 메인 루프에 섞지 않는다: 틱마다 테이프 배열(최대 700건)을 복사하므로 무겁다. 정상성 지표라 하루치면 충분하다.
 */
function runTape(ticks = 86_400, dtSec = 1, p0 = 1) {
  let s = fresh(p0);
  let tape: TapeTrade[] = [];
  let book: BotBook = { owner: 'bot-mm-1', bids: [], asks: [] };
  // 관심도 구간별 집계: quiet(<0.25) / mid / hot(>2)
  const bands = ['quiet', 'mid', 'hot'] as const;
  type Band = (typeof bands)[number];
  const acc: Record<Band, { ticks: number; zero: number; prints: number; kept: number; keptDen: number; vol: number }> = {
    quiet: { ticks: 0, zero: 0, prints: 0, kept: 0, keptDen: 0, vol: 0 },
    mid: { ticks: 0, zero: 0, prints: 0, kept: 0, keptDen: 0, vol: 0 },
    hot: { ticks: 0, zero: 0, prints: 0, kept: 0, keptDen: 0, vol: 0 },
  };
  // **체결로 만든** 1분봉 폭(유저가 차트에서 보는 봉) — 공정가 범위와 달리 호가 바운스·격자 스냅이 들어간다.
  // 관심도 구간별로 나눈다(그 분의 평균 관심도 기준). ⚠ 틱이 굵은 가격대(1.x, 10~19.x)에서 따로 볼 것.
  const candle: Record<Band, number[]> = { quiet: [], mid: [], hot: [] };
  let cHi = -Infinity;
  let cLo = Infinity;
  let cInt = 0;
  const perMin = Math.round(60 / dtSec);
  let prints = 0;
  let up = 0;
  let down = 0;
  let upBuy = 0;
  let downBuy = 0;
  let flips = 0;
  let pairs = 0;
  let prevSide: 'buy' | 'sell' | null = null;
  let crossed = 0;
  let levelsSum = 0;
  let spreadSum = 0;
  let spreadN = 0;
  let sliceSame = 0;
  let prevSize = 0;
  const digits: Record<number, number> = {};
  let lastPrice = s.ref;
  let prevInterest = 0.3;
  for (let t = 0; t < ticks; t++) {
    const now = T0 + t * dtSec * 1000;
    const before = tape.length;
    const r = simulateTick(s, tape, book, [], now, dtSec);
    // simulateTick 은 관심도를 next 에만 싣는다 — 이 틱의 관심도는 직전 상태의 값으로 구간을 나눈다
    const band: Band = prevInterest < 0.25 ? 'quiet' : prevInterest > 2 ? 'hot' : 'mid';
    const a = acc[band];
    a.ticks++;
    const nNew = Math.max(0, r.tape.length - before);
    const newPrints = r.tape.slice(r.tape.length - nNew);
    if (nNew === 0) a.zero++;
    a.prints += nNew;
    const prevKeys = new Set([...book.bids, ...book.asks].map((l) => `${l.price}:${l.size}`));
    for (const l of [...r.book.bids, ...r.book.asks]) {
      a.keptDen++;
      if (prevKeys.has(`${l.price}:${l.size}`)) a.kept++;
    }
    levelsSum += (r.book.bids.length + r.book.asks.length) / 2;
    if (r.book.bids.length && r.book.asks.length) {
      if (r.book.bids[0].price >= r.book.asks[0].price) crossed++;
      spreadSum += r.book.asks[0].price / r.book.bids[0].price - 1;
      spreadN++;
    }
    cInt += prevInterest;
    for (const x of newPrints) {
      cHi = Math.max(cHi, x.price);
      cLo = Math.min(cLo, x.price);
      prints++;
      a.vol += x.size;
      const d = x.price - lastPrice;
      if (d > 0) {
        up++;
        if (x.takerSide === 'buy') upBuy++;
      } else if (d < 0) {
        down++;
        if (x.takerSide === 'buy') downBuy++;
      }
      if (prevSide) {
        pairs++;
        if (prevSide !== x.takerSide) flips++;
        else if (Math.abs(x.size / Math.max(1, prevSize) - 1) < 0.25) sliceSame++;
      }
      prevSide = x.takerSide;
      prevSize = x.size;
      lastPrice = x.price;
      const dg = String(Math.round(x.size)).length;
      digits[dg] = (digits[dg] ?? 0) + 1;
    }
    if ((t + 1) % perMin === 0) {
      const mi = cInt / perMin;
      if (cHi > 0 && cLo < Infinity) candle[mi < 0.25 ? 'quiet' : mi > 2 ? 'hot' : 'mid'].push(cHi / cLo - 1);
      cHi = -Infinity;
      cLo = Infinity;
      cInt = 0;
    }
    prevInterest = r.next.interest;
    s = r.next;
    tape = r.tape.length > 700 ? r.tape.slice(-700) : r.tape; // prod 링 버퍼와 같은 길이(복사 비용도 막는다)
    book = r.book;
  }
  const dgTotal = Object.values(digits).reduce((x, y) => x + y, 0);
  return {
    bands: bands.map((b) => {
      const a = acc[b];
      return {
        band: b,
        share: a.ticks / ticks,
        zero: a.ticks ? a.zero / a.ticks : NaN,
        perSec: a.ticks ? a.prints / a.ticks / dtSec : NaN,
        rest: a.keptDen ? a.kept / a.keptDen : NaN,
        volPerSec: a.ticks ? a.vol / a.ticks / dtSec : NaN,
        candle: median(candle[b]),
      };
    }),
    upBuy: up ? upBuy / up : NaN,
    downBuy: down ? downBuy / down : NaN,
    flipRate: pairs ? flips / pairs : NaN,
    sliceShare: pairs ? sliceSame / pairs : NaN,
    crossed,
    levels: levelsSum / ticks,
    spread: spreadN ? spreadSum / spreadN : NaN,
    digits: Object.entries(digits)
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([k, v]) => `${k}자리 ${((v / dgTotal) * 100).toFixed(0)}%`)
      .join(' / '),
    endPrice: s.ref,
  };
}

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
console.log(`틱 ${TICKS.toLocaleString()}개 = ${DAYS}일치 × ${RUNS}회 (틱 간격 ${DT}초)\n`);
const stats: RunStat[] = [];
for (let r = 0; r < RUNS; r++) {
  const st = runOnce();
  stats.push(st);
  console.log(
    `#${r + 1} 종가 ${st.end.toPrecision(4)}  범위 ${st.min.toPrecision(4)}~${st.max.toPrecision(4)}  MDD ${pct(st.maxDrawdown, 1)}  ` +
      `관심도 중앙 ${st.intMedian.toFixed(2)}  1분봉 ${pct(st.bar1m)}  1시간봉(중앙) ${pct(st.bar1h, 1)}  일간범위 ${pct(st.dayRange, 1)}  ` +
      `투매 ${st.capEvents}회`,
  );
}
const avg = (f: (s: RunStat) => number) => mean(stats.map(f));
const occAgg = (k: 'occB' | 'occW') => {
  const o: Record<string, number> = {};
  for (const s of stats) for (const [r, v] of Object.entries(s[k])) o[r] = (o[r] ?? 0) + v;
  const tot = Object.values(o).reduce((a, b) => a + b, 0);
  return REGIMES.map((r) => `${r} ${(((o[r] ?? 0) / tot) * 100).toFixed(1)}%`).join(' / ');
};

console.log('\n── ① business time(관심도와 무관해야 하는 모양) ──');
console.log(
  `흐른 시간 ${(avg((s) => s.units) / DAYS).toFixed(0)}단위/일  단위 sd ${pct(avg((s) => s.bSd), 3)}  ` +
    `acf1 ${avg((s) => s.bAcf1).toFixed(3)}  |acf1| ${avg((s) => s.bAbsAcf1).toFixed(3)}  왜도 ${avg((s) => s.skew).toFixed(2)}`,
);
console.log(
  `추세효율(30단위) ${avg((s) => s.efficiency).toFixed(3)}  국면 수명 ${avg((s) => s.regimeLen).toFixed(0)}단위  ` +
    `되돌림: 분산비 60 ${avg((s) => s.vr60).toFixed(2)} → 1800 ${avg((s) => s.vr1800).toFixed(2)} ` +
    `= 되돌려주는 몫 ${(100 * (1 - avg((s) => s.vr1800) / avg((s) => s.vr60))).toFixed(0)}%(55% 미만)`,
);
console.log(
  `평균 공포 ${avg((s) => s.meanFear).toFixed(3)}  평균 탐욕 ${avg((s) => s.meanGreed).toFixed(3)}  투매 ${avg((s) => s.capEvents).toFixed(1)}회/${DAYS}일  ` +
    // 돌파 거리 기반 사건(§ spot.ts 사건) — 1000단위당 추격 ~5.4 / 연쇄 ~6.7 이 예전 모델과 같은 빈도다
    `돌파 추격 ${((1000 * avg((s) => s.fomoPerDay)) / avg((s) => s.units / DAYS)).toFixed(2)} / 손절 연쇄 ${((1000 * avg((s) => s.cascadePerDay)) / avg((s) => s.units / DAYS)).toFixed(2)} (1000단위당)`,
);
console.log(`국면 점유율(business): ${occAgg('occB')}`);
console.log(`국면 점유율(벽시계):   ${occAgg('occW')}`);
{
  // ⚠ 편향은 **로그드리프트**(단위당 로그수익률 평균)로 본다. 표본은 business time 단위라 틱 간격과 무관하다.
  // SE ≈ 단위 sd × √(분산비1800 / 총 단위수) — 국면이 수십 단위씩 살아 유효 표본이 적다.
  const drift = avg((s) => s.bMean);
  const units = stats.reduce((a, s) => a + s.units, 0);
  const se = avg((s) => s.bSd) * Math.sqrt(avg((s) => s.vr1800) / units);
  const perDay = drift * avg((s) => s.units / DAYS);
  console.log(
    `로그드리프트/단위 ${(drift * 1e6).toFixed(3)}e-6 (SE ≈ ${(se * 1e6).toFixed(3)}e-6, |값| 0.5 이하 권장)  ` +
      `= 하루 ${pct(perDay, 2)}  기하평균 종가 ${Math.exp(avg((s) => Math.log(s.end))).toFixed(4)}`,
  );
}

console.log('\n── ② 벽시계(유저가 보는 시장) ──');
console.log(
  `관심도 평균 ${avg((s) => s.intMean).toFixed(2)}  중앙 ${avg((s) => s.intMedian).toFixed(2)}  p10 ${avg((s) => s.intP10).toFixed(2)}  ` +
    `p90 ${avg((s) => s.intP90).toFixed(2)}  한산(<0.25) ${pct(avg((s) => s.quietShare), 0)}  과열(>2) ${pct(avg((s) => s.hotShare), 1)}  ` +
    `뉴스 ${avg((s) => s.newsPerDay).toFixed(1)}회/일  세션 평균 ${avg((s) => s.actMean).toFixed(3)}`,
);
console.log(
  `1분봉 폭 평균 ${pct(avg((s) => s.bar1m))}  한산할 때 ${pct(avg((s) => s.bar1mQuiet))}  과열 때 ${pct(avg((s) => s.bar1mHot))}  ` +
    `1시간봉 중앙 ${pct(avg((s) => s.bar1h), 1)}(p90 ${pct(avg((s) => s.bar1hP90), 1)})  ` +
    `일간 범위 ${pct(avg((s) => s.dayRange), 1)}  일간 sd ${pct(avg((s) => s.daySd), 1)}`,
);
console.log(
  `스윙(5%+) ${avg((s) => s.swingsPerDay).toFixed(1)}회/일(평균 ${pct(avg((s) => s.swingSize), 1)})  ` +
    `MDD ${pct(avg((s) => s.maxDrawdown), 1)}  최저 ${avg((s) => s.min).toFixed(3)}  최고 ${avg((s) => s.max).toFixed(3)}`,
);
console.log(
  `분당 거래량 p10 ${avg((s) => s.volP10).toFixed(2)} / p50 1 / p90 ${avg((s) => s.volP90).toFixed(2)} (중앙값 대비)  ` +
    `acf1 ${avg((s) => s.volAcf1).toFixed(2)}  |1분 수익률|↔거래량 상관 ${avg((s) => s.volRetCorr).toFixed(2)}`,
);
{
  const LEVEL_RUNS = Number(process.env.SIM_LEVEL_RUNS) || 48;
  const rows = [0.2, 1, 5].map((p0) => {
    const r = runLevel(p0, LEVEL_RUNS);
    return `시작 ${p0} → 하루 뒤 평균 ${pct(Math.exp(r.m) - 1, 1)} (±${pct(r.se, 1)})`;
  });
  console.log(`가격 수준 독립성(${LEVEL_RUNS}회): ${rows.join(' / ')} — 셋 다 0 근처여야 "돌아가야 할 가격"이 없다`);
}

const TAPE_P0 = Number(process.env.SIM_TAPE_P0) || 1;
const tp = runTape(86_400, 1, TAPE_P0);
console.log(`\n── ④ 체결 테이프·호가창(1초 틱 = 유저 폴링, 하루, 시작가 ${TAPE_P0}) ──`);
for (const b of tp.bands) {
  console.log(
    `${b.band.padEnd(5)} 시간 ${pct(b.share, 0).padStart(4)}  체결 없는 초 ${pct(b.zero, 0).padStart(4)}  초당 체결 ${b.perSec.toFixed(2)}건  ` +
      `초당 거래량 ${Math.round(b.volPerSec).toLocaleString()}  호가 지속(직전 초와 같은 레벨) ${pct(b.rest, 0)}  체결 1분봉 폭(중앙) ${pct(b.candle)}`,
  );
}
console.log(
  `상승틱 매수라벨 ${pct(tp.upBuy, 0)} / 하락틱 ${pct(tp.downBuy, 0)}  방향 전환율 ${pct(tp.flipRate, 0)}  ` +
    `쪼개진 주문 ${pct(tp.sliceShare, 0)}  한쪽 레벨 ${tp.levels.toFixed(1)}  최우선 스프레드 ${pct(tp.spread, 3)}  호가 역전 ${tp.crossed}회`,
);
console.log(`수량 자릿수: ${tp.digits}`);
const byHour: string[] = [];
for (let h = 0; h < 24; h += 2) {
  const utc = Date.UTC(2026, 0, 5, (h + 15) % 24, 0, 0); // KST h 시 = UTC h-9
  byHour.push(`${String(h).padStart(2, '0')}시 ${sessionActivity(utc).toFixed(2)}`);
}
console.log(`KST 시각별 세션 활성도(평일): ${byHour.join(' / ')}`);
