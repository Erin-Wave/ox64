// 차트 보조지표 레지스트리 — Chart.tsx 는 이 표만 보고 그린다(타입별 분기 없음).
// 지표를 추가할 땐: indicators.ts 에 계산 함수 → 여기 INDICATOR_DEFS 에 항목 하나. 스토어·Chart 는 건드리지 않는다.
//  - pane: 'overlay' = 캔들 위에 겹쳐 그림(가격 축 공유) / 'own' = 하단 별도 패널(priceScaleId = 지표 id)
//  - params: 파라미터 정의(입력칸이 이 순서로 자동 생성, 레전드 제목 `MACD(12,26,9)` 도 이 순서)
//  - lines: 선 스펙(compute 결과의 키 하나 = 시리즈 하나). color 가 없으면 지표에 배정된 팔레트 색
//  - levels: own 패널의 기준선(RSI 70/30 등) — 첫 선(lines[0])에 붙인다
//  - format: 레전드 값 표기(price=심볼 자릿수 / fixed1·fixed2 / volume=수량 축약)

import type { Candle } from '@/types';
import * as I from './indicators';

export type IndicatorType =
  | 'ema'
  | 'sma'
  | 'bb'
  | 'vwap'
  | 'ichimoku'
  | 'psar'
  | 'supertrend'
  | 'rsi'
  | 'macd'
  | 'stoch'
  | 'atr'
  | 'adx'
  | 'cci'
  | 'obv'
  | 'wr';

export type IndicatorParams = Record<string, number>;

export interface IndicatorParamDef {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step?: number;
}
export type LineKind = 'line' | 'hist' | 'dots';
export type LineStyleName = 'solid' | 'dotted' | 'dashed';
export interface IndicatorLineDef {
  key: string;
  /** 레전드 약어(단일 선이면 빈 문자열) */
  label: string;
  kind?: LineKind;
  style?: LineStyleName;
  width?: 1 | 2;
  /** 고정색(없으면 지표 배정색). 여러 선이 있는 지표에서 보조선을 구분할 때만 */
  color?: string;
}
export type IndicatorFormat = 'price' | 'fixed1' | 'fixed2' | 'volume';
export interface IndicatorDef {
  label: string;
  name: string;
  pane: 'overlay' | 'own';
  params: IndicatorParamDef[];
  lines: IndicatorLineDef[];
  levels?: { value: number; color?: string }[];
  format: IndicatorFormat;
  compute: (candles: Candle[], p: IndicatorParams) => Record<string, I.Series>;
}

const PERIOD = (def: number, label = '기간'): IndicatorParamDef => ({ key: 'period', label, def, min: 1, max: 500 });
const SIGNAL_COLOR = '#ff9800';
const UP = '#00c076';
const DOWN = '#f6465d';
const closesOf = (c: Candle[]) => c.map((x) => x.close);

