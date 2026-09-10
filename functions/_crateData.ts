/**
 * "상자깡"(ox64.app/c) 콘텐츠 정의 + 순수 로직 — D1 I/O 가 전혀 없다.
 * `_dungeonData.ts`/`_dungeonEngine.ts` 와 같은 "데이터·로직은 순수 함수로 분리" 패턴이라
 * `scripts/sim-crate.ts` 가 이 파일만 import 해서 밸런스를 수십만 번 시뮬레이션할 수 있다.
 * ⚠ 확률·가격·가치를 손댔으면 반드시 `npm run sim:crate` 로 회수율을 다시 잴 것.
 */

// ── 재료 ────────────────────────────────────────────────────────────────────────
// 카테고리는 머지해도 절대 안 바뀌고 레벨만 오른다(요구사항). 같은 카테고리·같은 레벨 2개 → 다음 레벨 1개.
// 가치는 레벨당 MERGE_MULT 배 — 2개(=2배)를 1개로 합치는데 가치가 2.25배가 되므로 개당 1.125배씩
// 이득이다. 이 "머지 프리미엄"이 이 게임의 유일한 성장 동력이고, 상자 기대 회수율을 원가 아래로
// 잡아둔 이유이기도 하다(상자만 까서 다 팔면 적자, 끝까지 머지해서 팔아야 흑자 = § 밸런스).
// ⚠⚠ **레벨 상한을 바꾸면 이 값도 같이 재조정해야 한다.** Lv1→최고 레벨의 가치 배율은
// `(MERGE_MULT/2)^(상한-1)` 라 상한에 지수로 반응한다 — 상한을 6에서 12 로 올렸을 때 2.35 를
// 그대로 두면 배율이 2.24 → 6.28 로 뛰어 optimal 회수율이 통째로 폭발한다(그래서 2.25 로 내렸다).
export const MERGE_MULT = 2.25;

export type MatCat = 'herb' | 'wood' | 'ore' | 'cloth' | 'gem' | 'essence' | 'lotto' | 'shard';

