// ox64.app/c — "상자깡" 클라이언트. 코인 트레이딩(src/services/api.ts)·퍼즐·던전과 완전히 분리된
// 별도 번들이다(재화가 다르고 이 페이지는 트레이딩 상태를 로드할 필요가 없다). 로그인 세션 쿠키
// (ox64_sess)만 /api/login 을 통해 공유한다 — 같은 계정으로 트레이딩·미니게임을 오간다.
//
// ⚠ 드롭 확률·재료 가치·상자 가격은 **전부 서버가 내려주는 값을 그대로 쓴다**(cats/shop/shardOdds).
// 클라에 같은 표를 또 적으면 서버 밸런스를 고칠 때 조용히 어긋나고, 보상은 서버가 주므로 화면만
// 틀리게 된다(트레이딩의 VIP 등급표와 같은 이유).

export type MatCat = 'wood' | 'ore' | 'gem' | 'essence' | 'shard';
export type JackpotTier = 'lucky' | 'mega' | 'legend';

export interface RewardItem {
  kind: 'coin' | 'mat' | 'crate';
  cat?: MatCat;
  level: number;
  count: number;
  jackpot?: JackpotTier;
}

export interface CatInfo {
  cat: MatCat;
  name: string;
  emoji: string;
  color: string;
  maxLevel: number;
  desc: string;
  /** 레벨별 판매가 — values[0] 이 Lv1 */
  values: number[];
}

export interface OddsRow {
  p: number;
  jackpot: JackpotTier | null;
  kind: 'coin' | 'mat' | 'crate';
  cat: MatCat | null;
  level: number;
  min: number;
  max: number;
}
export interface ShopCrate {
  level: number;
  name: string;
  emoji: string;
  price: number;
  desc: string;
  odds: OddsRow[];
}

export interface CrateState {
  coins: number;
  /** {"wood:1": 37, …} */
  inv: Record<string, number>;
  /** {"1": 3, "2": 0, …} */
  crates: Record<string, number>;
  seen: string[];
  invValue: number;
  netWorth: number;
  stats: { opened: number; merged: number; spent: number; earned: number; bestCoins: number; jackpots: number };
  refillsLeft: number;
  broke: boolean;
  mergeMult: number;
  cats: CatInfo[];
  shop: ShopCrate[];
  shardOdds: { level: number; p: number }[];
  jackpotTiers: { tier: JackpotTier; p: number; mult: number; label: string }[];
  limits: { maxBuy: number; maxOpen: number; refillAmount: number };
}

export interface OpenResult extends CrateState {
  opened: { level: number; count: number; results: RewardItem[][] };
}
export interface BuyResult extends CrateState {
  bought: { level: number; count: number; cost: number };
}
export interface MergeResult extends CrateState {
  merged?: { cat: MatCat; from: number; to: number; times: number };
  shardCrates?: number[];
  mergedAll?: number;
}
export interface SellResult extends CrateState {
  sold: { cat: MatCat | null; level: number; count: number; gain: number };
}

export class CrateApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CrateApiError';
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
  if (!res.ok) throw new CrateApiError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}
const post = <T>(body: Record<string, unknown>) => req<T>('/crate', { method: 'POST', body: JSON.stringify(body) });

export const crateApi = {
  login: (name: string, passcode: string) => req<{ name: string }>('/login', { method: 'POST', body: JSON.stringify({ name, passcode }) }),
  logout: () => req<{ ok: boolean }>('/logout', { method: 'POST' }),
  state: () => req<CrateState>('/crate'),
  buy: (level: number, count: number) => post<BuyResult>({ action: 'buy', level, count }),
  open: (level: number, count: number) => post<OpenResult>({ action: 'open', level, count }),
  merge: (cat: MatCat, level: number, times = 1) => post<MergeResult>({ action: 'merge', cat, level, times }),
  mergeAll: () => post<MergeResult>({ action: 'mergeAll' }),
  sell: (cat: MatCat, level: number, count?: number) => post<SellResult>({ action: 'sell', cat, level, count }),
  sellAll: (maxLevel: number) => post<SellResult>({ action: 'sellAll', maxLevel }),
  refill: () => post<CrateState>({ action: 'refill' }),
};
