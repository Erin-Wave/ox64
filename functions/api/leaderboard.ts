import { type Ctx, bad, json, safe, missingEnv, getSession, fetchPrices, BOT_USER_IDS, vipOf, type PositionRow } from '../_shared';

/**
 * GET /api/leaderboard — 친구들 자산 순위.
 * equity = 잔고(balance) + 열린 포지션의 미실현 손익(서버 시세 기준).
 * 로그인 필요(친구 전용, 공개 스크래핑 방지).
 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(() => handle(request, env));
}

async function handle(request: Request, env: Ctx['env']): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);

  const users = (
    await env.DB.prepare(
      `SELECT id, name, balance, total_volume FROM users WHERE id NOT IN (${BOT_USER_IDS.map(() => '?').join(',')})`,
    )
      .bind(...BOT_USER_IDS)
      .all<{
        id: string;
        name: string;
        balance: number;
        total_volume: number;
      }>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions').all<PositionRow>()
  ).results;

  // 거래소(플랫폼)가 수수료로 번 총액. ⚠ `fee_ledger` 를 SUM 하면 정확하지만 그 테이블은 체결 1건당
  // 1행이라 봇 때문에 빠르게 수백만 행으로 불어난다 — 5초 폴링마다 전체 스캔할 수는 없다. 같은 값이
  // `users.total_fees` 에 누적돼 있고(feeAccrualStmts 가 원장과 함께 갱신) users 는 몇 행뿐이라
  // 이쪽을 집계한다(두 값이 정확히 일치하는 것은 검증됨).
  const rev = await env.DB.prepare(
    `SELECT
       SUM(total_fees) AS total,
       SUM(CASE WHEN id IN (${BOT_USER_IDS.map(() => '?').join(',')}) THEN total_fees ELSE 0 END) AS fromBots,
       SUM(total_volume) AS volume
     FROM users`,
  )
    .bind(...BOT_USER_IDS)
    .first<{ total: number | null; fromBots: number | null; volume: number | null }>();
  const feeTotal = rev?.total ?? 0;
  const feeFromBots = rev?.fromBots ?? 0;

  const prices = await fetchPrices(env, positions.map((p) => p.symbol));

  const unrealizedByUser: Record<string, number> = {};
  const marginByUser: Record<string, number> = {};
  const openCountByUser: Record<string, number> = {};
  for (const p of positions) {
    const mark = prices[p.symbol] ?? p.entry_price;
    const dir = p.side === 'long' ? 1 : -1;
    unrealizedByUser[p.user_id] = (unrealizedByUser[p.user_id] ?? 0) + (mark - p.entry_price) * p.size * dir;
    marginByUser[p.user_id] = (marginByUser[p.user_id] ?? 0) + p.margin;
    openCountByUser[p.user_id] = (openCountByUser[p.user_id] ?? 0) + 1;
  }

  const rows = users
    .map((u) => {
      const unrealized = unrealizedByUser[u.id] ?? 0;
      // 순자산 = 여유잔고 + Σ(잠긴 증거금 + 미실현손익). 진입 시 잔고에서 빠진 증거금도 담보라 포함해야
      // "포지션을 열면 순위 자산이 증거금만큼 깎이는" 오류가 없다(강제청산/평가자산 판정과 동일한 정의).
      return {
        name: u.name,
        balance: u.balance,
        equity: u.balance + (marginByUser[u.id] ?? 0) + unrealized,
        unrealized,
        openCount: openCountByUser[u.id] ?? 0,
        vipTier: vipOf(u.total_volume ?? 0).tier,
        isMe: u.id === sess.uid,
      };
    })
    .sort((a, b) => b.equity - a.equity);

  return json({
    leaderboard: rows,
    // 거래소 수수료 수익 — 봇/유저 분리해서 함께 내려준다(봇이 물량 대부분을 만들어서 섞으면 의미가 흐려짐).
    revenue: {
      total: feeTotal,
      fromBots: feeFromBots,
      fromUsers: feeTotal - feeFromBots,
      volume: rev?.volume ?? 0,
    },
  });
}
