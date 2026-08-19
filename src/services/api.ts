// 서버 권위 백엔드(/api/*, Cloudflare Pages Functions + D1) 클라이언트.
// 잔고/체결/손익은 서버가 계산하므로 프론트는 요청·표시만 담당한다.

import type { Candle, Side } from '@/types';

export interface ApiPosition {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  size: number;
  leverage: number;
  openedAt: number;
  stopLoss: number | null;
  takeProfit: number | null;
}
export interface ApiOrder {
  id: string;
  symbol: string;
  side: Side;
  price: number;
  size: number;
  leverage: number;
  kind: 'open' | 'close' | 'liquidation';
  pnl: number | null;
  createdAt: number;
}
export interface ApiPendingOrder {
  id: string;
  symbol: string;
  side: Side;
  size: number;
  leverage: number;
  limitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  createdAt: number;
  reduceOnly: boolean; // true 면 지정가 "청산" 주문(체결 시 반대 포지션을 줄인다)
}
export interface ApiConditionalOrder {
  id: string;
  symbol: string;
  side: Side;
  size: number; // 1회성=남은(미체결) 목표 수량 / 무한=1회 실행 수량
  leverage: number;
  triggerPrice: number;
  triggerDir: 'above' | 'below'; // 'above'=가격 이상, 'below'=가격 이하가 되면 시장가 진입
  createdAt: number;
  /** 무한(반복) 조건부 — 체결돼도 주문이 사라지지 않는다 */
  repeating: boolean;
  /** 'continuous'=조건이 참인 동안 계속 실행(폴링마다) / 'rearm'=되돌아왔다 다시 트리거될 때만 */
  repeatMode: 'continuous' | 'rearm';
  /** (rearm 전용) true=트리거 대기 / false=재무장 대기(가격이 rearmPrice 로 돌아와야 다시 무장) */
  armed: boolean;
  rearmPrice: number | null; // null 이면 트리거 가격에서 재무장
  cooldownMs: number; // (continuous 전용) 최소 재실행 간격(0=폴링마다)
  lastFillAt: number | null;
  fillCount: number; // 지금까지 실행된 횟수
  maxFills: number | null; // 최대 실행 횟수(null=무제한)
}
export interface AppState {
  name: string;
  balance: number;
  refillsLeft: number;
  /** VIP 등급(상한 없음) — 누적 거래대금에서 서버가 파생. 수수료율/진행도 표시에 사용 */
  vipTier: number;
  feeRate: number;
  vipNextAt: number | null;
  /** 현재 등급 구간의 하한(진행률 계산용) — 등급이 무한이라 표에서 찾아 쓸 수 없다 */
  vipFrom: number;
  /** 등급표 — 무한 등급이라 **현재 등급 주변 창**만 온다(서버가 내려줌, 클라에 중복 정의 금지) */
  vipTiers: { tier: number; minVolume: number; rate: number }[];
  /** 등급 곡선 파라미터(한 등급당 거래대금 배수·수수료 배수) — 모달 설명 문구용 */
  vipCurve?: { baseVolume: number; growth: number; decay: number; minRate: number };
  totalVolume: number;
  totalFees: number;
  positions: ApiPosition[];
  orders: ApiOrder[];
  /** true 면 `orders` 는 전체 목록이 아니라 **증분**이다(§ loadState ordersSince) — 교체하지 말고 합칠 것.
   * 폴링마다 같은 50건을 다시 읽지 않으려는 것이고, 경계 1건이 중복으로 올 수 있어 id 로 걸러야 한다. */
  ordersPartial?: boolean;
  pendingOrders: ApiPendingOrder[];
  conditionalOrders: ApiConditionalOrder[];
  // 보유/미체결 심볼의 서버 마크가격 맵 — 클라가 서버와 동일 시세로 청산가/평가자산을 즉시 계산하게 한다
  // (OX 를 보고 있지 않아도 그 포지션 청산가가 계산되고, 진입 직후 청산가가 바로 표시됨).
  markPrices?: Record<string, number>;
}
export interface LeaderRow {
  name: string;
  balance: number;
  equity: number;
  unrealized: number;
  openCount: number;
  isMe: boolean;
  vipTier: number;
}

