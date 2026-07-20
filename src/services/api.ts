// 서버 권위 백엔드(/api/*, Cloudflare Pages Functions + D1) 클라이언트.
// 잔고/체결/손익은 서버가 계산하므로 프론트는 요청·표시만 담당한다.

import type { Candle, Side } from '@/types';

export interface ApiPosition {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  size: number;
  leverage: number;
  openedAt: number;
  stopLoss: number | null;
  takeProfit: number | null;
}
export interface ApiOrder {
  id: string;
  symbol: string;
  side: Side;
  price: number;
  size: number;
  leverage: number;
  kind: 'open' | 'close' | 'liquidation';
  pnl: number | null;
  createdAt: number;
}
export interface ApiPendingOrder {
  id: string;
  symbol: string;
  side: Side;
  size: number;
  leverage: number;
  limitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  createdAt: number;
  reduceOnly: boolean; // true 면 지정가 "청산" 주문(체결 시 반대 포지션을 줄인다)
}
export interface AppState {
  name: string;
  balance: number;
  refillsLeft: number;
  /** VIP 등급(0~4) — 누적 거래대금에서 서버가 파생. 수수료율/진행도 표시에 사용 */
  vipTier: number;
  feeRate: number;
  vipNextAt: number | null;
  totalVolume: number;
  totalFees: number;
  positions: ApiPosition[];
  orders: ApiOrder[];
  pendingOrders: ApiPendingOrder[];
  // 보유/미체결 심볼의 서버 마크가격 맵 — 클라가 서버와 동일 시세로 청산가/평가자산을 즉시 계산하게 한다
  // (OX 를 보고 있지 않아도 그 포지션 청산가가 계산되고, 진입 직후 청산가가 바로 표시됨).
  markPrices?: Record<string, number>;
}
export interface LeaderRow {
  name: string;
  balance: number;
  equity: number;
  unrealized: number;
  openCount: number;
  isMe: boolean;
  vipTier: number;
}

export interface SpotBookLevel {
  price: number;
  size: number;
}
export interface SpotTrade {
  id: string;
  price: number;
  size: number;
  takerSide: 'buy' | 'sell' | null;
  createdAt: number;
}
/** OX/USDT 시장 전체 표시용 데이터(호가창/체결내역) — 유저 개인 데이터 아님, 봇이 만든 합성 시장. */
export interface SpotState {
  book: { bids: SpotBookLevel[]; asks: SpotBookLevel[] };
  trades: SpotTrade[];
}

/** HTTP 상태를 담는 API 에러 — 401(인증만료)과 일시적 네트워크/5xx 오류를 구분하기 위함.
 * (일시 오류에 세션을 끊으면 쿠키가 멀쩡해도 로그인 화면으로 튕기므로.) */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

export const api = {
  login: (name: string, passcode: string) =>
    req<AppState>('/login', { method: 'POST', body: JSON.stringify({ name, passcode }) }),
  logout: () => req<{ ok: boolean }>('/logout', { method: 'POST' }),
  state: () => req<AppState>('/state'),
  open: (p: { symbol: string; side: Side; size: number; leverage: number; stopLoss?: number | null; takeProfit?: number | null }) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'open', ...p }) }),
  close: (positionId: string, size?: number) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'close', positionId, size }) }),
  limitClose: (positionId: string, size: number, limitPrice: number) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'limitClose', positionId, size, limitPrice }) }),
  limitOpen: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    limitPrice: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) => req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'limitOpen', ...p }) }),
  cancelLimit: (pendingId: string) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'cancelLimit', pendingId }) }),
  editLimit: (pendingId: string, p: { limitPrice?: number; size?: number }) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'editLimit', pendingId, ...p }) }),
  setSlTp: (positionId: string, p: { stopLoss: number | null; takeProfit: number | null }) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'setSlTp', positionId, ...p }) }),
  refill: () => req<AppState>('/refill', { method: 'POST' }),
  leaderboard: () => req<{ leaderboard: LeaderRow[] }>('/leaderboard'),
  spotState: () => req<SpotState>('/spot'),
  spotCandles: (interval: string, limit = 500) =>
    req<{ candles: Candle[] }>(`/spot?candles=1&interval=${encodeURIComponent(interval)}&limit=${limit}`),
};
