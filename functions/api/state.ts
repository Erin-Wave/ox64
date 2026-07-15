import { type Ctx, bad, json, safe, missingEnv, getSession, loadState } from '../_shared';
import { checkTriggers } from '../_trading';

/** GET /api/state — 로그인 사용자의 잔고+포지션+주문 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);
    // 지정가/SL/TP 체결 체크 — 폴링 시점마다 평가(서버에 cron 없음, functions/_trading.ts 참고)
    await checkTriggers(env, sess.uid);
    const state = await loadState(env, sess.uid);
    if (!state) return bad('unauthorized', 401);
    return json(state);
  });
}
