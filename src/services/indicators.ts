// 차트 보조지표 순수 계산 — 입력은 시간 오름차순 캔들(또는 종가 배열), 출력은 **같은 인덱스에 정렬된 값**
// (워밍업 구간은 null). 렌더링 정보(패널·색·라벨)는 indicatorDefs.ts 의 레지스트리가 들고, 여기엔 수식만 둔다.
// ⚠ 지표를 추가할 땐 여기에 계산 함수 하나 + indicatorDefs.ts 에 항목 하나 — Chart/스토어엔 타입 분기를 넣지 않는다.

import type { Candle } from '@/types';

export type Series = (number | null)[];

const nulls = (n: number): Series => new Array(n).fill(null);

/** null 이 섞인 배열의 단순이동평균 — 창 안에 null 이 하나라도 있으면 null. */
export function smaOf(arr: Series, period: number): Series {
  const out = nulls(arr.length);
  if (period < 1) return out;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v != null) {
      sum += v;
      cnt++;
    }
    if (i >= period) {
      const old = arr[i - period];
      if (old != null) {
        sum -= old;
        cnt--;
      }
    }
    if (i >= period - 1 && cnt === period) out[i] = sum / period;
  }
  return out;
}

/** null 이 섞인 배열의 EMA — 첫 유효값부터 period 개의 SMA 를 시드로 쓴다. */
export function emaOf(arr: Series, period: number): Series {
  const out = nulls(arr.length);
  if (period < 1) return out;
  let start = arr.findIndex((v) => v != null);
  if (start < 0 || start + period > arr.length) return out;
  // 시드 구간에 null 이 끼어 있으면 그 뒤로 미룬다(연속 period 개 필요)
  outer: for (; start + period <= arr.length; start++) {
    for (let j = start; j < start + period; j++) if (arr[j] == null) continue outer;
    break;
  }
  if (start + period > arr.length) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let j = start; j < start + period; j++) sum += arr[j]!;
  let prev = sum / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) continue;
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export const sma = (closes: number[], period: number): Series => smaOf(closes, period);
export const ema = (closes: number[], period: number): Series => emaOf(closes, period);

/** null 이 섞인 배열의 가중이동평균(WMA) — 창 안 최근 값일수록 무게가 크다(오래된 것부터 1, 2, …, period).
 * 창 안에 null 이 하나라도 있으면 null. 창을 한 칸 밀 때 가중합 = 이전 가중합 − 이전 단순합 + period × 새 값(O(n)). */
export function wmaOf(arr: Series, period: number): Series {
  const n = arr.length;
  const out = nulls(n);
  const p = Math.floor(period);
  if (p < 1) return out;
  const denom = (p * (p + 1)) / 2;
  let run = 0; // i 에서 끝나는 연속 유효값 개수
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v == null) {
      run = 0;
      continue;
    }
    run++;
    if (run < p) continue;
    if (run === p) {
      // 창이 처음 찼다 — 직접 센다
      sum = 0;
      wsum = 0;
      for (let k = 0; k < p; k++) {
        const x = arr[i - p + 1 + k] as number;
        sum += x;
        wsum += (k + 1) * x;
      }
    } else {
      wsum = wsum - sum + p * v;
      sum = sum - (arr[i - p] as number) + v;
    }
    out[i] = wsum / denom;
  }
  return out;
}

/** 헐 이동평균(HMA) = WMA(2·WMA(n/2) − WMA(n), √n) — 지연을 줄인 이동평균(트레이딩뷰 ta.hma 와 같은 식, 길이는 내림). */
export function hmaOf(arr: Series, period: number): Series {
  const p = Math.max(1, Math.floor(period));
  const half = wmaOf(arr, Math.max(1, Math.floor(p / 2)));
  const full = wmaOf(arr, p);
  const diff: Series = half.map((h, i) => (h == null || full[i] == null ? null : 2 * h - (full[i] as number)));
  return wmaOf(diff, Math.max(1, Math.floor(Math.sqrt(p))));
}

/** 창 안 최댓값·최솟값(창이 덜 찬 앞부분은 null) — 단조 덱으로 O(n). */
export function rollingMax(arr: number[], period: number): Series {
  return rolling(arr, period, (a, b) => a >= b);
}
export function rollingMin(arr: number[], period: number): Series {
  return rolling(arr, period, (a, b) => a <= b);
}
function rolling(arr: number[], period: number, keep: (a: number, b: number) => boolean): Series {
  const n = arr.length;
  const out = nulls(n);
  const p = Math.floor(period);
  if (p < 1) return out;
  const dq: number[] = []; // 인덱스 — 앞이 창 안의 극값
  let head = 0;
  for (let i = 0; i < n; i++) {
    while (dq.length > head && !keep(arr[dq[dq.length - 1]], arr[i])) dq.pop();
    dq.push(i);
    if (dq[head] <= i - p) head++;
    if (i >= p - 1) out[i] = arr[dq[head]];
  }
  return out;
}