/** 거래소가 수수료로 벌어들인 총액(봇/유저 분리) — /api/leaderboard 가 함께 내려준다. */
export interface FeeRevenue {
  total: number;
  fromBots: number;
  fromUsers: number;
  volume: number;
}

export interface SpotBookLevel {
  /** 이 가격대에 내가 걸어둔 물량(호가창에서 내 주문을 표시하기 위해 서버가 따로 합산해 내려준다) */
  mine?: number;
  price: number;
  size: number;
}
export interface SpotTrade {
  id: string;
  price: number;
  size: number;
  takerSide: 'buy' | 'sell' | null;
  createdAt: number;
}
/** OX/USDT 시장 전체 표시용 데이터(호가창/체결내역) — 유저 개인 데이터 아님, 봇이 만든 합성 시장. */
export interface SpotState {
  book: { bids: SpotBookLevel[]; asks: SpotBookLevel[] };
  trades: SpotTrade[];
}

/** HTTP 상태를 담는 API 에러 — 401(인증만료)과 일시적 네트워크/5xx 오류를 구분하기 위함.
 * (일시 오류에 세션을 끊으면 쿠키가 멀쩡해도 로그인 화면으로 튕기므로.) */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
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
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

// ── 주문내역 증분 조회 커서(§ functions/_shared.ts loadState ordersSince) ─────────────────────
// 액션 응답(POST /api/order)도 계정 상태를 통째로 돌려주는데, 예전엔 커서를 안 실어서 **액션마다 주문
// 50행을 다시 읽었다**(prod 실측 하루 759회 × 50행 = 3.8만 행 — 폴링에선 이미 없앤 낭비가 액션 경로에만
// 남아 있었다). 스토어가 상태를 받을 때마다(§ useTradingStore.apply) 이 커서를 갱신하고, 모든 주문
// 액션이 그 값을 함께 보낸다.
// ⚠ 여기 두는 이유: api.ts 는 스토어를 import 하지 않는다(그 방향이면 순환). 그래서 스토어가 밀어넣는다.
// ⚠ 커서를 모르면 undefined → 서버가 전체 목록을 준다(최초 로드·로그인·리필. 드문 전체 응답이
//   증분 병합이 어긋났을 때의 자기 복구 지점도 된다).
let ordersCursor: number | undefined;

/** 스토어가 계정 상태를 받을 때마다 최신 주문 시각을 여기 반영한다(되돌아가지 않게 단조 증가). */
export function setOrdersCursor(createdAt?: number) {
  if (createdAt == null) ordersCursor = undefined;
  else if (ordersCursor == null || createdAt > ordersCursor) ordersCursor = createdAt;
}

/** POST /api/order 공통 — 증분 커서를 항상 함께 보낸다. */
const orderReq = (body: Record<string, unknown>) =>
  req<AppState>('/order', { method: 'POST', body: JSON.stringify({ ...body, ordersSince: ordersCursor }) });

