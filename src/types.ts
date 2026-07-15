// 공용 도메인 타입 정의

export type Side = 'long' | 'short';
export type OrderStatus = 'open' | 'filled' | 'cancelled';

/** 트레이딩뷰 Lightweight Charts 캔들 (time = UTC seconds) */
export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** 바이낸스 kline websocket payload 중 우리가 쓰는 필드 */
export interface KlineTick {
  symbol: string;
  candle: Candle;
  isClosed: boolean; // 봉 마감 여부
}

/** 모의 주문 */
export interface Order {
  id: string;
  symbol: string;
  side: Side;
  price: number; // 진입 희망가 (시장가면 체결가)
  size: number; // 계약/코인 수량
  leverage: number;
  status: OrderStatus;
  createdAt: number;
}

/** 보유 포지션 */
export interface Position {
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

/** 미체결 지정가 주문 */
export interface PendingOrder {
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

/** 지인별 모의 계정 */
export interface Account {
  id: string;
  name: string;
  balance: number; // USDT 잔고
  createdAt: number;
}