export interface BollingerBands {
  basis: Series;
  upper: Series;
  lower: Series;
}
export function bollinger(closes: number[], period = 20, mult = 2): BollingerBands {
  const n = closes.length;
  const basis = nulls(n);
  const upper = nulls(n);
  const lower = nulls(n);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    basis[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { basis, upper, lower };
}

export function rsi(closes: number[], period = 14): Series {
  const out = nulls(closes.length);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** 롤링 VWAP — 최근 period 봉의 Σ(대표가×거래량)/Σ거래량. 세션 앵커(일 단위 리셋)가 아니라 이동창이다
 * (초봉~월봉 어느 인터벌에서도 의미가 성립하게). 거래량이 없으면 null. */
export function vwap(candles: Candle[], period = 20): Series {
  const n = candles.length;
  const out = nulls(n);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const v = c.volume ?? 0;
    pv += ((c.high + c.low + c.close) / 3) * v;
    vol += v;
    if (i >= period) {
      const o = candles[i - period];
      const ov = o.volume ?? 0;
      pv -= ((o.high + o.low + o.close) / 3) * ov;
      vol -= ov;
    }
    if (i >= period - 1 && vol > 0) out[i] = pv / vol;
  }
  return out;
}

export interface Macd {
  macd: Series;
  signal: Series;
  hist: Series;
}
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): Macd {
  const n = closes.length;
  const ef = emaOf(closes, fast);
  const es = emaOf(closes, slow);
  const m = nulls(n);
  for (let i = 0; i < n; i++) if (ef[i] != null && es[i] != null) m[i] = ef[i]! - es[i]!;
  const sig = emaOf(m, signal);
  const hist = nulls(n);
  for (let i = 0; i < n; i++) if (m[i] != null && sig[i] != null) hist[i] = m[i]! - sig[i]!;
  return { macd: m, signal: sig, hist };
}

export interface Stoch {
  k: Series;
  d: Series;
}
/** 스토캐스틱 — raw %K = (종가−최저)/(최고−최저)×100 (kPeriod 창), %K = SMA(raw, kSmooth), %D = SMA(%K, dPeriod). */
export function stoch(candles: Candle[], kPeriod = 14, kSmooth = 3, dPeriod = 3): Stoch {
  const n = candles.length;
  const raw = nulls(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    raw[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const k = smaOf(raw, kSmooth);
  const d = smaOf(k, dPeriod);
  return { k, d };
}

function trueRange(candles: Candle[]): number[] {
  const n = candles.length;
  const tr = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (i === 0) {
      tr[i] = c.high - c.low;
      continue;
    }
    const pc = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return tr;
}

/** Wilder 평활(RMA) — 첫 period 개 평균을 시드로, 이후 prev + (v − prev)/period. */
function rma(arr: number[], period: number): Series {
  const out = nulls(arr.length);
  if (arr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < arr.length; i++) {
    prev = prev + (arr[i] - prev) / period;
    out[i] = prev;
  }
  return out;
}

export function atr(candles: Candle[], period = 14): Series {
  return rma(trueRange(candles), period);
}

export interface Adx {
  adx: Series;
  pdi: Series;
  mdi: Series;
}
export function adx(candles: Candle[], period = 14): Adx {
  const n = candles.length;
  const out: Adx = { adx: nulls(n), pdi: nulls(n), mdi: nulls(n) };
  if (n < period + 1) return out;
  const tr = trueRange(candles);
  const pdm = new Array<number>(n).fill(0);
  const mdm = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  // 첫 봉은 전봉이 없어 DM 이 0 — Wilder 원식대로 1번 인덱스부터 평활한다
  const trS = rma(tr.slice(1), period);
  const pS = rma(pdm.slice(1), period);
  const mS = rma(mdm.slice(1), period);
  const dx: number[] = [];
  const dxIdx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] == null || pS[i] == null || mS[i] == null) continue;
    const t = trS[i]!;
    const pdi = t > 0 ? (pS[i]! / t) * 100 : 0;
    const mdi = t > 0 ? (mS[i]! / t) * 100 : 0;
    out.pdi[i + 1] = pdi;
    out.mdi[i + 1] = mdi;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
    dxIdx.push(i + 1);
  }
  const a = rma(dx, period);
  for (let j = 0; j < a.length; j++) if (a[j] != null) out.adx[dxIdx[j]] = a[j];
  return out;
}

/** CCI = (대표가 − SMA(대표가)) / (0.015 × 평균절대편차). */
export function cci(candles: Candle[], period = 20): Series {
  const n = candles.length;
  const out = nulls(n);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const mean = sum / period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
    dev /= period;
    out[i] = dev === 0 ? 0 : (tp[i] - mean) / (0.015 * dev);
  }
  return out;
}

