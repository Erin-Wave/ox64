import { create } from 'zustand';
import {
  api,
  ApiError,
  type ApiOrder,
  type ApiPendingOrder,
  type ApiPosition,
  type AppState,
  type SpotBookLevel,
  type SpotTrade,
  type SpotState,
} from '@/services/api';
import type { Side } from '@/types';
import { useMarketStore } from '@/store/useMarketStore';

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
  // 서버가 내려준 보유 심볼 마크가격(크로스 가용 증거금 계산용 — 서버 강제청산/증거금 판정과 동일 시세).
  markPrices: Record<string, number>;
  busy: boolean;
  error: string | null;

  // OX/USDT 는 다른 심볼과 동일하게 레버리지로 거래된다(positions/orders 공용) — 이 두 필드는
  // 호가창·체결내역 "표시용" 시장 데이터일 뿐(유저 개인 데이터 아님, 봇이 만든 합성 시장).
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
  limitClose: (positionId: string, size: number, limitPrice: number) => Promise<void>;
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
  editLimit: (pendingId: string, p: { limitPrice?: number; size?: number }) => Promise<void>;
  setSlTp: (positionId: string, p: { stopLoss: number | null; takeProfit: number | null }) => Promise<void>;
  refill: () => Promise<void>;

  spotRefresh: () => Promise<void>;
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
    markPrices: st.markPrices ?? {},
    error: null,
  });
  // 서버 마크가격을 가격 맵에 시드 — 보유 심볼(OX 포함, 현재 보고 있지 않아도)의 청산가/미실현PnL 이
  // 폴링을 기다리지 않고 즉시, 그리고 서버 강제청산 판정과 동일한 시세로 계산된다(청산가 안 찍히던 버그 수정).
  if (st.markPrices) {
    const setPrice = useMarketStore.getState().setPrice;
    for (const [sym, price] of Object.entries(st.markPrices)) {
      if (typeof price === 'number' && isFinite(price) && price > 0) setPrice(sym, price);
    }
  }
}
function applySpot(set: (s: Partial<TradingState>) => void, st: SpotState) {
  set({ spotBook: st.book, spotTrades: st.trades });
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
  markPrices: {},
  busy: false,
  error: null,

  spotBook: { bids: [], asks: [] },
  spotTrades: [],

  // 앱 시작 시 기존 세션(쿠키, 30일) 확인 → 유효하면 자동로그인.
  // 401(인증만료)이면 즉시 로그인 화면. 그 외 일시적 오류(네트워크·5xx)는 쿠키가 멀쩡할 수
  // 있으므로 몇 번 재시도한 뒤에야 로그인 화면으로 폴백한다(로드 순간 blip 으로 튕기지 않게).
  init: async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apply(set, await api.state());
        set({ ready: true });
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          set({ authed: false, ready: true });
          return;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // 일시 오류 → 잠시 후 재시도
      }
    }
    set({ authed: false, ready: true }); // 계속 실패 시에만 로그인 화면
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
      markPrices: {},
      spotBook: { bids: [], asks: [] },
      spotTrades: [],
    });
  },

  refresh: async () => {
    try {
      apply(set, await api.state());
    } catch (e) {
      // 401(인증만료)일 때만 로그아웃. 일시적 네트워크/5xx 로는 세션을 끊지 않는다
      // (쿠키가 멀쩡한데도 폴링 실패 한 번에 로그인 화면으로 튕기던 문제 → 30일 유지 안 되던 체감의 원인).
      if (e instanceof ApiError && e.status === 401) set({ authed: false });
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

  limitClose: async (positionId, size, limitPrice) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.limitClose(positionId, size, limitPrice));
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

  editLimit: async (pendingId, p) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.editLimit(pendingId, p));
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
}));
