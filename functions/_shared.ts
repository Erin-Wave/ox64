// ── Cloudflare Pages Functions 공용 유틸 (서버 권위 백엔드) ──────────────
// 잔고/체결/손익은 전부 서버(D1)에서 계산하고, 체결가는 서버가 바이낸스에서
// 직접 받아 쓴다 → 클라이언트가 가격이나 잔고를 조작해도 반영되지 않는다.

// 최소 D1 타입 (workers-types 의존 없이 배포 가능하게 직접 선언)
export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes: number };
}
export interface D1PreparedStatement {
  bind(...vals: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

export interface Ctx {
  request: Request;
  env: Env;
}

export const SEED_BALANCE = 10_000; // 신규 계정 모의 USDT
export const REFILL_AMOUNT = 10_000;
export const REFILL_DAILY_LIMIT = 3;

// OX/USDT 유동성 공급용 예약 봇 유저(schema.sql 에서 시딩) — 랭킹/통계에서 제외해야 함.
export const BOT_USER_IDS = ['bot-mm-1', 'bot-mm-2'] as const;

// 외부 시세 없는 가상 심볼(서버측 사본 — functions/ 는 src/symbols.ts 를 import 할 수 없어
// intervalSecFromCode 와 같은 이유로 값만 독립 보관). OXUSDT 는 레버리지 롱/숏도 다른 38종과
// 완전히 동일하게 order.ts 를 타지만, 체결가만 OKX/Coinbase 대신 봇이 만든 내부가격을 쓴다.
const VIRTUAL_SYMBOLS = ['OXUSDT'] as const;
export function isVirtualSymbol(s: string): boolean {
  return (VIRTUAL_SYMBOLS as readonly string[]).includes(s);
}

// 캔들 인터벌 코드 → 초 (src/symbols.ts INTERVAL_GROUPS 와 동일한 값을 함수 쪽에 독립 보관).
const INTERVAL_SEC: Record<string, number> = {
  '1s': 1,
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200,
  '1d': 86400, '3d': 259200, '1w': 604800, '1M': 2592000,
};
export function intervalSecFromCode(code: string): number {
  return INTERVAL_SEC[code] ?? 60;
}

// KST(UTC+9) 기준 오늘 날짜(YYYY-MM-DD) — 리필 일일 한도 판정에 사용.
// 차트(src/symbols.ts KST_OFFSET)와 동일한 오프셋 트릭: ms 를 더한 뒤 UTC 포맷으로 자르면 KST 날짜가 된다.
const KST_OFFSET_MS = 9 * 3600 * 1000;
export function todayKst(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
// USDT 페어 형식만 검증(고정 목록 동기화 부담 제거). 실제 존재 여부는 fetchPrice 가 검증.
export function isSymbol(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Z0-9]{2,20}USDT$/.test(s);
}

const COOKIE = 'ox64_sess';
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30일
const enc = new TextEncoder();

// ── JSON 응답 헬퍼 ──────────────────────────────────────────────
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
export const bad = (msg: string, status = 400) => json({ error: msg }, status);

// 설정(바인딩/시크릿) 누락을 명확한 메시지로 노출 — 500 의 흔한 원인 진단용
export function missingEnv(env: Env): string | null {
  if (!env || !env.DB || typeof env.DB.prepare !== 'function')
    return 'D1 바인딩 "DB" 가 없습니다. 대시보드 → Settings → Functions → D1 bindings 추가 후 재배포하세요.';
  if (!env.SESSION_SECRET)
    return 'SESSION_SECRET 이 없습니다. 대시보드 → Settings → Variables and Secrets 추가 후 재배포하세요.';
  return null;
}
// 핸들러 예외를 500 + 메시지로 반환(opaque 500 방지)
export async function safe(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'server error';
    return json({ error: `서버 오류: ${msg}` }, 500);
  }
}

// ── base64url / hex ────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
// WebCrypto 인자용 BufferSource 캐스팅(TS lib 의 ArrayBufferLike 마찰 회피, 런타임 무영향)
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// ── HMAC 서명 세션 토큰 (DB 세션 테이블 불필요) ──────────────────
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bs(enc.encode(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}
interface SessionPayload {
  uid: string;
  name: string;
  exp: number;
}
export async function signToken(payload: Omit<SessionPayload, 'exp'>, secret: string): Promise<string> {
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL };
  const body = b64url(enc.encode(JSON.stringify(full)));
  const key = await hmacKey(secret);
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, bs(enc.encode(body)))));
  return `${body}.${sig}`;
}
async function verifyToken(token: string, secret: string): Promise<SessionPayload | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, bs(fromB64url(sig)), bs(enc.encode(body)));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── 패스코드 해시 (PBKDF2-SHA256) ───────────────────────────────
async function pbkdf2(pass: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(enc.encode(pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bs(salt), iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}
export async function hashPasscode(pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${hex(salt)}$${hex(await pbkdf2(pass, salt))}`;
}
export async function verifyPasscode(pass: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'pbkdf2' || !saltHex || !hashHex) return false;
  return hex(await pbkdf2(pass, fromHex(saltHex))) === hashHex;
}

// ── 세션 쿠키 ──────────────────────────────────────────────────
export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TOKEN_TTL}`;
}
export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
export async function getSession(request: Request, env: Env): Promise<SessionPayload | null> {
  const cookie = request.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  if (!m) return null;
  return verifyToken(m[1], env.SESSION_SECRET);
}

// ── 서버측 시세 (체결가의 진실원본) ────────────────────────────
// ⚠ 바이낸스(api.binance.com·data-api.binance.vision)는 Cloudflare Worker egress IP 를
//   403 으로 차단한다(브라우저는 되지만 서버에선 안 됨). 그래서 서버 시세는
//   CF 에서 뚫리는 OKX → Coinbase → 바이낸스미러 순으로 폴백한다.
//   심볼은 USDT 페어(BTCUSDT 등). OKX=BTC-USDT, Coinbase=BTC-USD(≈USDT).
const HDR = { accept: 'application/json', 'user-agent': 'ox64/1.0' };
const base = (symbol: string) => symbol.replace(/USDT$/, '');

// 외부 시세 소스가 느리거나 멈추면 주문/상태 응답 전체가 그만큼 지연된다(롱/숏 버튼 체감 지연의
// 주원인). 각 요청에 짧은 타임아웃을 걸어, 한 소스가 늦으면 즉시 다음 폴백으로 넘어가게 한다.
async function timedFetch(url: string, ms = 2500): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: HDR, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fromOkx(symbol: string): Promise<number> {
  const r = await timedFetch(`https://www.okx.com/api/v5/market/ticker?instId=${base(symbol)}-USDT`);
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const d = (await r.json()) as { data?: { last: string }[] };
  return Number(d.data?.[0]?.last);
}
async function fromCoinbase(symbol: string): Promise<number> {
  const r = await timedFetch(`https://api.exchange.coinbase.com/products/${base(symbol)}-USD/ticker`);
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const d = (await r.json()) as { price?: string };
  return Number(d.price);
}
async function fromBinanceMirror(symbol: string): Promise<number> {
  const r = await timedFetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const d = (await r.json()) as { price: string };
  return Number(d.price);
}

// OX/USDT 는 외부 거래소에 없으므로 봇(runMarketMaker, functions/api/spot.ts)이 랜덤워크로
// 유지하는 내부 기준가를 그대로 체결가로 쓴다. D1 읽기라 외부 HTTP 처럼 실패할 일이 거의 없다.
async function getVirtualPrice(env: Env, pair: string): Promise<number> {
  const state = await env.DB.prepare('SELECT ref_price FROM spot_bot_state WHERE id = ?')
    .bind(pair)
    .first<{ ref_price: number }>();
  if (state?.ref_price) return state.ref_price;
  const lastTrade = await env.DB.prepare('SELECT price FROM spot_trades WHERE pair = ? ORDER BY created_at DESC LIMIT 1')
    .bind(pair)
    .first<{ price: number }>();
  return lastTrade?.price ?? 1;
}

export async function fetchPrice(env: Env, symbol: string): Promise<number> {
  if (isVirtualSymbol(symbol)) return getVirtualPrice(env, symbol);
  let last = '';
  for (const src of [fromOkx, fromCoinbase, fromBinanceMirror]) {
    try {
      const p = await src(symbol);
      if (p && isFinite(p)) return p;
      last = 'invalid price';
    } catch (e) {
      last = e instanceof Error ? e.message : 'error';
    }
  }
  throw new Error(`시세 조회 실패 (${last})`);
}
export async function fetchPrices(env: Env, symbols: string[]): Promise<Record<string, number>> {
  const uniq = [...new Set(symbols)];
  const out: Record<string, number> = {};
  await Promise.all(
    uniq.map(async (s) => {
      try {
        out[s] = await fetchPrice(env, s);
      } catch {
        /* 그 심볼만 스킵 */
      }
    }),
  );
  return out;
}

/** 크로스 마진 가용 증거금 계산용 — 유저 전 포지션의 미실현손익 합(marks 에 있는 심볼만 반영).
 * 신규 주문 가용 = 여유잔고 + 이 값 (= 평가자산 − 사용중 증거금). 이익 중이면 그 미실현이익까지 새
 * 주문 증거금으로 쓸 수 있고(=크로스), 손실 중이면 가용이 줄어든다. 아이솔레이티드였다면 이 항이 없다. */
export async function unrealizedTotal(env: Env, uid: string, marks: Record<string, number>): Promise<number> {
  const positions = (
    await env.DB.prepare('SELECT symbol, side, entry_price, size FROM positions WHERE user_id = ?')
      .bind(uid)
      .all<PositionRow>()
  ).results;
  let u = 0;
  for (const p of positions) {
    const mark = marks[p.symbol];
    if (mark == null) continue;
    u += (mark - p.entry_price) * p.size * (p.side === 'long' ? 1 : -1);
  }
  return u;
}

// ── D1 행 → 클라이언트 응답 형태 ────────────────────────────────
export interface UserRow {
  id: string;
  name: string;
  balance: number;
  refill_count: number;
  refill_date: string | null;
  ox_balance: number;
  total_volume: number;
  total_fees: number;
}

// ── 거래 수수료 / VIP 등급 ────────────────────────────────────────────────
// 등급은 **누적 거래대금(notional = 체결가 × 수량, 레버리지가 곱해진 명목금액)** 으로 결정된다.
// 증거금이 아니라 명목금액 기준이라 레버리지를 크게 쓸수록 등급이 빨리 오른다("레버리지 포함").
// 진입·청산 양쪽 모두 각자의 명목금액만큼 누적된다(거래소 관행과 동일).
// ⚠ 등급 기준 = 누적 거래대금, **1단계당 100배**(기존 0→1e6→1e8→1e10→1e12 패턴 유지). VIP4(1조) 가 너무
// 쉬워 상위 프레스티지 등급 VIP5~12 를 같은 100배 간격으로 이어붙였다(VIP12=1양=1e28). 요율도 기존처럼
// 공격적으로(대략 반토막씩 5-2-1) 0.001%(VIP4) → 0.000002%(VIP12) 로 내린다. 0.001% 미만이라 표시는
// `fmtFeeRate`(소수 6자리)로. ⚠ 1e28 은 double 정밀도를 넘지만 등급 판정은 크기 비교라 무관.
export const VIP_TIERS = [
  { tier: 0, minVolume: 0, rate: 0.0003 }, //     ~100만 USDT     0.03%
  { tier: 1, minVolume: 1e6, rate: 0.0002 }, //   100만~1억       0.02%
  { tier: 2, minVolume: 1e8, rate: 0.0001 }, //   1억~100억       0.01%
  { tier: 3, minVolume: 1e10, rate: 0.00005 }, // 100억~1조       0.005%
  { tier: 4, minVolume: 1e12, rate: 0.00001 }, // 1조~100조       0.001%
  { tier: 5, minVolume: 1e14, rate: 0.000005 }, //   100조~1경    0.0005%
  { tier: 6, minVolume: 1e16, rate: 0.000002 }, //   1경~100경    0.0002%
  { tier: 7, minVolume: 1e18, rate: 0.000001 }, //   100경~1해    0.0001%
  { tier: 8, minVolume: 1e20, rate: 0.0000005 }, //  1해~100해    0.00005%
  { tier: 9, minVolume: 1e22, rate: 0.0000002 }, //  100해~1자    0.00002%
  { tier: 10, minVolume: 1e24, rate: 0.0000001 }, // 1자~100자    0.00001%
  { tier: 11, minVolume: 1e26, rate: 0.00000005 }, // 100자~1양   0.000005%
  { tier: 12, minVolume: 1e28, rate: 0.00000002 }, // 1양~        0.000002%
] as const;

/** 누적 거래대금 → VIP 등급/수수료율/다음 등급 기준. 등급은 컬럼으로 저장하지 않고 항상 여기서
 * 파생한다(총거래량 하나만 진실원본이라 등급이 어긋날 여지가 없다). */
export function vipOf(totalVolume: number): { tier: number; rate: number; nextAt: number | null } {
  const v = totalVolume > 0 ? totalVolume : 0;
  let idx = 0;
  for (let i = VIP_TIERS.length - 1; i >= 0; i--) {
    if (v >= VIP_TIERS[i].minVolume) {
      idx = i;
      break;
    }
  }
  return { tier: VIP_TIERS[idx].tier, rate: VIP_TIERS[idx].rate, nextAt: VIP_TIERS[idx + 1]?.minVolume ?? null };
}

/** 이 유저의 현재 수수료율(누적 거래대금 기준). 체결 직전에 읽어 그 체결에 적용한다. */
export async function feeRateOf(env: Env, uid: string): Promise<number> {
  const row = await env.DB.prepare('SELECT total_volume FROM users WHERE id = ?')
    .bind(uid)
    .first<{ total_volume: number }>();
  return vipOf(row?.total_volume ?? 0).rate;
}

/**
 * 체결 1건의 수수료 부기 문장들 — 누적 거래대금/수수료 카운터 갱신 + `fee_ledger` 원장 기록.
 * ⚠ **잔고 차감은 여기서 하지 않는다**(호출부 담당) — 진입은 증거금과 함께 조건부 UPDATE 가드에
 * 합산해야 원자성이 유지되고, 청산은 환급액(`margin + pnl - fee`)에서 빼야 하기 때문이다. 여기서 또
 * 빼면 이중 차감된다. 체결을 쪼개서 처리하는 경로(OX 호가창 walking)는 청크마다 잔고만 정산하고
 * 이 부기는 **합계로 1번만** 부른다(원장이 청크 수만큼 불어나지 않게).
 */
export function feeAccrualStmts(
  env: Env,
  uid: string,
  symbol: string,
  kind: string, // 'open' | 'close' | 'liquidation'
  notional: number,
  rate: number,
  fee: number,
  now: number,
): D1PreparedStatement[] {
  return [
    env.DB.prepare('UPDATE users SET total_volume = total_volume + ?, total_fees = total_fees + ? WHERE id = ?').bind(
      notional,
      fee,
      uid,
    ),
    env.DB.prepare(
      'INSERT INTO fee_ledger (id, user_id, symbol, kind, notional, rate, fee, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, symbol, kind, notional, rate, fee, now),
  ];
}
export interface SpotOrderRow {
  id: string;
  user_id: string;
  pair: string;
  side: string; // 'buy' | 'sell'
  price: number;
  size: number;
  orig_size: number;
  status: string; // 'open' | 'filled' | 'cancelled'
  created_at: number;
}
export interface SpotTradeRow {
  id: string;
  pair: string;
  buyer_id: string;
  seller_id: string;
  price: number;
  size: number;
  taker_side: string | null; // 'buy' | 'sell'
  created_at: number;
}
export interface PositionRow {
  id: string;
  user_id: string;
  symbol: string;
  side: string;
  entry_price: number;
  size: number;
  leverage: number;
  margin: number;
  opened_at: number;
  stop_loss: number | null;
  take_profit: number | null;
}
export interface PendingRow {
  id: string;
  user_id: string;
  symbol: string;
  side: string;
  size: number;
  leverage: number;
  limit_price: number;
  margin: number;
  stop_loss: number | null;
  take_profit: number | null;
  created_at: number;
  reduce_only: number; // 1이면 지정가 청산(reduce-only) — 체결 시 포지션을 열지 않고 반대 포지션을 줄인다
}
export interface OrderRow {
  id: string;
  symbol: string;
  side: string;
  price: number;
  size: number;
  leverage: number;
  kind: string;
  pnl: number | null;
  created_at: number;
}
export interface ConditionalRow {
  id: string;
  user_id: string;
  symbol: string;
  side: string; // 'long' | 'short'
  size: number; // 남은(미체결) 목표 수량
  leverage: number;
  trigger_price: number;
  trigger_dir: string; // 'above'(>=) | 'below'(<=)
  created_at: number;
}

/** 로그인 사용자의 전체 상태(잔고+포지션+주문) 조회.
 * marks: 이미 받아둔 마크가격 맵(대개 checkTriggers 가 방금 fetch 한 것) — 넘기면 그대로 재사용해
 * 추가 시세 fetch 를 피한다. 안 넘기고 보유 심볼이 있으면 여기서 한 번 조회한다. 응답의 markPrices 는
 * 클라가 서버와 "동일한 시세"로 청산가/평가자산을 즉시(폴링 지연 없이) 계산하게 해준다(§청산가 표시). */
export async function loadState(env: Env, uid: string, marks?: Record<string, number>) {
  const user = await env.DB.prepare(
    'SELECT id, name, balance, refill_count, refill_date, total_volume, total_fees FROM users WHERE id = ?',
  )
    .bind(uid)
    .first<UserRow>();
  if (!user) return null;
  const vip = vipOf(user.total_volume ?? 0);
  const refillsLeft = user.refill_date === todayKst() ? Math.max(0, REFILL_DAILY_LIMIT - user.refill_count) : REFILL_DAILY_LIMIT;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ? ORDER BY opened_at DESC')
      .bind(uid)
      .all<PositionRow>()
  ).results;
  const orders = (
    await env.DB.prepare(
      'SELECT id, symbol, side, price, size, leverage, kind, pnl, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    )
      .bind(uid)
      .all<OrderRow>()
  ).results;
  const pending = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ? ORDER BY created_at DESC')
      .bind(uid)
      .all<PendingRow>()
  ).results;
  // 조건부(스탑) 주문 — 신규 테이블이라 배포 직후 아직 없을 수 있으므로 방어적으로 감싼다(없으면 빈 배열).
  let conditionals: ConditionalRow[] = [];
  try {
    conditionals = (
      await env.DB.prepare('SELECT * FROM conditional_orders WHERE user_id = ? ORDER BY created_at DESC')
        .bind(uid)
        .all<ConditionalRow>()
    ).results;
  } catch {
    /* conditional_orders 테이블 미생성(마이그레이션 전) — 조건부 없음으로 처리 */
  }
  const heldSymbols = [
    ...new Set([...positions.map((p) => p.symbol), ...pending.map((p) => p.symbol), ...conditionals.map((c) => c.symbol)]),
  ];
  const markPrices = marks ?? (heldSymbols.length ? await fetchPrices(env, heldSymbols) : {});
  return {
    name: user.name,
    balance: user.balance,
    refillsLeft,
    markPrices,
    // VIP 등급은 누적 거래대금에서 파생(저장 안 함) — 클라는 뱃지/수수료 예상액 표시에만 쓴다.
    vipTier: vip.tier,
    feeRate: vip.rate,
    vipNextAt: vip.nextAt,
    // 등급 기준표도 함께 내려보낸다 — 클라가 진행률/등급표를 그리려면 각 구간의 하한이 필요한데,
    // 클라에 같은 표를 또 적어두면 서버 기준이 바뀔 때 조용히 어긋난다(수수료는 서버가 떼므로
    // 화면만 틀리게 된다). 5개짜리 작은 배열이라 폴링마다 실려도 무시할 만한 크기.
    vipTiers: VIP_TIERS.map((t) => ({ tier: t.tier, minVolume: t.minVolume, rate: t.rate })),
    totalVolume: user.total_volume ?? 0,
    totalFees: user.total_fees ?? 0,
    positions: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entry_price,
      size: p.size,
      leverage: p.leverage,
      openedAt: p.opened_at,
      stopLoss: p.stop_loss,
      takeProfit: p.take_profit,
    })),
    orders: orders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      price: o.price,
      size: o.size,
      leverage: o.leverage,
      kind: o.kind,
      pnl: o.pnl,
      createdAt: o.created_at,
    })),
    pendingOrders: pending.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      leverage: p.leverage,
      limitPrice: p.limit_price,
      stopLoss: p.stop_loss,
      takeProfit: p.take_profit,
      createdAt: p.created_at,
      reduceOnly: !!p.reduce_only,
    })),
    conditionalOrders: conditionals.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      side: c.side,
      size: c.size,
      leverage: c.leverage,
      triggerPrice: c.trigger_price,
      triggerDir: c.trigger_dir,
      createdAt: c.created_at,
    })),
  };
}