/** OBV — 종가가 오르면 +거래량, 내리면 −거래량 누적. */
export function obv(candles: Candle[]): Series {
  const n = candles.length;
  const out = nulls(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const d = candles[i].close - candles[i - 1].close;
      const v = candles[i].volume ?? 0;
      if (d > 0) acc += v;
      else if (d < 0) acc -= v;
    }
    out[i] = acc;
  }
  return out;
}

/** 슈미트 트리거 판정 — d(= 선 − 기준선)를 그 자신의 평균 절대편차(EMA(|d|, period))로 나눈 z 가 +band 를 넘어야
 * 위, −band 밑으로 가야 아래로 **바뀐다**(그 사이면 직전 판정 유지). band=0 이면 부호 그대로(같으면 유지).
 * 편차 척도가 아직 없는 워밍업 구간은 부호로 판정한다. */
function hysteresis(d: Series, scale: Series, band: number): (boolean | null)[] {
  let st: boolean | null = null;
  return d.map((v, i) => {
    if (v == null) return null;
    const sc = scale[i];
    const z = sc != null && sc > 0 ? v / sc : v;
    const b = sc != null && sc > 0 ? band : 0;
    if (st === null) st = v > 0;
    else if (z > b) st = true;
    else if (z < -b) st = false;
    return st;
  });
}

/** OBV 국면(매집/분산 사이클). 두 질문의 조합이다:
 *  - **돈이 들어오나** — OBV 가 자기 기준선(`base` = OBV 의 EMA) 위면 최근 순매수 유입, 아래면 순매도.
 *  - **가격이 올라가 있나** — 종가가 같은 기간의 가격 EMA 위인가.
 *  → 0 매집(유입 · 가격 아직 아래) / 1 끌어올림(유입 · 가격 위) / 2 정리(유출 · 가격 아직 위) / 3 하락(유출 · 가격 아래)
 *    / 4 반등(유출 · 가격 위 — 단 **하락 뒤**라 정리할 물량이 없는 경우).
 *  사이클 순서가 곧 번호 순서다(매집 → 끌어올림 → 정리 → 하락 → 매집).
 * ⚠⚠ **노이즈 필터 = 두 질문 모두 히스테리시스**(2026-09-24, `band`). 기준선을 살짝 넘나드는 것만으로 뒤집으면 실제
 *   캔들(바이낸스 6코인 × 1m~1d, 3.6만 봉)에서 100봉당 23.9번 국면이 바뀌고 **국면의 62%가 1~2봉짜리**였다. 사후(중심
 *   이동평균 기울기)로 본 "정답"은 성분당 100봉에 3.3번만 바뀌므로 대부분이 잔떨림이다. 선이 기준선에서 자기 평균 편차의
 *   band 배 이상 벗어나야 바꾸면: band 0.5 → 전환 11.4/100봉·잔떨림 31%·정답 일치 59.2%(0 일 때 60.0%).
 *   ⚠ 일치율은 **어떤 실시간 추정으로도 ~75%(성분)/60%(국면)가 천장**이다 — OBV−EMA 대신 ΔOBV 평활·k봉 모멘텀·EMA 교차로
 *   바꿔도 73~75.5% 로 같았다(꺾인 건 꺾인 뒤에야 안다 = 원리적 지연). 밴드를 더 키우면 전환은 줄지만 그 지연이 커진다
 *   (1.0 → 7.1/100봉 · 55.8%). 그래서 기본 0.5 이고 유저가 파라미터로 조절한다(0 = 예전 동작).
 * ⚠ "유출 · 가격 위"는 **어디서 왔나에 따라 뜻이 반대다** — 끌어올림 뒤면 높은 가격에 물량을 넘기는 정리(분산)지만,
 *   하락 뒤면 거래량이 안 받쳐주는 반등일 뿐이다(정리할 물량 자체가 없다). 실제 캔들에서 하락을 벗어나는 전이의 1/3 이
 *   이 경로였다(가격 EMA 가 OBV 기준선보다 먼저 돌아선다). 마지막으로 끌어올림을 거쳤는지(하락이 오면 리셋)를 기억해 가른다.
 *   반대쪽("유입 · 가격 아래")은 어디서 왔든 매집이다(하락 뒤 = 바닥 매집, 끌어올림 뒤 = 눌림 매수).
 * ⚠ 기준을 0(절대 수준)이 아니라 **OBV 자신의 이동평균**으로 잡는 이유: OBV 는 불러온 첫 봉에서 0 으로 시작하는
 *   누적값이라 절대 수준은 "어디서부터 셌나"(과거봉을 더 불러오면 통째로 이동)에 달려 있다 — 기준선과의 차이(와 그 편차
 *   척도)는 그 상수 이동에 영향을 받지 않는다.
 * 반환: phase(국면 인덱스) + upper/lower(OBV 가 이 밖으로 나가야 흐름 판정이 바뀌는 밴드 — 차트에 점선으로 그린다). */