export const INDICATOR_DEFS: Record<IndicatorType, IndicatorDef> = {
  // ── 오버레이 ──────────────────────────────────────────────
  ema: {
    label: 'EMA',
    name: '지수이동평균',
    pane: 'overlay',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.ema(closesOf(c), p.period) }),
  },
  sma: {
    label: 'SMA',
    name: '단순이동평균',
    pane: 'overlay',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.sma(closesOf(c), p.period) }),
  },
  bb: {
    label: 'BB',
    name: '볼린저 밴드',
    pane: 'overlay',
    params: [PERIOD(20), { key: 'mult', label: '표준편차 배수', def: 2, min: 0.5, max: 5, step: 0.5 }],
    lines: [
      { key: 'upper', label: 'U', style: 'dotted' },
      { key: 'basis', label: 'B' },
      { key: 'lower', label: 'L', style: 'dotted' },
    ],
    format: 'price',
    compute: (c, p) => {
      const b = I.bollinger(closesOf(c), p.period, p.mult);
      return { upper: b.upper, basis: b.basis, lower: b.lower };
    },
  },
  vwap: {
    label: 'VWAP',
    name: '거래량 가중 평균가(롤링)',
    pane: 'overlay',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '', width: 2 }],
    format: 'price',
    compute: (c, p) => ({ v: I.vwap(c, p.period) }),
  },
  ichimoku: {
    label: 'Ichimoku',
    name: '일목균형표',
    pane: 'overlay',
    params: [
      { key: 'tenkan', label: '전환선', def: 9, min: 1, max: 200 },
      { key: 'kijun', label: '기준선', def: 26, min: 1, max: 300 },
      { key: 'senkou', label: '선행스팬B', def: 52, min: 1, max: 500 },
    ],
    lines: [
      { key: 'tenkan', label: '전환' },
      { key: 'kijun', label: '기준', color: '#ff6b6b' },
      { key: 'spanA', label: 'A', color: `${UP}99` },
      { key: 'spanB', label: 'B', color: `${DOWN}99` },
      { key: 'chikou', label: '후행', color: '#8bc34a', style: 'dashed' },
    ],
    format: 'price',
    compute: (c, p) => {
      const r = I.ichimoku(c, p.tenkan, p.kijun, p.senkou);
      return { tenkan: r.tenkan, kijun: r.kijun, spanA: r.spanA, spanB: r.spanB, chikou: r.chikou };
    },
  },
  psar: {
    label: 'PSAR',
    name: 'Parabolic SAR',
    pane: 'overlay',
    params: [
      { key: 'step', label: '가속 단계', def: 0.02, min: 0.001, max: 0.2, step: 0.005 },
      { key: 'max', label: '가속 상한', def: 0.2, min: 0.05, max: 1, step: 0.05 },
    ],
    lines: [{ key: 'v', label: '', kind: 'dots' }],
    format: 'price',
    compute: (c, p) => ({ v: I.psar(c, p.step, p.max) }),
  },
  supertrend: {
    label: 'SuperTrend',
    name: '슈퍼트렌드(ATR 추세선)',
    pane: 'overlay',
    params: [PERIOD(10, 'ATR 기간'), { key: 'mult', label: 'ATR 배수', def: 3, min: 0.5, max: 10, step: 0.5 }],
    lines: [
      { key: 'up', label: '↑', color: UP, width: 2 },
      { key: 'down', label: '↓', color: DOWN, width: 2 },
    ],
    format: 'price',
    compute: (c, p) => {
      const r = I.supertrend(c, p.period, p.mult);
      return { up: r.up, down: r.down };
    },
  },
  // ── 오실레이터(하단 별도 패널) ─────────────────────────────
  rsi: {
    label: 'RSI',
    name: '상대강도지수',
    pane: 'own',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 70, color: `${DOWN}40` }, { value: 30, color: `${UP}40` }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.rsi(closesOf(c), p.period) }),
  },
  macd: {
    label: 'MACD',
    name: '이동평균 수렴·확산',
    pane: 'own',
    params: [
      { key: 'fast', label: '단기', def: 12, min: 1, max: 200 },
      { key: 'slow', label: '장기', def: 26, min: 2, max: 500 },
      { key: 'signal', label: '시그널', def: 9, min: 1, max: 200 },
    ],
    lines: [
      { key: 'hist', label: 'H', kind: 'hist' },
      { key: 'macd', label: '' },
      { key: 'signal', label: 'S', color: SIGNAL_COLOR },
    ],
    levels: [{ value: 0 }],
    format: 'price',
    compute: (c, p) => {
      const r = I.macd(closesOf(c), p.fast, p.slow, p.signal);
      return { hist: r.hist, macd: r.macd, signal: r.signal };
    },
  },
  stoch: {
    label: 'Stoch',
    name: '스토캐스틱',
    pane: 'own',
    params: [
      { key: 'k', label: '%K 기간', def: 14, min: 1, max: 500 },
      { key: 'smooth', label: '%K 평활', def: 3, min: 1, max: 50 },
      { key: 'd', label: '%D 기간', def: 3, min: 1, max: 50 },
    ],
    lines: [
      { key: 'k', label: 'K' },
      { key: 'd', label: 'D', color: SIGNAL_COLOR },
    ],
    levels: [{ value: 80, color: `${DOWN}40` }, { value: 20, color: `${UP}40` }],
    format: 'fixed1',
    compute: (c, p) => {
      const r = I.stoch(c, p.k, p.smooth, p.d);
      return { k: r.k, d: r.d };
    },
  },
  atr: {
    label: 'ATR',
    name: '평균 진폭',
    pane: 'own',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.atr(c, p.period) }),
  },
  adx: {
    label: 'ADX',
    name: '추세 강도(+DI/−DI)',
    pane: 'own',
    params: [PERIOD(14)],
    lines: [
      { key: 'adx', label: '', width: 2 },
      { key: 'pdi', label: '+DI', color: UP },
      { key: 'mdi', label: '−DI', color: DOWN },
    ],
    levels: [{ value: 25 }],
    format: 'fixed1',
    compute: (c, p) => {
      const r = I.adx(c, p.period);
      return { adx: r.adx, pdi: r.pdi, mdi: r.mdi };
    },
  },
  cci: {
    label: 'CCI',
    name: '상품 채널 지수',
    pane: 'own',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 100, color: `${DOWN}40` }, { value: -100, color: `${UP}40` }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.cci(c, p.period) }),
  },
  obv: {
    label: 'OBV',
    name: '누적 거래량(On-Balance Volume)',
    pane: 'own',
    params: [],
    lines: [{ key: 'v', label: '' }],
    format: 'volume',
    compute: (c) => ({ v: I.obv(c) }),
  },
  wr: {
    label: 'W%R',
    name: 'Williams %R',
    pane: 'own',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: -20, color: `${DOWN}40` }, { value: -80, color: `${UP}40` }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.willr(c, p.period) }),
  },
};

/** 메뉴 표시 순서(오버레이 → 오실레이터). */
export const INDICATOR_TYPES = Object.keys(INDICATOR_DEFS) as IndicatorType[];
export const OVERLAY_TYPES = INDICATOR_TYPES.filter((t) => INDICATOR_DEFS[t].pane === 'overlay');
export const OSCILLATOR_TYPES = INDICATOR_TYPES.filter((t) => INDICATOR_DEFS[t].pane === 'own');

export const isIndicatorType = (t: unknown): t is IndicatorType => typeof t === 'string' && t in INDICATOR_DEFS;

export function defaultParams(type: IndicatorType): IndicatorParams {
  const out: IndicatorParams = {};
  for (const p of INDICATOR_DEFS[type].params) out[p.key] = p.def;
  return out;
}

/** 파라미터를 정의 범위로 잘라낸다(손으로 고친 localStorage 값·빈 입력 방어). */
export function clampParam(type: IndicatorType, key: string, v: unknown): number | undefined {
  const p = INDICATOR_DEFS[type].params.find((x) => x.key === key);
  if (!p) return undefined;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) return p.def;
  return Math.min(p.max, Math.max(p.min, n));
}

/** 레전드·목록 제목 — `EMA(20)` / `MACD(12,26,9)` / `OBV`. */
export function indicatorTitle(type: IndicatorType, params: IndicatorParams): string {
  const def = INDICATOR_DEFS[type];
  if (def.params.length === 0) return def.label;
  return `${def.label}(${def.params.map((p) => params[p.key] ?? p.def).join(',')})`;
}
