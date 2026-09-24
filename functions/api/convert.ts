import {
  type Ctx,
  type PositionRow,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  fetchPrices,
  loadState,
  quoteOf,
  balCol,
  USDT_KRW,
  type Quote,
} from '../_shared';
import { checkTriggers } from '../_trading';

/**
 * POST /api/convert { from: 'USDT' | 'KRW', amount, ordersSince? } — USDT 지갑 ↔ 원화 지갑 환전.
 *
 * - 환율 = 빗썸 USDT/KRW 현재가(서버가 받는다 — 클라가 보낸 환율은 안 쓴다), **수수료 0**.
 * - 환전 가능액 = `min(잔고, 잔고 + 그 지갑 미실현손익)` — **미실현 이익은 못 옮기고, 미실현 손실은 뺀다**.
 *   크로스라 잔고가 담보인데, 이익까지 빼 가면 포지션이 되돌아올 때 그 지갑이 곧바로 파산하고, 손실을 무시하고
 *   빼 가면 같은 일이 즉시 일어난다(실거래소의 "이체 가능 금액"과 같은 규칙).
 * - 기록은 주문내역에 `kind='convert'`, symbol `USDTKRW`, price=환율, size=USDT 수량(항상 USDT 단위),
 *   side = 'long'(원화→USDT, USDT 를 샀다) / 'short'(USDT→원화). 차트 마커는 심볼로 거르므로 섞이지 않는다.
 * - D1: users UPDATE 1 + orders INSERT 1(≈4행). 사람 손 속도의 액션이라 예산 계량 대상이 아니다(§6).
 */
export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handle(request, env));
}

async function handle(request: Request, env: Ctx['env']): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  const uid = sess.uid;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('invalid json');
  }
  const from: Quote | null = body.from === 'USDT' ? 'USDT' : body.from === 'KRW' ? 'KRW' : null;
  if (!from) return bad('환전 방향 오류');
  const to: Quote = from === 'USDT' ? 'KRW' : 'USDT';
  let amount = Number(body.amount);
  if (!(amount > 0) || !isFinite(amount)) return bad('금액 오류');
  const since = Number(body.ordersSince) || undefined;

  // 강제청산부터(파산한 지갑에서 돈을 빼 가지 못하게) + 보유 심볼 시세를 받는다.
  const marks = await checkTriggers(env, uid);
  const rate = marks[USDT_KRW] ?? (await fetchPrices(env, [USDT_KRW]))[USDT_KRW];
  if (!rate) return bad('환율 조회에 실패했습니다. 잠시 후 다시 시도해주세요');
  marks[USDT_KRW] = rate;

  const fc = balCol(from);
  const tc = balCol(to);
  const user = await env.DB.prepare(`SELECT ${fc} AS bal FROM users WHERE id = ?`).bind(uid).first<{ bal: number }>();
  if (!user) return bad('unauthorized', 401);
  const positions = (
    await env.DB.prepare('SELECT symbol, side, entry_price, size FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results.filter((p) => quoteOf(p.symbol) === from);
  let uPnL = 0;
  for (const p of positions) {
    const mark = marks[p.symbol];
    // 손익을 모르는 포지션이 있으면 환전 가능액을 알 수 없다(추정으로 빼 주면 그 지갑이 파산할 수 있다).
    if (mark == null) return bad('시세 조회에 실패했습니다. 잠시 후 다시 시도해주세요');
    uPnL += (mark - p.entry_price) * p.size * (p.side === 'long' ? 1 : -1);
  }
  const bal = user.bal ?? 0;
  const floor = Math.max(0, -uPnL); // 환전 뒤에도 잔고가 이만큼은 남아야 한다(미실현 손실만큼)
  const convertible = bal - floor; // = min(잔고, 잔고 + 미실현손익)
  if (!(convertible > 0)) return bad('환전 가능한 금액이 없습니다');
  // "최대"를 누르면 화면 값과 서버 값이 반올림만큼 어긋난다 — 그 정도 초과는 최대치로 맞춰 준다.
  if (amount > convertible) {
    if (amount > convertible * (1 + 1e-6) + 1e-6) return bad(`환전 가능 금액을 초과합니다 (최대 ${convertible.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${from})`);
    amount = convertible;
  }
  const received = from === 'USDT' ? amount * rate : amount / rate;
  const usdtAmount = from === 'USDT' ? amount : received;

  // ⚠ 가드 UPDATE 를 **단독으로 먼저** — 기록 INSERT 와 한 batch 에 넣으면 가드가 0행이어도 기록이 남는다
  // (D1 batch 는 0행 UPDATE 를 실패로 안 본다, §4). 가드 하한은 부동소수 오차만큼 느슨하게(최대치 환전이
  // `bal − convertible = floor − 1e-16` 로 떨어져 통째로 실패하지 않게).
  const slack = 1e-9 + Math.abs(bal) * 1e-12;
  const res = await env.DB.prepare(`UPDATE users SET ${fc} = ${fc} - ?, ${tc} = ${tc} + ? WHERE id = ? AND ${fc} - ? >= ?`)
    .bind(amount, received, uid, amount, floor - slack)
    .run();
  if (res.meta.changes !== 1) return bad('잔고가 방금 바뀌었습니다. 다시 시도해주세요');
  await env.DB.prepare(
    'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), uid, USDT_KRW, from === 'KRW' ? 'long' : 'short', rate, usdtAmount, 1, 'convert', null, Date.now())
    .run();

  return json(await loadState(env, uid, marks, since));
}
