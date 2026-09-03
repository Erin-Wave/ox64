import { create } from 'zustand';

export type IndicatorType = 'ema' | 'bb' | 'rsi';
// 캔들/배경 등 차트 전용 색상 프리셋 — 사이트 다크/라이트/고대비 테마와는 별개(차트만 독립적으로 색을 바꿈).
export type ChartColorScheme = 'binance' | 'okx' | 'tradingview';

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  period: number;
  mult?: number; // bb 전용 (표준편차 배수)
}

const DEFAULTS: Record<IndicatorType, Omit<IndicatorConfig, 'id' | 'type'>> = {
  ema: { period: 20 },
  bb: { period: 20, mult: 2 },
  rsi: { period: 14 },
};

let seq = 0;
const nextId = () => `ind_${++seq}_${Math.floor(Math.random() * 1e6)}`;

type BoolFlag =
  | 'showCountdown'
  | 'volume'
  | 'tradeMarkers'
  | 'positionLine'
  | 'slTpLines'
  | 'pendingLine'
  | 'orderBook'
  | 'bookTogether'
  | 'tradeFilterOn'
  | 'tradeStrength';

/** 체결 목록 필터 기준 — 수량(코인 개수) 또는 거래대금(가격×수량, USDT). */
export type TradeFilterBasis = 'qty' | 'notional';

/** 체결 목록 필터. ⚠ **모든 심볼에 같은 값이 적용된다**(심볼별로 따로 기억하지 않는다) — 유저가 그렇게
 * 쓰겠다고 정한 동작이다. 그래서 수량 기준은 심볼을 옮기면 의미가 크게 달라진다(BTC 0.5개 vs PEPE
 * 수십억 개) — 심볼을 넘나들며 쓸 거면 거래대금 기준이 맞다(설정 화면에도 그렇게 적어뒀다).
 * min/max 는 null 이면 그쪽 제한 없음. 표시(필터)일 뿐이라 서버·D1 과는 무관하다. */
export interface TradeFilter {
  on: boolean;
  basis: TradeFilterBasis;
  min: number | null;
  max: number | null;
}

/** 차트 표시 옵션 (localStorage 영속). */
interface ChartState {
  showCountdown: boolean;
  volume: boolean;
  tradeMarkers: boolean;
  positionLine: boolean;
  slTpLines: boolean;
  pendingLine: boolean;
  orderBook: boolean;
  // 호가창·체결내역이 한 화면에 보여줄 행 수(5~50). 각 열의 높이를 rows × 행높이로 잡아 스크롤 없이
  // 딱 그만큼 보이게 한다 — 예전엔 max-h-40(=10행) 고정이라 더 깊은 호가를 보려면 매번 스크롤해야 했다.
  bookRows: number;
  // PC(md+, 768px 이상)에서 호가와 체결을 탭 전환 없이 위아래로 같이 보여준다. 모바일은 폭이 좁아
  // 그대로 탭을 쓴다(이 값과 무관) — 옵션 이름에 PC 를 못 박은 이유.
  bookTogether: boolean;
  // 체결 목록 필터(전 심볼 공통, 표시 전용). on 이 꺼져 있으면 min/max 값은 남겨두고 무시만 한다 —
  // 껐다 켤 때 값을 다시 입력하지 않아도 되게.
  tradeFilterOn: boolean;
  tradeFilterBasis: TradeFilterBasis;
  tradeFilterMin: number | null;
  tradeFilterMax: number | null;
  // 체결 가격 배경에 "지금 이 가격이 싼가/비싼가"를 **레벨(0~±3)** 로 은은하게 깐다.
  // ⚠ 직전 체결 대비 상승/하락(틱 방향)이 아니다 — 그건 행 색(테이커 방향)과 거의 같은 정보라 새로
  // 알려주는 게 없다. 그 시점의 **최근 체결 평균** 대비 얼마나 벗어났는지를 재므로 "평균보다 좀 싸게
  // 체결"이 약세 1레벨, 더 싸면 2레벨이 된다(§ OrderBook withStrength).
  tradeStrength: boolean;
  visibleBars: number; // 처음 로드 시 보여줄 봉 개수 — 마지막으로 사용자가 확대/축소한 값을 기억
  colorScheme: ChartColorScheme;
  indicators: IndicatorConfig[];
  toggle: (k: BoolFlag) => void;
  setBookRows: (n: number) => void;
  setTradeFilter: (patch: Partial<TradeFilter>) => void;
  setVisibleBars: (n: number) => void;
  setColorScheme: (cs: ChartColorScheme) => void;
  addIndicator: (type: IndicatorType) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: Partial<Pick<IndicatorConfig, 'period' | 'mult'>>) => void;
}

