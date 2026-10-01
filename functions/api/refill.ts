import {
  type Ctx,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  loadState,
  todayKst,
  fetchPrices,
  REFILL_AMOUNT,
  REFILL_DAILY_LIMIT,
  quoteOf,
  USDT_KRW,
  type Quote,
  type UserRow,
  type PositionRow,
} from '../_shared';
import { checkTriggers } from '../_trading';

/**
 * POST /api/refill — 강제청산 등으로 자산이 완전히 바닥났을 때를 대비한 안전망.
 * 평가자산(두 지갑 합산, 원화는 USDT 환산)이 0(이하)일 때만 지급 — 자산이 남아있으면 거부.
 * 하루(KST 기준) 최대 3회, 1회당 10,000 USDT. 날짜가 바뀌면 자동으로 리셋(별도 cron 불필요 —
 * refill_date 가 오늘과 다르면 지금까지 쓴 횟수를 0으로 취급하고 이번 호출로 refill_date 를 오늘로 갱신).
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

  // ⚠ 먼저 트리거를 평가한다(2026-10-01) — 파산한 포지션이 남아 있으면 여기서 강제청산되고 리필은 빈 계좌에 들어간다.
  // 안 그러면 리필 1만 USDT 가 **청산됐어야 할 포지션의 담보**로 들어가 손실 포지션을 살려 냈다(감사).
  await checkTriggers(env, uid);

  const [userRes, posRes, pendRes] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, balance, krw_balance, refill_count, refill_date FROM users WHERE id = ?').bind(uid),
    env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid),
    // 대기 지정가(진입)에 잠긴 증거금도 내 자산이다 — 빼면 "지정가에 전 재산을 묶고 리필 → 취소해서 돌려받기"가 된다(감사).
    env.DB.prepare('SELECT symbol, margin FROM pending_orders WHERE user_id = ? AND reduce_only = 0').bind(uid),
  ]);
  const user = (userRes.results as UserRow[])[0];
  if (!user) return bad('unauthorized', 401);
  const positions = posRes.results as PositionRow[];
  const locked: Record<Quote, number> = { USDT: 0, KRW: 0 };
  for (const p of pendRes.results as { symbol: string; margin: number }[]) locked[quoteOf(p.symbol)] += p.margin;

  // ⚠ 파산 판정 = **두 지갑 합산**(USDT + 원화÷환율) — 원화가 남아 있으면 환전해서 쓰면 되므로 리필을 주지
  // 않는다(한쪽 지갑만 보면 원화로 옮겨두고 리필을 계속 받는 구멍이 된다). 리필 자체는 USDT 로 지급.
  const krwBal = user.krw_balance ?? 0;
  const needRate = krwBal !== 0 || locked.KRW !== 0 || positions.some((p) => quoteOf(p.symbol) === 'KRW');
  let marks: Record<string, number> | undefined;
  if (positions.length > 0 || needRate) {
    const prices = await fetchPrices(env, [...new Set(positions.map((p) => p.symbol)), ...(needRate ? [USDT_KRW] : [])]);
    marks = prices;
    // 평가자산(equity) = 여유잔고 + 대기 주문 증거금 + Σ(잠긴 증거금 + 미실현손익). 강제청산 판정(_trading.ts)과 동일한 식(지갑별).
    const eq: Record<Quote, number> = { USDT: user.balance + locked.USDT, KRW: krwBal + locked.KRW };
    for (const pos of positions) {
      const mark = prices[pos.symbol];
      if (mark == null) return bad('시세 조회에 실패했습니다. 잠시 후 다시 시도해주세요');
      const dir = pos.side === 'long' ? 1 : -1;
      eq[quoteOf(pos.symbol)] += pos.margin + (mark - pos.entry_price) * pos.size * dir;
    }
    const rate = prices[USDT_KRW];
    if (needRate && !rate) return bad('환율 조회에 실패했습니다. 잠시 후 다시 시도해주세요');
    const total = eq.USDT + (needRate ? eq.KRW / rate : 0);
    if (total > 0) {
      return bad(
        eq.KRW > 0 && eq.USDT <= 0
          ? '원화 자산이 남아있습니다 — 환전해서 사용하세요'
          : '평가자산이 남아있는 동안에는 리필할 수 없습니다',
      );
    }
  } else if (user.balance + locked.USDT > 0) {
    return bad('잔고가 남아있는 동안에는 리필할 수 없습니다');
  }

  const today = todayKst();
  const usedToday = user.refill_date === today ? user.refill_count : 0;
  if (usedToday >= REFILL_DAILY_LIMIT) return bad(`오늘 리필 횟수를 모두 사용했습니다 (${REFILL_DAILY_LIMIT}/${REFILL_DAILY_LIMIT})`);

  // ⚠⚠ 판정에 쓴 값이 **그대로일 때만** 지급한다(compare-and-swap, 2026-10-01). 예전엔 횟수를 "읽은 값 + 1" 로 덮어써서
  // 리필 버튼을 동시에 여러 번 보내면 전부 통과해 1만 USDT 가 요청 수만큼 들어오고 횟수는 1 만 올랐다(감사). 잔고·횟수·날짜가
  // 읽은 그대로가 아니면 0행 — 그 사이 무엇이 바뀌었으니 다시 판단하게 한다.
  // ⚠ **포지션이 없는 지갑의 음수 잔고는 0 으로 탕감**한다(2026-10-01). 아주 큰 포지션을 시장가로 한 번에 청산하면 호가창을
  // 따라 내려가며 증거금보다 훨씬 큰 손실이 실현돼 잔고가 깊은 음수로 끝날 수 있는데(실제 거래소라면 보험기금이 메우는 몫),
  // 그대로 두면 리필 1만 USDT 를 받아도 여전히 음수라 다시는 거래할 수 없었다. 포지션이 남은 지갑은 위 트리거 평가가 이미
  // 강제청산으로 0 을 만들었거나 아직 담보가 있는 상태라 건드리지 않는다.
  const hasPos = (q: Quote) => positions.some((p) => quoteOf(p.symbol) === q);
  const newUsdt = (hasPos('USDT') ? user.balance : Math.max(0, user.balance)) + REFILL_AMOUNT;
  const newKrw = hasPos('KRW') ? krwBal : Math.max(0, krwBal);
  const res = await env.DB.prepare(
    'UPDATE users SET balance = ?, krw_balance = ?, refill_count = ?, refill_date = ? WHERE id = ? AND balance = ? AND krw_balance = ? AND refill_count = ? AND IFNULL(refill_date, \'\') = ?',
  )
    .bind(newUsdt, newKrw, usedToday + 1, today, uid, user.balance, krwBal, user.refill_count, user.refill_date ?? '')
    .run();
  if (res.meta.changes !== 1) return bad('잔고가 방금 바뀌었습니다. 다시 시도해주세요', 409);

  return json(await loadState(env, uid, marks));
}
