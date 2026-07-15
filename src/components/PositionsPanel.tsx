import { useState } from 'react';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice } from '@/format';

/** 보유 포지션 목록 + 실시간 미실현 손익/ROE (OKX 스타일).
 * Standard 모드에서는 SL/TP 인라인 편집 + 미체결 지정가 주문 목록도 표시. */
export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);
  const closePosition = useTradingStore((s) => s.closePosition);
  const cancelLimit = useTradingStore((s) => s.cancelLimit);
  const setSlTp = useTradingStore((s) => s.setSlTp);
  const busy = useTradingStore((s) => s.busy);
  const prices = useMarketStore((s) => s.prices);
  const precisions = useMarketStore((s) => s.precisions);
  const standard = useSettingsStore((s) => s.tradingMode) === 'standard';

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');

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

  return (
    <div className="flex h-full flex-col">
      {/* 탭 헤더 */}
      <div className="flex items-center gap-4 border-b border-border px-3 py-2 text-sm">
        <span className="font-semibold text-text">
          포지션 <span className="text-muted">({positions.length})</span>
        </span>
        {standard && pendingOrders.length > 0 && (
          <span className="text-muted">
            미체결 <span className="text-text">({pendingOrders.length})</span>
          </span>
        )}
      </div>

      {positions.length === 0 ? (
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
                      <button
                        onClick={() => closePosition(p.id)}
                        disabled={busy}
                        className="rounded border border-border px-2.5 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                      >
                        청산
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 미체결 지정가 주문 (Standard 전용) */}
      {standard && pendingOrders.length > 0 && (
        <div className="border-t border-border">
          <div className="px-3 py-2 text-[11px] font-semibold text-muted">미체결 지정가 주문</div>
          <table className="w-full text-xs">
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id} className="border-b border-border/60">
                  <td className="px-3 py-2 font-medium text-text">{o.symbol.replace('USDT', '')}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        o.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                      }`}
                    >
                      {o.side === 'long' ? '롱' : '숏'} {o.leverage}x
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-text">
                    {fmtPrice(o.limitPrice, precisionOf(precisions, o.symbol))}
                  </td>
                  <td className="px-3 py-2 text-right text-text">{o.size}</td>
                  <td className="px-3 py-2 text-right">
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
      )}
    </div>
  );
}
