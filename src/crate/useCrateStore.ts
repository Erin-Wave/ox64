import { create } from 'zustand';
import {
  crateApi,
  CrateApiError,
  type CatInfo,
  type CrateState,
  type JackpotTier,
  type MatCat,
  type OddsRow,
  type RewardItem,
  type ShopCrate,
} from './api';

export interface Toast {
  kind: 'good' | 'bad' | 'jackpot';
  text: string;
}

/**
 * 지금 무대에 떠 있는 개봉 결과.
 * ⚠ 여러 개를 깔 때 상자별로 한 묶음씩 차례로 보여주면 10연차가 10초짜리 고문이 된다 — 그래서
 * 같은 보상끼리 **합산해서 한 번에** 띄우고(`items`), 상자별 원본은 잭팟 판정에만 쓴다.
 */
export interface OpenSession {
  level: number;
  count: number;
  /** 같은 (종류·재료·레벨)끼리 합산한 결과 — 화면에 뜨는 카드 목록 */
  items: RewardItem[];
  jackpot: JackpotTier | null;
  /** 이번 개봉으로 새로 도감에 등록된 재료 키 */
  discovered: string[];
}

/** 상자별 결과를 카드 목록으로 합산 — 10연에서 카드 40장이 쏟아지는 걸 막는다. */
function aggregate(results: RewardItem[][]): RewardItem[] {
  const map = new Map<string, RewardItem>();
  const order: string[] = [];
  for (const rewards of results)
    for (const r of rewards) {
      const key = `${r.kind}:${r.cat ?? ''}:${r.level}:${r.jackpot ?? ''}`;
      const found = map.get(key);
      if (found) found.count += r.count;
      else {
        map.set(key, { ...r });
        order.push(key);
      }
    }
  // 잭팟 먼저, 그다음 코인 → 상자 → 재료(레벨 높은 순)로 — 눈이 제일 중요한 것부터 읽게
  const rank = (r: RewardItem) => (r.jackpot ? 0 : r.kind === 'crate' ? 1 : r.kind === 'coin' ? 2 : 3);
  return order
    .map((k) => map.get(k)!)
    .sort((a, b) => rank(a) - rank(b) || b.level - a.level);
}

interface Store {
  ready: boolean;
  authed: boolean;
  name: string | null;

  coins: number;
  inv: Record<string, number>;
  crates: Record<string, number>;
  seen: string[];
  invValue: number;
  netWorth: number;
  stats: CrateState['stats'];
  refillsLeft: number;
  broke: boolean;
  mergeMult: number;
  cats: CatInfo[];
  shop: ShopCrate[];
  shardOdds: { level: number; p: number }[];
  jackpotTiers: CrateState['jackpotTiers'];
  limits: CrateState['limits'];

  busy: boolean;
  error: string | null;
  toast: Toast | null;
  session: OpenSession | null;
  /** 머지 애니메이션 대상 키("wood:2") — 잠깐 반짝였다 꺼진다 */
  flash: string | null;

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  buy: (level: number, count: number) => Promise<void>;
  open: (level: number, count: number) => Promise<void>;
  merge: (cat: MatCat, level: number, times?: number) => Promise<void>;
  mergeAll: () => Promise<void>;
  sell: (cat: MatCat, level: number, count?: number) => Promise<void>;
  sellAll: (maxLevel: number) => Promise<void>;
  refill: () => Promise<void>;
  closeSession: () => void;
  dismissToast: () => void;
  clearError: () => void;
}

function msgOf(e: unknown, fallback: string): string {
  return e instanceof CrateApiError ? e.message : fallback;
}

const EMPTY_STATS: CrateState['stats'] = { opened: 0, merged: 0, spent: 0, earned: 0, bestCoins: 0, jackpots: 0 };

/** 서버 응답에서 상태 필드만 뽑아 스토어에 반영한다(액션별 추가 필드는 각 액션이 따로 처리). */
function pick(s: CrateState) {
  return {
    coins: s.coins,
    inv: s.inv,
    crates: s.crates,
    seen: s.seen,
    invValue: s.invValue,
    netWorth: s.netWorth,
    stats: s.stats,
    refillsLeft: s.refillsLeft,
    broke: s.broke,
    mergeMult: s.mergeMult,
    cats: s.cats,
    shop: s.shop,
    shardOdds: s.shardOdds,
    jackpotTiers: s.jackpotTiers,
    limits: s.limits,
  };
}

