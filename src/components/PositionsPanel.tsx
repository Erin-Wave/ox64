import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice } from '@/format';

/** 보유 포지션 목록 + 실시간 미실현 손익/ROE (OKX 스타일). */
export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const closePosition = useTradingStore((s) => s.closePosition);
  const busy = useTradingStore((s) => s.busy);
  const prices = useMarketStore((s) => s.prices);
  const precisions = useMarketStore((s) => s.precisions);

  return (
    <div className="flex h-full flex-col">
      {/* 탭 헤더 */}
      <div className="flex items-center gap-4 border-b border-border px-3 py-2 text-sm">
        <span className="font-semibold text-text">
          포지션 <span className="text-muted">({positions.length})</span>
        </span>
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
                    <td className="px-3 py-2.5 text-right text-text">
                      {fmtPrice(p.entryPrice, precisionOf(precisions, p.symbol))}
                    </td>
                    <td className="px-3 py-2.5 text-right text-text">{p.size}</td>
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
    </div>
  );
}