export function obvPhase(
  closes: number[],
  obvS: Series,
  base: Series,
  period: number,
  band: number,
): { phase: Series; upper: Series; lower: Series } {
  const pma = emaOf(closes, period);
  const dF: Series = obvS.map((v, i) => (v == null || base[i] == null ? null : v - (base[i] as number)));
  const dP: Series = closes.map((c, i) => (pma[i] == null ? null : c - (pma[i] as number)));
  const scaleF = emaOf(dF.map((v) => (v == null ? null : Math.abs(v))), period);
  const scaleP = emaOf(dP.map((v) => (v == null ? null : Math.abs(v))), period);
  const flow = hysteresis(dF, scaleF, band);
  const price = hysteresis(dP, scaleP, band);
  const phase = nulls(closes.length);
  let markedUp = false; // 마지막 하락 이후 끌어올림을 거쳤나 — 정리(분산)는 올려놓은 뒤에만 성립한다
  for (let i = 0; i < closes.length; i++) {
    const f = flow[i];
    const p = price[i];
    if (f == null || p == null) continue;
    const ph = f ? (p ? 1 : 0) : p ? (markedUp ? 2 : 4) : 3;
    if (ph === 1) markedUp = true;
    else if (ph === 3) markedUp = false;
    phase[i] = ph;
  }
  // 밴드가 0 이면 기준선과 겹치므로 그리지 않는다.
  const bandLine = (sign: 1 | -1): Series =>
    band > 0 ? base.map((b, i) => (b == null || scaleF[i] == null ? null : b + sign * band * (scaleF[i] as number))) : nulls(closes.length);
  return { phase, upper: bandLine(1), lower: bandLine(-1) };
}

/** Williams %R = (최고 − 종가)/(최고 − 최저) × −100 (0 ~ −100). */
export function willr(candles: Candle[], period = 14): Series {
  const n = candles.length;
  const out = nulls(n);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    out[i] = hh === ll ? -50 : ((hh - candles[i].close) / (hh - ll)) * -100;
  }
  return out;
}

export interface Ichimoku {
  tenkan: Series;
  kijun: Series;
  /** 선행스팬 A/B — 길이가 n + kijun (kijun 봉 앞으로 밀려 그려진다). */
  spanA: Series;
  spanB: Series;
  /** 후행스팬 — 종가를 kijun 봉 뒤로 밀어 놓은 것(길이 n). */
  chikou: Series;
}
function midOf(candles: Candle[], i: number, period: number): number | null {
  if (i < period - 1) return null;
  let hh = -Infinity;
  let ll = Infinity;
  for (let j = i - period + 1; j <= i; j++) {
    if (candles[j].high > hh) hh = candles[j].high;
    if (candles[j].low < ll) ll = candles[j].low;
  }
  return (hh + ll) / 2;
}
export function ichimoku(candles: Candle[], tenkanP = 9, kijunP = 26, senkouP = 52): Ichimoku {
  const n = candles.length;
  const tenkan = nulls(n);
  const kijun = nulls(n);
  const spanA = nulls(n + kijunP);
  const spanB = nulls(n + kijunP);
  const chikou = nulls(n);
  for (let i = 0; i < n; i++) {
    const t = midOf(candles, i, tenkanP);
    const k = midOf(candles, i, kijunP);
    tenkan[i] = t;
    kijun[i] = k;
    if (t != null && k != null) spanA[i + kijunP] = (t + k) / 2;
    spanB[i + kijunP] = midOf(candles, i, senkouP);
    if (i + kijunP < n) chikou[i] = candles[i + kijunP].close;
  }
  return { tenkan, kijun, spanA, spanB, chikou };
}

/** Parabolic SAR (Wilder) — step 씩 가속, max 상한. 추세가 뒤집히면 극값에서 다시 시작. */
export function psar(candles: Candle[], step = 0.02, max = 0.2): Series {
  const n = candles.length;
  const out = nulls(n);
  if (n < 2) return out;
  let up = candles[1].close >= candles[0].close;
  let sar = up ? candles[0].low : candles[0].high;
  let ep = up ? candles[0].high : candles[0].low;
  let af = step;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    let next = sar + af * (ep - sar);
    if (up) {
      // 상승 추세의 SAR 은 직전 두 봉 저가 아래에 있어야 한다
      next = Math.min(next, candles[i - 1].low, i >= 2 ? candles[i - 2].low : candles[i - 1].low);
      if (c.low < next) {
        up = false;
        next = ep;
        ep = c.low;
        af = step;
      } else if (c.high > ep) {
        ep = c.high;
        af = Math.min(max, af + step);
      }
    } else {
      next = Math.max(next, candles[i - 1].high, i >= 2 ? candles[i - 2].high : candles[i - 1].high);
      if (c.high > next) {
        up = true;
        next = ep;
        ep = c.high;
        af = step;
      } else if (c.low < ep) {
        ep = c.low;
        af = Math.min(max, af + step);
      }
    }
    sar = next;
    out[i] = sar;
  }
  return out;
}

