import { create } from 'zustand';
import { puzzleApi, PuzzleApiError, type PuzzleGame, type PuzzleLevelInfo, type PuzzleState } from './api';

export interface Toast {
  kind: 'found' | 'clear' | 'over';
  text: string;
}

interface Store {
  ready: boolean;
  authed: boolean;
  name: string | null;
  currency: number;
  bestLevel: number;
  gamesPlayed: number;
  gamesWon: number;
  refillsLeft: number;
  activeGame: PuzzleGame | null;
  levels: PuzzleLevelInfo[];
  busy: boolean;
  error: string | null;
  toast: Toast | null;

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  start: (level: number) => Promise<void>;
  open: (x: number, y: number) => Promise<void>;
  abandon: () => Promise<void>;
  refill: () => Promise<void>;
  dismissToast: () => void;
  /** 서버 호출 없이 로컬에서만 레벨 선택 화면으로 되돌아간다(승/패로 이미 끝난 판을 접을 때). */
  backToLevels: () => void;
}

function msgOf(e: unknown, fallback: string): string {
  return e instanceof PuzzleApiError ? e.message : fallback;
}

export const usePuzzleStore = create<Store>((set, get) => ({
  ready: false,
  authed: false,
  name: null,
  currency: 0,
  bestLevel: 0,
  gamesPlayed: 0,
  gamesWon: 0,
  refillsLeft: 0,
  activeGame: null,
  levels: [],
  busy: false,
  error: null,
  toast: null,

  init: async () => {
    try {
      const s: PuzzleState = await puzzleApi.state();
      set({ ...s, authed: true, ready: true });
    } catch {
      set({ authed: false, ready: true });
    }
  },

  login: async (name, passcode) => {
    set({ busy: true, error: null });
    try {
      await puzzleApi.login(name, passcode);
      const s = await puzzleApi.state();
      set({ ...s, authed: true, name, busy: false });
    } catch (e) {
      set({ busy: false, error: msgOf(e, '로그인에 실패했습니다') });
    }
  },

  logout: async () => {
    await puzzleApi.logout().catch(() => {});
    set({ authed: false, activeGame: null, name: null });
  },

  start: async (level) => {
    set({ busy: true, error: null });
    try {
      const s = await puzzleApi.start(level);
      set({ ...s });
    } catch (e) {
      set({ error: msgOf(e, '시작하지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  open: async (x, y) => {
    const game = get().activeGame;
    if (!game || game.status !== 'active' || get().busy) return;
    if (game.cells.some((c) => c.x === x && c.y === y)) return;
    set({ busy: true, error: null });
    try {
      const r = await puzzleApi.open(game.id, x, y);
      // 서버의 activeGame 은 status='active' 인 판만 찾아 내려주므로, 이 오픈으로 판이 끝났으면(won/lost)
      // 거기선 null 이 온다 — 로컬에 들고 있던 보드에 이번 칸 결과만 이어붙여 항상 완전한 상태를 유지한다.
      // legend(범례)도 같은 이유로: 판이 안 끝났으면 서버가 다시 계산해 내려준 걸 쓰고, 끝났으면 로컬
      // legend 에서 방금 완성된 보석 종류(label 로 매칭)의 found 만 +1 해서 흉내낸다.
      const legend = r.activeGame
        ? r.activeGame.legend
        : game.legend.map((l) => (r.justCompleted && l.label === r.justCompleted.label ? { ...l, found: l.found + 1 } : l));
      const updatedGame: PuzzleGame = {
        ...game,
        cells: [...game.cells, r.cell],
        gemsFound: r.justCompleted ? game.gemsFound + 1 : game.gemsFound,
        legend,
        spent: game.spent + (get().levels.find((l) => l.level === game.level)?.costPerOpen ?? 1),
        status: r.gameStatus,
      };
      let toast: Toast | null = null;
      if (r.gameStatus === 'won') toast = { kind: 'clear', text: `클리어! +${r.reward} 재화` };
      else if (r.gameStatus === 'lost') toast = { kind: 'over', text: '재화가 바닥났습니다. 게임 오버' };
      else if (r.justCompleted) toast = { kind: 'found', text: `${r.justCompleted.label} 획득!` };
      set({
        currency: r.currency,
        bestLevel: r.bestLevel,
        gamesPlayed: r.gamesPlayed,
        gamesWon: r.gamesWon,
        refillsLeft: r.refillsLeft,
        levels: r.levels,
        activeGame: updatedGame,
        toast,
      });
    } catch (e) {
      set({ error: msgOf(e, '실패했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  abandon: async () => {
    const game = get().activeGame;
    if (!game) return;
    set({ busy: true });
    try {
      const s = await puzzleApi.abandon(game.id);
      set({ ...s });
    } finally {
      set({ busy: false });
    }
  },

  refill: async () => {
    set({ busy: true, error: null });
    try {
      const s = await puzzleApi.refill();
      set({ ...s });
    } catch (e) {
      set({ error: msgOf(e, '리필하지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  dismissToast: () => set({ toast: null }),
  backToLevels: () => set({ activeGame: null }),
}));
