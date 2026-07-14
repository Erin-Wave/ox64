import { create } from 'zustand';

/**
 * 시장/UI 상태 (Zustand).
 * 잦은 가격 틱으로 인한 전체 리렌더링을 막기 위해 selector 로만 구독한다.
 */
interface MarketState {
  symbol: string;
  interval: string;
  lastPrice: number | null;
  connected: boolean;

  setSymbol: (s: string) => void;
  setInterval: (i: string) => void;
  setLastPrice: (p: number) => void;
  setConnected: (c: boolean) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  symbol: 'BTCUSDT',
  interval: '1m',
  lastPrice: null,
  connected: false,

  setSymbol: (symbol) => set({ symbol }),
  setInterval: (interval) => set({ interval }),
  setLastPrice: (lastPrice) => set({ lastPrice }),
  setConnected: (connected) => set({ connected }),
}));
