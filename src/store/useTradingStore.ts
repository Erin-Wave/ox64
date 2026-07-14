import { create } from 'zustand';
import { api, type ApiOrder, type ApiPosition, type AppState } from '@/services/api';
import type { Side } from '@/types';

/**
 * 모의 트레이딩 상태 (서버 권위).
 * 잔고/포지션/주문의 진실원본은 서버(D1)이고, 스토어는 서버 응답의 캐시일 뿐.
 * 모든 변경은 /api/* 를 거치며 서버가 검증·계산한다 → 클라 조작 무의미.
 */
interface TradingState {
  ready: boolean; // 초기 세션 확인 완료
  authed: boolean;
  name: string | null;
  balance: number;
  positions: ApiPosition[];
  orders: ApiOrder[];
  busy: boolean;
  error: string | null;

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  openMarket: (p: { symbol: string; side: Side; size: number; leverage: number }) => Promise<void>;
  closePosition: (id: string) => Promise<void>;
}

function apply(set: (s: Partial<TradingState>) => void, st: AppState) {
  set({
    authed: true,
    name: st.name,
    balance: st.balance,
    positions: st.positions,
    orders: st.orders,
    error: null,
  });
}

export const useTradingStore = create<TradingState>((set) => ({
  ready: false,
  authed: false,
  name: null,
  balance: 0,
  positions: [],
  orders: [],
  busy: false,
  error: null,

  // 앱 시작 시 기존 세션(쿠키) 확인
  init: async () => {
    try {
      const st = await api.state();
      apply(set, st);
    } catch {
      set({ authed: false });
    } finally {
      set({ ready: true });
    }
  },

  login: async (name, passcode) => {
    set({ busy: true, error: null });
    try {
      const st = await api.login(name, passcode);
      apply(set, st);
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      /* 무시 */
    }
    set({ authed: false, name: null, balance: 0, positions: [], orders: [] });
  },

  refresh: async () => {
    try {
      apply(set, await api.state());
    } catch {
      set({ authed: false });
    }
  },

  openMarket: async ({ symbol, side, size, leverage }) => {
    set({ busy: true, error: null });
    try {
      // 가격은 보내지 않는다 — 서버가 체결가를 직접 받아 쓴다.
      apply(set, await api.open({ symbol, side, size, leverage }));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  closePosition: async (id) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.close(id));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },
}));
