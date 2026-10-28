/**
 * 가상 코인 예측 가능성(엣지) 점검 — `npm run sim:edge`
 *
 * ⚠ 봇 가격 모델(functions/api/spot.ts nextMarketState)을 건드렸으면 `sim:bot` 과 함께 반드시 돌릴 것.
 * `sim:bot` 은 "시장처럼 보이는가"(봉 폭·관심도·국면)를 재고, 이건 **"차트를 읽어서 돈을 벌 수 있는가"** 를 잰다.
 * 지인끼리 수익률을 겨루는 곳이라 가상 코인의 방향이 읽히면 그게 곧 공짜 돈이다(2026-10-28 제보: "좀만 눈치보면
 * 돈 불릴 수 있을 것 같다"). 실제 시장처럼 **변동성(크기)은 뭉쳐도 방향은 읽히지 않아야** 한다.
 *
 * 1초 틱(= 유저 폴링)으로 공정가 경로를 만들고, 유저가 차트에서 볼 수 있는 신호로 미래 수익률을 맞혀 본다:
 *   · 모멘텀       — 지난 L 초 수익률 → 다음 H 초 수익률
 *   · 이평 괴리    — 가격 ÷ EMA(1분·5분·20분 반감기) → 되돌림/추세
 *   · 돌파         — 지난 1시간 고저 범위 안에서의 위치(신고가 근처 = 1, 신저가 근처 = 0)
 *   · 낙폭         — 지난 1시간 고점 대비 낙폭(공포)
 * 그리고 **유저에게 안 보이는 모델 내부 상태**(국면·추세·심리·과열)로도 맞혀 본다(오라클). 오라클 IC 가 0 이면
 * 그보다 정보가 적은 어떤 차트 신호도 엣지가 없다 — 가장 강한 판정이다.
 *
 * 지표(미래 수익률은 **산술** — 선물 손익이 가격에 선형이라 유저가 실제로 버는 값):
 *   · IC = **중심화하지 않은** corr(신호, 미래 수익률). 실행마다 따로 재서 평균 ± 표준오차(실행 간)로 본다 — 겹치는
 *     표본이라 한 실행 안의 표본 수로 SE 를 내면 과신한다. 평균을 빼는 보통의 상관은 한 경로 안에서 미래 값까지 써서
 *     평균을 구하므로 순수 랜덤워크에서도 긴 구간일수록 음수로 기운다(실측 1h→1h −0.04, SIM_CONTROL=1 로 확인 가능).
 *   · 엣지 = 신호 강도 상위 10% 표본에서 신호 방향으로 들어갔을 때의 평균 미래 수익률(bp, 1bp = 0.01%). 문턱은 앞 25%
 *     표본으로만 정한다(전체로 정하면 문턱이 미래를 안다). 비교 기준: VIP0 시장가 왕복 비용 ≈ 수수료 6bp + 스프레드 ~20bp.
 *     지정가·고VIP 면 비용이 거의 0 이라 **몇 bp 의 엣지도 레버리지로 불릴 수 있다** — 합격선은 "비용보다 작다"가 아니라
 *     "0 과 구별 안 된다"다.
 *
 * 합격선(2026-10-28): 관측 신호 |IC| ≤ 0.02 수준이고 엣지가 0 과 구별되지 않을 것, 오라클도 마찬가지.
 * ⚠ 수익률 꼬리가 두꺼워(점프·뉴스) 실행 간 SE 가 작게 잡힐 때가 있다 — 별표(*)가 몇 칸 뜨면 **한 번 더 돌려** 같은 칸이 같은
 *   부호로 되풀이되는지 볼 것(마팅게일이면 구조적으로 0 이라 칸마다 부호가 바뀐다). 기준점: 2026-10-27 모델은 10초 모멘텀
 *   IC 0.58 · 20분 이평 괴리 역추종 15분 +51±7bp 처럼 SE 의 몇십 배로 찍혔다.
 */
import { nextMarketState, type BotState } from '../functions/api/spot';

