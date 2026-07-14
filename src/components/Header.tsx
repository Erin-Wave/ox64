import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

export default function Header() {
  const symbol = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  const connected = useMarketStore((s) => s.connected);
  const balance = useTradingStore((s) => s.balance);

  return (
    <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-2">
      <div className="flex items-center gap-4">
        <span className="text-base font-bold tracking-tight">ox64</span>
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="rounded bg-bg px-2 py-1 text-sm outline-none ring-1 ring-border"
        >
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="font-mono text-sm">
          {lastPrice != null ? lastPrice.toFixed(2) : '—'}
        </span>
        <span
          className={`h-2 w-2 rounded-full ${connected ? 'bg-up' : 'bg-muted'}`}
          title={connected ? '실시간 연결됨' : '연결 끊김'}
        />
      </div>
      <div className="text-sm">
        <span className="text-muted">잔고 </span>
        <span className="font-mono">{balance.toFixed(2)} USDT</span>
      </div>
    </header>
  );
}
