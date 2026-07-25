// ox64.app/b — "스핑크스 보석찾기" 퍼즐게임 클라이언트. 코인 트레이딩(src/services/api.ts)과 완전히
// 분리된 별도 클라이언트다(재화가 다르고, 이 페이지는 트레이딩 상태를 로드할 필요가 없다). 로그인
// 세션 쿠키(ox64_sess)만 /api/login 을 통해 공유한다 — 같은 계정으로 트레이딩·퍼즐 양쪽을 오간다.

export interface Connects {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}
export interface PuzzleCell {
  x: number;
  y: number;
  gemId: string | null;
  label?: string | null;
  color?: string | null;
  /** 이 칸이 속한 보석이 상하좌우 어느 방향으로 더 이어지는지(색+부위를 보고 유추하는 원작 방식) */
  connects?: Connects;
}
/** 이 보드에 실제로 숨어있는 보석 종류 목록(위치는 안 줌) — 색/모양/개수 + 그중 몇 개를 찾았는지 */
export interface PuzzleLegendItem {
  typeKey: string;
  label: string;
  color: string;
  shape: [number, number][];
  total: number;
  found: number;
}
export interface PuzzleGame {
  id: string;
  level: number;
  size: number;
  gemsTotal: number;
  gemsFound: number;
  cells: PuzzleCell[];
  legend: PuzzleLegendItem[];
  spent: number;
  status: 'active' | 'won' | 'lost' | 'abandoned';
}
export interface PuzzleLevelType {
  typeKey: string;
  label: string;
  color: string;
  shape: [number, number][];
  count: number;
}
export interface PuzzleLevelInfo {
  level: number;
  size: number;
  reward: number;
  gemsTotal: number;
  costPerOpen: number;
  types: PuzzleLevelType[];
}
export interface PuzzleState {
  currency: number;
  bestLevel: number;
  gamesPlayed: number;
  gamesWon: number;
  refillsLeft: number;
  activeGame: PuzzleGame | null;
  levels: PuzzleLevelInfo[];
}
export interface PuzzleOpenResult extends PuzzleState {
  gameStatus: 'active' | 'won' | 'lost';
  cell: PuzzleCell;
  justCompleted: { label: string; color: string } | null;
  reward: number;
}

export class PuzzleApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'PuzzleApiError';
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
  if (!res.ok) throw new PuzzleApiError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

export const puzzleApi = {
  login: (name: string, passcode: string) => req<{ name: string }>('/login', { method: 'POST', body: JSON.stringify({ name, passcode }) }),
  logout: () => req<{ ok: boolean }>('/logout', { method: 'POST' }),
  state: () => req<PuzzleState>('/puzzle'),
  start: (level: number) => req<PuzzleState>('/puzzle', { method: 'POST', body: JSON.stringify({ action: 'start', level }) }),
  open: (gameId: string, x: number, y: number) =>
    req<PuzzleOpenResult>('/puzzle', { method: 'POST', body: JSON.stringify({ action: 'open', gameId, x, y }) }),
  abandon: (gameId: string) => req<PuzzleState>('/puzzle', { method: 'POST', body: JSON.stringify({ action: 'abandon', gameId }) }),
  refill: () => req<PuzzleState>('/puzzle', { method: 'POST', body: JSON.stringify({ action: 'refill' }) }),
};
