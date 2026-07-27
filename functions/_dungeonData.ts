// ── "5분 던전" 콘텐츠 정의(서버 권위) — 아이콘 5종 · 영웅 6종 · 몬스터 24종 · 던전 4개 ──────
// 원작 "5-Minute Dungeon" 의 정확한 카드 텍스트/수량은 기억에 확신이 없어 그대로 베끼지 않았다.
// 메커니즘(아이콘 매칭, 개인 덱 히든드로우, 함정/포션/보스, 5분 타이머, 인원수 난이도 스케일링)은
// 재현하되 영웅 이름·카드 구성·몬스터 목록은 이 프로젝트 오리지널이다.
// 클라(src/dungeon/data.ts)는 이 표의 라벨/색/이모지만 자체 보관(표시 전용) — 실제 덱 구성·요구치·
// 판정 로직의 진실원본은 이 파일 하나뿐이다.

export type Icon = 'str' | 'mag' | 'agi' | 'hol' | 'nat';
export type CardIcon = Icon | 'wild';
export const ICONS: Icon[] = ['str', 'mag', 'agi', 'hol', 'nat'];

/** 카드 1장의 명세(덱 구성표에서 펼쳐진다). value = 요구치에 기여하는 양. */
export interface CardSpec {
  icon: CardIcon;
  value: number;
  special?: boolean;
}
/** 덱 구성표 — [값, 장수][] 형태로 읽기 쉽게 적는다. */
type Composition = [value: number, count: number][];
export interface HeroDef {
  id: string;
  name: string;
  blurb: string; // 로비 영웅 카드에 표시되는 한 줄 소개
  primary: Icon;
  secondary: Icon;
  deck: { primary: Composition; secondary: Composition; wild: Composition };
  special: { name: string; desc: string };
}

// 기본 덱 = 주 9장(1x6,2x2,3x1) + 보조 4장(1x3,2x1) + 와일드 2장 + 특수 1장 = 16장.
const STD_PRIMARY: Composition = [
  [1, 6],
  [2, 2],
  [3, 1],
];
const STD_SECONDARY: Composition = [
  [1, 3],
  [2, 1],
];
const STD_WILD: Composition = [[1, 2]];

export const HEROES: HeroDef[] = [
  {
    id: 'barbarian',
    name: '바바리안',
    blurb: '정면 돌파. 힘 카드가 가장 많고 한 방이 굵다.',
    primary: 'str',
    secondary: 'agi',
    deck: { primary: STD_PRIMARY, secondary: STD_SECONDARY, wild: STD_WILD },
    special: { name: '결전의 함성', desc: '요구치 한 항목을 즉시 3만큼 채운다 (손패 소모 없음)' },
  },
  {
    id: 'wizard',
    name: '위저드',
    blurb: '마법 특화. 파티가 위험할 때 체력을 되돌린다.',
    primary: 'mag',
    secondary: 'hol',
    deck: { primary: STD_PRIMARY, secondary: STD_SECONDARY, wild: STD_WILD },
    special: { name: '치유의 주문', desc: '파티 체력을 즉시 2 회복한다' },
  },
  {
    id: 'ninja',
    name: '닌자',
    blurb: '민첩 특화. 손패가 막히면 곧바로 다시 채운다.',
    primary: 'agi',
    secondary: 'mag',
    deck: { primary: STD_PRIMARY, secondary: STD_SECONDARY, wild: STD_WILD },
    special: { name: '그림자 밟기', desc: '내 손패를 상한까지 즉시 보충한다 (버리지 않음)' },
  },
  {
    id: 'paladin',
    name: '팔라딘',
    blurb: '신성 특화. 다음에 열릴 함정 하나를 막아낸다.',
    primary: 'hol',
    secondary: 'str',
    deck: { primary: STD_PRIMARY, secondary: STD_SECONDARY, wild: STD_WILD },
    special: { name: '수호의 방벽', desc: '다음에 나오는 함정 1개를 완전히 무효화한다' },
  },
  {
    id: 'druid',
    name: '드루이드',
    blurb: '자연 특화. 파티 전원의 손패를 한꺼번에 채운다.',
    primary: 'nat',
    secondary: 'hol',
    deck: { primary: STD_PRIMARY, secondary: STD_SECONDARY, wild: STD_WILD },
    special: { name: '자연의 부름', desc: '파티 전원의 손패를 상한까지 보충한다' },
  },
  {
    id: 'bard',
    name: '음유시인',
    blurb: '만능형. 아무 아이콘으로나 쓰이는 와일드 카드가 절반이다.',
    primary: 'nat',
    secondary: 'mag',
    // 주 5장 + 보조 2장 + 와일드 8장 + 특수 1장 = 16장 (유연하지만 한 방은 약함)
    deck: {
      primary: [
        [1, 4],
        [2, 1],
      ],
      secondary: [[1, 2]],
      wild: [
        [1, 7],
        [2, 1],
      ],
    },
    special: { name: '영감의 노래', desc: '남아있는 요구치를 자동으로 총 2만큼 채운다' },
  },
];
export const HERO_BY_ID = new Map(HEROES.map((h) => [h.id, h]));

