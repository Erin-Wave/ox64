import { create } from 'zustand';
import {
  api,
  ApiError,
  type ApiOrder,
  type ApiPendingOrder,
  type ApiConditionalOrder,
  type ApiPosition,
  type AppState,
  type SpotBookLevel,
  type SpotTrade,
  type SpotState,
} from '@/services/api';
import type { Candle, Side } from '@/types';
import { useMarketStore } from '@/store/useMarketStore';
import { intervalSec } from '@/symbols';

/**
 * 모의 트레이딩 상태 (서버 권위).
 * 잔고/포지션/주문의 진실원본은 서버(D1)이고, 스토어는 서버 응답의 캐시일 뿐.
 * 모든 변경은 /api/* 를 거치며 서버가 검증·계산한다 → 클라 조작 무의미.
 */
interface TradingState {
  ready: boolean; // 초기 세션 확인 완료
  authed: boolean;
  name: string | null;
  balance: number;
  refillsLeft: number;
  // VIP 등급(누적 거래대금에서 서버가 파생) + 그 등급의 수수료율. 헤더 뱃지·주문 수수료 예상액 표시용.
  vipTier: number;
  feeRate: number;
  vipNextAt: number | null;
  vipFrom: number;
  vipTiers: { tier: number; minVolume: number; rate: number }[];
  vipCurve: { baseVolume: number; growth: number; decay: number; minRate: number } | null;
  totalVolume: number;
  totalFees: number;
  positions: ApiPosition[];
  orders: ApiOrder[];
  pendingOrders: ApiPendingOrder[];
  conditionalOrders: ApiConditionalOrder[];
  // 서버가 내려준 보유 심볼 마크가격(크로스 가용 증거금 계산용 — 서버 강제청산/증거금 판정과 동일 시세).
  markPrices: Record<string, number>;
  busy: boolean;
  error: string | null;

  // OX/USDT 는 다른 심볼과 동일하게 레버리지로 거래된다(positions/orders 공용) — 이 두 필드는
  // 호가창·체결내역 "표시용" 시장 데이터일 뿐(유저 개인 데이터 아님, 봇이 만든 합성 시장).
  spotBook: { bids: SpotBookLevel[]; asks: SpotBookLevel[] };
  spotTrades: SpotTrade[];
  /** 통합 폴링이 받아온 **최근 N봉**(§ spotTick). 차트가 자기 배열에 병합해 그린다 — 전체 목록이 아니다. */
  spotCandles: Candle[];
  /** 위 봉들이 갱신된 시각(ms). 차트가 "새 데이터인가"를 이걸로 판단한다(배열 비교 대신). */
  spotCandlesAt: number;
  /** 위 봉들이 **어느 페어·인터벌의 것인지**(`pair|interval`). ⚠ 차트가 이걸 대조하지 않으면 인터벌을
   * 바꾼 직후 한 프레임 동안 **이전 인터벌의 봉**을 새 인터벌인 것처럼 그린다(효과 실행 순서상 차트가
   * 먼저 돌고 폴링의 초기화가 나중에 오기 때문). */
  spotCandlesKey: string;
  /** 계정 상태를 마지막으로 반영한 시각(ms) — useTriggerPoll 이 중복 폴링을 건너뛰는 데 쓴다. */
  stateAt: number;

