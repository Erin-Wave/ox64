// ox64.app/5m — "5분 던전" 클라이언트. 트레이딩(src/services/api.ts)·퍼즐(src/puzzle/api.ts) 어느
// 쪽과도 재사용하지 않는 완전히 독립된 클라이언트다(번들 분리 유지). 로그인 세션 쿠키(ox64_sess)만
// 공유한다 — 같은 계정으로 트레이딩·퍼즐·던전을 오간다.

export type Icon = 'str' | 'mag' | 'agi';
export type CardIcon = Icon | 'wild';
export type EventType = 'monster' | 'trap' | 'potion' | 'boss';

export interface DungeonCard {
  id: string;
  icon: CardIcon;
  value: number;
  special?: boolean;
}
export interface HeroSpecial {
  name: string;
  desc: string;
}
export interface HeroOut {
  id: string;
  name: string;
  primary: Icon;
  secondary: Icon;
  special: HeroSpecial;
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
}
export interface RoomOut {
  code: string;
  hostUserId: string;
  status: 'lobby' | 'active' | 'won' | 'lost';
  hp: number;
  endsAt: number | null;
  startedAt: number | null;
  current: CurrentCard | null;
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
  myUserId: string;
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
  chooseHero: (heroId: string) => post('chooseHero', { heroId }),
  start: () => post('start'),
  playCards: (plays: { cardId: string; target: string }[]) => post('playCards', { plays }),
  rest: () => post('rest'),
  useSpecial: (target?: string) => post('useSpecial', target ? { target } : {}),
  leave: () => post('leave'),
};
