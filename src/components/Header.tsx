import { useMarketStore, selectLastPrice, precisionOf } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice } from '@/format';
import SymbolSelect from '@/components/SymbolSelect';
import logo from '@/resources/images/icon_256.png';

export default function Header({ onOpenRank, onOpenSettings }: { onOpenRank: () => void; onOpenSettings: () => void }) {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore(selectLastPrice);
  const precisions = useMarketStore((s) => s.precisions);
  const connected = useMarketStore((s) => s.connected);
  const balance = useTradingStore((s) => s.balance);
  const name = useTradingStore((s) => s.name);
  const logout = useTradingStore((s) => s.logout);

  return (
    <header className="flex flex-wrap items-center justify-between gap-y-2 border-b border-border bg-panel px-3 py-2 sm:px-4">
      {/* 좌: 로고 · 심볼 · 현재가 */}
      <div className="flex items-center gap-3 sm:gap-4">
        <img src={logo} alt="ox64" className="h-9 w-9 shrink-0 sm:h-10 sm:w-10" />
        <div className="h-6 w-px bg-border" />
        <SymbolSelect />
        <div className="flex flex-col leading-none">
          <span className="text-[15px] font-bold text-text">
            {lastPrice != null ? fmtPrice(lastPrice, precisionOf(precisions, symbol)) : '—'}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-up' : 'bg-muted'}`} />
            {connected ? '실시간' : '연결 끊김'}
          </span>
        </div>
      </div>

      {/* 우: 잔고 · 랭킹 · 유저 */}
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="flex flex-col items-end leading-none">
          <span className="text-[10px] text-muted">잔고 (USDT)</span>
          <span className="mt-0.5 text-sm font-bold text-text">
            {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <button
          onClick={onOpenRank}
          className="rounded-md bg-panel2 px-3 py-1.5 text-xs font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
        >
          🏆 랭킹
        </button>
        <button
          onClick={onOpenSettings}
          aria-label="설정"
          className="rounded-md bg-panel2 px-2.5 py-1.5 text-xs font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
        >
          ⚙️
        </button>
        <div className="hidden items-center gap-2 sm:flex">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-elevated text-xs font-bold text-text">
            {name ? name.slice(0, 1).toUpperCase() : '?'}
          </span>
          <span className="max-w-[80px] truncate text-sm font-medium text-text">{name}</span>
        </div>
        <button
          onClick={() => logout()}
          className="rounded-md px-2 py-1.5 text-xs text-muted transition hover:text-text"
        >
          로그아웃
        </button>
      </div>
    </header>
  );
}
