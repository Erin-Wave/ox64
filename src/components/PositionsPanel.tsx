import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';

/** 보유 포지션 목록 + 실시간 미실현 손익 */
export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const closePosition = useTradingStore((s) => s.closePosition);
  const lastPrice = useMarketStore((s) => s.lastPrice);

  if (positions.length === 0) {
    return <div className="p-4 text-xs text-muted">보유 포지션 없음</div>;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">심볼</th>
            <th className="px-3 py-2 font-medium">방향</th>
            <th className="px-3 py-2 text-right font-medium">진입가</th>
            <th className="px-3 py-2 text-right font-medium">수량</th>
            <th className="px-3 py-2 text-right font-medium">미실현 PnL</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="font-mono">
          {positions.map((p) => {
            const dir = p.side === 'long' ? 1 : -1;
            const mark = lastPrice ?? p.entryPrice;
            const pnl = (mark - p.entryPrice) * p.size * dir;
            return (
              <tr key={p.id} className="border-t border-border">
                <td className="px-3 py-2">{p.symbol}</td>
                <td className={`px-3 py-2 ${p.side === 'long' ? 'text-up' : 'text-down'}`}>
                  {p.side === 'long' ? '롱' : '숏'} · {p.leverage}x
                </td>
                <td className="px-3 py-2 text-right">{p.entryPrice.toFixed(2)}</td>
                <td className="px-3 py-2 text-right">{p.size}</td>
                <td className={`px-3 py-2 text-right ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {pnl >= 0 ? '+' : ''}
                  {pnl.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => closePosition(p.id, mark)}
                    className="rounded bg-border px-2 py-1 text-muted hover:text-white"
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
  );
}
