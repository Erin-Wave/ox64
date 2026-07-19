import { useState } from 'react';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice, fmtQty, fmtUsd } from '@/format';
import type { ApiOrder } from '@/services/api';

type Tab = 'positions' | 'pending' | 'history';

const KIND_LABEL: Record<ApiOrder['kind'], string> = { open: '진입', close: '청산', liquidation: '강제청산' };
// sv-SE 로케일은 'YYYY-MM-DD HH:mm:ss' 형식으로 떨어져서 KST 타임존 지정과 함께 편하게 재사용.
const fmtTime = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

/** 보유 포지션 목록 + 실시간 미실현 손익/ROE·청산가 (OKX 스타일).
 * 탭: 포지션 / (Standard) 미체결 지정가 / 주문내역. */
export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);
  const orders = useTradingStore((s) => s.orders);
  const balance = useTradingStore((s) => s.balance);
  const closePosition = useTradingStore((s) => s.closePosition);
  const limitClose = useTradingStore((s) => s.limitClose);
  const cancelLimit = useTradingStore((s) => s.cancelLimit);
  const editLimit = useTradingStore((s) => s.editLimit);
  const setSlTp = useTradingStore((s) => s.setSlTp);
  const busy = useTradingStore((s) => s.busy);
  const prices = useMarketStore((s) => s.prices);
  const precisions = useMarketStore((s) => s.precisions);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const standard = useSettingsStore((s) => s.tradingMode) === 'standard';

  const [tab, setTab] = useState<Tab>('positions');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');
  const [closeAmt, setCloseAmt] = useState<Record<string, string>>({}); // 포지션별 부분청산 수량(비우면 전량)
  const [closePx, setClosePx] = useState<Record<string, string>>({}); // 포지션별 청산 지정가(비우면 시장가)

  // 지정가가 채워져 있으면 지정가 청산(reduce-only 주문 예약), 아니면 시장가 청산.
  // 수량이 비어 있으면 전량(시장가는 size 생략, 지정가는 보유수량 전체) — 보유량 초과는 서버가 거부.
  const doClose = (id: string, posSize: number) => {
    const amt = closeAmt[id] ? Number(closeAmt[id]) : NaN;
    const px = closePx[id] ? Number(closePx[id]) : NaN;
    if (px > 0) limitClose(id, amt > 0 ? amt : posSize, px);
    else closePosition(id, amt > 0 ? amt : undefined);
    setCloseAmt((s) => ({ ...s, [id]: '' }));
    setClosePx((s) => ({ ...s, [id]: '' }));
  };

  const startEdit = (id: string, sl: number | null, tp: number | null) => {
    setEditingId(id);
    setEditSl(sl != null ? String(sl) : '');
    setEditTp(tp != null ? String(tp) : '');
  };
  const saveEdit = (id: string) => {
    setSlTp(id, {
      stopLoss: editSl ? Number(editSl) : null,
      takeProfit: editTp ? Number(editTp) : null,
    });
    setEditingId(null);
  };

  // 미체결(지정가) 주문 수정 — 지정가/수량 인라인 편집.
  const [editPendId, setEditPendId] = useState<string | null>(null);
  const [editPendPx, setEditPendPx] = useState('');
  const [editPendSize, setEditPendSize] = useState('');
  const startEditPend = (id: string, price: number, size: number) => {
    setEditPendId(id);
    setEditPendPx(String(price));
    setEditPendSize(String(size));
  };
  const saveEditPend = (id: string) => {
    const px = editPendPx ? Number(editPendPx) : NaN;
    const size = editPendSize ? Number(editPendSize) : NaN;
    editLimit(id, { limitPrice: px > 0 ? px : undefined, size: size > 0 ? size : undefined });
    setEditPendId(null);
  };

  // 각 포지션의 미실현 PnL(현재 시세 기준) — 청산가 계산에서 "다른 포지션들"의 몫을 뺄 때 재사용.
  const unrealizedOf = (p: (typeof positions)[number]) => {
    const live = prices[p.symbol];
    if (live == null) return null;
    const dir = p.side === 'long' ? 1 : -1;
    return (live - p.entryPrice) * p.size * dir;
  };
  const totalUnrealizedKnown = positions.every((p) => unrealizedOf(p) != null);
  const totalUnrealized = positions.reduce((a, p) => a + (unrealizedOf(p) ?? 0), 0);
  const totalMargin = positions.reduce((a, p) => a + (p.entryPrice * p.size) / p.leverage, 0);

  // 청산가: 이 포지션의 가격이 얼마가 되면 계좌 평가자산이 0이 되는지.
  // 평가자산 = 여유잔고 + Σ(잠긴 증거금 + 미실현손익) — 서버(functions/_trading.ts)의 강제청산 조건과
  // 동일한 산식(증거금 항 포함). 추정치 표시용(실제 체결은 서버가 함).
  const liqPriceOf = (p: (typeof positions)[number]): number | null => {
    if (!totalUnrealizedKnown) return null;
    const mine = unrealizedOf(p);
    if (mine == null) return null;
    const others = totalUnrealized - mine;
    const dir = p.side === 'long' ? 1 : -1;
    return p.entryPrice - (balance + totalMargin + others) / (p.size * dir);
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      onClick={() => setTab(t)}
      className={`rounded px-2 py-1 text-xs font-semibold transition ${
        tab === t ? 'bg-elevated text-text' : 'text-muted hover:text-text'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 탭 헤더 */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {tabBtn('positions', `포지션 (${positions.length})`)}
        {standard && tabBtn('pending', `미체결 (${pendingOrders.length})`)}
        {tabBtn('history', '주문내역')}
      </div>

      {tab === 'positions' &&
        (positions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">
            보유 중인 포지션이 없습니다
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 text-right font-medium">현재가</th>
                  <th className="px-3 py-2 text-right font-medium">진입가</th>
                  <th className="px-3 py-2 text-right font-medium">청산가</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  {standard && <th className="px-3 py-2 text-right font-medium">SL / TP</th>}
                  <th className="px-3 py-2 text-right font-medium">미실현 PnL (ROE)</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const dir = p.side === 'long' ? 1 : -1;
                  const live = prices[p.symbol] ?? null;
                  const pnl = live != null ? (live - p.entryPrice) * p.size * dir : null;
                  const margin = (p.entryPrice * p.size) / p.leverage;
                  const roe = pnl != null && margin > 0 ? (pnl / margin) * 100 : null;
                  const pos = pnl != null && pnl >= 0;
                  const prec = precisionOf(precisions, p.symbol);
                  const editing = editingId === p.id;
                  const liq = liqPriceOf(p);
                  return (
                    <tr key={p.id} className="border-b border-border/60 transition hover:bg-panel2">
                      <td className="px-3 py-2.5 font-medium text-text">
                        <button
                          onClick={() => setSymbol(p.symbol)}
                          title={`${p.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {p.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            p.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                          }`}
                        >
                          {p.side === 'long' ? '롱' : '숏'} 크로스 {p.leverage}x
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">{live != null ? fmtPrice(live, prec) : '—'}</td>
                      <td className="px-3 py-2.5 text-right text-text">{fmtPrice(p.entryPrice, prec)}</td>
                      <td className="px-3 py-2.5 text-right text-down">
                        {liq != null && liq > 0 ? fmtPrice(liq, prec) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        <div>{fmtQty(p.size)}</div>
                        <div className="text-[10px] text-muted">({fmtUsd(margin)} USDT)</div>
                      </td>
                      {standard && (
                        <td className="px-3 py-2.5 text-right">
                          {editing ? (
                            <div className="flex items-center justify-end gap-1">
                              <input
                                value={editSl}
                                onChange={(e) => setEditSl(e.target.value)}
                                placeholder="SL"
                                inputMode="decimal"
                                className="w-16 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                              />
                              <input
                                value={editTp}
                                onChange={(e) => setEditTp(e.target.value)}
                                placeholder="TP"
                                inputMode="decimal"
                                className="w-16 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                              />
                              <button
                                onClick={() => saveEdit(p.id)}
                                disabled={busy}
                                className="rounded bg-elevated px-1.5 py-0.5 text-[11px] text-accent hover:bg-panel2"
                              >
                                저장
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(p.id, p.stopLoss, p.takeProfit)}
                              className="text-[11px] text-muted hover:text-text"
                            >
                              {p.stopLoss != null || p.takeProfit != null ? (
                                <span className="space-x-1">
                                  <span className="text-down">{p.stopLoss != null ? fmtPrice(p.stopLoss, prec) : '—'}</span>
                                  <span>/</span>
                                  <span className="text-up">{p.takeProfit != null ? fmtPrice(p.takeProfit, prec) : '—'}</span>
                                </span>
                              ) : (
                                '설정'
                              )}
                            </button>
                          )}
                        </td>
                      )}
                      <td
                        className={`px-3 py-2.5 text-right font-medium ${
                          pnl == null ? 'text-muted' : pos ? 'text-up' : 'text-down'
                        }`}
                      >
                        {pnl == null ? (
                          '—'
                        ) : (
                          <>
                            {pos ? '+' : ''}
                            {fmtUsd(pnl)}
                            <span className="ml-1 text-[10px] opacity-80">
                              ({pos ? '+' : ''}
                              {roe?.toFixed(1)}%)
                            </span>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {standard && (
                            <>
                              <input
                                value={closeAmt[p.id] ?? ''}
                                onChange={(e) => setCloseAmt((s) => ({ ...s, [p.id]: e.target.value }))}
                                placeholder={fmtQty(p.size)}
                                inputMode="decimal"
                                title="청산 수량(비우면 전량)"
                                className="w-14 rounded bg-panel2 px-1.5 py-1 text-right text-[11px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                              />
                              <input
                                value={closePx[p.id] ?? ''}
                                onChange={(e) => setClosePx((s) => ({ ...s, [p.id]: e.target.value }))}
                                placeholder="시장가"
                                inputMode="decimal"
                                title="청산 지정가(비우면 시장가, 채우면 그 가격에 지정가 청산 예약)"
                                className="w-16 rounded bg-panel2 px-1.5 py-1 text-right text-[11px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                              />
                            </>
                          )}
                          <button
                            onClick={() => (standard ? doClose(p.id, p.size) : closePosition(p.id))}
                            disabled={busy}
                            title={standard ? '지정가 입력 시 지정가 청산, 비우면 시장가 청산' : '전량 시장가 청산'}
                            className="rounded border border-border px-2.5 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                          >
                            청산
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'pending' &&
        (pendingOrders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">
            미체결 지정가 주문이 없습니다
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 text-right font-medium">지정가</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {pendingOrders.map((o) => {
                  const pe = editPendId === o.id;
                  return (
                    <tr key={o.id} className="border-b border-border/60">
                      <td className="px-3 py-2.5 font-medium text-text">
                        <button
                          onClick={() => setSymbol(o.symbol)}
                          title={`${o.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {o.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        {o.reduceOnly ? (
                          // 지정가 청산(reduce-only) — 주문 방향(side)의 반대가 청산 대상 포지션 방향.
                          <span className="rounded bg-elevated px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                            {o.side === 'short' ? '롱' : '숏'} 청산
                          </span>
                        ) : (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                              o.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                            }`}
                          >
                            {o.side === 'long' ? '롱' : '숏'} 크로스 {o.leverage}x
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {pe ? (
                          <input
                            value={editPendPx}
                            onChange={(e) => setEditPendPx(e.target.value)}
                            placeholder="지정가"
                            inputMode="decimal"
                            className="w-20 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                          />
                        ) : (
                          fmtPrice(o.limitPrice, precisionOf(precisions, o.symbol))
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {pe ? (
                          <input
                            value={editPendSize}
                            onChange={(e) => setEditPendSize(e.target.value)}
                            placeholder="수량"
                            inputMode="decimal"
                            className="w-20 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                          />
                        ) : (
                          fmtQty(o.size)
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {pe ? (
                            <>
                              <button
                                onClick={() => saveEditPend(o.id)}
                                disabled={busy}
                                className="rounded bg-elevated px-2 py-1 text-accent transition hover:bg-panel2 disabled:opacity-40"
                              >
                                저장
                              </button>
                              <button
                                onClick={() => setEditPendId(null)}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:text-text"
                              >
                                취소
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditPend(o.id, o.limitPrice, o.size)}
                                disabled={busy}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:border-accent hover:text-accent disabled:opacity-40"
                              >
                                수정
                              </button>
                              <button
                                onClick={() => cancelLimit(o.id)}
                                disabled={busy}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                              >
                                취소
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'history' &&
        (orders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">주문 내역이 없습니다</div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">시각</th>
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 font-medium">종류</th>
                  <th className="px-3 py-2 text-right font-medium">체결가</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2 text-right font-medium">손익</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const prec = precisionOf(precisions, o.symbol);
                  const pos = o.pnl != null && o.pnl >= 0;
                  return (
                    <tr key={o.id} className="border-b border-border/60">
                      <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtTime(o.createdAt)}</td>
                      <td className="px-3 py-2 font-medium text-text">
                        <button
                          onClick={() => setSymbol(o.symbol)}
                          title={`${o.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {o.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span className={o.side === 'long' ? 'text-up' : 'text-down'}>
                          {o.side === 'long' ? '롱' : '숏'} {o.leverage}x
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            o.kind === 'liquidation' ? 'font-semibold text-down' : 'text-muted'
                          }
                        >
                          {KIND_LABEL[o.kind]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-text">{fmtPrice(o.price, prec)}</td>
                      <td className="px-3 py-2 text-right text-text">{fmtQty(o.size)}</td>
                      <td className={`px-3 py-2 text-right font-medium ${o.pnl == null ? 'text-muted' : pos ? 'text-up' : 'text-down'}`}>
                        {o.pnl == null ? '—' : `${pos ? '+' : ''}${fmtUsd(o.pnl)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
