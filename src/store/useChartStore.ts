import { create } from 'zustand';

export type IndicatorType = 'ema' | 'bb' | 'rsi';

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

type BoolFlag = 'showCountdown' | 'volume' | 'tradeMarkers' | 'positionLine' | 'slTpLines';

/** 차트 표시 옵션 (localStorage 영속). */
interface ChartState {
  showCountdown: boolean;
  volume: boolean;
  tradeMarkers: boolean;
  positionLine: boolean;
  slTpLines: boolean;
  visibleBars: number; // 처음 로드 시 보여줄 봉 개수 — 마지막으로 사용자가 확대/축소한 값을 기억
  indicators: IndicatorConfig[];
  toggle: (k: BoolFlag) => void;
  setVisibleBars: (n: number) => void;
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
  const { showCountdown, volume, tradeMarkers, positionLine, slTpLines, visibleBars, indicators } = s;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ showCountdown, volume, tradeMarkers, positionLine, slTpLines, visibleBars, indicators }),
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
  visibleBars: saved.visibleBars ?? 38,
  indicators: saved.indicators ?? [],
  toggle: (k) => {
    set((s) => ({ [k]: !s[k] }) as Partial<ChartState>);
    persist(get());
  },
  setVisibleBars: (n) => {
    set({ visibleBars: n });
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
