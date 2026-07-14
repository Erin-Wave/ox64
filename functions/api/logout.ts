import { type Ctx, json, clearCookie } from '../_shared';

/** POST /api/logout — 세션 쿠키 제거 */
export async function onRequestPost(_ctx: Ctx): Promise<Response> {
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
