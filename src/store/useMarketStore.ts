import { create } from 'zustand';
import type { TickerTrade } from '@/types';
import { isVirtualSymbol } from '@/symbols';
import { virtualPrecision } from '@/format';

// 체결 테이프 보관 개수. 호가창 "체결" 탭이 보여줄 수 있는 최대 행 수(설정 상한 50)와 맞춘다 —
// 이보다 작으면 표시 개수를 50 으로 올려도 목록이 그만큼 안 찬다.
const MAX_TRADES = 50;

/**
 * 시장/UI 상태 (Zustand).
 * prices: 심볼별 최신가 맵 — 현재 보는 심볼(차트 WS) + 보유 포지션 심볼(폴링)을 모두 담아
 *   다른 심볼 포지션의 PnL 도 실시간 갱신되게 한다.
 * 잦은 틱 리렌더를 막기 위해 selector 로만 구독한다.
 * symbol/interval 은 마지막 선택값을 localStorage 에 저장해뒀다가 재접속 시 복원한다.
 */
interface MarketState {
  symbol: string;
  interval: string;
  prices: Record<string, number>;
  precisions: Record<string, number>; // 심볼별 가격 소수 자릿수
  connected: boolean;
  chartClickPrice: number | null; // 차트에서 마지막으로 클릭한 가격
  chartClickNonce: number; // 같은 가격을 다시 클릭해도 신호가 오도록 매번 증가
  // 차트/호가창 클릭 가격을 받을 입력칸. '' = 주문패널 지정가(기본), 'close:<positionId>' = 그 포지션의
  // 청산 지정가. ⚠ 클릭 대상이 하나여야 한다 — 안 그러면 한 번 클릭에 주문 지정가와 청산 지정가가 동시에
  // 바뀐다. 각 입력칸이 포커스될 때 자기를 타깃으로 등록한다(차트를 클릭하면 포커스가 풀리므로
  // document.activeElement 로는 판단할 수 없어 별도 상태로 기억한다).
  priceTarget: string;
  recentTrades: Record<string, TickerTrade[]>; // 심볼별 최근 체결(최신이 [0]) — useTradeTape 가 채움

  setSymbol: (s: string) => void;
  setInterval: (i: string) => void;
  setPrice: (symbol: string, price: number) => void;
  setPrecision: (symbol: string, precision: number) => void;
  setConnected: (c: boolean) => void;
  setChartClickPrice: (price: number) => void;
  setPriceTarget: (target: string) => void;
  pushTrade: (symbol: string, trade: TickerTrade) => void;
  setRecentTrades: (symbol: string, trades: TickerTrade[]) => void;
}

const KEY = 'ox64_market_opts_v1';
function load(): Partial<Pick<MarketState, 'symbol' | 'interval'>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function persist(s: Pick<MarketState, 'symbol' | 'interval'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ symbol: s.symbol, interval: s.interval }));
  } catch {
    /* ignore */
  }
}

const saved = load();
export const useMarketStore = create<MarketState>((set, get) => ({
  symbol: saved.symbol ?? 'BTCUSDT',
  interval: saved.interval ?? '1m',
  prices: {},
  precisions: {},
  connected: false,
  chartClickPrice: null,
  chartClickNonce: 0,
  priceTarget: '',
  recentTrades: {},

  setSymbol: (symbol) => {
    set({ symbol });
    persist(get());
  },
  setInterval: (interval) => {
    set({ interval });
    persist(get());
  },
  // ⚠ 가상 코인은 소수 자릿수가 **가격대에 따라 바뀐다**(유효숫자 4자리 고정 — 1.057 은 3자리,
  // 0.002434 는 6자리). 실제 코인처럼 거래소에서 tickSize 를 받아올 곳이 없으므로 가격이 갱신될 때
  // 여기서 파생해 둔다(진실원본 1곳) — 차트를 안 보고 있는 심볼도 헤더/포지션 패널에서 올바른
  // 자릿수로 표시된다(예전엔 4자리 하드코딩이라 123.4567 처럼 없는 자릿수가 보였다).
  setPrice: (symbol, price) =>
    set((s) => {
      if (s.prices[symbol] === price) return s;
      const prices = { ...s.prices, [symbol]: price };
      if (!isVirtualSymbol(symbol)) return { prices };
      const prec = virtualPrecision(price);
      return s.precisions[symbol] === prec ? { prices } : { prices, precisions: { ...s.precisions, [symbol]: prec } };
    }),
  setPrecision: (symbol, precision) =>
    set((s) => (s.precisions[symbol] === precision ? s : { precisions: { ...s.precisions, [symbol]: precision } })),
  setConnected: (connected) => set({ connected }),
  setChartClickPrice: (price) => set((s) => ({ chartClickPrice: price, chartClickNonce: s.chartClickNonce + 1 })),
  setPriceTarget: (priceTarget) => set((s) => (s.priceTarget === priceTarget ? s : { priceTarget })),
  pushTrade: (symbol, trade) =>
    set((s) => ({ recentTrades: { ...s.recentTrades, [symbol]: [trade, ...(s.recentTrades[symbol] ?? [])].slice(0, MAX_TRADES) } })),
  setRecentTrades: (symbol, trades) => set((s) => ({ recentTrades: { ...s.recentTrades, [symbol]: trades } })),
}));

/** 현재 보는 심볼의 최신가(선택자 헬퍼). */
export const selectLastPrice = (s: MarketState): number | null => s.prices[s.symbol] ?? null;
/** 현재 보는 심볼의 가장 최근 체결 방향(매수/매도 체결색으로 현재가 표시할 때 사용). */
export const selectLastTakerSide = (s: MarketState): 'buy' | 'sell' | null =>
  s.recentTrades[s.symbol]?.[0]?.takerSide ?? null;
/** 심볼 정밀도(없으면 2) — 가격 자릿수가 확정되기 전 폴백. */
export const precisionOf = (precisions: Record<string, number>, symbol: string): number =>
  precisions[symbol] ?? 2;