  init: () => Promise<void>;
  login: (name: string, passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  openMarket: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) => Promise<void>;
  closePosition: (id: string, size?: number) => Promise<void>;
  limitClose: (positionId: string, size: number, limitPrice: number) => Promise<void>;
  limitOpen: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    limitPrice: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) => Promise<void>;
  cancelLimit: (pendingId: string) => Promise<void>;
  editLimit: (pendingId: string, p: { limitPrice?: number; size?: number }) => Promise<void>;
  setSlTp: (positionId: string, p: { stopLoss: number | null; takeProfit: number | null }) => Promise<void>;
  conditionalOpen: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    triggerPrice: number;
    triggerDir: 'above' | 'below';
    repeating?: boolean; // 무한(반복) 조건부
    repeatMode?: 'continuous' | 'rearm';
    rearmPrice?: number | null;
    cooldownSec?: number | null;
    maxFills?: number | null;
  }) => Promise<void>;
  editConditional: (
    conditionalId: string,
    p: {
      triggerPrice?: number;
      size?: number;
      triggerDir?: 'above' | 'below';
      leverage?: number;
      repeating?: boolean;
      repeatMode?: 'continuous' | 'rearm';
      rearmPrice?: number | null;
      cooldownSec?: number | null;
      maxFills?: number | null;
    },
  ) => Promise<void>;
  cancelConditional: (conditionalId: string) => Promise<void>;
  refill: () => Promise<void>;

  spotRefresh: (pair: string) => Promise<void>;
  /** 호가·체결·캔들(+주기적으로 계정 상태)을 **한 요청**으로 갱신한다(§ api.spotTick). */
  spotTick: (pair: string, interval: string) => Promise<void>;
  /** 페어를 바꿀 때 이전 코인의 호가/체결을 즉시 비운다(§ useSpotPoll). */
  spotClear: () => void;
}

/** 증분으로 받은 주문들을 기존 목록 앞에 붙인다(둘 다 최신순). 중복 id 는 새 쪽을 남기고,
 * 서버가 주는 것과 같은 50건으로 자른다 — 그 이상은 어차피 화면에 안 쓰고 메모리만 먹는다. */
const ORDER_HISTORY_MAX = 50;
function mergeOrders(fresh: AppState['orders']): AppState['orders'] {
  const prev = useTradingStore.getState().orders;
  if (prev.length === 0) return fresh;
  const seen = new Set(fresh.map((o) => o.id));
  return [...fresh, ...prev.filter((o) => !seen.has(o.id))].slice(0, ORDER_HISTORY_MAX);
}

function apply(set: (s: Partial<TradingState>) => void, st: AppState) {
  set({
    authed: true,
    name: st.name,
    balance: st.balance,
    refillsLeft: st.refillsLeft,
    vipTier: st.vipTier ?? 0,
    feeRate: st.feeRate ?? 0.0003,
    vipNextAt: st.vipNextAt ?? null,
    vipFrom: st.vipFrom ?? 0,
    vipTiers: st.vipTiers ?? [],
    vipCurve: st.vipCurve ?? null,
    totalVolume: st.totalVolume ?? 0,
    totalFees: st.totalFees ?? 0,
    positions: st.positions,
    // ⚠ 증분 응답이면 기존 목록에 합친다(§ api.ts ordersPartial). 서버가 경계를 `>=` 로 잡아 마지막
    // 1건이 중복으로 올 수 있으므로 id 로 거른다 — 같은 밀리초에 두 건이 체결돼도 안 새게 하려는 것.
    orders: st.ordersPartial ? mergeOrders(st.orders) : st.orders,
    pendingOrders: st.pendingOrders,
    conditionalOrders: st.conditionalOrders ?? [],
    markPrices: st.markPrices ?? {},
    error: null,
    stateAt: Date.now(), // useTriggerPoll 이 "방금 갱신됐으니 건너뛰자"를 판단하는 기준
  });
  // 서버 마크가격을 가격 맵에 시드 — 보유 심볼(OX 포함, 현재 보고 있지 않아도)의 청산가/미실현PnL 이
  // 폴링을 기다리지 않고 즉시, 그리고 서버 강제청산 판정과 동일한 시세로 계산된다(청산가 안 찍히던 버그 수정).
  if (st.markPrices) {
    const setPrice = useMarketStore.getState().setPrice;
    for (const [sym, price] of Object.entries(st.markPrices)) {
      if (typeof price === 'number' && isFinite(price) && price > 0) setPrice(sym, price);
    }
  }
}
// ⚠ 체결 목록을 **0.5초 간격 2슬라이스로 흘려보낸다**(2026-08-19). 봇 틱 하나가 한 번에 3~12건을
// 찍으므로 폴링(1초)마다 그 묶음이 통째로 top 에 꽂혀, 실제로는 초당 수 건이 흐르는 시장인데도 화면은
// "1초에 한 번 덜컥" 갱신되는 것처럼 보였다. 도착한 묶음을 시간순으로 절반씩 보여주면 목록이 초당 두 번
// 흐른다 — **이미 받은 데이터를 순서대로 내보내는 것이라 서버 요청·D1 읽기·쓰기가 하나도 늘지 않는다**
// (가상 코인은 폴링 주기를 못 줄인다 — 요청 10만/일·쓰기 10만/일 한도, CLAUDE.md §6).
// 대가는 딱 하나: 이번 묶음의 **가장 새 체결이 최대 0.5초 늦게** 보인다(그동안 헤더 현재가·차트는
// 예전처럼 즉시 갱신되므로, 목록 맨 위가 현재가를 0.5초 뒤따라간다 = 실제 거래소 테이프와 같은 모양).
// 호가 사다리는 봇 틱당 스냅샷이 **하나뿐**이라 여기서 쪼갤 게 없다(그대로 1초).
const REVEAL_SLICE_MS = 500; // useSpotPoll 폴링 간격(1초)의 절반 — 슬라이스 2개
let dripTimer: number | undefined;
function clearDrip() {
  if (dripTimer === undefined) return;
  clearTimeout(dripTimer);
  dripTimer = undefined;
}

