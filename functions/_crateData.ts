/**
 * "상자깡"(ox64.app/c) 콘텐츠 정의 + 순수 로직 — D1 I/O 가 전혀 없다.
 * `_dungeonData.ts`/`_dungeonEngine.ts` 와 같은 "데이터·로직은 순수 함수로 분리" 패턴이라
 * `scripts/sim-crate.ts` 가 이 파일만 import 해서 밸런스를 수십만 번 시뮬레이션할 수 있다.
 * ⚠ 확률·가격·가치를 손댔으면 반드시 `npm run sim:crate` 로 회수율을 다시 잴 것.
 */

// ── 재료 ────────────────────────────────────────────────────────────────────────
// 카테고리는 머지해도 절대 안 바뀌고 레벨만 오른다(요구사항). 같은 카테고리·같은 레벨 2개 → 다음 레벨 1개.
// 가치는 레벨당 MERGE_MULT 배 — 2개(=2배)를 1개로 합치는데 가치가 2.35배가 되므로 개당 1.175배씩
// 이득이다. 이 "머지 프리미엄"이 이 게임의 유일한 성장 동력이고, 상자 기대 회수율을 원가 아래로
// 잡아둔 이유이기도 하다(상자만 까서 다 팔면 적자, 끝까지 머지해서 팔아야 흑자 = § 밸런스).
export const MERGE_MULT = 2.35;

export type MatCat = 'wood' | 'ore' | 'gem' | 'essence' | 'shard';

export interface CatDef {
  cat: MatCat;
  name: string;
  emoji: string;
  color: string;
  /** Lv1 판매가 */
  base: number;
  /** 이 카테고리의 최고 레벨(여기서 더는 못 합친다 — shard 만 예외로 Lv4 2개가 상자가 된다) */
  maxLevel: number;
  /** 표시용 한 줄 설명 */
  desc: string;
}

export const CATS: CatDef[] = [
  { cat: 'wood', name: '목재', emoji: '🪵', color: '#b0803a', base: 6, maxLevel: 6, desc: '가장 흔한 기본 재료' },
  { cat: 'ore', name: '광석', emoji: '⛏️', color: '#8aa4b8', base: 15, maxLevel: 6, desc: '단단한 중급 재료' },
  { cat: 'gem', name: '보석', emoji: '💎', color: '#38bdf8', base: 40, maxLevel: 6, desc: '값나가는 고급 재료' },
  { cat: 'essence', name: '정수', emoji: '🔮', color: '#a78bfa', base: 90, maxLevel: 6, desc: '희귀한 최고급 재료' },
  {
    cat: 'shard',
    name: '상자조각',
    emoji: '🧩',
    color: '#fbbf24',
    base: 10,
    maxLevel: 4,
    desc: 'Lv4 2개를 합치면 상자가 하나 나온다',
  },
];
export const CAT_BY_KEY = new Map<string, CatDef>(CATS.map((c) => [c.cat, c]));

/** 재료 1개 판매가 — base × MERGE_MULT^(레벨-1) */
export function matValue(cat: MatCat, level: number): number {
  const def = CAT_BY_KEY.get(cat);
  if (!def) return 0;
  return Math.round(def.base * Math.pow(MERGE_MULT, level - 1));
}

export function isValidMat(cat: string, level: number): boolean {
  const def = CAT_BY_KEY.get(cat);
  return !!def && Number.isInteger(level) && level >= 1 && level <= def.maxLevel;
}

/** 인벤토리 키 — 인벤토리 전체가 {"wood:1": 37, …} 맵 한 칸이라 D1 쓰기가 항상 상태 행 1행이다(§6). */
export const invKey = (cat: MatCat, level: number) => `${cat}:${level}`;
export function parseInvKey(key: string): { cat: MatCat; level: number } | null {
  const [cat, lv] = key.split(':');
  const level = Number(lv);
  if (!isValidMat(cat, level)) return null;
  return { cat: cat as MatCat, level };
}

// ── 상자 ────────────────────────────────────────────────────────────────────────
export type Drop =
  | { kind: 'coin'; min: number; max: number }
  | { kind: 'mat'; cat: MatCat; level: number; min: number; max: number }
  | { kind: 'crate'; level: number; min: number; max: number };

/** 슬롯 하나 = 독립시행 하나. 한 상자에서 여러 슬롯이 동시에 터질 수 있다(요구사항). */
export interface Slot {
  p: number;
  drop: Drop;
  /** 극한 확률 잭팟 — UI 가 별도 연출(황금 카드·전체 화면 플래시)로 띄운다. */
  jackpot?: JackpotTier;
}

/** 잭팟 등급 — 위로 갈수록 확률이 자릿수로 낮아지고 보상은 자릿수로 커진다. */
export type JackpotTier = 'lucky' | 'mega' | 'legend';

