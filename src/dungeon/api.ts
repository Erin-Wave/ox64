// ox64.app/5m — "5분 던전" 클라이언트. 트레이딩(src/services/api.ts)·퍼즐(src/puzzle/api.ts) 어느
// 쪽과도 재사용하지 않는 완전히 독립된 클라이언트다(번들 분리 유지). 로그인 세션 쿠키(ox64_sess)만
// 공유한다 — 같은 계정으로 트레이딩·퍼즐·던전을 오간다.

export type Icon = 'str' | 'mag' | 'agi' | 'hol' | 'nat';
export type CardIcon = Icon | 'wild';
export type EventType = 'monster' | 'trap' | 'potion' | 'boss';
export type RoomStatus = 'lobby' | 'active' | 'won' | 'lost';

export interface DungeonCard {
  id: string;
  icon: CardIcon;
  value: number;
  special?: boolean;
}
export interface HeroOut {
  id: string;
  name: string;
  blurb: string;
  primary: Icon;
  secondary: Icon;
  special: { name: string; desc: string };
}
export interface DungeonOut {
  id: string;
  name: string;
  desc: string;
  difficulty: number;
  startHp: number;
  monsters: number;
  traps: number;
  potions: number;
  boss: string;
}
export interface CurrentCard {
  key: string;
  type: EventType;
  name: string;
  // 서버는 Partial<Record<Icon|'any',number>> 로 보내지만, 클라는 Object.keys 로 순회만 하므로
  // 문자열 인덱스로 단순화해 불필요한 캐스팅을 피한다(런타임 형태는 동일).
  req: Record<string, number>;
  progress: Record<string, number>;
  phase?: number;
  /** 보스 1페이즈일 때만 — 2페이즈에서 요구할 값(미리 보여줘 준비할 수 있게) */
  req2?: Record<string, number>;
  /** 포션일 때만 — 격파 시 회복량 */
  heal?: number;
}
export interface LogEntry {
  k: string; // start|defeat|trap|ward|potion|phase|special|win|lose
  m: string;
  t: number;
}
export interface RoomOut {
  code: string;
  hostUserId: string;
  status: RoomStatus;
  hp: number;
  maxHp: number;
  ward: number;
  endsAt: number | null;
  startedAt: number | null;
  runMs: number;
  dungeonId: string;
  current: CurrentCard | null;
  cleared: number;
  totalEvents: number;
  log: LogEntry[];
}
export interface PlayerOut {
  userId: string;
  name: string;
  heroId: string;
  hand: DungeonCard[]; // 파티 전원에게 공개
  deckCount: number;
  discardCount: number;
  exhausted: boolean;
  usedSpecial: boolean;
  contributed: number;
}
export interface DungeonStats {
  gamesPlayed: number;
  wins: number;
  bestClearMs: number | null;
}
export interface DungeonState {
  stats: DungeonStats;
  room: RoomOut | null;
  players: PlayerOut[];
  heroes: HeroOut[];
  dungeons: DungeonOut[];
  myUserId: string;
  handLimit: number;
}

export class DungeonApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DungeonApiError';
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
  if (!res.ok) throw new DungeonApiError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

const post = (action: string, body: Record<string, unknown> = {}) =>
  req<DungeonState>('/dungeon', { method: 'POST', body: JSON.stringify({ action, ...body }) });

export const dungeonApi = {
  login: (name: string, passcode: string) => req<{ name: string }>('/login', { method: 'POST', body: JSON.stringify({ name, passcode }) }),
  logout: () => req<{ ok: boolean }>('/logout', { method: 'POST' }),
  state: () => req<DungeonState>('/dungeon'),
  create: () => post('create'),
  join: (code: string) => post('join', { code }),
  chooseDungeon: (dungeonId: string) => post('chooseDungeon', { dungeonId }),
  chooseHero: (heroId: string) => post('chooseHero', { heroId }),
  start: () => post('start'),
  /** 한 요청에 여러 장을 낼 수 있다(UI 의 "전부 내기"가 이걸 쓴다 — 클릭·요청 수를 줄여준다) */
  playCards: (plays: { cardId: string; target: string }[]) => post('playCards', { plays }),
  rest: () => post('rest'),
  useSpecial: (target?: string) => post('useSpecial', target ? { target } : {}),
  leave: () => post('leave'),
};
