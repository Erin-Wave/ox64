import { Observable } from 'rxjs';
import { filter, map, retry, share, throttleTime } from 'rxjs/operators';
import type { Candle, KlineTick } from '@/types';
import { baseOf, intervalSec, KST_OFFSET } from '@/symbols';
import type { AggTrade, OrderBookSnapshot } from './binanceWs';

/**
 * 빗썸(원화 마켓) — **브라우저 ↔ 빗썸 직결**(2026-09-24). 빗썸 공개 API 는 CORS 가 `*` 라 브라우저가 바로
 * 부를 수 있고, 그래서 차트·호가·체결은 Cloudflare 요청·D1 을 하나도 쓰지 않는다(바이낸스 직결과 같은 사상,
 * CLAUDE.md §6). 체결가만 서버가 따로 받는다(functions/_shared.ts fromBithumb).
 * 한도: IP당 초당 150 요청(토큰 버킷) — 사람 한 명의 브라우저로는 닿지 않는다.
 *
 * ⚠ 빗썸 봉은 전부 **한국시간 기준 정렬**이다(4시간봉 KST 0·4·8시, 일봉 KST 자정, 주봉 월요일 KST 자정,
 *   월봉 KST 1일). 롤업·실시간 봉도 같은 기준에 맞춘다(§ bucketOf).
 */
const REST = 'https://api.bithumb.com';
const WS = 'wss://ws-api.bithumb.com/websocket/v1';

/** 'BTCKRW' → 'KRW-BTC', 환율 키 'USDTKRW' → 'KRW-USDT'. */
export const bithumbMarket = (symbol: string) => `KRW-${baseOf(symbol)}`;

// ── 캔들(REST) ─────────────────────────────────────────────────────────────
// 빗썸이 주는 봉: 1·3·5·10·15·30·60·240분, 일·주·월. 차트 인터벌 중 2h·6h·8h·12h·3d 는 작은 봉을 합쳐 만들고
// (factor), **1s 는 과거 데이터가 없어 지원하지 않는다**(bithumbSupports 로 차트가 걸러낸다).
const SRC: Record<string, { path: string; factor: number }> = {
  '1m': { path: 'minutes/1', factor: 1 },
  '3m': { path: 'minutes/3', factor: 1 },
  '5m': { path: 'minutes/5', factor: 1 },
  '15m': { path: 'minutes/15', factor: 1 },
  '30m': { path: 'minutes/30', factor: 1 },
  '1h': { path: 'minutes/60', factor: 1 },
  '2h': { path: 'minutes/60', factor: 2 },
  '4h': { path: 'minutes/240', factor: 1 },
  '6h': { path: 'minutes/60', factor: 6 },
  '8h': { path: 'minutes/240', factor: 2 },
  '12h': { path: 'minutes/240', factor: 3 },
  '1d': { path: 'days', factor: 1 },
  '3d': { path: 'days', factor: 3 },
  '1w': { path: 'weeks', factor: 1 },
  '1M': { path: 'months', factor: 1 },
};
export const bithumbSupports = (interval: string) => interval in SRC;

const PAGE = 200; // 빗썸 캔들 요청당 최대 개수
const MAX_RAW = 2000; // 한 번 로드에 받는 원본 봉 상한(= 요청 10회). 6h 롤업이면 333봉
/** `to` 파라미터 — 빗썸은 존 표기 없는 **KST 시각**만 받는다('Z'·'+09:00' 은 400). 그 시각 **미만**의 봉을 준다. */
const toKst = (ms: number) => new Date(ms + KST_OFFSET * 1000).toISOString().slice(0, 19);

interface RawCandle {
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
}

