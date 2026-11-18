// 차트 보조지표 레지스트리 — Chart.tsx 는 이 표만 보고 그린다(타입별 분기 없음).
// 지표를 추가할 땐: indicators.ts 에 계산 함수 → 여기 INDICATOR_DEFS 에 항목 하나. 스토어·Chart 는 건드리지 않는다.
//  - pane: 'overlay' = 캔들 위에 겹쳐 그림(가격 축 공유) / 'own' = 하단 별도 패널(priceScaleId = 지표 id)
//          / 'volume' = 거래량 막대 위에 겹쳐 그림(priceScaleId 'vol' — 거래량을 끄면 같이 숨는다)
//  - group: 추가 메뉴의 분류(INDICATOR_GROUPS 순서로 묶어 보여준다)
//  - params: 파라미터 정의(입력칸이 이 순서로 자동 생성, 레전드 제목 `MACD(12,26,9)` 도 이 순서 — titleOf 가 있으면 그것)
//  - lines: 선 스펙(compute 결과의 키 하나 = 시리즈 하나). color 가 없으면 지표에 배정된 팔레트 색
//  - levels: own 패널의 기준선(RSI 70/30 등) — 첫 선(lines[0])에 붙인다
//  - format: 레전드 값 표기(price=심볼 자릿수 / fixed1·fixed2·fixed3 / volume=수량 축약)
//  - states: 봉마다의 "국면" 판정(OBV 매집/분산 등). compute 결과의 `states.key` 칸에 라벨 인덱스(0,1,…)를 담으면
//    레전드에 그 시점 라벨이 붙고, `colorByState` 선은 점마다 라벨 색으로 칠해진다. 이 칸은 선으로 그리지 않는다
//  - profile: 봉마다의 선이 아니라 **지금 화면에 보이는 봉 구간 전체**를 가격대별로 모아 가로 막대로 그리는 지표(매물대).
//    Chart 가 보이는 구간이 바뀔 때마다(팬·줌·새 봉) 그 구간 인덱스로 다시 부른다. 이런 지표의 lines 는 전부 kind 'value'
//    (선을 만들지 않고 레전드 값만 — 값은 I.profileValues 의 키: poc/vah/val, 커서 가격대의 at/atBuy)

import type { Candle } from '@/types';
import * as I from './indicators';

export type IndicatorType =
  // 이동평균
  | 'sma'
  | 'ema'
  | 'wma'
  | 'hma'
  | 'vwap'
  | 'vwapd'
  // 밴드 · 채널
  | 'bb'
  | 'env'
  | 'kc'
  | 'dc'
  // 추세
  | 'ichimoku'
  | 'psar'
  | 'supertrend'
  // 모멘텀 · 오실레이터
  | 'rsi'
  | 'stochrsi'
  | 'stoch'
  | 'kdj'
  | 'macd'
  | 'cci'
  | 'wr'
  | 'roc'
  | 'trix'
  | 'ao'
  | 'disp'
  | 'psy'
  // 거래량
  | 'vp'
  | 'volma'
  | 'obv'
  | 'mfi'
  | 'cmf'
  // 변동성 · 추세 강도
  | 'atr'
  | 'adx';

export type IndicatorParams = Record<string, number>;

export type IndicatorGroup = 'ma' | 'band' | 'trend' | 'momentum' | 'volume' | 'volatility';
/** 추가 메뉴의 분류 — 이 순서로 묶는다. */
export const INDICATOR_GROUPS: { key: IndicatorGroup; label: string }[] = [
  { key: 'ma', label: '이동평균' },
  { key: 'band', label: '밴드 · 채널' },
  { key: 'trend', label: '추세' },
  { key: 'momentum', label: '모멘텀 · 오실레이터 (아래 패널)' },
  { key: 'volume', label: '거래량' },
  { key: 'volatility', label: '변동성 · 추세 강도 (아래 패널)' },
];

