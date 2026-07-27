// ── 테란 유닛/건물 스펙 ────────────────────────────────────────────────────────
// 원작 수치를 그대로 옮긴 게 아니라 **감각만 맞춘 오리지널 밸런스**다(마린이 싸고 약하다,
// 탱크는 비싸고 사거리가 길다, 일꾼이 자원을 나른다 같은 관계). 웹에서 한 판이 5~10분에
// 끝나도록 건설/생산 시간을 원작보다 짧게 잡았다. 밸런스를 만지려면 이 파일만 보면 된다.
import { TILE } from './types';

export interface UnitSpec {
  id: string;
  name: string;
  hp: number;
  costM: number;
  costG: number;
  supply: number;
  buildTime: number; // 초
  dmg: number;
  range: number; // px (0에 가까우면 근접)
  cooldown: number; // 공격 간격(초)
  speed: number; // px/초
  sight: number; // px — 시야(전장의 안개)
  radius: number; // px — 충돌/선택 반경
  splash?: number; // px — 있으면 그 반경 내 적에게 절반 피해
  isWorker?: boolean;
  from: string; // 이 유닛을 뽑는 건물 id
  requires?: string; // 선행 건물 id
  hotkey: string;
  desc: string;
}

export const UNITS: Record<string, UnitSpec> = {
  scv: {
    id: 'scv',
    name: '일꾼',
    hp: 60,
    costM: 50,
    costG: 0,
    supply: 1,
    buildTime: 10,
    dmg: 5,
    range: 4,
    cooldown: 0.9,
    speed: 78,
    sight: 8 * TILE,
    radius: 8,
    isWorker: true,
    from: 'cc',
    hotkey: 'S',
    desc: '자원을 캐고 건물을 짓는다. 싸움에는 거의 쓸모가 없다.',
  },
  marine: {
    id: 'marine',
    name: '마린',
    hp: 40,
    costM: 50,
    costG: 0,
    supply: 1,
    buildTime: 12,
    dmg: 6,
    range: 4.2 * TILE,
    cooldown: 0.6,
    speed: 70,
    sight: 8 * TILE,
    radius: 8,
    from: 'barracks',
    hotkey: 'M',
    desc: '싸고 빠르게 뽑히는 기본 원거리 보병. 뭉쳐야 강하다.',
  },
  firebat: {
    id: 'firebat',
    name: '파이어뱃',
    hp: 55,
    costM: 50,
    costG: 25,
    supply: 1,
    buildTime: 14,
    dmg: 14,
    range: 1.6 * TILE,
    cooldown: 1.1,
    speed: 68,
    sight: 7 * TILE,
    radius: 9,
    splash: 26,
    from: 'barracks',
    requires: 'refinery',
    hotkey: 'F',
    desc: '사거리는 짧지만 붙으면 화력이 강하고 주변까지 태운다.',
  },
  tank: {
    id: 'tank',
    name: '시즈탱크',
    hp: 160,
    costM: 150,
    costG: 100,
    supply: 2,
    buildTime: 22,
    dmg: 32,
    range: 7 * TILE,
    cooldown: 1.6,
    speed: 48,
    sight: 9 * TILE,
    radius: 12,
    splash: 34,
    from: 'factory',
    hotkey: 'T',
    desc: '사거리가 가장 길고 범위 피해를 준다. 느리고 비싸다.',
  },
};

export interface BuildingSpec {
  id: string;
  name: string;
  hp: number;
  costM: number;
  costG: number;
  buildTime: number; // 초
  w: number; // 타일
  h: number;
  sight: number; // px
  supply?: number; // 인구 제공량
  produces?: string[];
  dropoff?: boolean; // 일꾼이 자원을 반납할 수 있는 곳
  onGeyser?: boolean; // 가스 간헐천 위에만 지을 수 있음
  requires?: string;
  hotkey: string;
  desc: string;
}

export const BUILDINGS: Record<string, BuildingSpec> = {
  cc: {
    id: 'cc',
    name: '커맨드 센터',
    hp: 1500,
    costM: 400,
    costG: 0,
    buildTime: 40,
    w: 4,
    h: 3,
    sight: 10 * TILE,
    supply: 10,
    produces: ['scv'],
    dropoff: true,
    hotkey: 'C',
    desc: '일꾼을 뽑고 자원을 받는다. 인구 10.',
  },
  depot: {
    id: 'depot',
    name: '서플라이 디팟',
    hp: 500,
    costM: 100,
    costG: 0,
    buildTime: 18,
    w: 2,
    h: 2,
    sight: 6 * TILE,
    supply: 8,
    hotkey: 'D',
    desc: '인구를 8 늘린다. 인구가 막히면 유닛을 못 뽑는다.',
  },
  barracks: {
    id: 'barracks',
    name: '배럭',
    hp: 1000,
    costM: 150,
    costG: 0,
    buildTime: 24,
    w: 3,
    h: 2,
    sight: 7 * TILE,
    produces: ['marine', 'firebat'],
    hotkey: 'B',
    desc: '마린과 파이어뱃을 뽑는다.',
  },
  refinery: {
    id: 'refinery',
    name: '리파이너리',
    hp: 750,
    costM: 100,
    costG: 0,
    buildTime: 18,
    w: 3,
    h: 2,
    sight: 6 * TILE,
    dropoff: false,
    onGeyser: true,
    hotkey: 'R',
    desc: '가스 간헐천 위에 지어 가스를 캘 수 있게 한다.',
  },
  factory: {
    id: 'factory',
    name: '팩토리',
    hp: 1250,
    costM: 200,
    costG: 100,
    buildTime: 30,
    w: 3,
    h: 3,
    sight: 7 * TILE,
    produces: ['tank'],
    requires: 'barracks',
    hotkey: 'F',
    desc: '시즈탱크를 뽑는다. 배럭이 먼저 있어야 한다.',
  },
};

/** 일꾼이 지을 수 있는 건물 목록(커맨드 카드 순서) */
export const BUILD_ORDER = ['depot', 'barracks', 'refinery', 'factory', 'cc'];

export const isUnit = (type: string) => type in UNITS;
export const isBuilding = (type: string) => type in BUILDINGS;
export const specOf = (type: string): UnitSpec | BuildingSpec | undefined => UNITS[type] ?? BUILDINGS[type];
export const nameOf = (type: string): string =>
  UNITS[type]?.name ?? BUILDINGS[type]?.name ?? (type === 'mineral' ? '미네랄' : type === 'geyser' ? '베스핀 간헐천' : type);

/** 팀 색 — 플레이어는 파랑, 적은 빨강(원작 색 감각) */
export const TEAM_COLOR = ['#4aa3ff', '#ff5a5a'];
export const TEAM_DARK = ['#1d4e80', '#7a2020'];
