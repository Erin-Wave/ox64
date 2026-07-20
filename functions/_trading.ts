// ── 지정가/스탑로스/테이크프로핏 체결 체크 ──────────────────────────────
// Cloudflare Pages Functions 는 정기 실행(cron)을 지원하지 않는다. 그래서 이 유저의
// state/order 요청이 들어올 때마다(클라이언트가 몇 초 간격으로 폴링) 호출해
// 조건이 맞으면 그 자리에서 체결시키는 방식으로 대체한다 — 아무도 앱을 켜두지
// 않은 동안은 체결되지 않는다(지인 대상 모의투자라 허용 가능한 트레이드오프).
//
// ⚠ 단, 강제청산(계좌 파산)만큼은 접속 여부와 무관하게 걸리길 원해서 sweepForcedLiquidations()
// 를 따로 뒀다 — cron/ 의 별도 Worker(Cron Trigger, Pages 는 cron 미지원이라 분리 배포)가
// 1시간마다 호출해 전 유저를 훑는다. 지정가/SL·TP 는 여전히 접속(폴링) 기반 그대로.

import {
  type D1PreparedStatement,
  type Env,
  type PendingRow,
  type PositionRow,
  fetchPrices,
  isVirtualSymbol,
  feeRateOf,
  feeAccrualStmts,
} from './_shared';
import { matchLimitPendingAgainstBook, matchReduceOnlyOxPending, recordVirtualFill } from './api/spot';

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

  // 계좌 순자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익).
  // ⚠ 예전엔 증거금 항을 빠뜨리고 "잔고 + 미실현손익"으로만 계산했다 — 진입 시 증거금은 잔고에서
  // 이미 빠져나갔는데(그게 곧 담보다) 그걸 순자산에서 또 제외한 꼴이라, 증거금 비중을 크게 잡으면
  // (슬라이더 100% 등) 진입 즉시 equity 가 0 근처가 돼 아주 작은 역행 틱에도 강제청산되던 치명적 버그.
  let equity = user.balance;
  let allPriced = true;
  for (const pos of positions) {
    const mark = prices[pos.symbol];
    if (mark == null) {
      allPriced = false;
      continue;
    }
    const dir = pos.side === 'long' ? 1 : -1;
    equity += pos.margin + (mark - pos.entry_price) * pos.size * dir;
  }
  if (!allPriced || equity >= 0) return false;

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
    // ⚠ 강제청산은 **수수료를 걷지 않는다**(바로 아래에서 잔고를 0 으로 리셋하므로 실제로 걷을 수
    // 없는 돈이다 — 부과하면 원장에 걷지도 못한 수익이 잡힌다). 다만 실제로 체결된 거래이므로
    // 거래대금은 누적한다(VIP 등급 산정에 반영). fee=0 인 'liquidation' 원장 행이 남아 나중에
    // "강제청산으로 얼마가 돌았는지"도 집계할 수 있다.
    stmts.push(...feeAccrualStmts(env, uid, pos.symbol, 'liquidation', mark * pos.size, 0, 0, now));
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

/** 실제 코인 지정가 청산(reduce-only) 정산 — mark 가 지정가를 크로스하면 대상 포지션을 그 지정가에 청산.
 * 대상 포지션(주문 side 의 반대)을 최신 상태로 다시 읽어(같은 폴링에서 물타기 등이 바꿨을 수 있음) 있으면
 * min(주문수량, 포지션수량)만큼 청산하고 pending 을 삭제한다. 포지션이 이미 없으면 고아 pending 을 정리.
 * (OX 는 봇 호가창 walking 이 필요해 spot.ts matchReduceOnlyOxPending 이 따로 담당 — 여기선 실제 코인 전용.) */
async function settleReduceOnlyClose(env: Env, uid: string, p: PendingRow, mark: number): Promise<void> {
  const posSide = p.side === 'short' ? 'long' : 'short'; // 청산 대상 포지션 방향(주문 side 의 반대)
  const pos = await env.DB.prepare('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?')
    .bind(uid, p.symbol, posSide)
    .first<PositionRow>();
  if (!pos) {
    await env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid).run(); // 고아 정리
    return;
  }
  // 매도청산(side short)은 가격이 지정가 이상으로 오르면, 매수청산(side long)은 지정가 이하로 내리면 체결.
  const fills = p.side === 'short' ? mark >= p.limit_price : mark <= p.limit_price;
  if (!fills) return;

  const closeSize = Math.min(p.size, pos.size);
  const dir = pos.side === 'long' ? 1 : -1;
  const pnl = (p.limit_price - pos.entry_price) * closeSize * dir;
  const marginReleased = (pos.margin * closeSize) / pos.size;
  const fullyClosed = closeSize >= pos.size - 1e-9;
  const now = Date.now();
  const rate = await feeRateOf(env, uid);
  const notional = p.limit_price * closeSize;
  const fee = notional * rate;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(marginReleased + pnl - fee, uid),
    ...feeAccrualStmts(env, uid, p.symbol, 'close', notional, rate, fee, now),
    fullyClosed
      ? env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid)
      : env.DB.prepare('UPDATE positions SET size = ?, margin = ? WHERE id = ? AND user_id = ?')
          .bind(pos.size - closeSize, pos.margin - marginReleased, pos.id, uid),
    env.DB.prepare('DELETE FROM pending_orders WHERE id = ? AND user_id = ?').bind(p.id, uid),
    env.DB.prepare(
      'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), uid, p.symbol, pos.side, p.limit_price, closeSize, pos.leverage, 'close', pnl, now),
  ]);
  await reflectVirtualFill(env, p.symbol, uid, p.limit_price, pos.side === 'long' ? 'sell' : 'buy', closeSize);
}