function expand(comp: Composition, icon: CardIcon): CardSpec[] {
  const out: CardSpec[] = [];
  for (const [value, count] of comp) for (let i = 0; i < count; i++) out.push({ icon, value });
  return out;
}
export function heroDeckSpec(hero: HeroDef): CardSpec[] {
  return [
    ...expand(hero.deck.primary, hero.primary),
    ...expand(hero.deck.secondary, hero.secondary),
    ...expand(hero.deck.wild, 'wild'),
    { icon: hero.primary, value: 0, special: true },
  ];
}

// ── 이벤트 카드 ────────────────────────────────────────────────────────────
export type Req = Partial<Record<Icon | 'any', number>>;
export type EventType = 'monster' | 'trap' | 'potion' | 'boss';
export interface EventDef {
  key: string;
  type: EventType;
  name: string;
  tier?: 1 | 2 | 3; // 몬스터 난이도 등급(던전이 이 등급으로 풀을 고른다)
  req?: Req; // monster/potion, boss 는 1페이즈 요구치
  req2?: Req; // boss 전용 2페이즈 요구치
  trapEffect?: { hpLoss: number; discardEach: number; note: string };
  heal?: number; // potion 전용 회복량
}

/** 몬스터 24종 — 요구치는 "3인 파티" 기준이고 실제 인원수에 맞춰 scaleReq() 로 조정된다. */
export const MONSTER_POOL: EventDef[] = [
  // tier 1 — 단일 아이콘 위주, 가볍게
  { key: 'slime', type: 'monster', tier: 1, name: '슬라임', req: { str: 2 } },
  { key: 'scout', type: 'monster', tier: 1, name: '고블린 정찰병', req: { agi: 2 } },
  { key: 'bats', type: 'monster', tier: 1, name: '박쥐 떼', req: { agi: 2 } },
  { key: 'wilddog', type: 'monster', tier: 1, name: '들개 무리', req: { str: 2 } },
  { key: 'spider', type: 'monster', tier: 1, name: '동굴 거미', req: { nat: 2 } },
  { key: 'cultist', type: 'monster', tier: 1, name: '광신도', req: { mag: 2 } },
  { key: 'ghoul', type: 'monster', tier: 1, name: '구울', req: { hol: 2 } },
  { key: 'thief', type: 'monster', tier: 1, name: '도적', req: { agi: 1, mag: 1 } },
  { key: 'skeleton', type: 'monster', tier: 1, name: '해골 병사', req: { str: 1, hol: 1 } },
  // tier 2 — 3짜리 단일 또는 2아이콘 조합
  { key: 'orc', type: 'monster', tier: 2, name: '오크 전사', req: { str: 3 } },
  { key: 'archer', type: 'monster', tier: 2, name: '다크엘프 궁수', req: { agi: 3 } },
  { key: 'acolyte', type: 'monster', tier: 2, name: '리치의 하수인', req: { mag: 3 } },
  { key: 'zombies', type: 'monster', tier: 2, name: '좀비 무리', req: { hol: 3 } },
  { key: 'creeper', type: 'monster', tier: 2, name: '덩굴 괴물', req: { nat: 3 } },
  { key: 'troll', type: 'monster', tier: 2, name: '트롤', req: { str: 2, agi: 2 } },
  { key: 'necro', type: 'monster', tier: 2, name: '사령술사', req: { mag: 2, hol: 1 } },
  { key: 'assassin', type: 'monster', tier: 2, name: '그림자 암살자', req: { agi: 2, mag: 1 } },
  { key: 'golem', type: 'monster', tier: 2, name: '석상 골렘', req: { str: 2, mag: 1 } },
  { key: 'hydra', type: 'monster', tier: 2, name: '늪지 히드라', req: { nat: 2, str: 1 } },
  // tier 3 — 다중 아이콘 대형
  { key: 'minotaur', type: 'monster', tier: 3, name: '미노타우로스', req: { str: 4, agi: 1 } },
  { key: 'archmage', type: 'monster', tier: 3, name: '타락한 대마법사', req: { mag: 4 } },
  { key: 'vampire', type: 'monster', tier: 3, name: '흡혈귀 백작', req: { hol: 3, agi: 2 } },
  { key: 'elemental', type: 'monster', tier: 3, name: '고대 정령', req: { nat: 3, mag: 2 } },
  { key: 'hellhound', type: 'monster', tier: 3, name: '지옥 사냥개', req: { str: 3, nat: 2 } },
  { key: 'banshee', type: 'monster', tier: 3, name: '밴시', req: { hol: 2, mag: 3 } },
];

