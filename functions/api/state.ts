import { type Ctx, bad, json, safe, missingEnv, getSession, loadState } from '../_shared';
import { checkTriggers } from '../_trading';

/** GET /api/state — 로그인 사용자의 잔고+포지션+주문 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);
    // 지정가/SL/TP 체결 체크 — 폴링 시점마다 평가(서버에 cron 없음, functions/_trading.ts 참고).
    // 반환된 마크가격을 loadState 에 넘겨 클라가 청산가/평가자산을 서버와 동일 시세로 즉시 계산하게 한다.
    const marks = await checkTriggers(env, sess.uid);
    const state = await loadState(env, sess.uid, marks);
    if (!state) return bad('unauthorized', 401);
    return json(state);
  });
}
