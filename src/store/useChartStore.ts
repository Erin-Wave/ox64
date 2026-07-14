import { create } from 'zustand';

/** 차트 표시 옵션 (localStorage 영속). */
interface ChartState {
  showCountdown: boolean;
  ema: boolean;
  bb: boolean;
  rsi: boolean;
  tradeMarkers: boolean;
  positionLine: boolean;
  toggle: (k: keyof Omit<ChartState, 'toggle'>) => void;
}

const KEY = 'ox64_chart_opts';
function load(): Partial<ChartState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function persist(s: ChartState) {
  const { showCountdown, ema, bb, rsi, tradeMarkers, positionLine } = s;
  try {
    localStorage.setItem(KEY, JSON.stringify({ showCountdown, ema, bb, rsi, tradeMarkers, positionLine }));
  } catch {
    /* ignore */
  }
}

const saved = load();
export const useChartStore = create<ChartState>((set, get) => ({
  showCountdown: saved.showCountdown ?? true,
  ema: saved.ema ?? false,
  bb: saved.bb ?? false,
  rsi: saved.rsi ?? false,
  tradeMarkers: saved.tradeMarkers ?? true,
  positionLine: saved.positionLine ?? true,
  toggle: (k) => {
    set((s) => ({ [k]: !s[k] }) as Partial<ChartState>);
    persist(get());
  },
}));