export interface CatDef {
  cat: MatCat;
  /** 팔 수 없는 재료(골드복권) — 긁는 것 말고는 쓸 데가 없다 */
  noSell?: boolean;
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

// ⚠ 이모지는 **Unicode 11.0 이하**로만 고를 것 — 12.0/13.0 대(🪵 U+1FAB5 등)는 구형 폰트에
// 글리프가 없어 두부(□)로 뜬다(실제로 목재 아이콘이 그렇게 깨졌다). 새 재료를 추가할 때 반드시 확인.
/** 일반 재료의 레벨 상한 — 상자조각(4)과 복권(1)만 예외다. */
export const MAX_MAT_LEVEL = 12;
/** 골드복권 상금의 기준액 — 상금은 이 값의 0.1~800배다(레벨이 없으므로 고정). */
export const LOTTO_BASE = 300;

export const CATS: CatDef[] = [
  { cat: 'herb', name: '약초', emoji: '🌿', color: '#5fbf6a', base: 4, maxLevel: MAX_MAT_LEVEL, desc: '지천에 널린 재료' },
  { cat: 'wood', name: '목재', emoji: '🌳', color: '#b0803a', base: 6, maxLevel: MAX_MAT_LEVEL, desc: '가장 흔한 기본 재료' },
  { cat: 'ore', name: '광석', emoji: '⛏️', color: '#8aa4b8', base: 15, maxLevel: MAX_MAT_LEVEL, desc: '단단한 중급 재료' },
  { cat: 'cloth', name: '섬유', emoji: '🧵', color: '#e08fb0', base: 24, maxLevel: MAX_MAT_LEVEL, desc: '손이 많이 가는 중급 재료' },
  { cat: 'gem', name: '보석', emoji: '💎', color: '#38bdf8', base: 40, maxLevel: MAX_MAT_LEVEL, desc: '값나가는 고급 재료' },
  { cat: 'essence', name: '정수', emoji: '🔮', color: '#a78bfa', base: 90, maxLevel: MAX_MAT_LEVEL, desc: '희귀한 최고급 재료' },
  {
    cat: 'lotto',
    name: '골드복권',
    emoji: '🎫',
    color: '#ffcc33',
    base: LOTTO_BASE,
    // ⚠ 레벨이 없다(상한 1) — 합칠 수도, 팔 수도 없고 **긁는 것만** 가능하다.
    // 그래서 `base` 는 판매가가 아니라 **상금의 기준액**이고, 상금은 그 0.1~800배다.
    maxLevel: 1,
    noSell: true,
    desc: '긁으면 골드가 나온다 — 최소 30 G, 최대 240,000 G',
  },
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

// ── 골드복권 ────────────────────────────────────────────────────────────────────
/**
 * 긁으면 `LOTTO_BASE`(300G)의 배수로 골드를 준다. 배수 분포가 이 아이템의 전부다 — 절반 이상은
 * 기준액도 못 건지고, 아주 가끔 수백 배가 터진다(로그 스케일 꼬리). 실측 최대 240,000골드.
 *
 * ⚠ 기대 배수는 `Σ p × (min+max)/2` = **약 2.6배**(= 771골드)다. 복권은 팔 수도 합칠 수도 없으므로
 * 이 기댓값이 곧 복권의 가치이고, 회수율 계산도 그 값으로 한다.
 * ⚠ 꼬리를 키울 땐 기대 배수를 반드시 다시 계산할 것 — `p × mult` 가 큰 항이 하나만 있어도 평균이
 * 통째로 끌려간다(0.1% × 800배 = 0.8배가 평균에 그대로 더해진다).
 */
export const LOTTO_TIERS: { p: number; min: number; max: number; label: string; color: string }[] = [
  { p: 0.55, min: 0.1, max: 0.8, label: '꽝', color: '#8b949e' },
  { p: 0.31, min: 0.8, max: 2.5, label: '소액', color: '#7ee787' },
  { p: 0.11, min: 2.5, max: 8, label: '당첨', color: '#4493f8' },
  { p: 0.025, min: 8, max: 30, label: '고액 당첨', color: '#bc8cff' },
  { p: 0.004, min: 30, max: 120, label: '대박', color: '#f0883e' },
  { p: 0.001, min: 120, max: 800, label: '1등', color: '#ff5ea8' },
];

export interface LottoResult {
  /** 판매가 대비 배수 */
  mult: number;
  /** 실제 지급 골드 */
  gold: number;
  tier: number;
  label: string;
  color: string;
}

/** 복권 한 장을 긁는다. */
export function scratchLotto(_level = 1, rng: Rng = Math.random): LottoResult {
  const base = LOTTO_BASE;
  let r = rng();
  for (let i = 0; i < LOTTO_TIERS.length; i++) {
    const t = LOTTO_TIERS[i];
    if (r < t.p) {
      const mult = t.min + rng() * (t.max - t.min);
      return { mult, gold: Math.max(1, Math.round(base * mult)), tier: i, label: t.label, color: t.color };
    }
    r -= t.p;
  }
  const t = LOTTO_TIERS[0];
  return { mult: t.min, gold: Math.max(1, Math.round(base * t.min)), tier: 0, label: t.label, color: t.color };
}

/** 복권의 기대 배수 — 시뮬·표시에서 "평균 몇 배" 를 보여줄 때 쓴다. */
export function lottoExpectedMult(): number {
  return LOTTO_TIERS.reduce((sum, t) => sum + t.p * ((t.min + t.max) / 2), 0);
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
    desc: '가벼운 나무 상자. 약초와 목재가 주로 나온다.',
    slots: [
      { p: 0.72, drop: coin(18, 38) },
      { p: 0.9, drop: mat('herb', 1, 1, 3) },
      { p: 0.35, drop: mat('herb', 2) },
      { p: 0.8, drop: mat('wood', 1) },
      { p: 0.38, drop: mat('wood', 2) },
      { p: 0.22, drop: mat('ore', 1) },
      { p: 0.2, drop: mat('ore', 2) },
      { p: 0.05, drop: mat('cloth', 1) },
      { p: 0.04, drop: mat('gem', 1) },
      { p: 0.008, drop: mat('lotto', 1) },
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
    desc: '단단히 잠긴 철제 상자. 광석과 섬유가 늘어난다.',
    slots: [
      { p: 0.7, drop: coin(70, 160) },
      { p: 0.6, drop: mat('herb', 3, 1, 2) },
      { p: 0.7, drop: mat('wood', 3) },
      { p: 0.6, drop: mat('ore', 2, 1, 2) },
      { p: 0.28, drop: mat('ore', 3) },
      { p: 0.4, drop: mat('cloth', 2) },
      { p: 0.15, drop: mat('cloth', 3) },
      { p: 0.2, drop: mat('gem', 2) },
      { p: 0.06, drop: mat('essence', 2) },
      { p: 0.035, drop: mat('lotto', 1) },
      { p: 0.45, drop: mat('shard', 2) },
      { p: 0.2, drop: mat('shard', 1, 1, 2) },
      { p: 0.2, drop: crate(1) },
      { p: 0.03, drop: crate(2) },
      { p: 0.004, drop: crate(3), jackpot: 'lucky' },
    ],
  },
  {
    level: 3,
    name: 'Lv3 상자',
    emoji: '🗝️',
    price: 2000,
    desc: '고대의 금고. 보석과 정수가 쏟아진다.',
    slots: [
      { p: 0.75, drop: coin(195, 510) },
      { p: 0.6, drop: mat('ore', 4, 1, 2) },
      { p: 0.5, drop: mat('cloth', 4) },
      { p: 0.5, drop: mat('gem', 3, 1, 2) },
      { p: 0.2, drop: mat('gem', 4) },
      { p: 0.3, drop: mat('essence', 3) },
      { p: 0.08, drop: mat('essence', 4) },
      { p: 0.3, drop: mat('wood', 5) },
      { p: 0.15, drop: mat('lotto', 1, 1, 2) },
      { p: 0.4, drop: mat('shard', 3, 1, 2) },
      { p: 0.3, drop: mat('shard', 2, 1, 2) },
      { p: 0.25, drop: crate(1, 1, 2) },
      { p: 0.15, drop: crate(2) },
      { p: 0.035, drop: crate(3) },
      { p: 0.006, drop: crate(4), jackpot: 'lucky' },
    ],
  },
  {
    level: 4,
    name: 'Lv4 상자',
    emoji: '💼',
    price: 9000,
    desc: '봉인된 보물함. 이미 합쳐진 고급 재료가 통째로 들어있다.',
    slots: [
      { p: 0.75, drop: coin(880, 2200) },
      { p: 0.6, drop: mat('gem', 5, 1, 2) },
      { p: 0.4, drop: mat('essence', 4, 1, 2) },
      { p: 0.7, drop: mat('cloth', 5, 1, 2) },
      { p: 0.5, drop: mat('ore', 6, 1, 2) },
      { p: 0.15, drop: mat('essence', 5) },
      { p: 0.12, drop: mat('gem', 6) },
      { p: 0.5, drop: mat('lotto', 1, 1, 3) },
      { p: 0.5, drop: mat('shard', 4, 1, 2) },
      { p: 0.25, drop: crate(3) },
      { p: 0.2, drop: crate(2, 1, 2) },
      { p: 0.04, drop: crate(4) },
      { p: 0.006, drop: crate(5), jackpot: 'lucky' },
    ],
  },
  {
    level: 5,
    name: 'Lv5 상자',
    emoji: '👑',
    price: 40000,
    desc: '왕가의 보고. 한 번에 인생이 바뀔 수도 있다.',
    slots: [
      { p: 0.75, drop: coin(4000, 11000) },
      { p: 0.6, drop: mat('essence', 6, 1, 2) },
      { p: 0.55, drop: mat('gem', 7, 1, 2) },
      { p: 0.5, drop: mat('cloth', 7, 1, 2) },
      { p: 0.35, drop: mat('ore', 8, 1, 2) },
      { p: 0.15, drop: mat('essence', 7) },
      { p: 0.07, drop: mat('gem', 8) },
      { p: 0.65, drop: mat('lotto', 1, 4, 10) },
      { p: 0.1, drop: mat('lotto', 1, 5, 12) },
      { p: 0.8, drop: mat('shard', 4, 2, 4) },
      { p: 0.22, drop: crate(4) },
      { p: 0.2, drop: crate(3, 1, 2) },
      { p: 0.035, drop: crate(5) },
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

// ── 보상을 퍼주는 장치 셋 ───────────────────────────────────────────────────────
// 초기 밸런스(naive 70%)는 "대충 하면 계속 깎인다"가 너무 세게 체감됐다. 회수율 숫자를 그냥 올리는
// 대신 **눈에 보이는 사건**으로 얹는다 — 같은 +15% 라도 "확률표가 좋아졌다"는 안 느껴지지만
// "✨ 보너스! 2개 더" 는 매번 보인다. 셋 다 `npm run sim:crate` 가 회수율에 미치는 영향을 실측한다.

/**
 * ① 개봉 보너스 — 상자를 깔 때마다 굴린다. 위에서부터 판정해 **하나만** 적용된다.
 * `mult` 는 그 상자의 모든 보상 수량에 곱하고, `extra` 는 보상 항목을 그만큼 더 얹는다
 * (추가 항목은 그 상자의 드롭 분포를 따르되 잭팟은 제외 — 잭팟은 잭팟 확률로만 나와야 한다).
 */
export type BonusTier = 'mega' | 'triple' | 'double' | 'extra';
export const BONUS_TIERS: { tier: BonusTier; p: number; mult: number; extra: number; label: string; emoji: string; color: string }[] = [
  { tier: 'mega', p: 0.002, mult: 5, extra: 2, label: '메가 잭팟', emoji: '💥', color: '#ff5ea8' },
  { tier: 'triple', p: 0.010, mult: 3, extra: 0, label: '트리플', emoji: '⚡', color: '#ff8f3f' },
  { tier: 'double', p: 0.038, mult: 2, extra: 0, label: '더블', emoji: '🔥', color: '#ffcc33' },
  { tier: 'extra', p: 0.10, mult: 1, extra: 2, label: '보너스', emoji: '✨', color: '#7ee787' },
];

/**
 * ② 개봉 마일스톤 — 누적 개봉 수(`crate_stats.opened`)가 배수를 넘을 때마다 상자를 준다.
 * ⚠ **컬럼을 추가하지 않으려고 `opened` 를 그대로 게이지로 쓴다**(prod 에 ALTER 를 돌릴 수 없다).
 * 진행도 표시도 `opened % every` 로 파생되므로 저장할 상태가 없다.
 * 저가 상자를 많이 까는 사람일수록 가격 대비 이득이 커서(Lv1 기준 +9%, Lv3 기준 +0.4%) 따라잡기
 * 장치로도 동작한다.
 */
export const MILESTONES: { every: number; level: number; count: number; label: string }[] = [
  { every: 60, level: 1, count: 1, label: '60회 개봉' },
  { every: 300, level: 2, count: 1, label: '300회 개봉' },
  { every: 1500, level: 3, count: 1, label: '1,500회 개봉' },
];

/**
 * ③ 대량 개봉 보너스 — 한 번에 이만큼 이상 까면 **확률적으로** 공짜 상자가 더 나온다.
 * ⚠ 확정 지급(10개마다 1개)으로 두면 그것만으로 회수율이 +10%p 올라 밸런스의 주인이 된다.
 * 확률로 두면 기여는 +3.5%p 로 줄면서 "가끔 하나 더 나오는" 재미는 남는다.
 */
export const BULK_BONUS_AT = 10;
export const BULK_BONUS_CRATES = 1;
export const BULK_BONUS_CHANCE = 0.22;
export function rollBulkBonus(count: number, rng: Rng = Math.random, ev?: DailyEvent | null): number {
  if (count < BULK_BONUS_AT) return 0;
  return ev?.bulkAlways || rng() < BULK_BONUS_CHANCE ? BULK_BONUS_CRATES : 0;
}

/**
 * ④ 업적 — "돈 벌 방법이 상자밖에 없다" 를 푸는 장치. 누적 통계가 기준선을 넘으면 한 번씩 지급한다.
 *
 * ⚠⚠ **수령 여부를 `seen_json`(도감) 배열에 `a:<key>` 로 같이 담는다** — prod 에 ALTER 를 돌릴 수
 * 없어서 컬럼을 못 늘리기 때문이다. `parseInvKey('a:open10')` 은 `null` 을 돌려주고 도감 화면은
 * `CATS` 기준으로만 그리므로 재료 쪽에 섞여 보이지 않는다. 재료 카테고리에 `a` 를 절대 쓰지 말 것.
 * ⚠ 보상 총량은 유한하다(전부 합쳐 약 6만 골드 상당) — 일회성이라 인플레 경로가 아니고, 초중반에
 * 크게 체감되다가 후반엔 무의미해진다(따라잡기 장치).
 */
export type AchStat = 'opened' | 'merged' | 'jackpots' | 'seen' | 'bestCoins' | 'earned';
export interface Achievement {
  key: string;
  stat: AchStat;
  at: number;
  label: string;
  desc: string;
  coins: number;
  /** [상자 레벨, 개수] */
  crates?: [number, number];
}

export const ACHIEVEMENTS: Achievement[] = [
  // 개봉
  { key: 'open1', stat: 'opened', at: 1, label: '첫 개봉', desc: '상자를 처음 열었다', coins: 300 },
  { key: 'open25', stat: 'opened', at: 25, label: '상자 애호가', desc: '상자 25개 개봉', coins: 600, crates: [1, 2] },
  { key: 'open100', stat: 'opened', at: 100, label: '개봉 장인', desc: '상자 100개 개봉', coins: 1500, crates: [2, 1] },
  { key: 'open500', stat: 'opened', at: 500, label: '상자 중독', desc: '상자 500개 개봉', coins: 4000, crates: [2, 3] },
  { key: 'open2000', stat: 'opened', at: 2000, label: '개봉의 신', desc: '상자 2,000개 개봉', coins: 12000, crates: [3, 2] },
  // 머지
  { key: 'merge1', stat: 'merged', at: 1, label: '첫 합성', desc: '재료를 처음 합쳤다', coins: 300 },
  { key: 'merge25', stat: 'merged', at: 25, label: '합성 견습', desc: '25번 합성', coins: 800, crates: [1, 3] },
  { key: 'merge100', stat: 'merged', at: 100, label: '합성 숙련', desc: '100번 합성', coins: 2000, crates: [2, 2] },
  { key: 'merge500', stat: 'merged', at: 500, label: '합성 대가', desc: '500번 합성', coins: 6000, crates: [3, 1] },
  { key: 'merge2000', stat: 'merged', at: 2000, label: '연금술사', desc: '2,000번 합성', coins: 15000, crates: [3, 3] },
  // 도감
  { key: 'seen8', stat: 'seen', at: 8, label: '수집가 입문', desc: '재료 8종 발견', coins: 800 },
  { key: 'seen16', stat: 'seen', at: 16, label: '수집가', desc: '재료 16종 발견', coins: 2500, crates: [2, 2] },
  { key: 'seen24', stat: 'seen', at: 24, label: '박물학자', desc: '재료 24종 발견', coins: 6000, crates: [3, 1] },
  { key: 'seenAll', stat: 'seen', at: 28, label: '도감 완성', desc: '모든 재료 발견', coins: 20000, crates: [3, 3] },
  // 잭팟
  { key: 'jack1', stat: 'jackpots', at: 1, label: '행운아', desc: '극한 확률 잭팟 적중', coins: 2000, crates: [2, 2] },
  { key: 'jack5', stat: 'jackpots', at: 5, label: '운명의 총아', desc: '잭팟 5회 적중', coins: 10000, crates: [3, 2] },
  // 자산
  { key: 'rich10k', stat: 'bestCoins', at: 10_000, label: '첫 만 골드', desc: '골드 10,000 보유', coins: 1500 },
  { key: 'rich100k', stat: 'bestCoins', at: 100_000, label: '부자', desc: '골드 100,000 보유', coins: 8000, crates: [3, 1] },
  { key: 'rich1m', stat: 'bestCoins', at: 1_000_000, label: '백만장자', desc: '골드 1,000,000 보유', coins: 40000, crates: [3, 5] },
  // 누적 수입
  { key: 'earn50k', stat: 'earned', at: 50_000, label: '장사꾼', desc: '누적 수입 50,000 골드', coins: 3000, crates: [2, 2] },
  { key: 'earn500k', stat: 'earned', at: 500_000, label: '거상', desc: '누적 수입 500,000 골드', coins: 20000, crates: [3, 3] },
];

/** 업적 수령 기록은 도감 배열에 이 접두사로 함께 담긴다. */
export const ACH_PREFIX = 'a:';
export const achKey = (key: string) => ACH_PREFIX + key;

/** 지금 통계로 새로 달성한(아직 안 받은) 업적들. */
export function pendingAchievements(
  stats: { opened: number; merged: number; jackpots: number; seen: number; bestCoins: number; earned: number },
  claimed: Set<string>,
): Achievement[] {
  return ACHIEVEMENTS.filter((a) => !claimed.has(achKey(a.key)) && stats[a.stat] >= a.at);
}

export const START_COINS = 600;

/**
 * ⚠⚠ 회생 경로 — 이 게임은 **가난할수록 회복이 구조적으로 어렵다**. 상자만 까면 회수율이 70% 라
 * 흑자를 내려면 머지를 해야 하는데, 머지에는 같은 재료 2개가 필요하고 그러려면 상자를 여러 개 까야
 * 한다. 즉 돈이 적으면 머지 기회 자체가 안 생겨 70% 손실이 그대로 굳는다(실제로 한 명이 전 재산을
 * 잃고 회복하지 못했다). 그래서 구제는 **돈이 아니라 상자로** 준다 — 상자를 여러 개 한꺼번에 줘야
 * 같은 재료가 모여 머지가 성립하고, 그때부터 스스로 굴러갈 수 있다.
 *
 * 지급은 두 단계이고 **컬럼을 더 쓰지 않는다**(`refill_date` + `refill_count` 두 개로 처리 —
 * 마이그레이션 없이 돌아가야 했다):
 *   · 그날 **첫 수령**(`refill_count === 0`) = 일일 지원. 조건 없이 누구나. 부자에겐 푼돈이고
 *     빈털터리에겐 생명줄이라, 따라잡기 장치로도 동작한다.
 *   · 그 뒤(`refill_count >= 1`) = 파산 구제. **총자산이 상자 3개 값에 못 미칠 때만.**
 */
export const DAILY_CRATES = 4; // 일일 지원으로 주는 Lv1 상자 수 — 같은 재료가 모여 머지가 되는 최소선
export const DAILY_COINS = 200;
export const RESCUE_CRATES = 3;
export const RESCUE_COINS = 400;
export const RESCUE_DAILY_LIMIT = 4; // 일일 지원 1회 + 구제 4회 = 하루 최대 5회 수령
/** 파산 판정선 — 가진 걸 전부 팔아도 가장 싼 상자를 이만큼도 못 사면 회생 불가로 본다. */
export const BROKE_CRATES = 3;

// ── 날짜 한정 이벤트 ────────────────────────────────────────────────────────────
/**
 * ⑤ 요일마다 도는 이벤트 — **KST 날짜에서 파생하므로 저장할 상태가 0** 이다(스케줄러도, 컬럼도,
 * cron 도 필요 없다. 트레이딩 리필의 "요청 시점에 KST 날짜를 계산" 패턴과 같은 사상).
 *
 * ⚠⚠ 효과는 전부 **회수율에 직접 얹힌다**. 이벤트가 하루씩 도니 평균 기여 = 각 효과의 1/7 합이고,
 * 그래서 `npm run sim:crate` 가 **요일별 회수율과 7일 평균**을 따로 찍는다. 평균이 100% 를 넘으면
 * 상자만 까도 골드가 불어나므로(§ 밸런스) 이벤트를 세게 만들려면 **평상시 드롭을 같이 낮춰야 한다**.
 * 지금은 "이벤트 날은 본전 이상, 평균은 그 아래" 를 노린다 — 그래야 그날 몰아 하는 재미가 생긴다.
 */
export interface DailyEvent {
  key: string;
  day: number; // 0=일 … 6=토 (KST)
  label: string;
  emoji: string;
  desc: string;
  /** 코인 드롭 수량 배수 */
  coinMult: number;
  /** 재료 드롭 수량 배수 */
  matMult: number;
  /** 상자조각 드롭 수량 배수(재료 배수와 곱해진다) */
  shardMult: number;
  /** 개봉 보너스(BONUS_TIERS) 확률 배수 */
  bonusMult: number;
  /** 극한 확률 잭팟 확률 배수 */
  jackpotMult: number;
  /** 상점 할인율(0.1 = 10% 싸게) */
  discount: number;
  /** 대량 개봉 보너스를 확정으로 */
  bulkAlways: boolean;
}

const EV = (
  day: number,
  key: string,
  emoji: string,
  label: string,
  desc: string,
  o: Partial<Omit<DailyEvent, 'key' | 'day' | 'label' | 'emoji' | 'desc'>>,
): DailyEvent => ({
  key,
  day,
  label,
  emoji,
  desc,
  coinMult: 1,
  matMult: 1,
  shardMult: 1,
  bonusMult: 1,
  jackpotMult: 1,
  discount: 0,
  bulkAlways: false,
  ...o,
});

export const DAILY_EVENTS: DailyEvent[] = [
  EV(0, 'gift', '🎁', '선물의 날', '개봉 보너스가 훨씬 자주 터집니다', { bonusMult: 1.6 }),
  EV(1, 'miner', '⛏️', '광부의 날', '재료가 더 많이 나옵니다', { matMult: 1.25 }),
  EV(2, 'gold', '💰', '황금의 날', '골드 드롭이 크게 늘어납니다', { coinMult: 1.35 }),
  EV(3, 'shard', '🧩', '조각의 날', '상자조각이 두 배로 나옵니다', { shardMult: 2 }),
  EV(4, 'sale', '📦', '창고 대방출', '상점 상자를 10% 싸게 삽니다', { discount: 0.1 }),
  EV(5, 'luck', '🍀', '행운의 날', '극한 확률 잭팟이 세 배로 잘 터집니다', { jackpotMult: 3 }),
  EV(6, 'festa', '🎉', '축제의 날', '대량 개봉 공짜 상자가 확정이고 보너스도 잘 터집니다', { bonusMult: 1.3, bulkAlways: true }),
];

/** `todayKst()` 가 준 'YYYY-MM-DD' 의 요일 이벤트. */
export function eventOfDay(dateKst: string): DailyEvent {
  const [y, m, d] = dateKst.split('-').map(Number);
  // UTC 로 만들어 요일만 뽑는다(이미 KST 로 환산된 날짜라 시간대를 또 적용하면 안 된다)
  const day = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
  return DAILY_EVENTS.find((e) => e.day === day) ?? DAILY_EVENTS[0];
}

/** 이벤트가 적용된 상자 가격(할인). */
export function priceOf(level: number, ev?: DailyEvent | null): number {
  const base = CRATE_BY_LEVEL.get(level)?.price ?? 0;
  return ev && ev.discount > 0 ? Math.max(1, Math.round(base * (1 - ev.discount))) : base;
}

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
export function rollCrate(level: number, rng: Rng = Math.random, ev?: DailyEvent | null): RewardItem[] {
  const slots = slotsOf(level);
  if (slots.length === 0) return [];
  const out: RewardItem[] = [];
  for (const slot of slots) {
    // 잭팟 슬롯만 잭팟 배수를 받는다(평범한 슬롯까지 배수를 먹이면 그게 곧 회수율 폭증이다)
    const p = slot.jackpot && ev ? slot.p * ev.jackpotMult : slot.p;
    if (rng() >= p) continue;
    const d = slot.drop;
    let count = randInt(rng, d.min, d.max);
    if (ev) {
      if (d.kind === 'coin') count = Math.round(count * ev.coinMult);
      else if (d.kind === 'mat') count = Math.round(count * ev.matMult * (d.cat === 'shard' ? ev.shardMult : 1));
    }
    if (count <= 0) continue;
    if (d.kind === 'coin') out.push({ kind: 'coin', level: 0, count, jackpot: slot.jackpot });
    else if (d.kind === 'mat') out.push({ kind: 'mat', cat: d.cat, level: d.level, count, jackpot: slot.jackpot });
    else out.push({ kind: 'crate', level: d.level, count, jackpot: slot.jackpot });
  }
  // 전부 꽝이면 최소 보상 하나는 준다 — "아무것도 안 나옴"은 재미가 아니라 그냥 고장처럼 보인다.
  if (out.length === 0) out.push({ kind: 'mat', cat: 'wood', level: 1, count: 1 });
  return out;
}

/**
 * 개봉 보너스를 굴린다 — 확률이 높은 순이 아니라 **등급이 높은 순**으로 판정해 하나만 적용한다
 * (메가가 떴는데 더블로 덮이면 안 된다).
 */
export function rollBonus(rng: Rng = Math.random, ev?: DailyEvent | null): (typeof BONUS_TIERS)[number] | null {
  const mult = ev?.bonusMult ?? 1;
  for (const b of BONUS_TIERS) if (rng() < b.p * mult) return b;
  return null;
}

/**
 * 보너스로 얹어주는 추가 보상 — 그 상자의 드롭 분포를 따르되 **잭팟 슬롯은 제외**한다
 * (잭팟은 잭팟 확률로만 나와야 한다). 슬롯을 확률 가중으로 골라서, 얹어주는 것도 흔한 건 흔하게
 * 귀한 건 귀하게 나온다.
 */
export function rollExtraRewards(level: number, n: number, rng: Rng = Math.random, ev?: DailyEvent | null): RewardItem[] {
  const slots = slotsOf(level).filter((s) => !s.jackpot);
  const total = slots.reduce((sum, s) => sum + s.p, 0);
  if (total <= 0) return [];
  const out: RewardItem[] = [];
  for (let i = 0; i < n; i++) {
    let r = rng() * total;
    let picked = slots[slots.length - 1];
    for (const s of slots) {
      r -= s.p;
      if (r <= 0) {
        picked = s;
        break;
      }
    }
    const d = picked.drop;
    let count = randInt(rng, d.min, d.max);
    if (ev) {
      if (d.kind === 'coin') count = Math.round(count * ev.coinMult);
      else if (d.kind === 'mat') count = Math.round(count * ev.matMult * (d.cat === 'shard' ? ev.shardMult : 1));
    }
    if (count <= 0) continue;
    if (d.kind === 'coin') out.push({ kind: 'coin', level: 0, count });
    else if (d.kind === 'mat') out.push({ kind: 'mat', cat: d.cat, level: d.level, count });
    else out.push({ kind: 'crate', level: d.level, count });
  }
  return out;
}

/** 누적 개봉 수가 `before` → `after` 로 늘 때 넘어선 마일스톤들. */
export function milestonesCrossed(before: number, after: number) {
  const out: { level: number; count: number; label: string; at: number }[] = [];
  for (const m of MILESTONES) {
    const from = Math.floor(before / m.every);
    const to = Math.floor(after / m.every);
    for (let k = from + 1; k <= to; k++) out.push({ level: m.level, count: m.count, label: m.label, at: k * m.every });
  }
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