// 반환값 = 이번에 받아온 마크가격 맵(loadState 로 넘겨 클라가 서버와 동일한 시세로 청산가/평가자산을
// 즉시 계산하게 한다 — 추가 fetch 없이 재사용). 포지션/미체결이 없으면 빈 맵.
export async function checkTriggers(env: Env, uid: string): Promise<Record<string, number>> {
  const pendings = (
    await env.DB.prepare('SELECT * FROM pending_orders WHERE user_id = ?').bind(uid).all<PendingRow>()
  ).results;
  const positions = (
    await env.DB.prepare('SELECT * FROM positions WHERE user_id = ?').bind(uid).all<PositionRow>()
  ).results;
  if (pendings.length === 0 && positions.length === 0) return {};

  const symbols = [...new Set([...pendings.map((p) => p.symbol), ...positions.map((p) => p.symbol)])];
  const prices = await fetchPrices(env, symbols);

  if (await liquidateIfBankrupt(env, uid, positions, pendings, prices)) return prices; // 방금 지운 대상으로 아래 로직 더 돌릴 필요 없음

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
    // 실제 호가 가격에 체결, 잔량은 대기. reduce_only(지정가 청산)면 청산 매칭으로 분기. 실제 코인은 아래로.
    if (isVirtualSymbol(p.symbol)) {
      if (p.reduce_only) await matchReduceOnlyOxPending(env, p.id);
      else await matchLimitPendingAgainstBook(env, p.id);
      continue;
    }

    // 지정가 청산(reduce-only, 실제 코인) — 로컬 호가창이 없어 mark 가 지정가를 크로스하면 그 지정가에 청산.
    // 매도청산(side short)은 mark>=limit(가격이 오르면 롱 익절), 매수청산(side long)은 mark<=limit(가격이 내리면 숏 익절).
    if (p.reduce_only) {
      await settleReduceOnlyClose(env, uid, p, mark);
      continue;
    }

    const fills = p.side === 'long' ? mark <= p.limit_price : mark >= p.limit_price;
    if (!fills) continue;

    const now = Date.now();
    const ordId = crypto.randomUUID();
    const key = `${p.symbol}|${p.side}`;
    const existing = posBySymbolSide.get(key);
    // 지정가는 **주문 낼 때가 아니라 체결될 때** 수수료를 뗀다(거래소 관행). 증거금은 주문 시점에
    // 이미 잠갔으므로 여기선 수수료만 잔고에서 차감한다 — 명목금액의 0.03% 이하라 잔고가 모자라
    // 실패할 여지는 사실상 없고(증거금 대비 수 %), 부족하면 크로스 평가자산이 줄어 강제청산이 처리한다.
    const feeRate = await feeRateOf(env, uid);
    const notional = p.limit_price * p.size;
    const fee = notional * feeRate;
    const feeStmts = [
      env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(fee, uid),
      ...feeAccrualStmts(env, uid, p.symbol, 'open', notional, feeRate, fee, now),
    ];

    if (existing) {
      const newSize = existing.size + p.size;
      const newEntry = (existing.entry_price * existing.size + p.limit_price * p.size) / newSize;
      const newMargin = existing.margin + p.margin;
      const finalSl = p.stop_loss != null ? p.stop_loss : existing.stop_loss;
      const finalTp = p.take_profit != null ? p.take_profit : existing.take_profit;
      await env.DB.batch([
        ...feeStmts,
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
        ...feeStmts,
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
  for (const posSnap of positions) {
    if (posSnap.stop_loss == null && posSnap.take_profit == null) continue;
    const mark = prices[posSnap.symbol];
    if (mark == null) continue;
    // ⚠ 같은 폴링에서 지정가 청산(reduce-only)·물타기가 이 포지션을 이미 줄이거나 없앴을 수 있으므로,
    // 스냅샷이 아니라 최신 상태를 다시 읽어 이중 청산(사라진 포지션에 잔고를 또 환급)하지 않게 한다.
    const pos = await env.DB.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?')
      .bind(posSnap.id, uid)
      .first<PositionRow>();
    if (!pos || (pos.stop_loss == null && pos.take_profit == null)) continue;
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
    const slRate = await feeRateOf(env, uid);
    const slNotional = trigger * pos.size;
    const slFee = slNotional * slRate;
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(pos.margin + pnl - slFee, uid),
      ...feeAccrualStmts(env, uid, pos.symbol, 'close', slNotional, slRate, slFee, now),
      env.DB.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').bind(pos.id, uid),
      env.DB.prepare(
        'INSERT INTO orders (id, user_id, symbol, side, price, size, leverage, kind, pnl, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(ordId, uid, pos.symbol, pos.side, trigger, pos.size, pos.leverage, 'close', pnl, now),
    ]);
    await reflectVirtualFill(env, pos.symbol, uid, trigger, pos.side === 'long' ? 'sell' : 'buy', pos.size);
  }

  return prices;
}
