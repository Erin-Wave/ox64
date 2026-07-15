// 서버 권위 백엔드(/api/*, Cloudflare Pages Functions + D1) 클라이언트.
// 잔고/체결/손익은 서버가 계산하므로 프론트는 요청·표시만 담당한다.

import type { Side } from '@/types';

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
}
export interface AppState {
  name: string;
  balance: number;
  refillsLeft: number;
  positions: ApiPosition[];
  orders: ApiOrder[];
  pendingOrders: ApiPendingOrder[];
}
export interface LeaderRow {
  name: string;
  balance: number;
  equity: number;
  unrealized: number;
  openCount: number;
  isMe: boolean;
}

export interface SpotOrder {
  id: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  origSize: number;
  createdAt: number;
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
  isMe: boolean;
}
export interface SpotState {
  usdtBalance: number;
  oxBalance: number;
  myOrders: SpotOrder[];
  book: { bids: SpotBookLevel[]; asks: SpotBookLevel[] };
  trades: SpotTrade[];
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
  setSlTp: (positionId: string, p: { stopLoss: number | null; takeProfit: number | null }) =>
    req<AppState>('/order', { method: 'POST', body: JSON.stringify({ action: 'setSlTp', positionId, ...p }) }),
  refill: () => req<AppState>('/refill', { method: 'POST' }),
  leaderboard: () => req<{ leaderboard: LeaderRow[] }>('/leaderboard'),
  spotState: () => req<SpotState>('/spot'),
  spotPlace: (side: 'buy' | 'sell', price: number, size: number) =>
    req<SpotState>('/spot', { method: 'POST', body: JSON.stringify({ action: 'place', side, price, size }) }),
  spotCancel: (orderId: string) =>
    req<SpotState>('/spot', { method: 'POST', body: JSON.stringify({ action: 'cancel', orderId }) }),
};