export const useCrateStore = create<Store>((set, get) => ({
  ready: false,
  authed: false,
  name: null,
  coins: 0,
  inv: {},
  crates: {},
  seen: [],
  invValue: 0,
  netWorth: 0,
  stats: EMPTY_STATS,
  refillsLeft: 0,
  broke: false,
  mergeMult: 2.35,
  cats: [],
  shop: [],
  shardOdds: [],
  jackpotTiers: [],
  limits: { maxBuy: 20, maxOpen: 10, refillAmount: 250 },
  busy: false,
  error: null,
  toast: null,
  session: null,
  flash: null,

  init: async () => {
    try {
      const s = await crateApi.state();
      set({ ...pick(s), authed: true, ready: true });
    } catch {
      set({ authed: false, ready: true });
    }
  },

  login: async (name, passcode) => {
    set({ busy: true, error: null });
    try {
      await crateApi.login(name, passcode);
      const s = await crateApi.state();
      set({ ...pick(s), authed: true, name, busy: false });
    } catch (e) {
      set({ busy: false, error: msgOf(e, '로그인에 실패했습니다') });
    }
  },

  logout: async () => {
    await crateApi.logout().catch(() => {});
    set({ authed: false, name: null, session: null });
  },

  buy: async (level, count) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.buy(level, count);
      set({ ...pick(r), toast: { kind: 'good', text: `${r.bought.count}개 구매 · -${r.bought.cost.toLocaleString()} G` } });
    } catch (e) {
      set({ error: msgOf(e, '구매하지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  open: async (level, count) => {
    if (get().busy) return;
    const before = new Set(get().seen);
    set({ busy: true, error: null });
    try {
      const r = await crateApi.open(level, count);
      // 이번 개봉에 잭팟이 하나라도 있으면 무대 전체가 반응한다(가장 높은 등급 기준).
      const order: JackpotTier[] = ['lucky', 'mega', 'legend'];
      let best: JackpotTier | null = null;
      for (const rewards of r.opened.results)
        for (const item of rewards)
          if (item.jackpot && (best === null || order.indexOf(item.jackpot) > order.indexOf(best))) best = item.jackpot;
      set({
        ...pick(r),
        session: {
          level,
          count,
          items: aggregate(r.opened.results),
          jackpot: best,
          discovered: r.seen.filter((k) => !before.has(k)),
        },
        toast: best ? { kind: 'jackpot', text: '잭팟!' } : null,
      });
    } catch (e) {
      set({ error: msgOf(e, '열지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  merge: async (cat, level, times = 1) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.merge(cat, level, times);
      if (r.shardCrates?.length) {
        const names = r.shardCrates.map((lv) => `Lv${lv}`).join(', ');
        set({ ...pick(r), toast: { kind: 'good', text: `상자조각이 상자로! (${names})` }, flash: null });
      } else if (r.merged) {
        set({ ...pick(r), flash: `${cat}:${r.merged.to}`, toast: null });
        setTimeout(() => set((s) => (s.flash === `${cat}:${r.merged!.to}` ? { flash: null } : s)), 650);
      } else {
        set({ ...pick(r) });
      }
    } catch (e) {
      set({ error: msgOf(e, '합치지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  mergeAll: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.mergeAll();
      set({ ...pick(r), toast: { kind: 'good', text: `${r.mergedAll}번 합쳤습니다` } });
    } catch (e) {
      set({ error: msgOf(e, '합치지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  sell: async (cat, level, count) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.sell(cat, level, count);
      set({ ...pick(r), toast: { kind: 'good', text: `+${r.sold.gain.toLocaleString()} G` } });
    } catch (e) {
      set({ error: msgOf(e, '팔지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  sellAll: async (maxLevel) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.sellAll(maxLevel);
      set({ ...pick(r), toast: { kind: 'good', text: `${r.sold.count}개 판매 · +${r.sold.gain.toLocaleString()} G` } });
    } catch (e) {
      set({ error: msgOf(e, '팔지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  refill: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.refill();
      set({ ...pick(r), toast: { kind: 'good', text: '지원금을 받았습니다' } });
    } catch (e) {
      set({ error: msgOf(e, '지원받지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  closeSession: () => set({ session: null }),
  dismissToast: () => set({ toast: null }),
  clearError: () => set({ error: null }),
}));

/** 표시용 파생값 — 컴포넌트마다 다시 계산하지 않도록 한곳에 둔다. */
export function oddsLabel(o: OddsRow, cats: CatInfo[], shop: ShopCrate[]): string {
  const range = o.min === o.max ? `${o.min}개` : `${o.min}~${o.max}개`;
  if (o.kind === 'coin') return o.min === o.max ? `${o.min.toLocaleString()} G` : `${o.min.toLocaleString()}~${o.max.toLocaleString()} G`;
  if (o.kind === 'crate') return `${shop.find((c) => c.level === o.level)?.name ?? `Lv${o.level} 상자`} ${range}`;
  const cat = cats.find((c) => c.cat === o.cat);
  return `${cat?.emoji ?? ''} Lv${o.level} ${cat?.name ?? ''} ${range}`;
}
