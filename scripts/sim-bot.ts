/**
 * 봇 심리 모델 장기 시뮬레이션 — `npm run sim:bot`
 *
 * ⚠ **봇 심리 파라미터(functions/api/spot.ts REGIME_PARAMS / nextMarketState)를 건드렸다면 반드시 이걸
 * 돌릴 것.** 모델은 DB 접근이 없는 순수 함수라 그대로 떼어내 며칠치를 몇 초에 굴릴 수 있고, 그러지 않으면
 * "틱마다 미세하게 남은 편향"이 며칠 뒤 가격을 0 으로 붕괴시키거나 발산시킨다(실제로 초기 튜닝에서
 * 5일 만에 -40% 가 나왔다). 국면 bias 는 국면 점유율로 가중했을 때 합이 ~0 이어야 한다.
 *
 * 합격선(§ CLAUDE.md "장기 안정성"):
 *   - 5일 뒤 가격이 시작가의 대략 0.5~2배 안에 머문다(앵커 tether 반감기 ~14h)
 *   - 수익률 lag1 자기상관 ≈ +0.15~0.3(추세 지속), |수익률| lag1 자기상관 ≈ 0.2 이상(변동성 뭉침)
 *   - 1분봉 평균 고저폭 ≈ 1~3%
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

  for (let t = 0; t < TICKS; t++) {
    const step = nextMarketState(s);
    s = step.next;
    rets.push(step.ret);
    occupancy[s.regime] = (occupancy[s.regime] ?? 0) + 1;
    if (s.regime === 'capitulation' && prevRegime !== 'capitulation') capEvents++;
    prevRegime = s.regime;
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
