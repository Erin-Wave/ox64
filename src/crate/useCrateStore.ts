import { create } from 'zustand';
import {
  crateApi,
  CrateApiError,
  type AchievedNow,
  type AchievementInfo,
  type BonusInfo,
  type BonusTier,
  type CatInfo,
  type DailyEventInfo,
  type LottoResult,
  type MilestoneInfo,
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
  /** 대량 개봉 보너스로 공짜로 더 깐 상자 수 */
  bulk: number;
  /** 이번 개봉에서 터진 보너스 등급들(같은 등급은 묶어 개수로) */
  bonusCounts: { tier: BonusTier; n: number }[];
  /** 넘어선 마일스톤 */
  milestones: { level: number; count: number; label: string; at: number }[];
  /** 같은 (종류·재료·레벨)끼리 합산한 결과 — 화면에 뜨는 카드 목록 */
  items: RewardItem[];
  jackpot: JackpotTier | null;
  /** 이번 개봉으로 새로 도감에 등록된 재료 키 */
  discovered: string[];
}

/** 터진 보너스를 등급별로 센다 — 10연에서 "✨×3 🔥×1" 처럼 한 줄로 보여주기 위해. */
function countBonuses(list: (BonusTier | null)[]): { tier: BonusTier; n: number }[] {
  const order: BonusTier[] = ['mega', 'triple', 'double', 'extra'];
  const map = new Map<BonusTier, number>();
  for (const t of list) if (t) map.set(t, (map.get(t) ?? 0) + 1);
  return order.filter((t) => map.has(t)).map((t) => ({ tier: t, n: map.get(t)! }));
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
  dailyReady: boolean;
  rescueLeft: number;
  broke: boolean;
  mergeMult: number;
  cats: CatInfo[];
  shop: ShopCrate[];
  shardOdds: { level: number; p: number }[];
  jackpotTiers: CrateState['jackpotTiers'];
  event: DailyEventInfo | null;
  eventWeek: CrateState['eventWeek'];
  lotto: CrateState['lotto'];
  bonusTiers: BonusInfo[];
  milestones: MilestoneInfo[];
  achievements: AchievementInfo[];
  limits: CrateState['limits'];

  busy: boolean;
  error: string | null;
  toast: Toast | null;
  session: OpenSession | null;
  /** 머지 애니메이션 대상 키("wood:2") — 잠깐 반짝였다 꺼진다 */
  flash: string | null;
  /** 방금 달성한 업적들 — 한 번에 여러 개가 터질 수 있어 큐로 하나씩 띄운다 */
  achieveQueue: AchievedNow[];
  /** 방금 긁은 복권 결과 — 무대에 띄웠다가 닫는다 */
  scratchResult: { count: number; gold: number; results: LottoResult[] } | null;

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
  popAchievement: () => void;
  scratch: (level: number, count: number) => Promise<void>;
  closeScratch: () => void;
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
    dailyReady: s.dailyReady,
    rescueLeft: s.rescueLeft,
    broke: s.broke,
    mergeMult: s.mergeMult,
    cats: s.cats,
    shop: s.shop,
    shardOdds: s.shardOdds,
    jackpotTiers: s.jackpotTiers,
    event: s.event,
    eventWeek: s.eventWeek,
    lotto: s.lotto,
    bonusTiers: s.bonusTiers,
    milestones: s.milestones,
    achievements: s.achievements,
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
  dailyReady: false,
  rescueLeft: 0,
  broke: false,
  mergeMult: 2.35,
  cats: [],
  shop: [],
  shardOdds: [],
  jackpotTiers: [],
  event: null,
  eventWeek: [],
  lotto: { tiers: [], expected: 2.57, maxAtOnce: 20 },
  bonusTiers: [],
  milestones: [],
  achievements: [],
  limits: { maxBuy: 20, maxOpen: 10, dailyCrates: 4, dailyCoins: 200, rescueCrates: 3, rescueCoins: 400, brokeCrates: 3, bulkAt: 10, bulkChance: 0.22, maxMergeTimes: 200 },
  busy: false,
  error: null,
  toast: null,
  session: null,
  flash: null,
  achieveQueue: [],
  scratchResult: null,

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
          bulk: r.opened.bulk,
          bonusCounts: countBonuses(r.opened.bonuses),
          milestones: r.opened.milestones,
          items: aggregate(r.opened.results),
          jackpot: best,
          discovered: r.seen.filter((k) => !before.has(k)),
        },
        toast: best ? { kind: 'jackpot', text: '잭팟!' } : null,
        achieveQueue: r.achieved ?? [],
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
        // ⚠ 레벨을 그대로 나열하면 200개를 열었을 때 "Lv1, Lv1, Lv1, …" 이 화면을 덮는다.
        // 서버가 준 레벨별 집계를 쓰고, 없으면(옛 응답) 직접 센다.
        const byLevel = r.shardSummary?.byLevel ?? r.shardCrates.reduce<Record<string, number>>((m, lv) => {
          m[lv] = (m[lv] ?? 0) + 1;
          return m;
        }, {});
        const names = Object.entries(byLevel)
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([lv, n]) => `Lv${lv}×${n}`)
          .join(' · ');
        set({
          ...pick(r),
          toast: { kind: 'good', text: `🧩 조각 ${r.shardCrates.length}회 → ${names}` },
          flash: null,
          achieveQueue: r.achieved ?? [],
        });
      } else if (r.merged) {
        set({ ...pick(r), flash: `${cat}:${r.merged.to}`, toast: null, achieveQueue: r.achieved ?? [] });
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
      set({ ...pick(r), toast: { kind: 'good', text: `${r.mergedAll}번 합쳤습니다` } , achieveQueue: r.achieved ?? [] });
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
      set({ ...pick(r), toast: { kind: 'good', text: `+${r.sold.gain.toLocaleString()} G` } , achieveQueue: r.achieved ?? [] });
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
      set({ ...pick(r), toast: { kind: 'good', text: `${r.sold.count}개 판매 · +${r.sold.gain.toLocaleString()} G` } , achieveQueue: r.achieved ?? [] });
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
      const g = r.granted;
      set({
        ...pick(r),
        toast: {
          kind: 'good',
          text: `${g.kind === 'daily' ? '오늘의 지원' : '구제 물자'} · 상자 ${g.crates}개 + ${g.coins.toLocaleString()} G`,
        },
        achieveQueue: r.achieved ?? [],
      });
    } catch (e) {
      set({ error: msgOf(e, '지원받지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  closeSession: () => set({ session: null }),
  popAchievement: () => set((s) => ({ achieveQueue: s.achieveQueue.slice(1) })),

  scratch: async (level, count) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const r = await crateApi.scratch(level, count);
      const best = r.scratched.results.reduce((m, x) => (x.mult > m.mult ? x : m), r.scratched.results[0]);
      set({
        ...pick(r),
        scratchResult: r.scratched,
        achieveQueue: r.achieved ?? [],
        // 큰 게 터졌을 때만 토스트 — 꽝까지 매번 띄우면 시끄럽다
        toast: best && best.mult >= 8 ? { kind: 'jackpot', text: `🎫 ${best.label}! +${best.gold.toLocaleString()} G` } : null,
      });
    } catch (e) {
      set({ error: msgOf(e, '긁지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },
  closeScratch: () => set({ scratchResult: null }),
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
