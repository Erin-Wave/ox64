// ── 지정가/스탑로스/테이크프로핏 체결 체크 ──────────────────────────────
// Cloudflare Pages Functions 는 정기 실행(cron)을 지원하지 않는다. 그래서 이 유저의
// state/order 요청이 들어올 때마다(클라이언트가 몇 초 간격으로 폴링) 호출해
// 조건이 맞으면 그 자리에서 체결시키는 방식으로 대체한다 — 아무도 앱을 켜두지
// 않은 동안은 체결되지 않는다(지인 대상 모의투자라 허용 가능한 트레이드오프).
//
// ⚠ 단, 강제청산(계좌 파산)만큼은 접속 여부와 무관하게 걸리길 원해서 sweepForcedLiquidations()
// 를 따로 뒀다 — cron/ 의 별도 Worker(Cron Trigger, Pages 는 cron 미지원이라 분리 배포)가
// 1시간마다 호출해 전 유저를 훑는다. 지정가/SL·TP 는 여전히 접속(폴링) 기반 그대로.

import { type D1PreparedStatement, type Env, type PendingRow, type PositionRow, fetchPrices, isVirtualSymbol } from './_shared';
import { matchLimitPendingAgainstBook, recordVirtualFill } from './api/spot';

// OX/USDT 는 진짜 상대 거래자가 없으니, 지정가/SL·TP 체결도 합성 시장(호가창·체결내역·다음 봇
// 기준가)에 반영해준다 — order.ts 의 reflectVirtualFill 과 동일한 이유(실패해도 무시, 표시용 부가효과).
async function reflectVirtualFill(env: Env, symbol: string, uid: string, price: number, takerSide: 'buy' | 'sell', size: number) {
  if (!isVirtualSymbol(symbol)) return;
  try {
    await recordVirtualFill(env, uid, price, takerSide, size);
  } catch {
    /* 표시용 부가효과 — 실패해도 무시 */
  }
}

/** 평가자산(잔고+미실현손익 합) < 0 이면 그 유저의 전 포지션을 강제청산 + 미체결 취소 + 잔고 0.
 * 심볼 가격을 하나라도 못 받아왔으면(allPriced=false) 이번 라운드는 건너뛴다 — 불완전한
 * 데이터로 잘못 청산시키는 것보다 다음 평가에서 다시 보는 게 안전. 청산이 실행됐으면 true. */
async function liquidateIfBankrupt(
  env: Env,
  uid: string,
  positions: PositionRow[],
  pendings: PendingRow[],
  prices: Record<string, number>,
): Promise<boolean> {
  if (positions.length === 0) return false;
  const user = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(uid).first<{ balance: number }>();
  if (!user) return false;

  let unrealized = 0;
  let allPriced = true;
  for (const pos of positions) {
    const mark = prices[pos.symbol];
    if (mark == null) {
      allPriced = false;
      continue;
    }
    const dir = pos.side === 'long' ? 1 : -1;
    unrealized += (mark - pos.entry_price) * pos.size * dir;
  }
  if (!allPriced || user.balance + unrealized >= 0) return false;

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const pos of positions) {
    const mark = prices[pos.symbol]!;
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (mark - pos.entry_price) * pos.size * dir;
    stmts.push(env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid));
    stmts.push(
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), uid, pos.symbol, pos.side, mark, pos.size, pos.leverage, 'liquidation', pnl, now),
    );
  }
  for (const p of pendings) {
    stmts.push(env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid));
  }
  stmts.push(env.DB.prepare('UPDATE users SET balance = 0 WHERE id = ?').bind(uid));
  await env.DB.batch(stmts);
  return true;
}

/** cron/ Worker 가 접속자 유무와 무관하게 주기 호출 — 포지션이 있는 전 유저를 훑어
 * 강제청산만 평가한다(지정가/SL·TP 는 범위 밖 — 그건 접속 시 checkTriggers 가 처리). */
export async function sweepForcedLiquidations(env: Env): Promise<{ checked: number; liquidated: number }> {
  const positions = (await env.DB.prepare('SELECT * FROM positions').all<PositionRow>()).results;
  if (positions.length === 0) return { checked: 0, liquidated: 0 };

  const byUser = new Map<string, PositionRow[]>();
  for (const p of positions) {
    const arr = byUser.get(p.user_id);
    if (arr) arr.push(p);
    else byUser.set(p.user_id, [p]);
  }

  const symbols = [...new Set(positions.map((p) => p.symbol))];
  const prices = await fetchPrices(env, symbols);

  let liquidated = 0;
  for (const [uid, userPositions] of byUser) {
    const pendings = (
      await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ?').bind(uid).all<PendingRow>()
    ).results;
    if (await liquidateIfBankrupt(env, uid, userPositions, pendings, prices)) liquidated++;
  }
  return { checked: byUser.size, liquidated };
}

