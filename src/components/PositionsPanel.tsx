import { useState } from 'react';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice } from '@/format';
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
  const cancelLimit = useTradingStore((s) => s.cancelLimit);
  const setSlTp = useTradingStore((s) => s.setSlTp);
  const busy = useTradingStore((s) => s.busy);
  const prices = useMarketStore((s) => s.prices);
  const precisions = useMarketStore((s) => s.precisions);
  const standard = useSettingsStore((s) => s.tradingMode) === 'standard';

  const [tab, setTab] = useState<Tab>('positions');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');
  const [closeAmt, setCloseAmt] = useState<Record<string, string>>({}); // 포지션별 부분청산 수량(비우면 전량)

  const doClose = (id: string) => {
    const raw = closeAmt[id];
    const amt = raw ? Number(raw) : NaN;
    closePosition(id, amt > 0 ? amt : undefined); // 빈칸/유효하지 않으면 size 생략(전량 청산), 보유량 초과는 서버가 거부
    setCloseAmt((s) => ({ ...s, [id]: '' }));
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

  // 각 포지션의 미실현 PnL(현재 시세 기준) — 청산가 계산에서 "다른 포지션들"의 몫을 뺄 때 재사용.
  const unrealizedOf = (p: (typeof positions)[number]) => {
    const live = prices[p.symbol];
    if (live == null) return null;
    const dir = p.side === 'long' ? 1 : -1;
    return (live - p.entryPrice) * p.size * dir;
  };
  const totalUnrealizedKnown = positions.every((p) => unrealizedOf(p) != null);
  const totalUnrealized = positions.reduce((a, p) => a + (unrealizedOf(p) ?? 0), 0);

  // 청산가: 이 포지션의 가격이 얼마가 되면 계좌 평가자산(잔고+전체 미실현손익 합)이 0이 되는지.
  // 서버(functions/_trading.ts checkTriggers)의 강제청산 조건과 동일한 산식 — 추정치 표시용(체결은 서버가 함).
  const liqPriceOf = (p: (typeof positions)[number]): number | null => {
    if (!totalUnrealizedKnown) return null;
    const mine = unrealizedOf(p);
    if (mine == null) return null;
    const others = totalUnrealized - mine;
    const dir = p.side === 'long' ? 1 : -1;
    return p.entryPrice - (balance + others) / (p.size * dir);
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
                      <td className="px-3 py-2.5 font-medium text-text">{p.symbol.replace('USDT', '')}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            p.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                          }`}
                        >
                          {p.side === 'long' ? '롱' : '숏'} {p.leverage}x
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">{fmtPrice(p.entryPrice, prec)}</td>
                      <td className="px-3 py-2.5 text-right text-down">
                        {liq != null && liq > 0 ? fmtPrice(liq, prec) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">{p.size}</td>
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
                            {pnl.toFixed(2)}
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
                            <input
                              value={closeAmt[p.id] ?? ''}
                              onChange={(e) => setCloseAmt((s) => ({ ...s, [p.id]: e.target.value }))}
                              placeholder={String(p.size)}
                              inputMode="decimal"
                              title="청산 수량(비우면 전량)"
                              className="w-16 rounded bg-panel2 px-1.5 py-1 text-right text-[11px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                            />
                          )}
                          <button
                            onClick={() => (standard ? doClose(p.id) : closePosition(p.id))}
                            disabled={busy}
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
                {pendingOrders.map((o) => (
                  <tr key={o.id} className="border-b border-border/60">
                    <td className="px-3 py-2.5 font-medium text-text">{o.symbol.replace('USDT', '')}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                          o.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                        }`}
                      >
                        {o.side === 'long' ? '롱' : '숏'} {o.leverage}x
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-text">
                      {fmtPrice(o.limitPrice, precisionOf(precisions, o.symbol))}
                    </td>
                    <td className="px-3 py-2.5 text-right text-text">{o.size}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={() => cancelLimit(o.id)}
                        disabled={busy}
                        className="rounded border border-border px-2.5 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                      >
                        취소
                      </button>
                    </td>
                  </tr>
                ))}
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
                      <td className="px-3 py-2 font-medium text-text">{o.symbol.replace('USDT', '')}</td>
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
                      <td className="px-3 py-2 text-right text-text">{o.size}</td>
                      <td className={`px-3 py-2 text-right font-medium ${o.pnl == null ? 'text-muted' : pos ? 'text-up' : 'text-down'}`}>
                        {o.pnl == null ? '—' : `${pos ? '+' : ''}${o.pnl.toFixed(2)}`}
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
