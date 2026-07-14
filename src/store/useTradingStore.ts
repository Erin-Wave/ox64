import { create } from 'zustand';
import { db } from '@/db/db';
import type { Order, Position, Side } from '@/types';

/**
 * 모의 트레이딩 상태 (Zustand + IndexedDB 영속).
 * 스토어는 메모리 캐시이고, 모든 변경은 Dexie 에도 기록해 새로고침에도 유지한다.
 */
interface TradingState {
  accountId: string | null;
  balance: number;
  positions: Position[];
  orders: Order[];

  hydrate: () => Promise<void>;
  openMarket: (params: {
    symbol: string;
    side: Side;
    price: number;
    size: number;
    leverage: number;
  }) => Promise<void>;
  closePosition: (id: string, markPrice: number) => Promise<void>;
}

export const useTradingStore = create<TradingState>((set, get) => ({
  accountId: null,
  balance: 0,
  positions: [],
  orders: [],

  // IndexedDB 에서 초기 상태 로드
  hydrate: async () => {
    const account = await db.accounts.orderBy('createdAt').first();
    const positions = await db.positions.toArray();
    const orders = await db.orders.toArray();
    set({
      accountId: account?.id ?? null,
      balance: account?.balance ?? 0,
      positions,
      orders,
    });
  },

  // 시장가 진입 (단순화: 즉시 체결 + 포지션 생성)
  openMarket: async ({ symbol, side, price, size, leverage }) => {
    const { accountId } = get();
    if (!accountId) return;

    const now = Date.now();
    const order: Order = {
      id: crypto.randomUUID(),
      symbol,
      side,
      price,
      size,
      leverage,
      status: 'filled',
      createdAt: now,
    };
    const position: Position = {
      id: crypto.randomUUID(),
      symbol,
      side,
      entryPrice: price,
      size,
      leverage,
      openedAt: now,
    };

    // 증거금 차감 (명목가 / 레버리지)
    const margin = (price * size) / leverage;
    const newBalance = get().balance - margin;

    await db.transaction('rw', db.orders, db.positions, db.accounts, async () => {
      await db.orders.add(order);
      await db.positions.add(position);
      await db.accounts.update(accountId, { balance: newBalance });
    });

    set({
      orders: [...get().orders, order],
      positions: [...get().positions, position],
      balance: newBalance,
    });
  },

  // 포지션 청산 → 손익 정산 후 잔고 반영
  closePosition: async (id, markPrice) => {
    const { accountId, positions } = get();
    if (!accountId) return;
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;

    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (markPrice - pos.entryPrice) * pos.size * dir;
    const margin = (pos.entryPrice * pos.size) / pos.leverage;
    const newBalance = get().balance + margin + pnl;

    await db.transaction('rw', db.positions, db.accounts, async () => {
      await db.positions.delete(id);
      await db.accounts.update(accountId, { balance: newBalance });
    });

    set({
      positions: positions.filter((p) => p.id !== id),
      balance: newBalance,
    });
  },
}));
