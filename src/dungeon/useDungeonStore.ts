import { create } from 'zustand';
import { dungeonApi, DungeonApiError, type DungeonState, type HeroOut, type PlayerOut, type RoomOut, type DungeonStats } from './api';

export interface Toast {
  kind: 'info' | 'win' | 'lose';
  text: string;
}

interface Store {
  ready: boolean;
  authed: boolean;
  name: string | null;
  stats: DungeonStats;
  room: RoomOut | null;
  players: PlayerOut[];
  heroes: HeroOut[];
  myUserId: string | null;
  busy: boolean;
  error: string | null;
  toast: Toast | null;
  polling: boolean;

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  create: () => Promise<void>;
  join: (code: string) => Promise<void>;
  chooseHero: (heroId: string) => Promise<void>;
  start: () => Promise<void>;
  playCard: (cardId: string, target: string) => Promise<void>;
  rest: () => Promise<void>;
  useSpecial: (target?: string) => Promise<void>;
  leave: () => Promise<void>;
  poll: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  dismissToast: () => void;
}

function msgOf(e: unknown, fallback: string): string {
  return e instanceof DungeonApiError ? e.message : fallback;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function applyState(set: (partial: Partial<Store>) => void, s: DungeonState, prevRoom: RoomOut | null) {
  let toast: Toast | null = null;
  if (prevRoom?.status === 'active' && s.room?.status === 'won') toast = { kind: 'win', text: '던전 클리어!' };
  else if (prevRoom?.status === 'active' && s.room?.status === 'lost') toast = { kind: 'lose', text: '던전 실패…' };
  set({ stats: s.stats, room: s.room, players: s.players, heroes: s.heroes, myUserId: s.myUserId, ...(toast ? { toast } : {}) });
}

export const useDungeonStore = create<Store>((set, get) => ({
  ready: false,
  authed: false,
  name: null,
  stats: { gamesPlayed: 0, wins: 0, bestClearMs: null },
  room: null,
  players: [],
  heroes: [],
  myUserId: null,
  busy: false,
  error: null,
  toast: null,
  polling: false,

  init: async () => {
    try {
      const s = await dungeonApi.state();
      applyState(set, s, null);
      set({ authed: true, ready: true });
    } catch {
      set({ authed: false, ready: true });
    }
  },

  login: async (name, passcode) => {
    set({ busy: true, error: null });
    try {
      await dungeonApi.login(name, passcode);
      const s = await dungeonApi.state();
      applyState(set, s, null);
      set({ authed: true, name, busy: false });
    } catch (e) {
      set({ busy: false, error: msgOf(e, '로그인에 실패했습니다') });
    }
  },

  logout: async () => {
    get().stopPolling();
    await dungeonApi.logout().catch(() => {});
    set({ authed: false, name: null, room: null, players: [] });
  },

  create: async () => {
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.create(), get().room);
    } catch (e) {
      set({ error: msgOf(e, '방을 만들지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  join: async (code) => {
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.join(code), get().room);
    } catch (e) {
      set({ error: msgOf(e, '참가하지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  chooseHero: async (heroId) => {
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.chooseHero(heroId), get().room);
    } catch (e) {
      set({ error: msgOf(e, '선택하지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  start: async () => {
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.start(), get().room);
    } catch (e) {
      set({ error: msgOf(e, '시작하지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  playCard: async (cardId, target) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.playCards([{ cardId, target }]), get().room);
    } catch (e) {
      set({ error: msgOf(e, '카드를 낼 수 없습니다') });
    } finally {
      set({ busy: false });
    }
  },

  rest: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.rest(), get().room);
    } catch (e) {
      set({ error: msgOf(e, '휴식할 수 없습니다') });
    } finally {
      set({ busy: false });
    }
  },

  useSpecial: async (target) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.useSpecial(target), get().room);
    } catch (e) {
      set({ error: msgOf(e, '사용할 수 없습니다') });
    } finally {
      set({ busy: false });
    }
  },

  leave: async () => {
    set({ busy: true, error: null });
    try {
      applyState(set, await dungeonApi.leave(), null);
    } catch (e) {
      set({ error: msgOf(e, '나가지 못했습니다') });
    } finally {
      set({ busy: false });
    }
  },

  poll: async () => {
    if (pollInFlight || !get().authed) return;
    pollInFlight = true;
    try {
      const s = await dungeonApi.state();
      applyState(set, s, get().room);
    } catch {
      /* 일시적 네트워크 오류는 무시(다음 틱에 재시도) — 로그아웃시키지 않는다 */
    } finally {
      pollInFlight = false;
    }
  },

  startPolling: () => {
    if (pollTimer) return;
    set({ polling: true });
    pollTimer = setInterval(() => get().poll(), 1000);
  },
  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    set({ polling: false });
  },

  dismissToast: () => set({ toast: null }),
}));