const DT = Number(process.env.SIM_DT) || 1;
const DAYS = Number(process.env.SIM_DAYS) || 3;
const RUNS = Number(process.env.SIM_RUNS) || 8;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const SAMPLE_SEC = 5; // 신호를 뽑는 간격
// SIM_CONTROL=1 — 같은 표본 추출로 **순수 랜덤워크**(상태 없음, 일정한 변동성)를 잰다. 한 경로 안에서 과거·미래 수익률의
// 상관을 재면 순수 랜덤워크도 긴 구간에서 약간 음수가 나온다(유한 표본 편향) — 모델 값과 이걸 나란히 보고 판단할 것.
const CONTROL = process.env.SIM_CONTROL === '1';

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

const HORIZONS = [10, 60, 300, 900, 3600]; // 미래 수익률 구간(초)
const LOOKBACKS = [10, 60, 300, 900, 3600]; // 모멘텀 구간(초)
const EMA_HALF = [60, 300, 1200]; // 이평 반감기(초)
const RANGE_SEC = 3600; // 돌파·낙폭 판정 창
const REGIME_CODE: Record<string, number> = { capitulation: -3, panic: -2, pullback: -1, calm: 0, rally: 1, euphoria: 2 };

interface Feature {
  name: string;
  hidden?: boolean; // 오라클(유저에게 안 보임)
  values: number[];
}

/** **중심화하지 않은** 상관 Σxy / √(Σx²·Σy²). ⚠ 보통의 상관(평균을 빼는)은 한 경로 안에서 평균을 미래 값까지 써서 구하므로
 * 순수 랜덤워크에서도 긴 구간일수록 음수로 기운다(실측: 1h→1h −0.04). 마팅게일이면 E[x·y] = 0 이 정확히 성립하므로
 * 평균을 빼지 않은 이 값이 0 근처여야 한다. */
