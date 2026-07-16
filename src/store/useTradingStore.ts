import { create } from 'zustand';
import {
  api,
  type ApiOrder,
  type ApiPendingOrder,
  type ApiPosition,
  type AppState,
  type SpotOrder,
  type SpotBookLevel,
  type SpotTrade,
  type SpotState,
} from '@/services/api';
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
  refillsLeft: number;
  positions: ApiPosition[];
  orders: ApiOrder[];
  pendingOrders: ApiPendingOrder[];
  busy: boolean;
  error: string | null;

  // OX/USDT 가상 코인 현물(레버리지 없음, 별개 매칭엔진) — balance(USDT)는 위 필드를 공유한다.
  oxBalance: number;
  spotOpenOrders: SpotOrder[];
  spotBook: { bids: SpotBookLevel[]; asks: SpotBookLevel[] };
  spotTrades: SpotTrade[];

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  openMarket: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) => Promise<void>;
  closePosition: (id: string, size?: number) => Promise<void>;
  limitOpen: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    limitPrice: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) => Promise<void>;
  cancelLimit: (pendingId: string) => Promise<void>;
  setSlTp: (positionId: string, p: { stopLoss: number | null; takeProfit: number | null }) => Promise<void>;
  refill: () => Promise<void>;

  spotRefresh: () => Promise<void>;
  spotPlace: (side: 'buy' | 'sell', price: number, size: number) => Promise<void>;
  spotCancel: (orderId: string) => Promise<void>;
}

function apply(set: (s: Partial<TradingState>) => void, st: AppState) {
  set({
    authed: true,
    name: st.name,
    balance: st.balance,
    refillsLeft: st.refillsLeft,
    positions: st.positions,
    orders: st.orders,
    pendingOrders: st.pendingOrders,
    error: null,
  });
}
function applySpot(set: (s: Partial<TradingState>) => void, st: SpotState) {
  set({
    balance: st.usdtBalance,
    oxBalance: st.oxBalance,
    spotOpenOrders: st.myOrders,
    spotBook: st.book,
    spotTrades: st.trades,
    error: null,
  });
}

export const useTradingStore = create<TradingState>((set) => ({
  ready: false,
  authed: false,
  name: null,
  balance: 0,
  refillsLeft: 3,
  positions: [],
  orders: [],
  pendingOrders: [],
  busy: false,
  error: null,

  oxBalance: 0,
  spotOpenOrders: [],
  spotBook: { bids: [], asks: [] },
  spotTrades: [],

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
    set({
      authed: false,
      name: null,
      balance: 0,
      refillsLeft: 3,
      positions: [],
      orders: [],
      pendingOrders: [],
      oxBalance: 0,
      spotOpenOrders: [],
      spotBook: { bids: [], asks: [] },
      spotTrades: [],
    });
  },

  refresh: async () => {
    try {
      apply(set, await api.state());
    } catch {
      set({ authed: false });
    }
  },

  openMarket: async ({ symbol, side, size, leverage, stopLoss, takeProfit }) => {
    set({ busy: true, error: null });
    try {
      // 가격은 보내지 않는다 — 서버가 체결가를 직접 받아 쓴다.
      apply(set, await api.open({ symbol, side, size, leverage, stopLoss, takeProfit }));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  closePosition: async (id, size) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.close(id, size));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  limitOpen: async ({ symbol, side, size, leverage, limitPrice, stopLoss, takeProfit }) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.limitOpen({ symbol, side, size, leverage, limitPrice, stopLoss, takeProfit }));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  cancelLimit: async (pendingId) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.cancelLimit(pendingId));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  setSlTp: async (positionId, p) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.setSlTp(positionId, p));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  refill: async () => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.refill());
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  spotRefresh: async () => {
    try {
      applySpot(set, await api.spotState());
    } catch {
      /* 다음 폴링에서 재시도 — 마지막 알려진 값 유지 */
    }
  },

  spotPlace: async (side, price, size) => {
    set({ busy: true, error: null });
    try {
      applySpot(set, await api.spotPlace(side, price, size));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  spotCancel: async (orderId) => {
    set({ busy: true, error: null });
    try {
      applySpot(set, await api.spotCancel(orderId));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },
}));
