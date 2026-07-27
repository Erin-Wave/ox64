// ── ox64.app/s1 "미니 RTS"(스타크래프트1 스타일) 도메인 타입 ─────────────────────────
// ⚠ 이 게임만 트레이딩/퍼즐/던전과 달리 **완전히 클라이언트에서 돌아간다**(서버·로그인 없음).
// RTS 는 초당 수십 회 시뮬레이션이 필요해서 Pages Functions + D1 폴링으로는 불가능하다
// (5분 던전이 0.5초 폴링인 걸 생각하면 40배 차이). 그래서 AI 대전 단일 플레이로 만들고,
// 전적도 서버가 아니라 localStorage 에 둔다 — 클라 시뮬이라 서버에 기록해봐야 위조 가능한
// "가짜 권위" 기록이 진짜 권위 기록(트레이딩 잔고 등) 옆에 생길 뿐이라서.

export const TILE = 24; // 타일 한 변(px)
export const MAP_W = 64;
export const MAP_H = 64;
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

/** 시뮬레이션 고정 틱 — 렌더는 rAF 로 매 프레임 돌지만 시뮬은 항상 이 간격으로만 전진한다
 * (프레임레이트에 따라 유닛 속도/공격속도가 달라지지 않게). */
export const TICK_MS = 1000 / 30;
export const TICK_S = TICK_MS / 1000;

export const PLAYER = 0;
export const ENEMY = 1;
export const NEUTRAL = -1;

export const SUPPLY_MAX = 200;
/** 미네랄 덩이 하나가 품은 총량 / 일꾼이 한 번에 들고 오는 양(원작과 같은 감각) */
export const MINERAL_PATCH = 1500;
export const GEYSER_AMOUNT = 5000;
export const CARRY_MINERAL = 8;
export const CARRY_GAS = 8;
export const MINE_TIME = 2.2; // 초 — 덩이에 붙어서 캐는 시간
export const GAS_TIME = 2.4;

export interface Vec {
  x: number;
  y: number;
}

export type OrderKind =
  | 'idle'
  | 'move'
  | 'attackMove' // 이동하다 적을 보면 교전(A + 클릭)
  | 'attack' // 특정 대상 공격
  | 'gather' // 자원 채집(캐고 → 반납 → 다시 캐기를 스스로 반복)
  | 'return' // 들고 있는 자원을 반납하러 가는 중
  | 'build' // 건물 지으러 가는 중 / 짓는 중
  | 'hold'; // 제자리 사수(적이 사거리에 들어오면 쏘되 움직이지 않음)

export interface Order {
  kind: OrderKind;
  /** 목표 지점(월드 좌표) */
  x?: number;
  y?: number;
  /** 목표 엔티티 id (공격 대상, 채집할 자원, 반납할 건물) */
  target?: number;
  /** build 명령 전용 — 무엇을 어느 타일에 지을지 */
  buildType?: string;
  bx?: number;
  by?: number;
}

export interface QueueItem {
  type: string;
  /** 남은 시간(초) */
  left: number;
  total: number;
}

export type EntityKind = 'unit' | 'building' | 'resource';

export interface Entity {
  id: number;
  kind: EntityKind;
  /** UNITS / BUILDINGS 의 키, 또는 자원이면 'mineral' | 'geyser' */
  type: string;
  owner: number; // PLAYER | ENEMY | NEUTRAL
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;

  // ── 유닛 전용 ──
  order: Order;
  path: Vec[];
  cooldown: number; // 남은 공격 쿨다운(초)
  carrying: number; // 들고 있는 자원량
  carryType: 'mineral' | 'gas' | null;
  /** 채집 중인 자원 엔티티 id — 반납 후 같은 자리로 돌아가기 위해 기억한다 */
  homeResource: number | null;
  mineTimer: number; // 자원에 붙어서 캐는 남은 시간
  /** 이동이 막혔는지 감지해 길을 다시 찾기 위한 값들 */
  stuck: number;
  lastX: number;
  lastY: number;

  // ── 건물 전용 ──
  /** 건설 중이면 0~1, 완성이면 1 */
  progress: number;
  buildLeft: number; // 남은 건설 시간(초)
  queue: QueueItem[];
  rally: Vec | null;
  /** 리파이너리가 올라간 가스 간헐천 id */
  geyser?: number;

  // ── 자원 전용 ──
  amount: number;
  /** 리파이너리가 지어졌으면 그 건물 id(간헐천은 그때부터 직접 캘 수 없다) */
  refinery?: number;
}

export interface Tracer {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  color: string;
}

export type GameStatus = 'playing' | 'won' | 'lost';

export interface PlayerState {
  minerals: number;
  gas: number;
  supplyUsed: number;
  supplyMax: number;
}
