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

type BoolFlag = 'showCountdown' | 'volume' | 'tradeMarkers' | 'positionLine' | 'slTpLines' | 'pendingLine' | 'orderBook';

/** 차트 표시 옵션 (localStorage 영속). */
interface ChartState {
  showCountdown: boolean;
  volume: boolean;
  tradeMarkers: boolean;
  positionLine: boolean;
  slTpLines: boolean;
  pendingLine: boolean;
  orderBook: boolean;
  visibleBars: number; // 처음 로드 시 보여줄 봉 개수 — 마지막으로 사용자가 확대/축소한 값을 기억
  colorScheme: ChartColorScheme;
  indicators: IndicatorConfig[];
  toggle: (k: BoolFlag) => void;
  setVisibleBars: (n: number) => void;
  setColorScheme: (cs: ChartColorScheme) => void;
  addIndicator: (type: IndicatorType) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: Partial<Pick<IndicatorConfig, 'period' | 'mult'>>) => void;
}

const KEY = 'ox64_chart_opts_v2';
function load(): Partial<ChartState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function persist(s: ChartState) {
  const { showCountdown, volume, tradeMarkers, positionLine, slTpLines, pendingLine, orderBook, visibleBars, colorScheme, indicators } = s;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ showCountdown, volume, tradeMarkers, positionLine, slTpLines, pendingLine, orderBook, visibleBars, colorScheme, indicators }),
    );
  } catch {
    /* ignore */
  }
}

const saved = load();
export const useChartStore = create<ChartState>((set, get) => ({
  showCountdown: saved.showCountdown ?? true,
  volume: saved.volume ?? true,
  tradeMarkers: saved.tradeMarkers ?? true,
  positionLine: saved.positionLine ?? true,
  slTpLines: saved.slTpLines ?? true,
  pendingLine: saved.pendingLine ?? true,
  orderBook: saved.orderBook ?? true,
  visibleBars: saved.visibleBars ?? 38,
  colorScheme: saved.colorScheme ?? 'binance',
  indicators: saved.indicators ?? [],
  toggle: (k) => {
    set((s) => ({ [k]: !s[k] }) as Partial<ChartState>);
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
