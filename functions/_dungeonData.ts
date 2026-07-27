// ── "5분 던전" 콘텐츠 정의(서버 권위) — 영웅 3종 + 던전 1개(몬스터10+함정2+포션2+보스1) ──────
// 원작 "5-Minute Dungeon" 의 정확한 카드 텍스트/수량은 기억에 확신이 없어 그대로 베끼지 않았다.
// 메커니즘(아이콘 매칭, 개인 덱 히든드로우, 함정/포션/보스, 5분 타이머)은 재현하되 영웅 이름·카드
// 구성·몬스터 목록은 이 프로젝트 오리지널이다. 클라(src/dungeon/data.ts)는 이 표의 라벨/색만 자체
// 보관(표시 전용) — 실제 덱 구성·순서·판정 로직의 진실원본은 이 파일 하나뿐이다.

export type Icon = 'str' | 'mag' | 'agi';
export type CardIcon = Icon | 'wild';

export interface HeroDef {
  id: string;
  name: string;
  primary: Icon;
  secondary: Icon;
  special: { name: string; desc: string };
}

// 개인 덱 15장 구성 스펙: 주 아이콘 9장(1값×6, 2값×2, 3값×1) + 보조 아이콘 3장(1값) +
// 와일드 2장(1값, 아무 아이콘으로나 인정) + 고유 특수카드 1장(요구치엔 안 쓰고 useSpecial 전용).
export const HEROES: HeroDef[] = [
  {
    id: 'barbarian',
    name: '바바리안',
    primary: 'str',
    secondary: 'agi',
    special: { name: '결전의 함성', desc: '즉시 현재 요구치 한 항목에 3만큼 기여(손패 소모 없음)' },
  },
  {
    id: 'wizard',
    name: '위저드',
    primary: 'mag',
    secondary: 'str',
    special: { name: '치유의 주문', desc: '즉시 파티 체력 +2' },
  },
  {
    id: 'ninja',
    name: '닌자',
    primary: 'agi',
    secondary: 'mag',
    special: { name: '그림자 밟기', desc: '즉시 손패를 상한까지 무료로 보충(버림 없음)' },
  },
];
export const HERO_BY_ID = new Map(HEROES.map((h) => [h.id, h]));

export interface CardSpec {
  icon: CardIcon;
  value: number;
  special?: boolean;
}
export function heroDeckSpec(hero: HeroDef): CardSpec[] {
  const cards: CardSpec[] = [];
  for (let i = 0; i < 6; i++) cards.push({ icon: hero.primary, value: 1 });
  for (let i = 0; i < 2; i++) cards.push({ icon: hero.primary, value: 2 });
  cards.push({ icon: hero.primary, value: 3 });
  for (let i = 0; i < 3; i++) cards.push({ icon: hero.secondary, value: 1 });
  for (let i = 0; i < 2; i++) cards.push({ icon: 'wild', value: 1 });
  cards.push({ icon: hero.primary, value: 0, special: true });
  return cards; // 6+2+1+3+2+1 = 15
}

export type Req = Partial<Record<Icon | 'any', number>>;
export type EventType = 'monster' | 'trap' | 'potion' | 'boss';
export interface EventDef {
  key: string;
  type: EventType;
  name: string;
  req?: Req; // monster/potion, boss 는 1페이즈 요구치
  req2?: Req; // boss 전용 2페이즈 요구치
  trapEffect?: { hpLoss: number; discardEach: number };
}

export const MONSTER_POOL: EventDef[] = [
  { key: 'slime', type: 'monster', name: '슬라임', req: { str: 2 } },
  { key: 'scout', type: 'monster', name: '고블린 정찰병', req: { agi: 2 } },
  { key: 'skeleton', type: 'monster', name: '해골 병사', req: { mag: 1, str: 1 } },
  { key: 'thief', type: 'monster', name: '도적', req: { agi: 1, mag: 1 } },
  { key: 'orc', type: 'monster', name: '오크 전사', req: { str: 3 } },
  { key: 'archer', type: 'monster', name: '다크엘프 궁수', req: { agi: 3 } },
  { key: 'cultist', type: 'monster', name: '리치의 하수인', req: { mag: 3 } },
  { key: 'troll', type: 'monster', name: '트롤', req: { str: 2, agi: 2 } },
  { key: 'necro', type: 'monster', name: '사령술사', req: { mag: 2, str: 1 } },
  { key: 'assassin', type: 'monster', name: '그림자 암살자', req: { agi: 2, mag: 1 } },
];
export const TRAP_POOL: EventDef[] = [
  { key: 'spikes', type: 'trap', name: '가시 함정', trapEffect: { hpLoss: 1, discardEach: 1 } },
  { key: 'fog', type: 'trap', name: '저주의 안개', trapEffect: { hpLoss: 1, discardEach: 1 } },
];
export const POTION_POOL: EventDef[] = [
  { key: 'potion1', type: 'potion', name: '치유의 물약', req: { any: 3 } },
  { key: 'potion2', type: 'potion', name: '활력의 영약', req: { any: 3 } },
];
export const BOSS: EventDef = {
  key: 'boss',
  type: 'boss',
  name: '던전의 군주',
  req: { str: 2, mag: 2, agi: 2 },
  req2: { any: 6 },
};

export const HAND_LIMIT = 5;
export const START_HP = 5;
export const MAX_HP = 7;
export const MAX_PARTY = 4;
export const RUN_MS = 5 * 60 * 1000;
export const POTION_HEAL = 1;