export async function checkTriggers(env: Env, uid: string): Promise<void> {
  const pendings = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ?').bind(uid).all<PendingRow>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results;
  if (pendings.length === 0 && positions.length === 0) return;

  const symbols = [...new Set([...pendings.map((p) => p.symbol), ...positions.map((p) => p.symbol)])];
  const prices = await fetchPrices(env, symbols);

  if (await liquidateIfBankrupt(env, uid, positions, pendings, prices)) return; // 방금 지운 대상으로 아래 로직 더 돌릴 필요 없음

  // ── 지정가 체결 ── long: mark<=limit(싸게 매수), short: mark>=limit(비싸게 매도)
  // 체결가는 limit_price 그대로 사용(생성 시 이미 그 가격 기준으로 증거금을 잠갔으므로 재계산 불필요).
  // 같은 심볼·방향 포지션이 이미 있으면(또는 이번 루프에서 방금 합쳐졌으면) 새 행을 또 만들지 않고
  // 평단가를 재계산해 합친다 — order.ts 의 시장가 진입과 동일한 원웨이 모드 동작(포지션 중복 생성 버그 수정).
  const posBySymbolSide = new Map<string, PositionRow>();
  for (const pos of positions) posBySymbolSide.set(`${pos.symbol}|${pos.side}`, pos);

  for (const p of pendings) {
    const mark = prices[p.symbol];
    if (mark == null) continue;

    // OX/USDT 는 봇 호가창에 walking 매칭(runMarketMaker 와 공유하는 실제 매칭 엔진). 있는 물량만
    // 실제 호가 가격에 체결, 잔량은 대기. 실제 코인은 아래 기존 limit_price 체결 경로 그대로.
    if (isVirtualSymbol(p.symbol)) {
      await matchLimitPendingAgainstBook(env, p.id);
      continue;
    }

    const fills = p.side === 'long' ? mark <= p.limit_price : mark >= p.limit_price;
    if (!fills) continue;

    const now = Date.now();
    const ordId = crypto.randomUUID();
    const key = `${p.symbol}|${p.side}`;
    const existing = posBySymbolSide.get(key);

    if (existing) {
      const newSize = existing.size + p.size;
      const newEntry = (existing.entry_price * existing.size + p.limit_price * p.size) / newSize;
      const newMargin = existing.margin + p.margin;
      const finalSl = p.stop_loss != null ? p.stop_loss : existing.stop_loss;
      const finalTp = p.take_profit != null ? p.take_profit : existing.take_profit;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
        env.DB.prepare(
          'UPDATE positions SET entry_price = ?, size = ?, margin = ?, stop_loss = ?, take_profit = ? WHERE id = ? AND user_id = ?',
        ).bind(newEntry, newSize, newMargin, finalSl, finalTp, existing.id, uid),
        env.DB.prepare(
          'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(ordId, uid, p.symbol, p.side, p.limit_price, p.size, existing.leverage, 'open', null, now),
      ]);
      await reflectVirtualFill(env, p.symbol, uid, p.limit_price, p.side === 'long' ? 'buy' : 'sell', p.size);
      posBySymbolSide.set(key, {
        ...existing,
        entry_price: newEntry,
        size: newSize,
        margin: newMargin,
        stop_loss: finalSl,
        take_profit: finalTp,
      });
    } else {
      const posId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
        env.DB.prepare(
          'INSERT INTO positions (id, user_id, symbol, side, entry_price, size, leverage, margin, opened_at, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).bind(posId, uid, p.symbol, p.side, p.limit_price, p.size, p.leverage, p.margin, now, p.stop_loss, p.take_profit),
        env.DB.prepare(
          'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(ordId, uid, p.symbol, p.side, p.limit_price, p.size, p.leverage, 'open', null, now),
      ]);
      await reflectVirtualFill(env, p.symbol, uid, p.limit_price, p.side === 'long' ? 'buy' : 'sell', p.size);
      posBySymbolSide.set(key, {
        id: posId,
        user_id: uid,
        symbol: p.symbol,
        side: p.side,
        entry_price: p.limit_price,
        size: p.size,
        leverage: p.leverage,
        margin: p.margin,
        opened_at: now,
        stop_loss: p.stop_loss,
        take_profit: p.take_profit,
      });
    }
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
    await reflectVirtualFill(env, pos.symbol, uid, trigger, pos.side === 'long' ? 'sell' : 'buy', pos.size);
  }
}
