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

  const user = await env.DB.prepare('SELECT id, name, balance, krw_balance, refill_count, refill_date FROM users WHERE id = ?')
    .bind(uid)
    .first<UserRow>();
  if (!user) return bad('unauthorized', 401);

  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results;
  // ⚠ 파산 판정 = **두 지갑 합산**(USDT + 원화÷환율) — 원화가 남아 있으면 환전해서 쓰면 되므로 리필을 주지
  // 않는다(한쪽 지갑만 보면 원화로 옮겨두고 리필을 계속 받는 구멍이 된다). 리필 자체는 USDT 로 지급.
  const krwBal = user.krw_balance ?? 0;
  const needRate = krwBal !== 0 || positions.some((p) => quoteOf(p.symbol) === 'KRW');
  let marks: Record<string, number> | undefined;
  if (positions.length > 0 || needRate) {
    const prices = await fetchPrices(env, [...new Set(positions.map((p) => p.symbol)), ...(needRate ? [USDT_KRW] : [])]);
    marks = prices;
    // 평가자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익). 강제청산 판정(_trading.ts)과 동일한 식(지갑별).
    const eq: Record<Quote, number> = { USDT: user.balance, KRW: krwBal };
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
  } else if (user.balance > 0) {
    return bad('잔고가 남아있는 동안에는 리필할 수 없습니다');
  }

  const today = todayKst();
  const usedToday = user.refill_date === today ? user.refill_count : 0;
  if (usedToday >= REFILL_DAILY_LIMIT) return bad(`오늘 리필 횟수를 모두 사용했습니다 (${REFILL_DAILY_LIMIT}/${REFILL_DAILY_LIMIT})`);

  await env.DB.prepare('UPDATE users SET balance = balance + ?, refill_count = ?, refill_date = ? WHERE id = ?')
    .bind(REFILL_AMOUNT, usedToday + 1, today, uid)
    .run();

  return json(await loadState(env, uid, marks));
}