export const api = {
  login: (name: string, passcode: string) =>
    req<AppState>('/login', { method: 'POST', body: JSON.stringify({ name, passcode }) }),
  logout: () => req<{ ok: boolean }>('/logout', { method: 'POST' }),
  /** ordersSince = 클라가 가진 가장 최근 주문의 createdAt. 주면 그 이후 주문만 증분으로 받는다
   * (응답 `ordersPartial=true`). 안 주면 전체(최초 로드·새로고침·액션 응답). */
  state: (ordersSince?: number) =>
    req<AppState>(ordersSince ? `/state?ordersSince=${ordersSince}` : '/state'),
  open: (p: { symbol: string; side: Side; size: number; leverage: number; stopLoss?: number | null; takeProfit?: number | null }) =>
    orderReq({ action: 'open', ...p }),
  close: (positionId: string, size?: number) =>
    orderReq({ action: 'close', positionId, size }),
  limitClose: (positionId: string, size: number, limitPrice: number) =>
    orderReq({ action: 'limitClose', positionId, size, limitPrice }),
  limitOpen: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    limitPrice: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) => orderReq({ action: 'limitOpen', ...p }),
  cancelLimit: (pendingId: string) =>
    orderReq({ action: 'cancelLimit', pendingId }),
  editLimit: (pendingId: string, p: { limitPrice?: number; size?: number }) =>
    orderReq({ action: 'editLimit', pendingId, ...p }),
  setSlTp: (positionId: string, p: { stopLoss: number | null; takeProfit: number | null }) =>
    orderReq({ action: 'setSlTp', positionId, ...p }),
  conditionalOpen: (p: {
    symbol: string;
    side: Side;
    size: number;
    leverage: number;
    triggerPrice: number;
    triggerDir: 'above' | 'below';
    /** true 면 무한(반복) 조건부 — 체결돼도 사라지지 않는다 */
    repeating?: boolean;
    /** 'continuous'(기본)=조건이 참인 동안 계속 / 'rearm'=되돌아왔다 다시 트리거될 때만 */
    repeatMode?: 'continuous' | 'rearm';
    /** (rearm) 재무장 가격(생략=트리거 가격). below 면 트리거 이상, above 면 트리거 이하여야 함 */
    rearmPrice?: number | null;
    /** (continuous) 최소 재실행 간격(초, 0=폴링마다) */
    cooldownSec?: number | null;
    /** 최대 실행 횟수(생략/null=무제한) */
    maxFills?: number | null;
  }) => orderReq({ action: 'conditionalOpen', ...p }),
  /** 조건부 주문 수정 — 보낸 필드만 바뀐다(증거금을 잠그지 않는 주문이라 정산 없이 UPDATE) */
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
  ) => orderReq({ action: 'editConditional', conditionalId, ...p }),
  cancelConditional: (conditionalId: string) =>
    orderReq({ action: 'cancelConditional', conditionalId }),
  refill: () => req<AppState>('/refill', { method: 'POST' }),
  leaderboard: () => req<{ leaderboard: LeaderRow[]; revenue: FeeRevenue }>('/leaderboard'),
  spotState: (pair: string) => req<SpotState>(`/spot?pair=${encodeURIComponent(pair)}`),
  /** ⚠ **통합 폴링**(§ functions/api/state.ts `?tick=`) — 호가·체결·캔들(+선택적으로 계정 상태)을
   * **한 요청**으로 받는다. 예전엔 이 셋이 각자 폴링해서 OX 화면 1인이 시간당 8,640요청이었고, 그게
   * 무료 플랜(하루 10만 요청)에서 "하루 총 시청 시간 11.4시간"이라는 천장을 만들었다.
   * `state` 는 매번 받지 않는다 — 매번 받으면 요청은 줄어도 계정 읽기가 2.5배가 되어 읽기 쪽이 손해다. */
  spotTick: (pair: string, o: { interval: string; bars: number; state?: boolean; ordersSince?: number }) =>
    req<{ market: SpotState; candles: Candle[]; state: AppState | null }>(
      `/state?tick=${encodeURIComponent(pair)}&interval=${encodeURIComponent(o.interval)}&bars=${o.bars}` +
        (o.state ? '&state=1' : '') +
        (o.state && o.ordersSince ? `&ordersSince=${o.ordersSince}` : ''),
    ),
  /** OX 캔들. endTimeMs 를 주면 그 시각 "이전" 봉만 — 차트 왼쪽 스크롤 시 과거 구간 이어받기용. */
  spotCandles: (pair: string, interval: string, limit = 500, endTimeMs?: number) =>
    req<{ candles: Candle[] }>(
      `/spot?pair=${encodeURIComponent(pair)}&candles=1&interval=${encodeURIComponent(interval)}&limit=${limit}${endTimeMs ? `&endTime=${endTimeMs}` : ''}`,
    ),
};