function corr(a: number[], b: number[]): number {
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    cov += a[i] * b[i];
    va += a[i] * a[i];
    vb += b[i] * b[i];
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/** 신호 강도 상위 frac 표본에서 신호 방향으로 들어갔을 때의 평균 미래 수익률(산술, 비율).
 * ⚠ 문턱은 **앞 25% 표본으로만** 정하고 나머지에서 잰다 — 전체로 정하면 문턱이 미래 가격을 알게 되어(뒤 표본의 신호가 앞
 * 표본의 미래 수익률을 포함한다) 순수 랜덤워크에서도 엣지가 한쪽으로 기운다. */
function topEdge(sig: number[], fut: number[], frac = 0.1): number {
  const warm = Math.floor(sig.length / 4);
  const absSorted = sig
    .slice(0, warm)
    .map(Math.abs)
    .filter((v) => v > 0 && Number.isFinite(v))
    .sort((x, y) => x - y);
  if (absSorted.length < 20) return 0;
  const th = absSorted[Math.floor((1 - frac) * absSorted.length)];
  let sum = 0;
  let n = 0;
  for (let i = warm; i < sig.length; i++) {
    if (!(Math.abs(sig[i]) >= th) || sig[i] === 0) continue;
    sum += Math.sign(sig[i]) * fut[i];
    n++;
  }
  return n ? sum / n : 0;
}

interface RunOut {
  ic: Record<string, number[]>; // `${feature}|${H}` → IC
  edge: Record<string, number[]>;
  sdH: number[]; // 구간별 미래 수익률 sd(규모 감각용)
}

function runOnce(seedOffset: number): RunOut {
  const ticks = Math.round((DAYS * 86400) / DT);
  const logP = new Float64Array(ticks + 1);
  let s = fresh();
  logP[0] = 0;
  // 오라클용 내부 상태(틱마다)
  const drift = new Float64Array(ticks + 1);
  const senti = new Float64Array(ticks + 1);
  const stretch = new Float64Array(ticks + 1);
  const regime = new Float64Array(ticks + 1);
  for (let t = 0; t < ticks; t++) {
    const now = T0 + seedOffset * 3_600_000 * 7 + t * DT * 1000;
    if (CONTROL) {
      logP[t + 1] = logP[t] + 0.001 * Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
      continue;
    }
    s = nextMarketState(s, now, DT).next;
    logP[t + 1] = Math.log(s.ref);
    drift[t + 1] = s.drift;
    senti[t + 1] = s.sentiment;
    stretch[t + 1] = s.anchor > 0 ? Math.log(s.ref / s.anchor) : 0;
    regime[t + 1] = REGIME_CODE[s.regime] ?? 0;
  }
  const perSec = 1 / DT;
  const step = Math.max(1, Math.round(SAMPLE_SEC * perSec));
  const maxLook = Math.round(Math.max(...LOOKBACKS, RANGE_SEC) * perSec);
  const maxFwd = Math.round(Math.max(...HORIZONS) * perSec);
  // EMA 들(로그 가격)
  const emas = EMA_HALF.map((hl) => {
    const a = 1 - Math.exp(-(DT * Math.LN2) / hl);
    const out = new Float64Array(ticks + 1);
    let e = logP[0];
    for (let t = 0; t <= ticks; t++) {
      e += a * (logP[t] - e);
      out[t] = e;
    }
    return out;
  });
  // 1시간 이동 최고·최저(단조 덱)
  const W = Math.round(RANGE_SEC * perSec);
  const rollMax = new Float64Array(ticks + 1);
  const rollMin = new Float64Array(ticks + 1);
  {
    const qMax: number[] = [];
    const qMin: number[] = [];
    let hMax = 0;
    let hMin = 0;
    for (let t = 0; t <= ticks; t++) {
      while (qMax.length > hMax && logP[qMax[qMax.length - 1]] <= logP[t]) qMax.pop();
      qMax.push(t);
      while (qMin.length > hMin && logP[qMin[qMin.length - 1]] >= logP[t]) qMin.pop();
      qMin.push(t);
      while (qMax[hMax] <= t - W) hMax++;
      while (qMin[hMin] <= t - W) hMin++;
      rollMax[t] = logP[qMax[hMax]];
      rollMin[t] = logP[qMin[hMin]];
    }
  }

  const feats: Feature[] = [
    ...LOOKBACKS.map((L) => ({ name: `모멘텀 ${fmtSec(L)}`, values: [] as number[] })),
    ...EMA_HALF.map((hl) => ({ name: `이평괴리 ${fmtSec(hl)}`, values: [] as number[] })),
    { name: '1h 범위 위치', values: [] },
    { name: '1h 고점 대비 낙폭', values: [] },
    { name: '[내부] 추세(drift)', hidden: true, values: [] },
    { name: '[내부] 국면', hidden: true, values: [] },
    { name: '[내부] 심리', hidden: true, values: [] },
    { name: '[내부] 적정가 괴리', hidden: true, values: [] },
  ];
  const futs: number[][] = HORIZONS.map(() => []);
  for (let t = maxLook; t + maxFwd <= ticks; t += step) {
    let k = 0;
    for (const L of LOOKBACKS) feats[k++].values.push(logP[t] - logP[t - Math.round(L * perSec)]);
    for (let e = 0; e < EMA_HALF.length; e++) feats[k++].values.push(logP[t] - emas[e][t]);
    const span = rollMax[t] - rollMin[t];
    // 범위 위치는 0.5 를 빼 "위쪽 끝 = +, 아래쪽 끝 = −" 로(돌파 추종 신호)
    feats[k++].values.push(span > 0 ? (logP[t] - rollMin[t]) / span - 0.5 : 0);
    // 낙폭은 −(고점 대비 낙폭): "많이 빠졌다 = 음수" → IC 가 음이면 낙폭 매수(되돌림)가 통한다
    feats[k++].values.push(logP[t] - rollMax[t]);
    feats[k++].values.push(drift[t]);
    feats[k++].values.push(regime[t]);
    feats[k++].values.push(senti[t]);
    feats[k++].values.push(stretch[t]);
    // 미래 수익률은 **산술**로 — 선물 손익이 가격에 선형이라 유저가 실제로 버는 값이 이것이다.
    for (let j = 0; j < HORIZONS.length; j++) futs[j].push(Math.expm1(logP[t + Math.round(HORIZONS[j] * perSec)] - logP[t]));
  }
  const ic: Record<string, number[]> = {};
  const edge: Record<string, number[]> = {};
  for (const f of feats) {
    for (let j = 0; j < HORIZONS.length; j++) {
      const key = `${f.name}|${HORIZONS[j]}`;
      ic[key] = [corr(f.values, futs[j])];
      edge[key] = [topEdge(f.values, futs[j])];
    }
  }
  const sdH = futs.map((a) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
  });
  return { ic, edge, sdH };
}

