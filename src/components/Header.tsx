import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import logo from '@/resources/images/icon_256.png';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

export default function Header({ onOpenRank }: { onOpenRank: () => void }) {
  const symbol = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  const connected = useMarketStore((s) => s.connected);
  const balance = useTradingStore((s) => s.balance);
  const name = useTradingStore((s) => s.name);
  const logout = useTradingStore((s) => s.logout);

  return (
    <header className="flex flex-wrap items-center justify-between gap-y-1 border-b border-border bg-panel px-3 py-2 sm:px-4">
      <div className="flex items-center gap-2 sm:gap-4">
        <img src={logo} alt="ox64" className="h-11 w-11 shrink-0 sm:h-12 sm:w-12" />
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
        <span className="text-sm">{lastPrice != null ? lastPrice.toFixed(2) : '—'}</span>
        <span
          className={`h-2 w-2 rounded-full ${connected ? 'bg-up' : 'bg-muted'}`}
          title={connected ? '실시간 연결됨' : '연결 끊김'}
        />
      </div>

      <div className="flex items-center gap-3 text-sm">
        <button
          onClick={onOpenRank}
          className="rounded bg-bg px-2 py-1 text-xs ring-1 ring-border hover:text-white"
        >
          🏆 랭킹
        </button>
        <span>
          <span className="text-muted">잔고 </span>
          {balance.toFixed(2)} USDT
        </span>
        <span className="hidden text-muted sm:inline">·</span>
        <span className="hidden font-semibold sm:inline">{name}</span>
        <button onClick={() => logout()} className="text-xs text-muted hover:text-white">
          로그아웃
        </button>
      </div>
    </header>
  );
}
