import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'high-contrast';
export type TradingMode = 'easy' | 'standard';

interface SettingsState {
  theme: Theme;
  tradingMode: TradingMode;
  setTheme: (t: Theme) => void;
  setTradingMode: (m: TradingMode) => void;
}

const KEY = 'ox64_settings_v1';
function load(): Partial<SettingsState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function persist(s: SettingsState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ theme: s.theme, tradingMode: s.tradingMode }));
  } catch {
    /* ignore */
  }
}
function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

const saved = load();
applyTheme(saved.theme ?? 'dark'); // 모듈 로드 시점(React 마운트 전)에 즉시 적용 — FOUC 방지

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: saved.theme ?? 'dark',
  tradingMode: saved.tradingMode ?? 'standard',
  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
    persist(get());
  },
  setTradingMode: (m) => {
    set({ tradingMode: m });
    persist(get());
  },
}));