function fmtSec(sec: number): string {
  return sec >= 3600 ? `${sec / 3600}h` : sec >= 60 ? `${sec / 60}m` : `${sec}s`;
}

const meanSe = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const v = a.length > 1 ? a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) : 0;
  return { m, se: Math.sqrt(v / a.length) };
};

console.log(`1초 틱 공정가 ${DAYS}일 × ${RUNS}회, ${SAMPLE_SEC}초마다 표본\n`);
const all: RunOut[] = [];
for (let r = 0; r < RUNS; r++) all.push(runOnce(r));
const keys = Object.keys(all[0].ic);
const names = [...new Set(keys.map((k) => k.split('|')[0]))];
const sdH = HORIZONS.map((_, j) => meanSe(all.map((x) => x.sdH[j])).m);
console.log(`미래 수익률 sd: ${HORIZONS.map((h, j) => `${fmtSec(h)} ${(sdH[j] * 1e4).toFixed(1)}bp`).join(' / ')}\n`);
const head = `${'신호'.padEnd(18)}` + HORIZONS.map((h) => `${('→' + fmtSec(h)).padStart(18)}`).join('');
console.log('IC = 중심화하지 않은 corr(신호, 미래 산술 수익률)  [실행 간 평균 ± SE]  * = |IC| > 0.02 이고 2SE 밖');
console.log(head);
let worst = 0;
let worstObs = 0;
for (const n of names) {
  const cells = HORIZONS.map((h) => {
    const { m, se } = meanSe(all.map((x) => x.ic[`${n}|${h}`][0]));
    const flag = Math.abs(m) > 0.02 && Math.abs(m) > 2 * se ? '*' : ' ';
    if (Math.abs(m) > 2 * se) {
      worst = Math.max(worst, Math.abs(m));
      if (!n.startsWith('[')) worstObs = Math.max(worstObs, Math.abs(m));
    }
    return `${m >= 0 ? '+' : ''}${m.toFixed(3)}±${se.toFixed(3)}${flag}`.padStart(18);
  });
  console.log(`${n.padEnd(18)}${cells.join('')}`);
}
console.log('\n상위 10% 신호(문턱은 앞 25% 표본으로)에서 신호 방향으로 들어갔을 때 평균 수익(bp, 비용 전)  [평균 ± SE]');
console.log(head);
let bestEdge = 0;
for (const n of names) {
  const cells = HORIZONS.map((h) => {
    const { m, se } = meanSe(all.map((x) => x.edge[`${n}|${h}`][0]));
    if (!n.startsWith('[') && Math.abs(m) > 2 * se) bestEdge = Math.max(bestEdge, m * 1e4);
    return `${m >= 0 ? '+' : ''}${(m * 1e4).toFixed(1)}±${(se * 1e4).toFixed(1)}`.padStart(18);
  });
  console.log(`${n.padEnd(18)}${cells.join('')}`);
}
console.log(
  `\n요약: 관측 신호 최대 |IC| ${worstObs.toFixed(3)} · 내부 상태 포함 ${worst.toFixed(3)} · 관측 신호 최대 유의 엣지 ${bestEdge.toFixed(1)}bp` +
    ` (VIP0 시장가 왕복 비용 ≈ 26bp, 지정가·고VIP 면 ~0)`,
);
