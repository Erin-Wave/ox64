// ── Cloudflare Pages Functions 공용 유틸 (서버 권위 백엔드) ──────────────
// 잔고/체결/손익은 전부 서버(D1)에서 계산하고, 체결가는 서버가 바이낸스에서
// 직접 받아 쓴다 → 클라이언트가 가격이나 잔고를 조작해도 반영되지 않는다.

// ⚠ `_budget.ts` 는 이 파일에서 **타입만** import 한다(런타임 순환 없음, 그쪽 todayKst 사본 주석 참고).
import { meterStmt, ROWS_PER_FILL } from './_budget';

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

// ⚠ 주문 수량 상한 = **부동소수 폭주 방지용 안전장치일 뿐**이고, 실제 한도는 "증거금+수수료 <= 크로스
// 가용"조건이 잡는다. 그래서 이 값은 "정상 거래로 도달할 수 있는 최대"보다 훨씬 크게 잡아야 한다 —
// 예전 1e15(1000조) 는 싼 코인(PEPE 1e-5, OX 하한 1e-4)을 고배율로 잡으면 잔고 1억 USDT 수준에서
// 이미 넘어서, 슬라이더 100% 가 곧 "수량 오류"가 되는 버그였다(그 전엔 1e6 캡이 같은 이유로 문제였다).
// 이 캡을 넘는 값은 어차피 아래 증거금 가드가 "증거금이 부족합니다"로 정확히 거부한다.
export const MAX_ORDER_SIZE = 1e30;

/** 수량 잔여/전량 판정 오차 — **크기에 비례**해야 한다. double 은 유효자리가 ~16자리뿐이라 1e15 개를
 * 여러 청크로 walking 체결하면 합산 오차가 0.1~1 단위로 나온다. 고정 1e-9 로 비교하면 그 먼지가
 * "아직 안 채워진 잔량"으로 남아 **전량 청산해도 먼지 포지션이 계속 남고**(pending 도 안 지워짐)
 * 대량 주문에서 청산 버튼을 아무리 눌러도 0 이 안 되는 상태가 된다. 상대오차 1e-12 는 double 정밀도
 * (2.2e-16)보다 넉넉하고 경제적으로는 무의미한 크기다. */
export const sizeEps = (size: number) => Math.max(1e-9, Math.abs(size) * 1e-12);

// OX/USDT 유동성 공급용 예약 봇 유저(schema.sql 에서 시딩) — 랭킹/통계에서 제외해야 함.
export const BOT_USER_IDS = ['bot-mm-1', 'bot-mm-2'] as const;

// 외부 시세 없는 가상 심볼(서버측 사본 — functions/ 는 src/symbols.ts 를 import 할 수 없어
// intervalSecFromCode 와 같은 이유로 값만 독립 보관). OXUSDT 는 레버리지 롱/숏도 다른 38종과
// 완전히 동일하게 order.ts 를 타지만, 체결가만 OKX/Coinbase 대신 봇이 만든 내부가격을 쓴다.
const VIRTUAL_SYMBOLS = ['OXUSDT', 'EWUSDT'] as const;
export function isVirtualSymbol(s: string): boolean {
  return (VIRTUAL_SYMBOLS as readonly string[]).includes(s);
}

// ── 가상 코인 호가 단위 = **유효숫자 4자리 고정** ─────────────────────────────
// ⚠ 예전엔 "소수 4자리 고정"(틱 0.0001)이었다. 그건 가격이 1 USDT 근처일 때만 말이 되는 규칙이라,
// 봇 가격이 0.002 대로 내려가면 유효숫자가 2자리뿐이라 호가가 뭉텅이로 움직이고(0.0024↔0.0025 =
// 4% 점프), 반대로 100 USDT 를 넘으면 의미 없는 자릿수(123.4567)가 붙었다. 지금은 실제 거래소처럼
// **가격 크기에 따라 틱이 10배씩 바뀐다**:
//   0.9234 → 0.0001 / 0.002434 → 0.000001 / 123.4 → 0.1
// 서버(봇 기준가·호가 사다리·체결가·유저 지정가/트리거가)와 클라 표시(src/format.ts 의 동일 구현)가
// 이 규칙을 공유한다 — ⚠ 한쪽만 고치면 "입력한 가격과 다르게 걸린다"가 된다.
export const VIRTUAL_SIG_DIGITS = 4;

