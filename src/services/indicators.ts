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

/** OBV 국면(매집/분산 사이클). 두 질문의 조합이다:
 *  - **돈이 들어오나** — OBV 가 자기 기준선(`base` = OBV 의 EMA) 위면 최근 순매수 유입, 아래면 순매도.
 *  - **가격이 올라가 있나** — 종가가 같은 기간의 가격 EMA 위인가.
 *  → 0 매집(유입 · 가격 아직 아래) / 1 끌어올림(유입 · 가격 위) / 2 정리(유출 · 가격 아직 위) / 3 하락(유출 · 가격 아래)
 *    / 4 반등(유출 · 가격 위 — 단 **하락 뒤**라 정리할 물량이 없는 경우).
 *  사이클 순서가 곧 번호 순서다(매집 → 끌어올림 → 정리 → 하락 → 매집).
 * ⚠⚠ "유출 · 가격 위"는 **어디서 왔나에 따라 뜻이 반대다** — 끌어올림 뒤면 높은 가격에 물량을 넘기는 정리(분산)지만,
 *   하락 뒤면 거래량이 안 받쳐주는 반등일 뿐이다(정리할 물량 자체가 없다). 예전엔 둘 다 "정리"라 하락 끝의 반등이
 *   전부 정리로 칠해졌고, 실제 캔들에서 하락을 벗어나는 전이의 1/3 이 이 경로였다(가격 EMA 가 OBV 기준선보다 먼저
 *   돌아선다 → 대개 1~3봉 뒤 OBV 가 기준선을 뚫고 끌어올림). 그래서 마지막으로 끌어올림을 거쳤는지(하락이 오면 리셋)를
 *   기억해 가른다. 반대쪽("유입 · 가격 아래")은 어디서 왔든 매집이다(하락 뒤 = 바닥 매집, 끌어올림 뒤 = 눌림 매수).
 * ⚠ 기준을 0(절대 수준)이 아니라 **OBV 자신의 이동평균**으로 잡는 이유: OBV 는 불러온 첫 봉에서 0 으로 시작하는
 *   누적값이라 절대 수준은 "어디서부터 셌나"(과거봉을 더 불러오면 통째로 이동)에 달려 있다 — 기준선과의 차이는
 *   그 상수 이동에 영향을 받지 않는다.
 * ⚠ 같으면(거래 없는 한산한 봉이 이어져 OBV 가 평평해지고 기준선이 따라붙은 자리) **직전 판정을 잇는다** —
 *   `>` 로만 가르면 평평한 구간이 전부 "유출"로 칠해진다. */
export function obvPhase(closes: number[], obvS: Series, base: Series, period: number): Series {
  const pma = emaOf(closes, period);
  const out = nulls(closes.length);
  let flowUp: boolean | null = null;
  let priceUp: boolean | null = null;
  let markedUp = false; // 마지막 하락 이후 끌어올림을 거쳤나 — 정리(분산)는 올려놓은 뒤에만 성립한다
  for (let i = 0; i < closes.length; i++) {
    const v = obvS[i];
    const b = base[i];
    const m = pma[i];
    if (v == null || b == null || m == null) continue;
    if (v !== b || flowUp == null) flowUp = v > b;
    if (closes[i] !== m || priceUp == null) priceUp = closes[i] > m;
    const ph = flowUp ? (priceUp ? 1 : 0) : priceUp ? (markedUp ? 2 : 4) : 3;
    if (ph === 1) markedUp = true;
    else if (ph === 3) markedUp = false;
    out[i] = ph;
  }
  return out;
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
export function supertrend(candles: Candle[], period = 10, mult = 3): SuperTrend {
  const n = candles.length;
  const up = nulls(n);
  const down = nulls(n);
  const a = atr(candles, period);
  let prevUpper = NaN;
  let prevLower = NaN;
  let bull = true;
  for (let i = 0; i < n; i++) {
    const at = a[i];
    if (at == null) continue;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    let upper = mid + mult * at;
    let lower = mid - mult * at;
    const pc = i > 0 ? candles[i - 1].close : c.close;
    // 밴드는 추세 방향으로만 조여든다(되돌아가지 않는다)
    if (!Number.isNaN(prevLower) && pc > prevLower) lower = Math.max(lower, prevLower);
    if (!Number.isNaN(prevUpper) && pc < prevUpper) upper = Math.min(upper, prevUpper);
    if (Number.isNaN(prevUpper)) bull = c.close >= mid;
    else if (bull && c.close < prevLower) bull = false;
    else if (!bull && c.close > prevUpper) bull = true;
    prevUpper = upper;
    prevLower = lower;
    if (bull) up[i] = lower;
    else down[i] = upper;
  }
  return { up, down };
}
