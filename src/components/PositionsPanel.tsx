import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';

/** 보유 포지션 목록 + 실시간 미실현 손익(현재 보는 심볼 기준 추정). */
export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const closePosition = useTradingStore((s) => s.closePosition);
  const busy = useTradingStore((s) => s.busy);
  const curSymbol = useMarketStore((s) => s.symbol);
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
        <tbody>
          {positions.map((p) => {
            const dir = p.side === 'long' ? 1 : -1;
            // 현재 보는 심볼의 실시간가로만 추정(다른 심볼은 서버 청산 시 확정).
            const live = p.symbol === curSymbol ? lastPrice : null;
            const pnl = live != null ? (live - p.entryPrice) * p.size * dir : null;
            return (
              <tr key={p.id} className="border-t border-border">
                <td className="px-3 py-2">{p.symbol}</td>
                <td className={`px-3 py-2 ${p.side === 'long' ? 'text-up' : 'text-down'}`}>
                  {p.side === 'long' ? '롱' : '숏'} · {p.leverage}x
                </td>
                <td className="px-3 py-2 text-right">{p.entryPrice.toFixed(2)}</td>
                <td className="px-3 py-2 text-right">{p.size}</td>
                <td
                  className={`px-3 py-2 text-right ${
                    pnl == null ? 'text-muted' : pnl >= 0 ? 'text-up' : 'text-down'
                  }`}
                >
                  {pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => closePosition(p.id)}
                    disabled={busy}
                    className="rounded bg-border px-2 py-1 text-muted hover:text-white disabled:opacity-40"
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