/** 새로 온 체결을 절반만 먼저 보여주고 나머지는 REVEAL_SLICE_MS 뒤에. 목록은 최신이 [0] 이라
 * 뒤쪽이 과거다 — 그래서 "앞에서 half 개를 뺀 것"이 오래된 절반이 된다. */
function dripTrades(set: (s: Partial<TradingState>) => void, incoming: SpotTrade[]) {
  // 새 배치가 왔으면 직전 배치의 남은 슬라이스는 버린다 — 그 체결들은 이 배치에도 들어있다.
  clearDrip();
  const shown = useTradingStore.getState().spotTrades;
  const lastShown = shown[0]?.createdAt ?? 0;
  // ⚠ 식별은 id 가 아니라 **시각(createdAt)** 으로 한다. 봇 테이프는 링 버퍼(TAPE_MAX=400)라 넘칠 때
  // 인덱스가 밀리고, id 가 `t<시각>-<인덱스>` 합성이라 같은 체결의 id 가 폴링마다 바뀐다.
  const firstOld = incoming.findIndex((t) => t.createdAt <= lastShown);
  const fresh = firstOld < 0 ? incoming.length : firstOld;
  // 첫 로드(보여준 게 없음)나 새 체결이 0~1건이면 나눌 이유가 없다.
  if (lastShown === 0 || fresh <= 1) {
    set({ spotTrades: incoming });
    return;
  }
  const half = Math.ceil(fresh / 2);
  set({ spotTrades: incoming.slice(half) });
  dripTimer = window.setTimeout(() => {
    dripTimer = undefined;
    set({ spotTrades: incoming });
  }, REVEAL_SLICE_MS);
}

function applySpot(set: (s: Partial<TradingState>) => void, st: SpotState) {
  set({ spotBook: st.book });
  dripTrades(set, st.trades);
}