export interface IndicatorParamDef {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step?: number;
}
/** 'value' = 선으로 그리지 않고 레전드에 값만 찍는다(매물대의 POC 처럼 봉마다의 값이 아닌 것) */
export type LineKind = 'line' | 'hist' | 'dots' | 'value';
export type LineStyleName = 'solid' | 'dotted' | 'dashed';
export interface IndicatorLineDef {
  key: string;
  /** 레전드 약어(단일 선이면 빈 문자열) */
  label: string;
  /** 파라미터에 따라 바뀌는 레전드 약어(거래량 이평 `MA5` 처럼) — 있으면 label 대신 */
  labelOf?: (p: IndicatorParams) => string;
  kind?: LineKind;
  /** 히스토그램 막대 색: 'sign' = 0 위 상승색·아래 하락색(MACD) / 'slope' = 직전 막대보다 커지면 상승색·작아지면 하락색(AO) */
  histColor?: 'sign' | 'slope';
  style?: LineStyleName;
  width?: 1 | 2;
  /** 고정색(없으면 지표 배정색). 여러 선이 있는 지표에서 보조선을 구분할 때만 */
  color?: string;
  /** 점마다 def.states 의 라벨 색으로 칠한다(판정이 없는 워밍업 구간은 배정색) */
  colorByState?: boolean;
  /** false 면 레전드에 값을 안 찍는다(밴드 경계처럼 보조로만 그리는 선) */
  legend?: boolean;
  /** false 면 가격축 범위 계산에서 뺀다 — 캔들에서 멀리 떨어질 수 있는 선(엔벨로프 ±%)이 축을 넓혀 캔들을 납작하게 만들지 않게.
   * 화면 밖이면 안 보이고, 가격이 다가오면 보인다(레전드엔 늘 값이 있다) */
  autoscale?: boolean;
  /** 이 값만 다른 표기(없으면 지표의 format) — 가격 지표 안의 거래량·비중 값 */
  format?: IndicatorFormat;
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
export type IndicatorFormat = 'price' | 'fixed1' | 'fixed2' | 'fixed3' | 'volume' | 'pct';
/** 가로 막대로 그릴 매물대 한 장 + 막대 최대 폭(차트 폭 대비 0~1) */
export interface ProfileDraw extends I.PriceProfile {
  width: number;
}
export interface IndicatorDef {
  label: string;
  name: string;
  pane: 'overlay' | 'own' | 'volume';
  group: IndicatorGroup;
  params: IndicatorParamDef[];
  lines: IndicatorLineDef[];
  levels?: { value: number; color?: string }[];
  states?: IndicatorStates;
  format: IndicatorFormat;
  /** 레전드·목록 제목(없으면 `라벨(파라미터,…)`) */
  titleOf?: (p: IndicatorParams) => string;
  compute: (candles: Candle[], p: IndicatorParams) => Record<string, I.Series>;
  /** 보이는 구간 [from, to](봉 인덱스) 전체를 가격대별로 모은다 — 있으면 Chart 가 가로 막대로 그린다(위 머리말 profile) */
  profile?: (candles: Candle[], from: number, to: number, p: IndicatorParams) => ProfileDraw | null;
}

const PERIOD = (def: number, label = '기간'): IndicatorParamDef => ({ key: 'period', label, def, min: 1, max: 500 });
const SIGNAL_COLOR = '#ff9800';
const UP = '#00c076';
const DOWN = '#f6465d';
const OVERBOUGHT = `${DOWN}40`;
const OVERSOLD = `${UP}40`;
const closesOf = (c: Candle[]) => c.map((x) => x.close);
/** 위 · 가운데 · 아래 선 셋(볼린저·엔벨로프·켈트너·돈치안 공통 모양) */
const BAND_LINES: IndicatorLineDef[] = [
  { key: 'upper', label: 'U', style: 'dotted' },
  { key: 'basis', label: 'B' },
  { key: 'lower', label: 'L', style: 'dotted' },
];

export const INDICATOR_DEFS: Record<IndicatorType, IndicatorDef> = {
  // ── 이동평균 ─────────────────────────────────────────────
  sma: {
    label: 'SMA',
    name: '단순이동평균 (MA)',
    pane: 'overlay',
    group: 'ma',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.sma(closesOf(c), p.period) }),
  },
  ema: {
    label: 'EMA',
    name: '지수이동평균',
    pane: 'overlay',
    group: 'ma',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.ema(closesOf(c), p.period) }),
  },
  wma: {
    label: 'WMA',
    name: '가중이동평균',
    pane: 'overlay',
    group: 'ma',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.wmaOf(closesOf(c), p.period) }),
  },
  // 헐 이동평균 — 지연이 적어 방향 전환을 빨리 보여준다(트레이딩뷰 기본 9)
  hma: {
    label: 'HMA',
    name: '헐 이동평균 (지연 적음)',
    pane: 'overlay',
    group: 'ma',
    params: [{ key: 'period', label: '기간', def: 9, min: 2, max: 500 }],
    lines: [{ key: 'v', label: '', width: 2 }],
    format: 'price',
    compute: (c, p) => ({ v: I.hmaOf(closesOf(c), p.period) }),
  },
  vwap: {
    label: 'VWAP',
    name: '거래량 가중 평균가 (롤링)',
    pane: 'overlay',
    group: 'ma',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '', width: 2 }],
    format: 'price',
    compute: (c, p) => ({ v: I.vwap(c, p.period) }),
  },
  // 하루마다 리셋하는 VWAP(트레이딩뷰 VWAP 의 세션 앵커). 기준 시각은 한국시간 — 0 = 자정, 9 = UTC 0시(바이낸스 일봉 경계)
  vwapd: {
    label: 'VWAP',
    name: '일간 VWAP (하루마다 리셋)',
    pane: 'overlay',
    group: 'ma',
    params: [{ key: 'anchor', label: '하루 시작 (한국시간 시)', def: 0, min: 0, max: 23 }],
    lines: [{ key: 'v', label: '', width: 2 }],
    format: 'price',
    titleOf: (p) => `VWAP(일간·${p.anchor ?? 0}시)`,
    compute: (c, p) => ({ v: I.sessionVwap(c, p.anchor ?? 0) }),
  },
  // ── 밴드 · 채널 ──────────────────────────────────────────
  bb: {
    label: 'BB',
    name: '볼린저 밴드',
    pane: 'overlay',
    group: 'band',
    params: [PERIOD(20), { key: 'mult', label: '표준편차 배수', def: 2, min: 0.5, max: 5, step: 0.5 }],
    lines: BAND_LINES,
    format: 'price',
    compute: (c, p) => {
      const b = I.bollinger(closesOf(c), p.period, p.mult);
      return { upper: b.upper, basis: b.basis, lower: b.lower };
    },
  },
  // 엔벨로프 — 이평에서 ±% 떨어진 선(국내에서 많이 쓴다). ⚠ 기본 폭을 넓게 잡으면 선이 캔들보다 멀어져 가격축이 그만큼 넓어진다
  // (1분봉에 ±10% 면 캔들이 납작해진다) — 그래서 트레이딩뷰(10%)보다 좁은 2% 로 시작한다.
  env: {
    label: 'ENV',
    name: '엔벨로프 (이평 ± %)',
    pane: 'overlay',
    group: 'band',
    params: [PERIOD(20), { key: 'pct', label: '폭 (%)', def: 2, min: 0.1, max: 50, step: 0.1 }],
    // ⚠ 위·아래 선은 가격축 범위에서 뺀다 — 1분봉에선 ±2% 도 캔들 진폭의 몇 배라 축이 넓어져 캔들이 한 줄로 눌렸다(폰 실측)
    lines: [
      { key: 'upper', label: 'U', style: 'dotted', autoscale: false },
      { key: 'basis', label: 'B' },
      { key: 'lower', label: 'L', style: 'dotted', autoscale: false },
    ],
    format: 'price',
    compute: (c, p) => {
      const b = I.envelope(closesOf(c), p.period, p.pct);
      return { upper: b.upper, basis: b.basis, lower: b.lower };
    },
  },
  kc: {
    label: 'KC',
    name: '켈트너 채널 (EMA ± ATR)',
    pane: 'overlay',
    group: 'band',
    params: [
      PERIOD(20, 'EMA 기간'),
      { key: 'mult', label: 'ATR 배수', def: 2, min: 0.1, max: 10, step: 0.1 },
      { key: 'atr', label: 'ATR 기간', def: 10, min: 1, max: 500 },
    ],
    lines: BAND_LINES,
    format: 'price',
    compute: (c, p) => {
      const b = I.keltner(c, p.period, p.mult, p.atr);
      return { upper: b.upper, basis: b.basis, lower: b.lower };
    },
  },
  dc: {
    label: 'DC',
    name: '돈치안 채널 (N봉 최고·최저)',
    pane: 'overlay',
    group: 'band',
    params: [PERIOD(20)],
    lines: [
      { key: 'upper', label: 'U' },
      { key: 'basis', label: 'B', style: 'dotted' },
      { key: 'lower', label: 'L' },
    ],
    format: 'price',
    compute: (c, p) => {
      const b = I.donchian(c, p.period);
      return { upper: b.upper, basis: b.basis, lower: b.lower };
    },
  },
  // ── 추세 ────────────────────────────────────────────────
  ichimoku: {
    label: 'Ichimoku',
    name: '일목균형표',
    pane: 'overlay',
    group: 'trend',
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
    group: 'trend',
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
    name: '슈퍼트렌드 (ATR 추세선)',
    pane: 'overlay',
    group: 'trend',
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
  // ── 모멘텀 · 오실레이터(하단 별도 패널) ───────────────────
  rsi: {
    label: 'RSI',
    name: '상대강도지수',
    pane: 'own',
    group: 'momentum',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 70, color: OVERBOUGHT }, { value: 30, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.rsi(closesOf(c), p.period) }),
  },
  stochrsi: {
    label: 'StochRSI',
    name: '스토캐스틱 RSI',
    pane: 'own',
    group: 'momentum',
    params: [
      { key: 'rsi', label: 'RSI 기간', def: 14, min: 1, max: 500 },
      { key: 'stoch', label: '스토캐스틱 기간', def: 14, min: 1, max: 500 },
      { key: 'k', label: '%K 평활', def: 3, min: 1, max: 50 },
      { key: 'd', label: '%D 기간', def: 3, min: 1, max: 50 },
    ],
    lines: [
      { key: 'k', label: 'K' },
      { key: 'd', label: 'D', color: SIGNAL_COLOR },
    ],
    levels: [{ value: 80, color: OVERBOUGHT }, { value: 20, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => {
      const r = I.stochRsi(closesOf(c), p.rsi, p.stoch, p.k, p.d);
      return { k: r.k, d: r.d };
    },
  },
  stoch: {
    label: 'Stoch',
    name: '스토캐스틱',
    pane: 'own',
    group: 'momentum',
    params: [
      { key: 'k', label: '%K 기간', def: 14, min: 1, max: 500 },
      { key: 'smooth', label: '%K 평활', def: 3, min: 1, max: 50 },
      { key: 'd', label: '%D 기간', def: 3, min: 1, max: 50 },
    ],
    lines: [
      { key: 'k', label: 'K' },
      { key: 'd', label: 'D', color: SIGNAL_COLOR },
    ],
    levels: [{ value: 80, color: OVERBOUGHT }, { value: 20, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => {
      const r = I.stoch(c, p.k, p.smooth, p.d);
      return { k: r.k, d: r.d };
    },
  },
  kdj: {
    label: 'KDJ',
    name: 'KDJ (바이낸스·OKX 식 스토캐스틱)',
    pane: 'own',
    group: 'momentum',
    params: [
      { key: 'period', label: 'RSV 기간', def: 9, min: 1, max: 500 },
      { key: 'm1', label: 'K 평활', def: 3, min: 1, max: 50 },
      { key: 'm2', label: 'D 평활', def: 3, min: 1, max: 50 },
    ],
    lines: [
      { key: 'k', label: 'K' },
      { key: 'd', label: 'D', color: SIGNAL_COLOR },
      { key: 'j', label: 'J', color: '#e91e63' },
    ],
    levels: [{ value: 80, color: OVERBOUGHT }, { value: 20, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => {
      const r = I.kdj(c, p.period, p.m1, p.m2);
      return { k: r.k, d: r.d, j: r.j };
    },
  },
  macd: {
    label: 'MACD',
    name: '이동평균 수렴·확산',
    pane: 'own',
    group: 'momentum',
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
  cci: {
    label: 'CCI',
    name: '상품 채널 지수',
    pane: 'own',
    group: 'momentum',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 100, color: OVERBOUGHT }, { value: -100, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.cci(c, p.period) }),
  },
  wr: {
    label: 'W%R',
    name: 'Williams %R',
    pane: 'own',
    group: 'momentum',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: -20, color: OVERBOUGHT }, { value: -80, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.willr(c, p.period) }),
  },
  roc: {
    label: 'ROC',
    name: '변화율 (N봉 전 대비 %)',
    pane: 'own',
    group: 'momentum',
    params: [PERIOD(9)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 0 }],
    format: 'fixed2',
    compute: (c, p) => ({ v: I.roc(closesOf(c), p.period) }),
  },
  // 값 단위 = 베이시스포인트(0.01%) — 트레이딩뷰 TRIX 와 같은 스케일(퍼센트로 두면 1분봉에서 0.00 만 보인다)
  trix: {
    label: 'TRIX',
    name: 'TRIX (3중 EMA 변화율)',
    pane: 'own',
    group: 'momentum',
    params: [
      { key: 'period', label: '기간', def: 18, min: 1, max: 300 },
      { key: 'signal', label: '시그널', def: 9, min: 1, max: 200 },
    ],
    lines: [
      { key: 'trix', label: '' },
      { key: 'signal', label: 'S', color: SIGNAL_COLOR },
    ],
    levels: [{ value: 0 }],
    format: 'fixed2',
    compute: (c, p) => {
      const r = I.trix(closesOf(c), p.period, p.signal);
      return { trix: r.trix, signal: r.signal };
    },
  },
  // 막대 색은 0 위아래가 아니라 **직전보다 커졌나**(빌 윌리엄스 원래 표기 — 트레이딩뷰·바이낸스와 같다)
  ao: {
    label: 'AO',
    name: '어썸 오실레이터',
    pane: 'own',
    group: 'momentum',
    params: [
      { key: 'fast', label: '단기', def: 5, min: 1, max: 200 },
      { key: 'slow', label: '장기', def: 34, min: 2, max: 500 },
    ],
    lines: [{ key: 'v', label: '', kind: 'hist', histColor: 'slope' }],
    levels: [{ value: 0 }],
    format: 'price',
    compute: (c, p) => ({ v: I.awesome(c, p.fast, p.slow) }),
  },
  disp: {
    label: '이격도',
    name: '이격도 (종가 ÷ 이동평균 × 100)',
    pane: 'own',
    group: 'momentum',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 100 }],
    format: 'fixed2',
    compute: (c, p) => ({ v: I.disparity(closesOf(c), p.period) }),
  },
  psy: {
    label: '심리선',
    name: '투자심리선 (오른 봉 비율)',
    pane: 'own',
    group: 'momentum',
    params: [PERIOD(10)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 75, color: OVERBOUGHT }, { value: 25, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.psychological(closesOf(c), p.period) }),
  },
  // ── 거래량 ──────────────────────────────────────────────
  // 매물대 — **지금 화면에 보이는 봉 전체**의 거래량을 가격대별로 모아 차트 오른쪽에 가로 막대로(트레이딩뷰 VPVR). 팬·줌으로
  // 보이는 구간이 바뀌면 다시 센다. 막대 = 매수(양봉 거래량, 가격축 쪽)+매도(음봉), 진한 칸 = 가치 영역(VA, 거래의 va% 가 몰린
  // 가격대), 가로 실선 = POC(가장 많이 거래된 가격), 막대 위 점선 = VA 위·아래 끝(VAH/VAL).
  vp: {
    label: '매물대',
    name: '거래량 프로파일 (VPVR · 보이는 구간)',
    pane: 'overlay',
    group: 'volume',
    params: [
      { key: 'rows', label: '가격 구간 수', def: 24, min: 6, max: 100 },
      { key: 'va', label: '가치 영역 %', def: 70, min: 10, max: 100 },
      { key: 'width', label: '막대 폭 (차트 폭 %)', def: 30, min: 5, max: 80 },
    ],
    lines: [
      { key: 'poc', label: 'POC', kind: 'value' },
      { key: 'vah', label: 'VAH', kind: 'value' },
      { key: 'val', label: 'VAL', kind: 'value' },
      { key: 'at', label: '이 가격대', kind: 'value', format: 'volume' },
      { key: 'atBuy', label: '매수', kind: 'value', format: 'pct' },
    ],
    format: 'price',
    compute: () => ({}),
    profile: (c, from, to, p) => {
      const r = I.volumeProfile(c, from, to, p.rows, p.va);
      return r && { ...r, width: p.width / 100 };
    },
  },
  // 거래량 막대 위에 겹치는 이평 두 줄(바이낸스 VOL 의 MA5·MA10). 거래량을 끄면 같이 숨는다(pane 'volume')
  volma: {
    label: 'VOL MA',
    name: '거래량 이동평균 (거래량 막대 위)',
    pane: 'volume',
    group: 'volume',
    params: [
      { key: 'p1', label: '이평 1', def: 5, min: 1, max: 500 },
      { key: 'p2', label: '이평 2', def: 10, min: 1, max: 500 },
    ],
    lines: [
      { key: 'ma1', label: '', labelOf: (p) => `MA${p.p1}` },
      { key: 'ma2', label: '', labelOf: (p) => `MA${p.p2}`, color: SIGNAL_COLOR },
    ],
    format: 'volume',
    compute: (c, p) => ({ ma1: I.volumeMa(c, p.p1), ma2: I.volumeMa(c, p.p2) }),
  },
  // OBV 는 고정 기준선(RSI 70/30 같은)이 없다 — 누적값이라 절대 수준은 "어디서부터 셌나"에 달려 있다.
  // 그래서 기준선 = OBV 자신의 EMA(점선), 선 색 = 그 기준선과 가격 추세로 가른 국면(I.obvPhase).
  obv: {
    label: 'OBV',
    name: '누적 거래량(OBV) · 매집/분산 국면',
    pane: 'own',
    group: 'volume',
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
  mfi: {
    label: 'MFI',
    name: '자금 흐름 지수 (거래량 RSI)',
    pane: 'own',
    group: 'volume',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 80, color: OVERBOUGHT }, { value: 20, color: OVERSOLD }],
    format: 'fixed1',
    compute: (c, p) => ({ v: I.mfi(c, p.period) }),
  },
  cmf: {
    label: 'CMF',
    name: '차이킨 자금 흐름',
    pane: 'own',
    group: 'volume',
    params: [PERIOD(20)],
    lines: [{ key: 'v', label: '' }],
    levels: [{ value: 0 }],
    format: 'fixed3',
    compute: (c, p) => ({ v: I.cmf(c, p.period) }),
  },
  // ── 변동성 · 추세 강도 ───────────────────────────────────
  atr: {
    label: 'ATR',
    name: '평균 진폭',
    pane: 'own',
    group: 'volatility',
    params: [PERIOD(14)],
    lines: [{ key: 'v', label: '' }],
    format: 'price',
    compute: (c, p) => ({ v: I.atr(c, p.period) }),
  },
  adx: {
    label: 'ADX',
    name: '추세 강도 (+DI/−DI)',
    pane: 'own',
    group: 'volatility',
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
};

/** 메뉴 표시 순서(위 표 순서). */
export const INDICATOR_TYPES = Object.keys(INDICATOR_DEFS) as IndicatorType[];
/** 분류별 목록(추가 메뉴) — INDICATOR_GROUPS 순서, 그 안은 표 순서. */
export const INDICATOR_TYPES_BY_GROUP = INDICATOR_GROUPS.map((g) => ({
  ...g,
  types: INDICATOR_TYPES.filter((t) => INDICATOR_DEFS[t].group === g.key),
}));

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

/** 레전드·목록 제목 — `EMA(20)` / `MACD(12,26,9)` / `OBV`(파라미터 없음) / titleOf 가 있으면 그것. */
export function indicatorTitle(type: IndicatorType, params: IndicatorParams): string {
  const def = INDICATOR_DEFS[type];
  if (def.titleOf) return def.titleOf(params);
  if (def.params.length === 0) return def.label;
  return `${def.label}(${def.params.map((p) => params[p.key] ?? p.def).join(',')})`;
}