export interface SuperTrend {
  /** 상승 국면의 지지선(그 외 구간은 null → 선이 끊긴다) */
  up: Series;
  /** 하락 국면의 저항선 */
  down: Series;
}
/** 슈퍼트렌드 — 트레이딩뷰 ta.supertrend 와 같은 식. 밴드 = 중간가 ± mult × ATR 이고 추세 방향으로만 조여든다(직전 종가가 밴드를
 * 뚫었을 때만 새로 잡는다). 하락 국면이면 종가가 **이번 봉의 (조여든) 윗밴드**를 넘을 때, 상승 국면이면 아랫밴드 밑으로 갈 때 뒤집힌다.
 * ⚠ 예전엔 뒤집힘을 "직전 봉의 밴드"와 비교해서 조여든 만큼 늦게 뒤집혔다(트레이딩뷰·거래소 차트보다 한두 봉 늦는 일이 있었다).
 * 첫 봉은 하락 국면에서 시작한다(트레이딩뷰와 같다). */
export function supertrend(candles: Candle[], period = 10, mult = 3): SuperTrend {
  const n = candles.length;
  const up = nulls(n);
  const down = nulls(n);
  const a = atr(candles, period);
  let prevUpper = NaN;
  let prevLower = NaN;
  let bull = false;
  for (let i = 0; i < n; i++) {
    const at = a[i];
    if (at == null) continue;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    let upper = mid + mult * at;
    let lower = mid - mult * at;
    const first = Number.isNaN(prevUpper);
    if (!first) {
      const pc = candles[i - 1].close;
      // 밴드는 추세 방향으로만 조여든다 — 직전 종가가 밴드를 뚫었을 때만 새 값으로
      if (!(lower > prevLower || pc < prevLower)) lower = prevLower;
      if (!(upper < prevUpper || pc > prevUpper)) upper = prevUpper;
      bull = bull ? !(c.close < lower) : c.close > upper;
    }
    prevUpper = upper;
    prevLower = lower;
    if (bull) up[i] = lower;
    else down[i] = upper;
  }
  return { up, down };
}

/** 매물대(볼륨 프로파일) 한 장 — 봉마다의 값이 아니라 **봉 구간 전체**를 가격대별로 모은 결과. 칸 0 = 가장 낮은 가격대. */
export interface PriceProfile {
  /** 맨 아래 칸의 하단 가격과 칸 높이 — k 번 칸 = [lo + k·step, lo + (k+1)·step) */
  lo: number;
  step: number;
  /** 칸별 거래량 — 양봉(종가 ≥ 시가)의 거래량은 매수(up), 음봉은 매도(down) 쪽에 센다 */
  up: number[];
  down: number[];
  /** 거래량이 가장 많이 쌓인 칸(POC)과 가치 영역(VA)의 칸 범위 [vaLo, vaHi] */
  poc: number;
  vaLo: number;
  vaHi: number;
  /** 가장 큰 칸의 거래량(막대 길이의 기준)과 전체 거래량 */
  max: number;
  total: number;
}

/** candles[from..to] 의 거래량을 rows 개 가격대로 나눠 담는다(트레이딩뷰 VPVR 과 같은 셈법).
 * 봉 하나의 거래량은 그 봉의 저가~고가에 **고르게** 퍼졌다고 보고 겹치는 길이만큼 나눠 담는다 — 봉 안에서 어느 가격에 얼마나
 * 체결됐는지는 캔들에 없다(트레이딩뷰도 하위 봉을 못 쓰면 같은 가정). 그래서 봉이 굵을수록(1d 를 몇 개만 보면) 칸이 뭉개진다.
 * 가치 영역 = POC 에서 시작해 위·아래 이웃 칸 중 거래량이 큰 쪽을 한 칸씩 붙여 전체의 vaPct% 에 닿을 때까지.
 * 보이는 봉에 거래량이 하나도 없으면 null. */