export interface CrateDef {
  level: number;
  name: string;
  emoji: string;
  price: number;
  desc: string;
  slots: Slot[];
}

const coin = (min: number, max: number): Drop => ({ kind: 'coin', min, max });
const mat = (cat: MatCat, level: number, min = 1, max = min): Drop => ({ kind: 'mat', cat, level, min, max });
const crate = (level: number, min = 1, max = min): Drop => ({ kind: 'crate', level, min, max });

/**
 * ⚠⚠ 극한 확률 잭팟(모든 상자 공통). 배수는 **그 상자의 가격 기준**이라 Lv3 상자(2,000)에서
 * legend 가 터지면 300만 골드다. 확률이 자릿수로 낮아 **기대 회수율에는 거의 영향이 없으면서**
 * (총 기여 = 가격의 약 3.4%) "언젠가 한 번은 터진다"는 도박성만 얹는 게 목적이다.
 * ⚠ 여기 숫자를 키울 땐 `p × mult` 합계가 0.05(=가격의 5%)를 넘지 않게 할 것 — 넘으면 잭팟이
 * 밸런스의 주인이 되어 "많이 까는 사람이 확률적으로 무조건 이기는" 인플레 경로가 된다.
 */
export const JACKPOTS: { tier: JackpotTier; p: number; mult: number; label: string }[] = [
  { tier: 'lucky', p: 1 / 2_000, mult: 25, label: '행운의 상자' },
  { tier: 'mega', p: 1 / 25_000, mult: 150, label: '초대박' },
  { tier: 'legend', p: 1 / 250_000, mult: 1500, label: '전설' },
];

/**
 * 재료 잭팟 — 코인 대신 최고급 재료를 통째로 준다(Lv1 상자에서 나오면 65배).
 * 코인 잭팟과 달리 **바로 쓸 수 있는 돈이 아니라 팔거나 더 굴릴 수 있는 물건**이라 체감이 다르다.
 */
export const MAT_JACKPOT: Slot = { p: 1 / 8_000, drop: mat('essence', 6), jackpot: 'mega' };

/**
 * ⚠ 밸런스의 진실원본. 목표는 "상자 1개당":
 *   · 머지 없이 전부 즉시 판매(naive) → 원가의 ~70% (적자)
 *   · 최고 레벨까지 머지 후 판매(optimal) → 원가의 ~110% (흑자)
 * 즉 **돈은 상자가 아니라 머지가 번다**. 이래야 상자만 까는 것으로는 인플레가 안 일어난다.
 * 실측은 `npm run sim:crate` 로 확인하고 이 표만 고쳐 조정할 것.
 */
export const CRATES: CrateDef[] = [
  {
    level: 1,
    name: 'Lv1 상자',
    emoji: '📦',
    price: 100,
    desc: '가벼운 나무 상자. 목재와 광석이 주로 나온다.',
    slots: [
      { p: 0.72, drop: coin(25, 48) },
      { p: 0.85, drop: mat('wood', 1, 1, 2) },
      { p: 0.45, drop: mat('wood', 2) },
      { p: 0.28, drop: mat('ore', 1, 1, 2) },
      { p: 0.26, drop: mat('ore', 2) },
      { p: 0.06, drop: mat('gem', 1) },
      { p: 0.02, drop: mat('essence', 1) },
      { p: 0.2, drop: mat('shard', 1) },
      { p: 0.06, drop: mat('shard', 2) },
      { p: 0.035, drop: crate(1) },
      { p: 0.004, drop: crate(2), jackpot: 'lucky' },
    ],
  },
  {
    level: 2,
    name: 'Lv2 상자',
    emoji: '🎁',
    price: 450,
    desc: '단단히 잠긴 철제 상자. 보석과 상자조각이 늘어난다.',
    slots: [
      { p: 0.7, drop: coin(100, 240) },
      { p: 0.85, drop: mat('wood', 2, 1, 3) },
      { p: 0.6, drop: mat('ore', 2, 1, 2) },
      { p: 0.3, drop: mat('ore', 3) },
      { p: 0.55, drop: mat('gem', 1, 1, 2) },
      { p: 0.2, drop: mat('gem', 2) },
      { p: 0.14, drop: mat('essence', 1) },
      { p: 0.04, drop: mat('essence', 2) },
      { p: 0.45, drop: mat('shard', 2) },
      { p: 0.2, drop: mat('shard', 1, 1, 2) },
      { p: 0.22, drop: crate(1) },
      { p: 0.03, drop: crate(2) },
      { p: 0.004, drop: crate(3), jackpot: 'lucky' },
    ],
  },
  {
    level: 3,
    name: 'Lv3 상자',
    emoji: '🗝️',
    price: 2000,
    desc: '고대의 금고. 정수와 상위 상자가 쏟아진다.',
    slots: [
      { p: 0.75, drop: coin(300, 780) },
      { p: 0.8, drop: mat('ore', 3, 1, 3) },
      { p: 0.7, drop: mat('gem', 2, 2, 4) },
      { p: 0.45, drop: mat('gem', 3) },
      { p: 0.5, drop: mat('essence', 1, 1, 2) },
      { p: 0.35, drop: mat('essence', 2, 1, 2) },
      { p: 0.1, drop: mat('essence', 3) },
      { p: 0.55, drop: mat('shard', 3, 1, 2) },
      { p: 0.35, drop: mat('shard', 2, 1, 2) },
      { p: 0.45, drop: crate(1, 1, 2) },
      { p: 0.3, drop: crate(2) },
      { p: 0.05, drop: crate(3) },
      { p: 0.008, drop: mat('essence', 5), jackpot: 'lucky' },
    ],
  },
];
export const CRATE_BY_LEVEL = new Map<number, CrateDef>(CRATES.map((c) => [c.level, c]));
export const MAX_CRATE_LEVEL = CRATES.length;

