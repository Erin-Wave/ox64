import {
  type Ctx,
  bad,
  json,
  safe,
  missingEnv,
  getSession,
  loadState,
  todayKst,
  REFILL_AMOUNT,
  REFILL_DAILY_LIMIT,
  type UserRow,
} from '../_shared';

/**
 * POST /api/refill — 강제청산 등으로 잔고가 바닥났을 때를 대비한 안전망.
 * 하루(KST 기준) 최대 3회, 1회당 10,000 USDT 지급. 날짜가 바뀌면 자동으로 리셋(별도 cron 불필요 —
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

  const user = await env.DB.prepare('SELECT id, name, balance, refill_count, refill_date FROM users WHERE id = ?')
    .bind(uid)
    .first<UserRow>();
  if (!user) return bad('unauthorized', 401);

  const today = todayKst();
  const usedToday = user.refill_date === today ? user.refill_count : 0;
  if (usedToday >= REFILL_DAILY_LIMIT) return bad(`오늘 리필 횟수를 모두 사용했습니다 (${REFILL_DAILY_LIMIT}/${REFILL_DAILY_LIMIT})`);

  await env.DB.prepare('UPDATE users SET balance = balance + ?, refill_count = ?, refill_date = ? WHERE id = ?')
    .bind(REFILL_AMOUNT, usedToday + 1, today, uid)
    .run();

  return json(await loadState(env, uid));
}