export function volumeProfile(candles: Candle[], from: number, to: number, rows = 24, vaPct = 70): PriceProfile | null {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(candles.length - 1, Math.floor(to));
  if (b < a) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = a; i <= b; i++) {
    const c = candles[i];
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  let n = Math.max(1, Math.round(rows));
  let step = (hi - lo) / n;
  // 보이는 봉이 전부 한 가격이면(봉 하나·호가 정지) 그 가격을 가운데 둔 한 칸으로
  if (!(step > 0)) {
    n = 1;
    step = Math.max(Math.abs(lo) * 1e-4, 1e-12);
    lo -= step / 2;
  }
  const up = new Array<number>(n).fill(0);
  const down = new Array<number>(n).fill(0);
  const binOf = (p: number) => Math.min(n - 1, Math.max(0, Math.floor((p - lo) / step)));
  let total = 0;
  for (let i = a; i <= b; i++) {
    const c = candles[i];
    const v = c.volume ?? 0;
    if (!(v > 0)) continue;
    total += v;
    const dst = c.close >= c.open ? up : down;
    const h = c.high - c.low;
    if (!(h > 0)) {
      dst[binOf(c.close)] += v;
      continue;
    }
    const last = binOf(c.high);
    for (let k = binOf(c.low); k <= last; k++) {
      // 맨 위·맨 아래 칸은 끝을 열어 둔다 — lo + n·step 이 부동소수로 고가에 살짝 못 미쳐 거래량이 새지 않게
      const top = k === n - 1 ? Infinity : lo + (k + 1) * step;
      const bot = k === 0 ? -Infinity : lo + k * step;
      const ov = Math.min(top, c.high) - Math.max(bot, c.low);
      if (ov > 0) dst[k] += (v * ov) / h;
    }
  }
  if (!(total > 0)) return null;
  let poc = 0;
  let max = 0;
  for (let k = 0; k < n; k++) {
    const t = up[k] + down[k];
    if (t > max) {
      max = t;
      poc = k;
    }
  }
  const target = (total * Math.min(100, Math.max(0, vaPct))) / 100;
  let vaLo = poc;
  let vaHi = poc;
  let acc = max;
  while (acc < target && (vaLo > 0 || vaHi < n - 1)) {
    const below = vaLo > 0 ? up[vaLo - 1] + down[vaLo - 1] : -1;
    const above = vaHi < n - 1 ? up[vaHi + 1] + down[vaHi + 1] : -1;
    if (above >= below) {
      vaHi++;
      acc += above;
    } else {
      vaLo--;
      acc += below;
    }
  }
  return { lo, step, up, down, poc, vaLo, vaHi, max, total };
}

/** 매물대 레전드 값 — POC(칸 가운데)·VAH(가치 영역 위 끝)·VAL(아래 끝) 가격. price 를 주면 그 가격이 든 칸의 거래량(at)과
 * 그중 매수 비중(atBuy, %)도. at 은 봉 거래량을 고르게 퍼뜨린 **추정치**라 유효숫자 4자리로 자른다(31.38102415 같은 가짜 정밀도 방지). */
export function profileValues(p: PriceProfile, price?: number | null): Record<string, number> {
  const out: Record<string, number> = {
    poc: p.lo + (p.poc + 0.5) * p.step,
    vah: p.lo + (p.vaHi + 1) * p.step,
    val: p.lo + p.vaLo * p.step,
  };
  if (price != null && Number.isFinite(price)) {
    const k = Math.floor((price - p.lo) / p.step);
    if (k >= 0 && k < p.up.length) {
      const t = p.up[k] + p.down[k];
      out.at = t > 0 ? Number(t.toPrecision(4)) : 0;
      if (t > 0) out.atBuy = (p.up[k] / t) * 100;
    }
  }
  return out;
}

// ── 2026-11-18 추가 지표 ─────────────────────────────────────────────────────────────────────────
// 식은 트레이딩뷰·바이낸스 기본 지표와 같게 맞췄다(다른 곳과 값을 대조해 볼 수 있게). 워밍업 구간은 null.

export interface Bands {
  upper: Series;
  basis: Series;
  lower: Series;
}

/** 엔벨로프 — 이동평균(SMA)에서 위아래로 pct% 떨어진 선. */
export function envelope(closes: number[], period = 20, pct = 2): Bands {
  const basis = smaOf(closes, period);
  const k = pct / 100;
  return {
    basis,
    upper: basis.map((b) => (b == null ? null : b * (1 + k))),
    lower: basis.map((b) => (b == null ? null : b * (1 - k))),
  };
}

/** 켈트너 채널 — 중심 EMA(종가, period) ± mult × ATR(atrPeriod)(트레이딩뷰 기본: 20 · 2 · ATR 10). */
export function keltner(candles: Candle[], period = 20, mult = 2, atrPeriod = 10): Bands {
  const basis = emaOf(
    candles.map((c) => c.close),
    period,
  );
  const a = atr(candles, atrPeriod);
  return {
    basis,
    upper: basis.map((b, i) => (b == null || a[i] == null ? null : b + mult * (a[i] as number))),
    lower: basis.map((b, i) => (b == null || a[i] == null ? null : b - mult * (a[i] as number))),
  };
}