/** 원본 봉을 `count` 개까지(오래된 → 최신). endTimeMs 가 있으면 그 시각 이전 구간. */
async function fetchRaw(market: string, path: string, count: number, endTimeMs?: number): Promise<Candle[]> {
  const out: Candle[] = []; // 최신 → 오래된 순으로 쌓는다(빗썸 응답 순서)
  let cursor = endTimeMs;
  while (out.length < count) {
    const n = Math.min(PAGE, count - out.length);
    const url = `${REST}/v1/candles/${path}?market=${market}&count=${n}${cursor ? `&to=${toKst(cursor)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bithumb candles ${res.status}`);
    const rows = (await res.json()) as RawCandle[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({
        time: Math.floor(Date.parse(`${r.candle_date_time_utc}Z`) / 1000),
        open: r.opening_price,
        high: r.high_price,
        low: r.low_price,
        close: r.trade_price,
        volume: r.candle_acc_trade_volume,
      });
    }
    cursor = out[out.length - 1].time * 1000;
    if (rows.length < n) break; // 더 과거가 없다
  }
  out.reverse();
  // 페이지 경계에서 같은 봉이 두 번 올 수 있다 — 시간으로 중복 제거
  return out.filter((c, i) => i === 0 || c.time > out[i - 1].time);
}

/** KST 기준 정렬 버킷 시작(초). 빗썸 봉과 같은 경계. */
const bucketOf = (t: number, sec: number) => Math.floor((t + KST_OFFSET) / sec) * sec - KST_OFFSET;

/** 과거 캔들(오래된 → 최신, 최대 limit 개). binanceRest.fetchKlines 와 같은 모양. */
export async function fetchBithumbKlines(symbol: string, interval: string, limit = 500, endTimeMs?: number): Promise<Candle[]> {
  const src = SRC[interval];
  if (!src) return [];
  const want = Math.min(MAX_RAW, limit * src.factor);
  const raw = await fetchRaw(bithumbMarket(symbol), src.path, want, endTimeMs);
  if (src.factor === 1) return raw.slice(-limit);
  // 롤업 — 작은 봉을 KST 정렬 버킷으로 합친다.
  const sec = intervalSec(interval);
  const out: Candle[] = [];
  for (const c of raw) {
    const b = bucketOf(c.time, sec);
    const last = out[out.length - 1];
    if (last && last.time === b) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume = (last.volume ?? 0) + (c.volume ?? 0);
    } else {
      out.push({ ...c, time: b });
    }
  }
  // 원본을 상한까지 받았으면 맨 앞 버킷은 중간부터 시작했을 수 있다(더 과거가 남아 있다) — 버린다.
  // 다음 과거 로드가 그 구간을 온전히 다시 받는다(endTime = 남은 가장 오래된 봉).
  if (raw.length >= want && out.length > 1) out.shift();
  return out.slice(-limit);
}

// ── 시세(REST) ─────────────────────────────────────────────────────────────
/** 여러 심볼 현재가를 **한 요청**으로(환율 키 'USDTKRW' 포함 가능). 실패한 심볼은 빠진다. */
export async function fetchBithumbPrices(symbols: string[]): Promise<Record<string, number>> {
  const syms = [...new Set(symbols)];
  if (syms.length === 0) return {};
  const res = await fetch(`${REST}/v1/ticker?markets=${syms.map(bithumbMarket).join(',')}`);
  if (!res.ok) return {};
  const arr = (await res.json()) as { market: string; trade_price: number }[];
  const byMarket = new Map(arr.map((x) => [x.market, Number(x.trade_price)]));
  const out: Record<string, number> = {};
  for (const s of syms) {
    const p = byMarket.get(bithumbMarket(s));
    if (p && isFinite(p) && p > 0) out[s] = p;
  }
  return out;
}

/** 심볼 선택기용 현재가 + **24시간** 변동률. v1 ticker 의 변동률은 "전일(KST 자정) 대비"라 24h 열과 뜻이
 * 달라서, 롤링 24h 값을 주는 구 API(/public/ticker)를 심볼마다 부른다(드롭다운을 열었을 때만, 브라우저 직결). */
export async function fetchBithumb24h(symbols: string[]): Promise<Record<string, { price: number; changePct: number }>> {
  const out: Record<string, { price: number; changePct: number }> = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const res = await fetch(`${REST}/public/ticker/${baseOf(s)}_KRW`);
        if (!res.ok) return;
        const d = (await res.json()) as { status: string; data?: { closing_price: string; fluctate_rate_24H: string } };
        const price = Number(d.data?.closing_price);
        if (d.status === '0000' && price > 0) out[s] = { price, changePct: Number(d.data?.fluctate_rate_24H) || 0 };
      } catch {
        /* 그 심볼만 비운다 */
      }
    }),
  );
  return out;
}

// ── 실시간(WebSocket) ───────────────────────────────────────────────────────
// 마켓당 소켓 **하나**를 체결·호가가 공유한다(share — 구독자가 0 이 되면 닫고, 다시 구독하면 새로 연다).
// 빗썸 메시지는 바이너리 프레임이라 디코딩이 필요하다. 끊기면(close/error) 2초 뒤 다시 연결.
interface WsTrade {
  ty: 'trade';
  tp: number; // 체결가
  tv: number; // 체결량
  ab: 'ASK' | 'BID'; // 테이커 방향(ASK=매도, BID=매수)
  ttms: number; // 체결 시각(ms)
}
interface WsOrderbook {
  ty: 'orderbook';
  obu: { ap: number; bp: number; as: number; bs: number }[];
}
type WsMsg = WsTrade | WsOrderbook | { ty?: string };

const sockets = new Map<string, Observable<WsMsg>>();
const decoder = new TextDecoder();
function socketOf(market: string): Observable<WsMsg> {
  let o = sockets.get(market);
  if (o) return o;
  o = new Observable<WsMsg>((sub) => {
    const ws = new WebSocket(WS);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () =>
      ws.send(
        JSON.stringify([
          { ticket: `ox64-${Math.random().toString(36).slice(2)}` },
          { type: 'trade', codes: [market] },
          { type: 'orderbook', codes: [market] },
          { format: 'SIMPLE' },
        ]),
      );
    ws.onmessage = (e) => {
      try {
        sub.next(JSON.parse(typeof e.data === 'string' ? e.data : decoder.decode(e.data as ArrayBuffer)) as WsMsg);
      } catch {
        /* 깨진 프레임 무시 */
      }
    };
    ws.onerror = () => sub.error(new Error('bithumb ws error'));
    ws.onclose = () => sub.error(new Error('bithumb ws closed')); // 서버가 닫아도 retry 로 다시 연다
    return () => {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
    };
  }).pipe(retry({ delay: 2000 }), share());
  sockets.set(market, o);
  return o;
}

/** 실시간 체결(binanceWs.aggTradeStream 과 같은 모양). */
export function bithumbTradeStream(symbol: string): Observable<AggTrade> {
  return socketOf(bithumbMarket(symbol)).pipe(
    filter((m): m is WsTrade => m.ty === 'trade'),
    map((m) => ({ price: m.tp, qty: m.tv, takerSide: m.ab === 'BID' ? ('buy' as const) : ('sell' as const), time: m.ttms })),
  );
}

const BOOK_THROTTLE_MS = 200; // binanceWs 와 같은 이유(렌더 부담)
/** 실시간 호가(30단계, binanceWs.orderbookStream 과 같은 모양). 수량 0 인 단계는 뺀다. */
export function bithumbOrderbookStream(symbol: string): Observable<OrderBookSnapshot> {
  return socketOf(bithumbMarket(symbol)).pipe(
    filter((m): m is WsOrderbook => m.ty === 'orderbook' && Array.isArray((m as WsOrderbook).obu)),
    map((m) => ({
      bids: m.obu.filter((u) => u.bs > 0).map((u) => ({ price: u.bp, qty: u.bs })),
      asks: m.obu.filter((u) => u.as > 0).map((u) => ({ price: u.ap, qty: u.as })),
    })),
    throttleTime(BOOK_THROTTLE_MS, undefined, { leading: true, trailing: true }),
  );
}

/** KST 기준 다음 달 1일 0시(초) — 월봉은 길이가 달라 고정 초로 못 나눈다. */
function nextMonthStart(t: number): number {
  const d = new Date((t + KST_OFFSET) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 - KST_OFFSET;
}

/**
 * 실시간 봉 — 빗썸은 캔들 스트림이 없어서 **체결로 직접 쌓는다**. 경계는 `getLast()`(차트가 가진 마지막 봉)를
 * 기준점으로 잡는다: REST 로 받은 마지막 봉이 곧 진행 중인 봉이라 그 시각에서 인터벌 배수만큼 떨어진 곳이
 * 다음 경계다(롤업 인터벌도 같은 식 — 정렬 계산을 따로 할 필요가 없다). 월봉만 달력으로 계산한다.
 * ⚠ REST 조회와 소켓 연결 사이의 체결 몇 건이 거래량에 두 번 잡힐 수 있다(표시 전용이라 무시).
 */
export function bithumbKlineStream(symbol: string, interval: string, getLast: () => Candle | undefined): Observable<KlineTick> {
  const sec = intervalSec(interval);
  let cur: Candle | undefined;
  return bithumbTradeStream(symbol).pipe(
    map((tr): KlineTick | null => {
      const t = Math.floor(tr.time / 1000);
      const last = getLast();
      if (last && (!cur || last.time > cur.time)) cur = { ...last };
      if (!cur) {
        cur = { time: bucketOf(t, sec), open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: tr.qty };
      } else if (t < cur.time) {
        return null; // 이미 지난 봉의 체결(늦게 도착) — 무시
      } else {
        const next = interval === '1M' ? nextMonthStart(cur.time) : cur.time + sec;
        if (t >= next) {
          const start = interval === '1M' ? next : cur.time + Math.floor((t - cur.time) / sec) * sec;
          cur = { time: start, open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: tr.qty };
        } else {
          cur = {
            ...cur,
            high: Math.max(cur.high, tr.price),
            low: Math.min(cur.low, tr.price),
            close: tr.price,
            volume: (cur.volume ?? 0) + tr.qty,
          };
        }
      }
      return { symbol, candle: cur, isClosed: false };
    }),
    filter((x): x is KlineTick => x !== null),
  );
}
