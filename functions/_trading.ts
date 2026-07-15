// ── 지정가/스탑로스/테이크프로핏 체결 체크 ──────────────────────────────
// Cloudflare Pages Functions 는 정기 실행(cron)을 지원하지 않는다. 그래서 이 유저의
// state/order 요청이 들어올 때마다(클라이언트가 몇 초 간격으로 폴링) 호출해
// 조건이 맞으면 그 자리에서 체결시키는 방식으로 대체한다 — 아무도 앱을 켜두지
// 않은 동안은 체결되지 않는다(지인 대상 모의투자라 허용 가능한 트레이드오프).

import { type Env, type PendingRow, type PositionRow, fetchPrices } from './_shared';

export async function checkTriggers(env: Env, uid: string): Promise<void> {
  const pendings = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ?').bind(uid).all<PendingRow>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results;
  if (pendings.length === 0 && positions.length === 0) return;

  const symbols = [...new Set([...pendings.map((p) => p.symbol), ...positions.map((p) => p.symbol)])];
  const prices = await fetchPrices(symbols);

  // ── 지정가 체결 ── long: mark<=limit(싸게 매수), short: mark>=limit(비싸게 매도)
  // 체결가는 limit_price 그대로 사용(생성 시 이미 그 가격 기준으로 증거금을 잠갔으므로 재계산 불필요).
  for (const p of pendings) {
    const mark = prices[p.symbol];
    if (mark == null) continue;
    const fills = p.side === 'long' ? mark <= p.limit_price : mark >= p.limit_price;
    if (!fills) continue;

    const now = Date.now();
    const posId = crypto.randomUUID();
    const ordId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
      env.DB.prepare(
        'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(posId, uid, p.symbol, p.side, p.limit_price, p.size, p.leverage, p.margin, now, p.stop_loss, p.take_profit),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, p.symbol, p.side, p.limit_price, p.size, p.leverage, 'open', null, now),
    ]);
  }

  // ── SL/TP 트리거 ── 체결가는 stop_loss/take_profit 값 그대로 사용(슬리피지 모델링 없음).
  for (const pos of positions) {
    if (pos.stop_loss == null && pos.take_profit == null) continue;
    const mark = prices[pos.symbol];
    if (mark == null) continue;
    const dir = pos.side === 'long' ? 1 : -1;

    let trigger: number | null = null;
    if (pos.side === 'long') {
      if (pos.stop_loss != null && mark <= pos.stop_loss) trigger = pos.stop_loss;
      else if (pos.take_profit != null && mark >= pos.take_profit) trigger = pos.take_profit;
    } else {
      if (pos.stop_loss != null && mark >= pos.stop_loss) trigger = pos.stop_loss;
      else if (pos.take_profit != null && mark <= pos.take_profit) trigger = pos.take_profit;
    }
    if (trigger == null) continue;

    const pnl = (trigger - pos.entry_price) * pos.size * dir;
    const now = Date.now();
    const ordId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(pos.margin + pnl, uid),
      env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, pos.symbol, pos.side, trigger, pos.size, pos.leverage, 'close', pnl, now),
    ]);
  }
}
