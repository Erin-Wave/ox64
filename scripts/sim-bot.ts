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
 */
import { nextMarketState, GAUGE_FULL, type BotState } from '../functions/api/spot';

const TICKS_PER_MIN = 20; // 접속 중 ~60/분, 유휴(cron) 12/분 사이의 대표값
const DAYS = Number(process.env.SIM_DAYS) || 5;   // SIM_DAYS=20 처럼 늘려 더 긴 안정성 확인
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

  for (let t = 0; t < TICKS; t++) {
    const step = nextMarketState(s);
    s = step.next;
    rets.push(step.ret);
    occupancy[s.regime] = (occupancy[s.regime] ?? 0) + 1;
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
  '국면 점유율: ' +
    Object.entries(occ)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${((v / total) * 100).toFixed(1)}%`)
      .join(' / '),
);
