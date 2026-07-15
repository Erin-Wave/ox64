import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'high-contrast';
export type TradingMode = 'easy' | 'standard';
export type FontSize = 'sm' | 'md' | 'lg';

const FONT_SIZE_PX: Record<FontSize, string> = { sm: '14px', md: '16px', lg: '18px' };

interface SettingsState {
  theme: Theme;
  tradingMode: TradingMode;
  fontSize: FontSize;
  setTheme: (t: Theme) => void;
  setTradingMode: (m: TradingMode) => void;
  setFontSize: (f: FontSize) => void;
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
    localStorage.setItem(KEY, JSON.stringify({ theme: s.theme, tradingMode: s.tradingMode, fontSize: s.fontSize }));
  } catch {
    /* ignore */
  }
}
function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}
// html 기준 폰트 크기를 바꾸면 Tailwind rem 단위 전체가 비례해서 커진다.
function applyFontSize(f: FontSize) {
  document.documentElement.style.fontSize = FONT_SIZE_PX[f];
}

const saved = load();
applyTheme(saved.theme ?? 'dark'); // 모듈 로드 시점(React 마운트 전)에 즉시 적용 — FOUC 방지
applyFontSize(saved.fontSize ?? 'md');

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: saved.theme ?? 'dark',
  tradingMode: saved.tradingMode ?? 'standard',
  fontSize: saved.fontSize ?? 'md',
  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
    persist(get());
  },
  setTradingMode: (m) => {
    set({ tradingMode: m });
    persist(get());
  },
  setFontSize: (f) => {
    applyFontSize(f);
    set({ fontSize: f });
    persist(get());
  },
}));