/** 가격의 10 의 지수(유효숫자 반올림 후 기준). `toExponential` 로 뽑아 log10 의 경계 오차를 피한다
 *  — Math.log10(0.001) 은 -3.0000000000000004 라 floor 가 한 자리 어긋난다. */
function virtualExp(price: number): number {
  return Number(Math.abs(price).toExponential(VIRTUAL_SIG_DIGITS - 1).split('e')[1]);
}

/** 그 가격대의 최소 호가 단위(틱). 예: 0.9234→0.0001, 0.002434→0.000001, 123.4→0.1 */
export function virtualTick(price: number): number {
  const p = Math.abs(price);
  if (!(p > 0) || !isFinite(p)) return 1e-8;
  return Math.pow(10, virtualExp(p) - (VIRTUAL_SIG_DIGITS - 1));
}

/** 가격을 유효숫자 4자리로 스냅. 9.9996e-1 처럼 올림으로 자릿수가 넘어가는 경우도 `toExponential`
 *  이 알아서 1.000e+0 으로 처리하므로 틱이 어긋나지 않는다. */
export function roundVirtual(price: number): number {
  if (!isFinite(price) || price === 0) return 0;
  return Number(price.toExponential(VIRTUAL_SIG_DIGITS - 1));
}

/** 그 가격대의 소수 자릿수(표시용). 예: 0.9234→4, 0.002434→6, 123.4→1, 12340→0 */
export function virtualPrecision(price: number): number {
  const p = Math.abs(price);
  if (!(p > 0) || !isFinite(p)) return VIRTUAL_SIG_DIGITS;
  return Math.max(0, VIRTUAL_SIG_DIGITS - 1 - virtualExp(p));
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
// ⚠ 등급은 **표가 아니라 공식**이다(2026-08-09, 무한 레벨). 예전엔 VIP0~12 짜리 13행 상수표였고 1단계당
// 100배라, (a)등급이 12 에서 끝나 그 위로는 아무리 거래해도 변화가 없고 (b)한 칸이 100배라 RPG 로 치면
// "레벨이 12개뿐이고 다음 레벨까지 경험치 100배"인 구조였다. 지금은 등비수열 두 개로 무한히 이어진다:
//
//   등급 t 진입 거래대금 = VIP_BASE_VOLUME × VIP_VOLUME_GROWTH^(t-1)   (t>=1, VIP0 = 0)
//   등급 t 수수료율      = max(VIP_MIN_RATE, VIP_BASE_RATE × VIP_RATE_DECAY^t)
//
// 밸런스 근거:
//  · 거래대금 4배/등급 — 한 등급이 "조금만 더 하면 오른다"고 느껴지는 폭. 첫 등급이 1만 USDT 라 몇 번만
//    거래해도 VIP1 이 뜨고(초반 보상), 이후 VIP10=26억 · VIP20=2.7경 · VIP30=2.9해 · VIP40=3.1자 로 이어진다.
//    거래대금은 명목금액(레버리지 포함)이라 고배율 유저는 한 판에 몇 등급씩 뛴다 — 그래서 100배가 아니라
//    4배로 촘촘하게 썰어야 "레벨업"이 자주 일어난다. 현재 최상위 유저(~1e24)가 VIP34 근처.
//  · 요율 ×0.79/등급 — **옛 13행 표를 그대로 근사한 값**이다(옛 VIP1(1e6)≈새 VIP4, 옛 VIP4(1e12)≈새 VIP14
//    에서 요율이 거의 일치). 즉 등급 숫자만 촘촘해지고 "이만큼 거래하면 수수료가 이 정도" 라는 실제 경제는
//    바뀌지 않는다. 등급마다 -21% 라 5등급이면 대략 반토막.
//  · 하한 0.0000001% — 0 으로 두면 상위 등급의 거래가 거래소 수익에 전혀 안 잡힌다(랭킹 수수료 수익 표시가
//    멈춰버림). 대략 VIP54 부터 이 하한에 닿는다.
// ⚠ 표시 자릿수: 이 하한(1e-9)은 퍼센트로 0.0000001% 라 `fmtFeeRate` 가 소수 **8자리**까지 찍어야 한다
//   (6자리였을 땐 0.0000001% 가 "0" 으로 뭉개졌다). 상수를 더 내리면 그쪽도 같이 늘릴 것.
export const VIP_BASE_VOLUME = 1e4; // VIP1 진입 누적 거래대금(USDT)
export const VIP_VOLUME_GROWTH = 4; // 한 등급당 거래대금 배수
export const VIP_BASE_RATE = 0.0003; // VIP0 요율 = 0.03%
export const VIP_RATE_DECAY = 0.79; // 한 등급당 요율 배수
export const VIP_MIN_RATE = 1e-9; // 요율 하한 = 0.0000001%

/** 그 등급에 들어가는 데 필요한 누적 거래대금(VIP0 = 0). */
export function vipMinVolume(tier: number): number {
  if (!(tier > 0)) return 0;
  return VIP_BASE_VOLUME * Math.pow(VIP_VOLUME_GROWTH, tier - 1);
}

/** 그 등급의 수수료율(분수). */
export function vipRate(tier: number): number {
  if (!(tier > 0)) return VIP_BASE_RATE;
  return Math.max(VIP_MIN_RATE, VIP_BASE_RATE * Math.pow(VIP_RATE_DECAY, tier));
}

/** 누적 거래대금 → VIP 등급/수수료율/다음 등급 기준. 등급은 컬럼으로 저장하지 않고 항상 여기서
 * 파생한다(총거래량 하나만 진실원본이라 등급이 어긋날 여지가 없다).
 * ⚠ 로그로 구한 등급은 기준선에 정확히 걸친 값에서 부동소수 오차로 한 칸 어긋날 수 있어(1e4·4^k 를
 * 그대로 넣어도 지수가 k-1e-16 으로 나온다) 계산 뒤 실제 기준선과 대조해 보정한다. */
export function vipOf(totalVolume: number): { tier: number; rate: number; nextAt: number | null } {
  const v = totalVolume > 0 && isFinite(totalVolume) ? totalVolume : 0;
  let tier = 0;
  if (v >= VIP_BASE_VOLUME) {
    tier = Math.floor(Math.log(v / VIP_BASE_VOLUME) / Math.log(VIP_VOLUME_GROWTH) + 1e-9) + 1;
    // 경계 보정(최대 몇 회). 위/아래 양방향 모두 막는다.
    while (tier > 0 && v < vipMinVolume(tier)) tier--;
    while (v >= vipMinVolume(tier + 1)) tier++;
  }
  const next = vipMinVolume(tier + 1);
  return { tier, rate: vipRate(tier), nextAt: isFinite(next) ? next : null };
}

/** 등급표를 "현재 등급 주변 창" 으로만 만든다 — 등급이 무한이라 전부 내려보낼 수 없다. */
export function vipTierWindow(tier: number, before = 2, after = 6) {
  const from = Math.max(0, tier - before);
  const rows: { tier: number; minVolume: number; rate: number }[] = [];
  for (let t = from; t <= tier + after; t++) rows.push({ tier: t, minVolume: vipMinVolume(t), rate: vipRate(t) });
  return rows;
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
    // ⚠ D1 쓰기 예산 계량(§ _budget.ts). **이 함수가 모든 체결 경로가 반드시 지나는 유일한 병목**이라
    // 여기 한 줄이면 시장가/지정가/지정가청산/SL·TP/조건부(1회성·반복)/강제청산/OX walking 이 전부 잡힌다
    // — 경로마다 흩뿌리면 새 체결 경로를 추가할 때 빠뜨리고, 그 누락이 곧 다음 청구서다.
    // 그래서 조건부 경로 등에 계량을 **따로 넣으면 이중 계산**이 된다(넣지 말 것).
    meterStmt(env, ROWS_PER_FILL),
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
  size: number; // 1회성=남은(미체결) 목표 수량 / 무한=1회 실행 수량(고정)
  leverage: number;
  trigger_price: number;
  trigger_dir: string; // 'above'(>=) | 'below'(<=)
  created_at: number;
  // ── 무한(반복) 조건부 (2026-07-28) ──
  // ⚠ 마이그레이션 전 DB 에선 컬럼 자체가 없어 undefined 로 들어온다 → 읽을 땐 항상 `?? 기본값`.
  repeating?: number | null; // 1이면 체결돼도 삭제하지 않는다
  repeat_mode?: string | null; // 'continuous'(조건 참인 동안 계속) | 'rearm'(되돌아와야 재실행)
  armed?: number | null; // (rearm 전용) 1=트리거 대기 / 0=재무장 대기
  rearm_price?: number | null; // (rearm 전용) 재무장 가격(NULL 이면 trigger_price)
  cooldown_ms?: number | null; // (continuous 전용) 최소 재실행 간격 ms(0=폴링마다)
  last_fill_at?: number | null; // 마지막 실행 시각(ms)
  fill_count?: number | null; // 지금까지 실행된 횟수
  max_fills?: number | null; // 최대 실행 횟수(NULL=무제한)
}
/** 무한 조건부의 반복 방식 — 컬럼이 없거나 값이 이상하면 기본 'continuous'(조건 참인 동안 계속). */
export function repeatModeOf(c: ConditionalRow): 'continuous' | 'rearm' {
  return c.repeat_mode === 'rearm' ? 'rearm' : 'continuous';
}

/** ⚠ `continuous` 무한 조건부의 **재실행 간격 하한**(2026-08-01). 예전엔 0(=폴링마다 ≈1초)이 허용됐는데,
 * 그러면 주문 하나가 하루 8.6만 번 체결되고 체결 1건이 D1 에 ~18행을 쓰므로 **하루 155만 행 = 월 4,650만 행**
 * — 그 주문 하나로 월 rows written 포함분(5,000만)을 거의 다 먹는다($47 청구 사건 이후 계산, §6 D1 예산).
 * 5초로 두면 같은 주문이 월 930만 행이 되어 봇(600만)과 합쳐도 여유가 3배 남는다. DCA/물타기 용도에서
 * 1초와 5초의 체감 차이는 거의 없다(가격이 조건 아래에 머무는 시간은 보통 분 단위다).
 * ⚠ **저장값이 아니라 이 함수를 통해서만 판정할 것** — 하한 도입 전에 만들어진 기존 주문들이 DB 에
 * cooldown_ms=0 으로 남아 있어서, 생성 시점 검증만 고치면 그 주문들은 계속 1초 간격으로 돈다. */
export const MIN_CONTINUOUS_COOLDOWN_MS = 5_000;
export function effectiveCooldownMs(cooldownMs: number | null | undefined): number {
  return Math.max(MIN_CONTINUOUS_COOLDOWN_MS, cooldownMs ?? 0);
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
    // 현재 등급 구간의 하한(진행률 계산용) — 등급이 무한이라 클라가 표에서 찾아 쓰던 방식은 못 쓴다.
    vipFrom: vipMinVolume(vip.tier),
    // 등급표는 **현재 등급 주변 창**만 내려보낸다(무한 등급이라 전부 못 보냄). 클라에 같은 공식을 또
    // 적어두면 서버 기준이 바뀔 때 조용히 어긋난다(수수료는 서버가 떼므로 화면만 틀리게 된다).
    vipTiers: vipTierWindow(vip.tier),
    // 등급 곡선 파라미터 — 모달이 "한 등급당 거래대금 ×4 · 수수료 ×0.79" 를 설명하는 데 쓴다(하드코딩 금지).
    vipCurve: { baseVolume: VIP_BASE_VOLUME, growth: VIP_VOLUME_GROWTH, decay: VIP_RATE_DECAY, minRate: VIP_MIN_RATE },
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
      // 무한(반복) 조건부 — 마이그레이션 전 DB 는 컬럼이 없어 undefined 라 기본값으로 방어한다.
      repeating: !!(c.repeating ?? 0),
      repeatMode: repeatModeOf(c),
      armed: (c.armed ?? 1) !== 0,
      rearmPrice: c.rearm_price ?? null,
      cooldownMs: c.cooldown_ms ?? 0,
      lastFillAt: c.last_fill_at ?? null,
      fillCount: c.fill_count ?? 0,
      maxFills: c.max_fills ?? null,
    })),
  };
}
