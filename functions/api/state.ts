import { type Ctx, bad, json, getSession, loadState } from '../_shared';

/** GET /api/state — 로그인 사용자의 잔고+포지션+주문 */
export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  const state = await loadState(env, sess.uid);
  if (!state) return bad('unauthorized', 401);
  return json(state);
}