/** 함정 6종 — 공개 즉시 자동 발동한다(막을 방법은 팔라딘의 "수호의 방벽"뿐). */
export const TRAP_POOL: EventDef[] = [
  { key: 'spikes', type: 'trap', name: '가시 함정', trapEffect: { hpLoss: 1, discardEach: 1, note: '체력 -1, 전원 손패 1장 버림' } },
  { key: 'fog', type: 'trap', name: '저주의 안개', trapEffect: { hpLoss: 1, discardEach: 2, note: '체력 -1, 전원 손패 2장 버림' } },
  { key: 'rockfall', type: 'trap', name: '낙석', trapEffect: { hpLoss: 2, discardEach: 0, note: '체력 -2' } },
  { key: 'poison', type: 'trap', name: '독 구름', trapEffect: { hpLoss: 1, discardEach: 1, note: '체력 -1, 전원 손패 1장 버림' } },
  { key: 'seal', type: 'trap', name: '마력 봉인', trapEffect: { hpLoss: 0, discardEach: 3, note: '전원 손패 3장 버림' } },
  { key: 'pitfall', type: 'trap', name: '함정 바닥', trapEffect: { hpLoss: 2, discardEach: 1, note: '체력 -2, 전원 손패 1장 버림' } },
];

/** 포션 4종 — 요구치가 전부 'any'(아무 카드나)라 어떤 영웅 조합이든 마실 수 있다. */
export const POTION_POOL: EventDef[] = [
  { key: 'potion_small', type: 'potion', name: '치유의 물약', req: { any: 3 }, heal: 1 },
  { key: 'potion_big', type: 'potion', name: '활력의 영약', req: { any: 4 }, heal: 2 },
  { key: 'potion_holy', type: 'potion', name: '성수', req: { any: 3 }, heal: 1 },
  { key: 'potion_dew', type: 'potion', name: '재생의 이슬', req: { any: 5 }, heal: 2 },
];

/** 보스 4종 — 던전마다 하나씩, 항상 덱의 마지막 카드. 2페이즈(1페이즈 격파 시 진행도 초기화). */
export const BOSSES: Record<string, EventDef> = {
  goblin_king: { key: 'goblin_king', type: 'boss', name: '고블린 왕', req: { str: 3, agi: 3 }, req2: { any: 6 } },
  lich: { key: 'lich', type: 'boss', name: '리치', req: { mag: 3, hol: 3 }, req2: { any: 8 } },
  dragon: { key: 'dragon', type: 'boss', name: '고대 용', req: { str: 4, mag: 3, agi: 3 }, req2: { any: 9 } },
  overlord: { key: 'overlord', type: 'boss', name: '던전의 군주', req: { str: 3, mag: 3, agi: 3, hol: 3 }, req2: { any: 10 } },
};

export interface DungeonDef {
  id: string;
  name: string;
  desc: string;
  difficulty: 1 | 2 | 3 | 4;
  startHp: number;
  monsters: number;
  traps: number;
  potions: number;
  /** 몬스터를 뽑을 등급 풀(중복 등급을 넣으면 그만큼 비중이 커진다) */
  tiers: (1 | 2 | 3)[];
  bossKey: keyof typeof BOSSES;
}
export const DUNGEONS: DungeonDef[] = [
  {
    id: 'goblin_den',
    name: '고블린 소굴',
    desc: '처음 들어가기 좋은 던전. 약한 몬스터 위주고 함정도 하나뿐이다.',
    difficulty: 1,
    startHp: 5,
    monsters: 8,
    traps: 1,
    potions: 2,
    tiers: [1],
    bossKey: 'goblin_king',
  },
  {
    id: 'graveyard',
    name: '저주받은 묘지',
    desc: '중급 던전. 두 가지 아이콘을 함께 요구하는 몬스터가 섞여 나온다.',
    difficulty: 2,
    startHp: 5,
    monsters: 11,
    traps: 2,
    potions: 2,
    tiers: [1, 2],
    bossKey: 'lich',
  },
  {
    id: 'dragon_nest',
    name: '용의 둥지',
    desc: '상급 던전. 요구치가 크고 함정이 잦다. 손발이 맞아야 5분 안에 끝난다.',
    difficulty: 3,
    startHp: 6,
    monsters: 13,
    traps: 3,
    potions: 2,
    tiers: [2, 3],
    bossKey: 'dragon',
  },
  {
    id: 'abyss',
    name: '심연의 왕좌',
    desc: '최고 난이도. 쉬지 않고 카드를 내야 겨우 시간이 맞는다.',
    difficulty: 4,
    startHp: 6,
    monsters: 15,
    traps: 4,
    potions: 3,
    tiers: [2, 3, 3],
    bossKey: 'overlord',
  },
];
export const DUNGEON_BY_ID = new Map(DUNGEONS.map((d) => [d.id, d]));
export const DEFAULT_DUNGEON_ID = DUNGEONS[0].id;

export const HAND_LIMIT = 5;
export const MAX_HP = 10;
export const MAX_PARTY = 4;
export const RUN_MS = 5 * 60 * 1000;
export const LOG_LIMIT = 20;

/** 인원수 난이도 스케일 — 사람이 많을수록 초당 낼 수 있는 카드가 늘어나므로 요구치도 같이 올린다.
 * (요구치는 3인 기준으로 적혀 있다.) */
export function partyScale(n: number): number {
  if (n <= 1) return 0.55;
  if (n === 2) return 0.8;
  if (n === 3) return 1;
  return 1.2;
}
