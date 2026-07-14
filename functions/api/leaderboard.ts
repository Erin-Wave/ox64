import { type Ctx, bad, json, getSession, fetchPrices, type PositionRow } from '../_shared';

/**
 * GET /api/leaderboard — 친구들 자산 순위.
 * equity = 잔고(balance) + 열린 포지션의 미실현 손익(서버 시세 기준).
 * 로그인 필요(친구 전용, 공개 스크래핑 방지).
 */
export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);

  const users = (
    await env.DB.prepare('SELECT id, name, balance FROM users').all<{
      id: string;
      name: string;
      balance: number;
    }>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions').all<PositionRow>()
  ).results;

  const prices = await fetchPrices(positions.map((p) => p.symbol));

  const unrealizedByUser: Record<string, number> = {};
  const openCountByUser: Record<string, number> = {};
  for (const p of positions) {
    const mark = prices[p.symbol] ?? p.entry_price;
    const dir = p.side === 'long' ? 1 : -1;
    unrealizedByUser[p.user_id] = (unrealizedByUser[p.user_id] ?? 0) + (mark - p.entry_price) * p.size * dir;
    openCountByUser[p.user_id] = (openCountByUser[p.user_id] ?? 0) + 1;
  }

  const rows = users
    .map((u) => {
      const unrealized = unrealizedByUser[u.id] ?? 0;
      return {
        name: u.name,
        balance: u.balance,
        equity: u.balance + unrealized,
        unrealized,
        openCount: openCountByUser[u.id] ?? 0,
        isMe: u.id === sess.uid,
      };
    })
    .sort((a, b) => b.equity - a.equity);

  return json({ leaderboard: rows });
}