/** 돈치안 채널 — 최근 period 봉의 최고 고가 · 최저 저가와 그 가운데. */
export function donchian(candles: Candle[], period = 20): Bands {
  const upper = rollingMax(
    candles.map((c) => c.high),
    period,
  );
  const lower = rollingMin(
    candles.map((c) => c.low),
    period,
  );
  return { upper, lower, basis: upper.map((u, i) => (u == null || lower[i] == null ? null : (u + (lower[i] as number)) / 2)) };
}

/** 일간 VWAP — 하루(한국시간 anchorHour 시 기준)마다 처음부터 다시 누적하는 거래량 가중 평균가(트레이딩뷰 VWAP 의 세션 앵커).
 * anchorHour = 0 이면 한국시간 0시, 9 면 UTC 0시(바이낸스 일봉 경계). 봉 시작 시각으로 하루를 가른다 — 하루보다 긴 봉은 봉마다
 * 새 하루라 그 봉의 대표가와 같아진다. 그날 거래량이 아직 0 이면 null. */
export function sessionVwap(candles: Candle[], anchorHour = 0): Series {
  const n = candles.length;
  const out = nulls(n);
  const shift = (9 - anchorHour) * 3600; // 유닉스 초 + 이만큼 = "그 시각이 하루의 0시"인 시계
  let day = NaN;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const d = Math.floor((c.time + shift) / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const v = c.volume ?? 0;
    pv += ((c.high + c.low + c.close) / 3) * v;
    vol += v;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

/** 스토캐스틱 RSI — RSI 를 스토캐스틱에 넣은 것: raw = (RSI − 최저 RSI)/(최고 − 최저)×100(stochPeriod 창), %K = SMA(raw, k), %D = SMA(%K, d).
 * 창 안 RSI 가 전부 같으면(강한 추세에서 RSI 가 100 에 붙은 채) 직전 값을 잇는다 — 50 으로 두면 "중립"으로 읽힌다. */
export function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dPeriod = 3): Stoch {
  const r = rsi(closes, rsiPeriod);
  const n = r.length;
  const raw = nulls(n);
  const p = Math.max(1, Math.floor(stochPeriod));
  let prev: number | null = null;
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (r[i] == null) {
      run = 0;
      continue;
    }
    run++;
    if (run < p) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) {
      const x = r[j] as number;
      if (x > hh) hh = x;
      if (x < ll) ll = x;
    }
    const st: number | null = hh > ll ? (((r[i] as number) - ll) / (hh - ll)) * 100 : prev;
    raw[i] = st;
    prev = st;
  }
  const k = smaOf(raw, kSmooth);
  return { k, d: smaOf(k, dPeriod) };
}

export interface Kdj {
  k: Series;
  d: Series;
  j: Series;
}
/** KDJ(바이낸스·OKX 기본 9·3·3) — RSV = (종가 − n봉 최저)/(n봉 최고 − 최저)×100, K = (RSV + (m1−1)·K₋₁)/m1, D = (K + (m2−1)·D₋₁)/m2,
 * J = 3K − 2D. K·D 는 50 에서 시작한다(중국식 SMA(x, m, 1)). J 는 0~100 밖으로 나갈 수 있다. */
export function kdj(candles: Candle[], period = 9, m1 = 3, m2 = 3): Kdj {
  const n = candles.length;
  const out: Kdj = { k: nulls(n), d: nulls(n), j: nulls(n) };
  const hh = rollingMax(
    candles.map((c) => c.high),
    period,
  );
  const ll = rollingMin(
    candles.map((c) => c.low),
    period,
  );
  let k = 50;
  let d = 50;
  for (let i = 0; i < n; i++) {
    if (hh[i] == null || ll[i] == null) continue;
    const range = (hh[i] as number) - (ll[i] as number);
    const rsv = range > 0 ? ((candles[i].close - (ll[i] as number)) / range) * 100 : 50;
    k = (rsv + (m1 - 1) * k) / m1;
    d = (k + (m2 - 1) * d) / m2;
    out.k[i] = k;
    out.d[i] = d;
    out.j[i] = 3 * k - 2 * d;
  }
  return out;
}

/** 자금 흐름 지수(MFI) — 대표가가 오른 봉의 (대표가×거래량) 합 ÷ 내린 봉의 합으로 만든 "거래량 실린 RSI"(0~100).
 * 창 안에 오른 봉도 내린 봉도 없으면(거래가 없던 구간) null. */
