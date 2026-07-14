import { create } from 'zustand';

/**
 * 시장/UI 상태 (Zustand).
 * prices: 심볼별 최신가 맵 — 현재 보는 심볼(차트 WS) + 보유 포지션 심볼(폴링)을 모두 담아
 *   다른 심볼 포지션의 PnL 도 실시간 갱신되게 한다.
 * 잦은 틱 리렌더를 막기 위해 selector 로만 구독한다.
 */
interface MarketState {
  symbol: string;
  interval: string;
  prices: Record<string, number>;
  connected: boolean;

  setSymbol: (s: string) => void;
  setInterval: (i: string) => void;
  setPrice: (symbol: string, price: number) => void;
  setConnected: (c: boolean) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  symbol: 'BTCUSDT',
  interval: '1m',
  prices: {},
  connected: false,

  setSymbol: (symbol) => set({ symbol }),
  setInterval: (interval) => set({ interval }),
  setPrice: (symbol, price) =>
    set((s) => (s.prices[symbol] === price ? s : { prices: { ...s.prices, [symbol]: price } })),
  setConnected: (connected) => set({ connected }),
}));

/** 현재 보는 심볼의 최신가(선택자 헬퍼). */
export const selectLastPrice = (s: MarketState): number | null => s.prices[s.symbol] ?? null;
