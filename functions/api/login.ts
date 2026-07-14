import {
  type Ctx,
  bad,
  json,
  safe,
  missingEnv,
  hashPasscode,
  verifyPasscode,
  signToken,
  sessionCookie,
  loadState,
  SEED_BALANCE,
  type UserRow,
} from '../_shared';

/**
 * POST /api/login  { name, passcode }
 * - 이름이 없으면 신규 가입(그 패스코드로 등록, 기본 잔고 지급).
 * - 있으면 패스코드 검증. 성공 시 HMAC 서명 세션 쿠키 발급.
 */
export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handle(request, env));
}

async function handle(request: Request, env: Ctx['env']): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);

  let body: { name?: unknown; passcode?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad('invalid json');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const passcode = typeof body.passcode === 'string' ? body.passcode : '';
  if (name.length < 1 || name.length > 20) return bad('이름은 1~20자');
  if (passcode.length < 4 || passcode.length > 64) return bad('패스코드는 4자 이상');

  const existing = await env.DB.prepare('SELECT id, name, balance FROM users WHERE name = ?')
    .bind(name)
    .first<UserRow & { passcode_hash?: string }>();

  let uid: string;
  if (!existing) {
    // 신규 가입
    uid = crypto.randomUUID();
    const hash = await hashPasscode(passcode);
    await env.DB.prepare(
      'INSERT INTO users (id, name, passcode_hash, balance, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(uid, name, hash, SEED_BALANCE, Date.now())
      .run();
  } else {
    const row = await env.DB.prepare('SELECT passcode_hash FROM users WHERE id = ?')
      .bind(existing.id)
      .first<{ passcode_hash: string }>();
    if (!row || !(await verifyPasscode(passcode, row.passcode_hash))) {
      return bad('패스코드가 틀립니다', 401);
    }
    uid = existing.id;
  }

  const token = await signToken({ uid, name }, env.SESSION_SECRET);
  const state = await loadState(env, uid);
  return json(state, 200, { 'set-cookie': sessionCookie(token) });
}
