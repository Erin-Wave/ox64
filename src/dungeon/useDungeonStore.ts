import { create } from 'zustand';
import {
  dungeonApi,
  DungeonApiError,
  type DungeonOut,
  type DungeonState,
  type DungeonStats,
  type HeroOut,
  type PlayerOut,
  type RoomOut,
} from './api';
import { planAutoPlay } from './data';

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
  dungeons: DungeonOut[];
  myUserId: string | null;
  handLimit: number;
  busy: boolean;
  error: string | null;
  toast: Toast | null;
  polling: boolean;

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  create: () => Promise<void>;
  join: (code: string) => Promise<void>;
  chooseDungeon: (dungeonId: string) => Promise<void>;
  chooseHero: (heroId: string) => Promise<void>;
  start: () => Promise<void>;
  playCard: (cardId: string, target: string) => Promise<void>;
  /** 손패에서 지금 낼 수 있는 카드를 한 번에 다 낸다(요청·클릭 수 절감) */
  autoPlay: () => Promise<void>;
  rest: () => Promise<void>;
  useSpecial: (target?: string) => Promise<void>;
  leave: () => Promise<void>;
  poll: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  dismissError: () => void;
  dismissToast: () => void;
}

function msgOf(e: unknown, fallback: string): string {
  return e instanceof DungeonApiError ? e.message : fallback;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
/** 직전에 반영한 서버 응답의 직렬화본 — 같으면 setState 를 건너뛴다(0.5초 폴링이 매번 전체
 * 리렌더를 일으키지 않게. 타이머 카운트다운은 GameBoard 의 자체 1초 틱이 따로 굴린다). */
let lastSnapshot = '';

/** 폴링 간격 — 진행 중일 때만 촘촘히 본다. 로비/종료/대기는 바뀔 일이 드물어 느슨하게.
 * ⚠ 서버 GET 은 D1 왕복 2회·쓰기 0회로 맞춰져 있다(functions/api/dungeon.ts 상단 주석) —
 * 이 간격을 더 줄이려면 그 비용부터 다시 확인할 것(D1 무료 플랜은 쓰기 한도가 빡빡하다). */
function delayFor(room: RoomOut | null): number {
  if (!room) return 4000; // 방이 없으면 내 액션 말고는 바뀔 게 없다
  if (room.status === 'active') return 500;
  if (room.status === 'lobby') return 1000;
  return 2000; // won/lost — 결과 화면
}

export const useDungeonStore = create<Store>((set, get) => {
  const applyState = (s: DungeonState) => {
    const prev = get().room;
    let toast: Toast | null = null;
    if (prev?.status === 'active' && s.room?.status === 'won') toast = { kind: 'win', text: '던전 클리어!' };
    else if (prev?.status === 'active' && s.room?.status === 'lost') toast = { kind: 'lose', text: '던전 실패…' };
    const snap = JSON.stringify(s);
    if (snap === lastSnapshot && !toast) return; // 변화 없음 → 리렌더 유발하지 않음
    lastSnapshot = snap;
    set({
      stats: s.stats,
      room: s.room,
      players: s.players,
      heroes: s.heroes,
      dungeons: s.dungeons,
      myUserId: s.myUserId,
      handLimit: s.handLimit,
      ...(toast ? { toast } : {}),
    });
  };

  /** 액션 공통 래퍼 — busy 토글 + 에러 메시지 처리를 한 곳에 모은다. */
  const run = async (fn: () => Promise<DungeonState>, fallback: string) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      applyState(await fn());
    } catch (e) {
      set({ error: msgOf(e, fallback) });
    } finally {
      set({ busy: false });
    }
  };

  return {
    ready: false,
    authed: false,
    name: null,
    stats: { gamesPlayed: 0, wins: 0, bestClearMs: null },
    room: null,
    players: [],
    heroes: [],
    dungeons: [],
    myUserId: null,
    handLimit: 5,
    busy: false,
    error: null,
    toast: null,
    polling: false,

    init: async () => {
      try {
        applyState(await dungeonApi.state());
        set({ authed: true, ready: true });
      } catch {
        set({ authed: false, ready: true });
      }
    },

    login: async (name, passcode) => {
      set({ busy: true, error: null });
      try {
        await dungeonApi.login(name, passcode);
        lastSnapshot = '';
        applyState(await dungeonApi.state());
        set({ authed: true, name, busy: false });
      } catch (e) {
        set({ busy: false, error: msgOf(e, '로그인에 실패했습니다') });
      }
    },

    logout: async () => {
      get().stopPolling();
      await dungeonApi.logout().catch(() => {});
      lastSnapshot = '';
      set({ authed: false, name: null, room: null, players: [] });
    },

    create: () => run(() => dungeonApi.create(), '방을 만들지 못했습니다'),
    join: (code) => run(() => dungeonApi.join(code), '참가하지 못했습니다'),
    chooseDungeon: (dungeonId) => run(() => dungeonApi.chooseDungeon(dungeonId), '던전을 바꾸지 못했습니다'),
    chooseHero: (heroId) => run(() => dungeonApi.chooseHero(heroId), '선택하지 못했습니다'),
    start: () => run(() => dungeonApi.start(), '시작하지 못했습니다'),
    playCard: (cardId, target) => run(() => dungeonApi.playCards([{ cardId, target }]), '카드를 낼 수 없습니다'),
    rest: () => run(() => dungeonApi.rest(), '휴식할 수 없습니다'),
    useSpecial: (target) => run(() => dungeonApi.useSpecial(target), '사용할 수 없습니다'),
    leave: () => run(() => dungeonApi.leave(), '나가지 못했습니다'),

    autoPlay: async () => {
      const { room, players, myUserId } = get();
      const me = players.find((p) => p.userId === myUserId);
      if (!room?.current || !me) return;
      const plays = planAutoPlay(me.hand, room.current.req, room.current.progress);
      if (plays.length === 0) return;
      await run(() => dungeonApi.playCards(plays), '카드를 낼 수 없습니다');
    },

    poll: async () => {
      if (pollInFlight || !get().authed) return;
      pollInFlight = true;
      try {
        applyState(await dungeonApi.state());
      } catch {
        /* 일시적 네트워크 오류는 무시(다음 틱에 재시도) — 로그아웃시키지 않는다 */
      } finally {
        pollInFlight = false;
      }
    },

    // setInterval 이 아니라 자기 자신을 다시 예약하는 setTimeout 루프 — 매 틱마다 현재 방 상태로
    // 간격을 다시 계산할 수 있어서(진행 중 0.5초 / 로비 1초 / 대기 4초) 인터벌을 갈아끼울 필요가 없다.
    startPolling: () => {
      if (pollTimer || get().polling) return;
      set({ polling: true });
      const tick = async () => {
        pollTimer = null;
        if (!get().polling) return;
        await get().poll();
        if (!get().polling) return;
        pollTimer = setTimeout(tick, delayFor(get().room));
      };
      pollTimer = setTimeout(tick, delayFor(get().room));
    },
    stopPolling: () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      set({ polling: false });
    },

    dismissError: () => set({ error: null }),
    dismissToast: () => set({ toast: null }),
  };
});