/** 그 상자에 실제로 적용되는 슬롯 전체(고정 슬롯 + 공통 잭팟) — 확률 공시와 롤이 같은 목록을 본다. */
export function slotsOf(level: number): Slot[] {
  const def = CRATE_BY_LEVEL.get(level);
  if (!def) return [];
  const jackpotSlots: Slot[] = JACKPOTS.map((j) => ({
    p: j.p,
    drop: coin(Math.round(def.price * j.mult * 0.8), Math.round(def.price * j.mult * 1.2)),
    jackpot: j.tier,
  }));
  return [...def.slots, ...jackpotSlots, MAT_JACKPOT];
}

/**
 * 상자조각 Lv4 2개 → 랜덤 상자 1개(확률적으로 더 높은 레벨). 기댓값(약 443골드)은 Lv4 조각
 * 2개의 판매가(260골드)보다 훨씬 높아야 "조각은 팔지 말고 합쳐라"가 성립한다.
 */
export const SHARD_CRATE_ODDS: { level: number; p: number }[] = [
  { level: 1, p: 0.55 },
  { level: 2, p: 0.33 },
  { level: 3, p: 0.12 },
];

export const SHOP_MAX_BUY = 20; // 한 요청에 살 수 있는 상자 수
export const MAX_OPEN_AT_ONCE = 10; // 한 요청에 깔 수 있는 상자 수

export const START_COINS = 600;
export const CRATE_REFILL_AMOUNT = 250;
export const CRATE_REFILL_DAILY_LIMIT = 5;

// ── 롤(추첨) ────────────────────────────────────────────────────────────────────
export interface RewardItem {
  kind: 'coin' | 'mat' | 'crate';
  cat?: MatCat;
  level: number; // coin 이면 0
  count: number;
  jackpot?: JackpotTier;
}

type Rng = () => number;

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 상자 하나를 깐 결과. 슬롯마다 **독립시행**이라 하나만 나올 수도, 여러 개가 한꺼번에 나올 수도 있다.
 * ⚠ 상자에서 상자가 나오는 재귀는 여기서 풀지 않는다 — 나온 상자는 인벤토리에 들어가고 유저가
 * 직접 깐다(자동으로 풀면 "10개 깠는데 결과가 40줄"이 되어 응답·애니메이션이 폭주한다).
 */
export function rollCrate(level: number, rng: Rng = Math.random): RewardItem[] {
  const slots = slotsOf(level);
  if (slots.length === 0) return [];
  const out: RewardItem[] = [];
  for (const slot of slots) {
    if (rng() >= slot.p) continue;
    const d = slot.drop;
    const count = randInt(rng, d.min, d.max);
    if (count <= 0) continue;
    if (d.kind === 'coin') out.push({ kind: 'coin', level: 0, count, jackpot: slot.jackpot });
    else if (d.kind === 'mat') out.push({ kind: 'mat', cat: d.cat, level: d.level, count, jackpot: slot.jackpot });
    else out.push({ kind: 'crate', level: d.level, count, jackpot: slot.jackpot });
  }
  // 전부 꽝이면 최소 보상 하나는 준다 — "아무것도 안 나옴"은 재미가 아니라 그냥 고장처럼 보인다.
  if (out.length === 0) out.push({ kind: 'mat', cat: 'wood', level: 1, count: 1 });
  return out;
}

/** 상자조각 Lv4 2개를 합쳤을 때 나오는 상자 레벨. */
export function rollShardCrate(rng: Rng = Math.random): number {
  let r = rng();
  for (const o of SHARD_CRATE_ODDS) {
    if (r < o.p) return o.level;
    r -= o.p;
  }
  return SHARD_CRATE_ODDS[0].level;
}
