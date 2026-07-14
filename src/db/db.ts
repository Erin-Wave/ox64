import Dexie, { type EntityTable } from 'dexie';
import type { Account, Order, Position } from '@/types';

/**
 * IndexedDB (Dexie) — 서버가 없는 Cloudflare Pages 환경에서
 * 모의 자산/주문/포지션을 브라우저 로컬 DB 에 영속한다.
 */
export const db = new Dexie('ox64') as Dexie & {
  accounts: EntityTable<Account, 'id'>;
  orders: EntityTable<Order, 'id'>;
  positions: EntityTable<Position, 'id'>;
};

// 스키마 v1 — 인덱싱할 필드만 나열 (전체 객체는 그대로 저장됨)
db.version(1).stores({
  accounts: 'id, name, createdAt',
  orders: 'id, symbol, status, createdAt',
  positions: 'id, symbol, side, openedAt',
});

// 개발/디버그 편의: 브라우저 콘솔에서 `db.accounts.toArray()` 등으로 직접 조회·수정.
// (모든 데이터가 그 브라우저 로컬에만 있으므로 노출해도 보안 이슈 없음.)
if (typeof window !== 'undefined') {
  (window as unknown as { db: typeof db }).db = db;
}

/** 최초 실행 시 기본 계정 시드 */
export async function ensureSeed(): Promise<void> {
  const count = await db.accounts.count();
  if (count > 0) return;
  await db.accounts.add({
    id: crypto.randomUUID(),
    name: 'Me',
    balance: 10_000, // 모의 USDT 1만
    createdAt: Date.now(),
  });
}