export const BOOK_ROWS_MIN = 5;
export const BOOK_ROWS_MAX = 50;
export const BOOK_ROWS_DEFAULT = 10; // 예전 고정 높이(max-h-40 = 160px ÷ 16px/행)와 같은 값

const KEY = 'ox64_chart_opts_v2';
function load(): Partial<ChartState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function persist(s: ChartState) {
  const { showCountdown, volume, tradeMarkers, positionLine, slTpLines, pendingLine, orderBook } = s;
  const { bookRows, bookTogether, visibleBars, colorScheme, indicators } = s;
  const { tradeFilterOn, tradeFilterBasis, tradeFilterMin, tradeFilterMax, tradeStrength } = s;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        showCountdown, volume, tradeMarkers, positionLine, slTpLines, pendingLine, orderBook,
        bookRows, bookTogether, visibleBars, colorScheme, indicators,
        tradeFilterOn, tradeFilterBasis, tradeFilterMin, tradeFilterMax, tradeStrength,
      }),
    );
  } catch {
    /* ignore */
  }
}

/** 저장값이 손으로 바뀌었거나(localStorage) 범위 밖이면 안전한 값으로 되돌린다 — 0/NaN 이 들어오면
 * 호가창 높이가 0 이 되어 아무것도 안 보인다. */
const clampRows = (n: number) =>
  Number.isFinite(n) ? Math.min(BOOK_ROWS_MAX, Math.max(BOOK_ROWS_MIN, Math.round(n))) : BOOK_ROWS_DEFAULT;

/** 필터 경계값 정리 — 0/음수/NaN/빈값은 "제한 없음"(null)으로 본다. 0 을 경계로 두면 "0 이상"이라
 * 아무것도 못 거르면서 필터가 켜진 것처럼 보인다. */
const cleanLimit = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

const saved = load();
export const useChartStore = create<ChartState>((set, get) => ({
  showCountdown: saved.showCountdown ?? true,
  volume: saved.volume ?? true,
  tradeMarkers: saved.tradeMarkers ?? true,
  positionLine: saved.positionLine ?? true,
  slTpLines: saved.slTpLines ?? true,
  pendingLine: saved.pendingLine ?? true,
  orderBook: saved.orderBook ?? true,
  bookRows: clampRows(saved.bookRows ?? BOOK_ROWS_DEFAULT),
  bookTogether: saved.bookTogether ?? false,
  tradeFilterOn: saved.tradeFilterOn ?? false,
  tradeFilterBasis: saved.tradeFilterBasis ?? 'notional',
  tradeFilterMin: cleanLimit(saved.tradeFilterMin),
  tradeFilterMax: cleanLimit(saved.tradeFilterMax),
  tradeStrength: saved.tradeStrength ?? true,
  visibleBars: saved.visibleBars ?? 38,
  colorScheme: saved.colorScheme ?? 'binance',
  indicators: saved.indicators ?? [],
  toggle: (k) => {
    set((s) => ({ [k]: !s[k] }) as Partial<ChartState>);
    persist(get());
  },
  setBookRows: (n) => {
    set({ bookRows: clampRows(n) });
    persist(get());
  },
  setTradeFilter: (patch) => {
    const next: Partial<ChartState> = {};
    if (patch.on !== undefined) next.tradeFilterOn = patch.on;
    if (patch.basis !== undefined) next.tradeFilterBasis = patch.basis;
    if (patch.min !== undefined) next.tradeFilterMin = cleanLimit(patch.min);
    if (patch.max !== undefined) next.tradeFilterMax = cleanLimit(patch.max);
    set(next);
    persist(get());
  },
  setVisibleBars: (n) => {
    set({ visibleBars: n });
    persist(get());
  },
  setColorScheme: (cs) => {
    set({ colorScheme: cs });
    persist(get());
  },
  addIndicator: (type) => {
    const cfg: IndicatorConfig = { id: nextId(), type, ...DEFAULTS[type] };
    set((s) => ({ indicators: [...s.indicators, cfg] }));
    persist(get());
  },
  removeIndicator: (id) => {
    set((s) => ({ indicators: s.indicators.filter((i) => i.id !== id) }));
    persist(get());
  },
  updateIndicator: (id, patch) => {
    set((s) => ({
      indicators: s.indicators.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
    persist(get());
  },
}));
