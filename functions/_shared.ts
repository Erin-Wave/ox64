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
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;
export function isSymbol(s: unknown): s is string {
  return typeof s === 'string' && (SYMBOLS as readonly string[]).includes(s);
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

// ── 바이낸스 서버측 시세 (스팟) — 체결가의 진실원본 ──────────────
export async function fetchPrice(symbol: string): Promise<number> {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error(`price fetch ${r.status}`);
  const d = (await r.json()) as { price: string };
  const p = Number(d.price);
  if (!p || !isFinite(p)) throw new Error('bad price');
  return p;
}
export async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const uniq = [...new Set(symbols)];
  if (uniq.length === 0) return {};
  const param = encodeURIComponent(JSON.stringify(uniq));
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${param}`);
  if (!r.ok) throw new Error(`prices fetch ${r.status}`);
  const arr = (await r.json()) as { symbol: string; price: string }[];
  const out: Record<string, number> = {};
  for (const x of arr) out[x.symbol] = Number(x.price);
  return out;
}

// ── D1 행 → 클라이언트 응답 형태 ────────────────────────────────
export interface UserRow {
  id: string;
  name: string;
  balance: number;
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

/** 로그인 사용자의 전체 상태(잔고+포지션+주문) 조회 */
export async function loadState(env: Env, uid: string) {
  const user = await env.DB.prepare('SELECT id, name, balance FROM users WHERE id = ?')
    .bind(uid)
    .first<UserRow>();
  if (!user) return null;
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
  return {
    name: user.name,
    balance: user.balance,
    positions: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entry_price,
      size: p.size,
      leverage: p.leverage,
      openedAt: p.opened_at,
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
  };
}