export const useTradingStore = create<TradingState>((set) => ({
  ready: false,
  authed: false,
  name: null,
  balance: 0,
  refillsLeft: 3,
  vipTier: 0,
  feeRate: 0.0003,
  vipNextAt: null,
  vipFrom: 0,
  vipTiers: [],
  vipCurve: null,
  totalVolume: 0,
  totalFees: 0,
  positions: [],
  orders: [],
  pendingOrders: [],
  conditionalOrders: [],
  markPrices: {},
  busy: false,
  error: null,

  spotBook: { bids: [], asks: [] },
  spotTrades: [],
  spotCandles: [],
  spotCandlesAt: 0,
  spotCandlesKey: '',
  stateAt: 0,

  // 앱 시작 시 기존 세션(쿠키, 30일) 확인 → 유효하면 자동로그인.
  // 401(인증만료)이면 즉시 로그인 화면. 그 외 일시적 오류(네트워크·5xx)는 쿠키가 멀쩡할 수
  // 있으므로 몇 번 재시도한 뒤에야 로그인 화면으로 폴백한다(로드 순간 blip 으로 튕기지 않게).
  init: async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apply(set, await api.state());
        set({ ready: true });
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          set({ authed: false, ready: true });
          return;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // 일시 오류 → 잠시 후 재시도
      }
    }
    set({ authed: false, ready: true }); // 계속 실패 시에만 로그인 화면
  },

  login: async (name, passcode) => {
    set({ busy: true, error: null });
    try {
      const st = await api.login(name, passcode);
      apply(set, st);
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      /* 무시 */
    }
    set({
      authed: false,
      name: null,
      balance: 0,
      refillsLeft: 3,
      vipTier: 0,
      feeRate: 0.0003,
      vipNextAt: null,
      vipFrom: 0,
      vipTiers: [],
      vipCurve: null,
      totalVolume: 0,
      totalFees: 0,
      positions: [],
      orders: [],
      pendingOrders: [],
      conditionalOrders: [],
      markPrices: {},
      spotBook: { bids: [], asks: [] },
      spotTrades: [],
    });
  },

  refresh: async () => {
    try {
      // 주문내역은 증분으로만 받는다(§ mergeOrders) — 목록이 비어 있으면(최초·로그아웃 후) 전체.
      const since = useTradingStore.getState().orders[0]?.createdAt;
      apply(set, await api.state(since));
    } catch (e) {
      // 401(인증만료)일 때만 로그아웃. 일시적 네트워크/5xx 로는 세션을 끊지 않는다
      // (쿠키가 멀쩡한데도 폴링 실패 한 번에 로그인 화면으로 튕기던 문제 → 30일 유지 안 되던 체감의 원인).
      if (e instanceof ApiError && e.status === 401) set({ authed: false });
    }
  },

  openMarket: async ({ symbol, side, size, leverage, stopLoss, takeProfit }) => {
    set({ busy: true, error: null });
    try {
      // 가격은 보내지 않는다 — 서버가 체결가를 직접 받아 쓴다.
      apply(set, await api.open({ symbol, side, size, leverage, stopLoss, takeProfit }));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  closePosition: async (id, size) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.close(id, size));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  limitClose: async (positionId, size, limitPrice) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.limitClose(positionId, size, limitPrice));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  limitOpen: async ({ symbol, side, size, leverage, limitPrice, stopLoss, takeProfit }) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.limitOpen({ symbol, side, size, leverage, limitPrice, stopLoss, takeProfit }));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  cancelLimit: async (pendingId) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.cancelLimit(pendingId));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  editLimit: async (pendingId, p) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.editLimit(pendingId, p));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  setSlTp: async (positionId, p) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.setSlTp(positionId, p));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  conditionalOpen: async (p) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.conditionalOpen(p));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  editConditional: async (conditionalId, p) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.editConditional(conditionalId, p));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  cancelConditional: async (conditionalId) => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.cancelConditional(conditionalId));
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  refill: async () => {
    set({ busy: true, error: null });
    try {
      apply(set, await api.refill());
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  // ⚠ 가상 코인이 둘 이상이면 심볼을 바꾼 직후 첫 폴링 응답이 오기 전까지 **이전 코인의 호가창이
  // 그대로 보인다**(EW 를 눌렀는데 OX 호가가 잠깐 보이는 식). 값이 아예 없는 게 틀린 값보다 낫다.
  // ⚠ 캔들도 함께 비운다 — 안 비우면 인터벌/심볼을 바꾼 직후 차트가 **이전 조합의 봉**을 한 번 그린다
  // (통합 폴링 응답이 오기 전까지). 차트는 spotCandlesAt 이 0 이면 아무것도 안 그린다.
  spotClear: () => {
    clearDrip(); // 코인이 바뀌었다 — 이전 코인의 남은 슬라이스가 새 목록에 섞이지 않게
    set({ spotBook: { bids: [], asks: [] }, spotTrades: [], spotCandles: [], spotCandlesAt: 0, spotCandlesKey: '' });
  },

  spotRefresh: async (pair: string) => {
    try {
      applySpot(set, await api.spotState(pair));
    } catch {
      /* 다음 폴링에서 재시도 — 마지막 알려진 값 유지 */
    }
  },

  // ⚠ 통합 폴링(§ api.spotTick) — 예전의 세 폴링(호가 1s · 캔들 1s · 계정 2.5s)을 한 요청으로 합친 것.
  // 두 가지를 여기서 정한다:
  //  (1) **몇 봉을 받을지** — 최초/심볼·인터벌 변경 직후엔 500봉, 그 뒤엔 "마지막 로드 이후 흐른 시간 ÷
  //      인터벌 + 2"봉만. 저장 안 하는 인터벌은 서버가 조회 시 롤업하므로 이 숫자에 배수가 곱해져
  //      읽기 행 수가 된다(30m 이면 ×30) → 작게 유지하는 게 곧 읽기 절감이다.
  //  (2) **계정 상태를 실을지** — 매 틱 실으면 요청은 줄어도 계정 읽기가 2.5배가 되어 손해다. 예전
  //      /api/state 폴링 주기(2.5초)와 비슷하게 STATE_EVERY 틱마다 한 번만 싣는다.
  spotTick: async (pair: string, interval: string) => {
    const st = useTradingStore.getState();
    const key = `${pair}|${interval}`;
    const fresh = tickKey !== key; // 심볼이나 인터벌이 바뀌었다 → 처음부터 다시
    if (fresh) {
      tickKey = key;
      tickCount = 0;
    }
    const sec = intervalSec(interval);
    const bars = fresh || st.spotCandlesAt === 0
      ? FULL_BARS
      : Math.min(FULL_BARS, Math.max(POLL_MIN_BARS, Math.ceil((Date.now() - st.spotCandlesAt) / 1000 / sec) + 2));
    const wantState = tickCount % STATE_EVERY === 0;
    tickCount++;
    try {
      const r = await api.spotTick(pair, {
        interval,
        bars,
        state: wantState,
        ordersSince: st.orders[0]?.createdAt,
      });
      applySpot(set, r.market);
      if (r.candles.length) set({ spotCandles: r.candles, spotCandlesAt: Date.now(), spotCandlesKey: key });
      if (r.state) apply(set, r.state);
    } catch {
      /* 다음 폴링에서 재시도 — 마지막 알려진 값 유지 */
    }
  },
}));

// ⚠ 통합 폴링의 "이 조합을 언제부터 보고 있나" 추적 — 스토어 상태로 두면 값이 바뀔 때마다 리렌더가
// 나는데, 이건 화면에 안 그려지는 순수 내부 상태다(캔들 요청 폭·계정 상태 주기 계산에만 쓴다).
let tickKey = '';
let tickCount = 0;
const FULL_BARS = 500; // 최초 로드 폭(차트가 왼쪽으로 스크롤하면 loadOlder 가 더 붙인다)
const POLL_MIN_BARS = 2; // 진행 중인 봉 + 방금 닫힌 봉이면 갱신엔 충분하다
const STATE_EVERY = 3; // 3틱(≈3초)마다 계정 상태를 함께 받는다 — 예전 /api/state 폴링(2.5초)과 비슷