export function mfi(candles: Candle[], period = 14): Series {
  const n = candles.length;
  const out = nulls(n);
  const p = Math.floor(period);
  if (p < 1) return out;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const pos = new Array<number>(n).fill(0);
  const neg = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const flow = tp[i] * (candles[i].volume ?? 0);
    if (tp[i] > tp[i - 1]) pos[i] = flow;
    else if (tp[i] < tp[i - 1]) neg[i] = flow;
  }
  let ps = 0;
  let ns = 0;
  for (let i = 1; i < n; i++) {
    ps += pos[i];
    ns += neg[i];
    if (i > p) {
      ps -= pos[i - p];
      ns -= neg[i - p];
    }
    if (i < p) continue;
    // 창을 밀며 더하고 빼서 생긴 부동소수 먼지(−1e-9 같은)는 0 으로
    const tot = Math.abs(ps) + Math.abs(ns);
    const P = ps > 1e-12 * tot ? ps : 0;
    const N = ns > 1e-12 * tot ? ns : 0;
    if (P + N <= 0) continue;
    out[i] = N === 0 ? 100 : 100 - 100 / (1 + P / N);
  }
  return out;
}

/** 변화율(ROC) = (종가 − period 봉 전 종가) / period 봉 전 종가 × 100. */
export function roc(closes: number[], period = 9): Series {
  const out = nulls(closes.length);
  const p = Math.max(1, Math.floor(period));
  for (let i = p; i < closes.length; i++) {
    const prev = closes[i - p];
    if (prev !== 0) out[i] = ((closes[i] - prev) / prev) * 100;
  }
  return out;
}

/** TRIX — 로그 종가의 3중 EMA 가 한 봉에 변한 양 × 10,000(= 베이시스포인트, 트레이딩뷰 식) + 그 EMA(시그널). */
export function trix(closes: number[], period = 15, signal = 9): { trix: Series; signal: Series } {
  const logs: Series = closes.map((c) => (c > 0 ? Math.log(c) : null));
  const e3 = emaOf(emaOf(emaOf(logs, period), period), period);
  const t = nulls(closes.length);
  for (let i = 1; i < closes.length; i++) if (e3[i] != null && e3[i - 1] != null) t[i] = 10000 * ((e3[i] as number) - (e3[i - 1] as number));
  return { trix: t, signal: emaOf(t, signal) };
}

/** 차이킨 자금 흐름(CMF) = Σ(자금흐름 승수 × 거래량) / Σ거래량, 승수 = ((종가−저가) − (고가−종가)) / (고가−저가). −1~1, 거래량이 없으면 null. */
export function cmf(candles: Candle[], period = 20): Series {
  const n = candles.length;
  const out = nulls(n);
  const p = Math.floor(period);
  if (p < 1) return out;
  const mfv = new Array<number>(n);
  const vol = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const v = c.volume ?? 0;
    const range = c.high - c.low;
    mfv[i] = range > 0 ? ((c.close - c.low - (c.high - c.close)) / range) * v : 0;
    vol[i] = v;
  }
  let sm = 0;
  let sv = 0;
  for (let i = 0; i < n; i++) {
    sm += mfv[i];
    sv += vol[i];
    if (i >= p) {
      sm -= mfv[i - p];
      sv -= vol[i - p];
    }
    if (i >= p - 1 && sv > 1e-12) out[i] = sm / sv;
  }
  return out;
}

/** 어썸 오실레이터(AO) = SMA(중간가, fast) − SMA(중간가, slow), 중간가 = (고가+저가)/2(빌 윌리엄스 5 · 34). */
export function awesome(candles: Candle[], fast = 5, slow = 34): Series {
  const mid = candles.map((c) => (c.high + c.low) / 2);
  const f = smaOf(mid, fast);
  const s = smaOf(mid, slow);
  return f.map((v, i) => (v == null || s[i] == null ? null : v - (s[i] as number)));
}

/** 이격도 = 종가 / 이동평균(SMA) × 100 — 100 위면 평균보다 위로 벌어진 정도. */
export function disparity(closes: number[], period = 20): Series {
  const ma = smaOf(closes, period);
  return ma.map((m, i) => (m == null || m === 0 ? null : (closes[i] / m) * 100));
}

/** 투자심리선 = 최근 period 봉 중 종가가 전 봉보다 오른 봉의 비율(%) — 75 이상 과열 · 25 이하 침체(국내 HTS 기본 10). */
export function psychological(closes: number[], period = 10): Series {
  const n = closes.length;
  const out = nulls(n);
  const p = Math.floor(period);
  if (p < 1) return out;
  let ups = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) ups++;
    if (i > p && closes[i - p] > closes[i - p - 1]) ups--;
    if (i >= p) out[i] = (ups / p) * 100;
  }
  return out;
}

/** 거래량 이동평균 — 거래량의 SMA(거래량 막대 위에 겹쳐 그린다). */
export function volumeMa(candles: Candle[], period: number): Series {
  return smaOf(
    candles.map((c) => c.volume ?? 0),
    period,
  );
}
