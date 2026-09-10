// ox64.app/c — "상자깡" 클라이언트. 코인 트레이딩(src/services/api.ts)·퍼즐·던전과 완전히 분리된
// 별도 번들이다(재화가 다르고 이 페이지는 트레이딩 상태를 로드할 필요가 없다). 로그인 세션 쿠키
// (ox64_sess)만 /api/login 을 통해 공유한다 — 같은 계정으로 트레이딩·미니게임을 오간다.
//
// ⚠ 드롭 확률·재료 가치·상자 가격은 **전부 서버가 내려주는 값을 그대로 쓴다**(cats/shop/shardOdds).
// 클라에 같은 표를 또 적으면 서버 밸런스를 고칠 때 조용히 어긋나고, 보상은 서버가 주므로 화면만
// 틀리게 된다(트레이딩의 VIP 등급표와 같은 이유).

export type MatCat = 'herb' | 'wood' | 'ore' | 'cloth' | 'gem' | 'essence' | 'lotto' | 'shard';
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
  /** 팔 수 없는 재료(골드복권) */
  noSell?: boolean;
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
  /** 오늘 실제로 내는 값(할인 반영) */
  price: number;
  /** 할인 전 원가 */
  listPrice: number;
  desc: string;
  odds: OddsRow[];
}

export type BonusTier = 'mega' | 'triple' | 'double' | 'extra';
export interface BonusInfo {
  tier: BonusTier;
  p: number;
  mult: number;
  extra: number;
  label: string;
  emoji: string;
  color: string;
}
export interface MilestoneInfo {
  every: number;
  level: number;
  count: number;
  label: string;
  /** 다음 보상까지 얼마나 왔는지(누적 개봉 % every) */
  progress: number;
}
export interface AchievementInfo {
  key: string;
  label: string;
  desc: string;
  coins: number;
  crates: [number, number] | null;
  stat: 'opened' | 'merged' | 'jackpots' | 'seen' | 'bestCoins' | 'earned';
  at: number;
  done: boolean;
}
/** 방금 달성해서 지급된 업적 */
export interface AchievedNow {
  key: string;
  label: string;
  desc: string;
  coins: number;
  crates?: [number, number];
}

export interface DailyEventInfo {
  key: string;
  day: number;
  label: string;
  emoji: string;
  desc: string;
  coinMult: number;
  matMult: number;
  shardMult: number;
  bonusMult: number;
  jackpotMult: number;
  discount: number;
  bulkAlways: boolean;
  /** 서버가 판정한 KST 날짜 */
  today: string;
}

/** 골드복권 한 장의 결과 */
export interface LottoResult {
  mult: number;
  gold: number;
  tier: number;
  label: string;
  color: string;
}
export interface ScratchResult extends CrateState {
  scratched: { level: number; count: number; gold: number; results: LottoResult[] };
  achieved?: AchievedNow[];
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
  /** 오늘 일일 지원을 아직 안 받았나(조건 없이 하루 한 번) */
  dailyReady: boolean;
  /** 남은 파산 구제 횟수 */
  rescueLeft: number;
  broke: boolean;
  mergeMult: number;
  cats: CatInfo[];
  shop: ShopCrate[];
  shardOdds: { level: number; p: number }[];
  jackpotTiers: { tier: JackpotTier; p: number; mult: number; label: string }[];
  event: DailyEventInfo;
  eventWeek: { day: number; key: string; emoji: string; label: string; desc: string }[];
  lotto: {
    tiers: { p: number; min: number; max: number; label: string; color: string }[];
    expected: number;
    maxAtOnce: number;
  };
  bonusTiers: BonusInfo[];
  milestones: MilestoneInfo[];
  achievements: AchievementInfo[];
  limits: { maxBuy: number; maxOpen: number; dailyCrates: number; dailyCoins: number; rescueCrates: number; rescueCoins: number; brokeCrates: number; bulkAt: number; bulkChance: number; maxMergeTimes: number };
}

export interface OpenResult extends CrateState {
  opened: {
    level: number;
    count: number;
    /** 대량 개봉 보너스로 공짜로 더 깐 상자 수 */
    bulk: number;
    results: RewardItem[][];
    /** 상자별로 터진 보너스 등급(없으면 null) */
    bonuses: (BonusTier | null)[];
    /** 이번 개봉으로 넘어선 마일스톤들 */
    milestones: { level: number; count: number; label: string; at: number }[];
    /** 이 개봉에 적용된 이벤트 키 */
    event: string;
  };
  achieved: AchievedNow[];
}
export interface BuyResult extends CrateState {
  bought: { level: number; count: number; cost: number };
}
export interface MergeResult extends CrateState {
  achieved?: AchievedNow[];
  merged?: { cat: MatCat; from: number; to: number; times: number };
  shardCrates?: number[];
  /** 상자조각 일괄 개봉 요약 — {times, byLevel:{"1":3,"2":1}} */
  shardSummary?: { times: number; byLevel: Record<string, number> };
  mergedAll?: number;
}
export interface GrantResult extends CrateState {
  achieved?: AchievedNow[];
  granted: { kind: 'daily' | 'rescue'; crates: number; coins: number };
}
export interface SellResult extends CrateState {
  achieved?: AchievedNow[];
  sold: { cat: MatCat | null; level: number; count: number; gain: number };
}

/** 랭킹 한 줄 — 소지 골드와 총자산(재료·상자를 값으로 환산)을 둘 다 준다. */
export interface BoardEntry {
  name: string;
  me: boolean;
  coins: number;
  netWorth: number;
  opened: number;
  merged: number;
  jackpots: number;
  bestCoins: number;
}
export interface BoardResult {
  entries: BoardEntry[];
  updatedAt: number;
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
  board: () => req<BoardResult>('/crate?board=1'),
  buy: (level: number, count: number) => post<BuyResult>({ action: 'buy', level, count }),
  open: (level: number, count: number) => post<OpenResult>({ action: 'open', level, count }),
  merge: (cat: MatCat, level: number, times = 1) => post<MergeResult>({ action: 'merge', cat, level, times }),
  mergeAll: () => post<MergeResult>({ action: 'mergeAll' }),
  sell: (cat: MatCat, level: number, count?: number) => post<SellResult>({ action: 'sell', cat, level, count }),
  sellAll: (maxLevel: number) => post<SellResult>({ action: 'sellAll', maxLevel }),
  scratch: (level: number, count: number) => post<ScratchResult>({ action: 'scratch', level, count }),
  refill: () => post<GrantResult>({ action: 'refill' }),
};
