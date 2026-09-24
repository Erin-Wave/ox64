// 차트 보조지표 레지스트리 — Chart.tsx 는 이 표만 보고 그린다(타입별 분기 없음).
// 지표를 추가할 땐: indicators.ts 에 계산 함수 → 여기 INDICATOR_DEFS 에 항목 하나. 스토어·Chart 는 건드리지 않는다.
//  - pane: 'overlay' = 캔들 위에 겹쳐 그림(가격 축 공유) / 'own' = 하단 별도 패널(priceScaleId = 지표 id)
//  - params: 파라미터 정의(입력칸이 이 순서로 자동 생성, 레전드 제목 `MACD(12,26,9)` 도 이 순서)
//  - lines: 선 스펙(compute 결과의 키 하나 = 시리즈 하나). color 가 없으면 지표에 배정된 팔레트 색
//  - levels: own 패널의 기준선(RSI 70/30 등) — 첫 선(lines[0])에 붙인다
//  - format: 레전드 값 표기(price=심볼 자릿수 / fixed1·fixed2 / volume=수량 축약)
//  - states: 봉마다의 "국면" 판정(OBV 매집/분산 등). compute 결과의 `states.key` 칸에 라벨 인덱스(0,1,…)를 담으면
//    레전드에 그 시점 라벨이 붙고, `colorByState` 선은 점마다 라벨 색으로 칠해진다. 이 칸은 선으로 그리지 않는다

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
  /** 점마다 def.states 의 라벨 색으로 칠한다(판정이 없는 워밍업 구간은 배정색) */
  colorByState?: boolean;
  /** false 면 레전드에 값을 안 찍는다(밴드 경계처럼 보조로만 그리는 선) */
  legend?: boolean;
}
export interface IndicatorStateLabel {
  text: string;
  color: string;
  /** 설정 패널 칩에 마우스를 올리면 뜨는 설명 */
  hint: string;
}
export interface IndicatorStates {
  /** compute 결과에서 라벨 인덱스가 담긴 키 */
  key: string;
  labels: IndicatorStateLabel[];
}
export type IndicatorFormat = 'price' | 'fixed1' | 'fixed2' | 'volume';
export interface IndicatorDef {
  label: string;
  name: string;
  pane: 'overlay' | 'own';
  params: IndicatorParamDef[];
  lines: IndicatorLineDef[];
  levels?: { value: number; color?: string }[];
  states?: IndicatorStates;
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
  // OBV 는 고정 기준선(RSI 70/30 같은)이 없다 — 누적값이라 절대 수준은 "어디서부터 셌나"에 달려 있다.
  // 그래서 기준선 = OBV 자신의 EMA(점선), 선 색 = 그 기준선과 가격 추세로 가른 국면(I.obvPhase).
  obv: {
    label: 'OBV',
    name: '누적 거래량(OBV) · 매집/분산 국면',
    pane: 'own',
    params: [
      { key: 'period', label: '기준선 기간', def: 20, min: 2, max: 500 }, // 1 이면 기준선 = OBV 라 판정이 안 된다
      // 노이즈 필터 — 기준선에서 평균 편차의 몇 배를 벗어나야 국면을 바꾸나(0 = 넘나들 때마다, § I.obvPhase).
      // ⚠ 상한 2 는 의도 — 실측(3.6만 봉) 2.0 에서 성분 정답 일치 59~62%·국면 중앙 24봉, 3.0 이면 52~54%(≈동전)·76봉이고
      //   끌어올림−하락 이후 수익률 차가 1.1%→0 으로 사라진다(국면이 정보를 잃고 얼어붙는다).
      { key: 'band', label: '노이즈 필터(0=끔)', def: 0.5, min: 0, max: 2, step: 0.1 },
    ],
    lines: [
      { key: 'v', label: '', width: 2, colorByState: true },
      { key: 'base', label: '기준', style: 'dashed', color: '#8a94a6' },
      // OBV 가 이 점선 밖으로 나가야 흐름(유입/유출) 판정이 바뀐다 — 기준선을 넘었는데 색이 안 바뀌는 이유가 보이게
      { key: 'upper', label: '', style: 'dotted', color: '#8a94a666', legend: false },
      { key: 'lower', label: '', style: 'dotted', color: '#8a94a666', legend: false },
    ],
    states: {
      key: 'phase',
      labels: [
        { text: '매집', color: '#42a5f5', hint: 'OBV 가 기준선 위(순매수 유입)인데 가격은 아직 평균 아래 — 조용히 모으는 중' },
        { text: '끌어올림', color: UP, hint: 'OBV·가격 둘 다 평균 위 — 모은 물량을 바탕으로 가격을 올리는 중' },
        { text: '정리', color: SIGNAL_COLOR, hint: '끌어올린 뒤 OBV 가 기준선 아래로(순매도) 꺾였는데 가격은 아직 평균 위 — 높은 가격에 물량을 넘기는 중' },
        { text: '하락', color: DOWN, hint: 'OBV·가격 둘 다 평균 아래 — 매도세가 가격을 끌어내리는 중' },
        { text: '반등', color: '#b39ddb', hint: '하락 뒤 가격은 평균 위로 올라왔지만 OBV 는 아직 기준선 아래 — 거래량이 받쳐주지 않는 반등(곧 OBV 가 따라오면 끌어올림, 못 따라오면 다시 하락)' },
      ],
    },
    format: 'volume',
    compute: (c, p) => {
      const v = I.obv(c);
      const base = I.emaOf(v, p.period);
      const r = I.obvPhase(closesOf(c), v, base, p.period, p.band ?? 0.5);
      return { v, base, upper: r.upper, lower: r.lower, phase: r.phase };
    },
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
