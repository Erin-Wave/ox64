import { useState } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import type { Side } from '@/types';

/** 시장가 롱/숏 진입 패널. 체결가는 서버가 결정하므로 심볼/방향/수량/레버리지만 전송. */
export default function OrderPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  const openMarket = useTradingStore((s) => s.openMarket);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);

  const [size, setSize] = useState('0.01');
  const [leverage, setLeverage] = useState(10);

  const submit = (side: Side) => {
    const sz = Number(size);
    if (!sz || sz <= 0 || busy) return;
    openMarket({ symbol, side, size: sz, leverage });
  };

  const notional = lastPrice ? lastPrice * Number(size || 0) : 0;
  const margin = notional / leverage;

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold text-muted">시장가 주문</h2>

      <label className="text-xs text-muted">수량 ({symbol.replace('USDT', '')})</label>
      <input
        value={size}
        onChange={(e) => setSize(e.target.value)}
        inputMode="decimal"
        className="rounded bg-bg px-2 py-1.5 text-sm outline-none ring-1 ring-border focus:ring-muted"
      />

      <label className="text-xs text-muted">레버리지 · {leverage}x</label>
      <input
        type="range"
        min={1}
        max={125}
        value={leverage}
        onChange={(e) => setLeverage(Number(e.target.value))}
        className="accent-muted"
      />

      {lastPrice != null && (
        <p className="text-xs text-muted">
          명목가 ≈ {notional.toFixed(2)} · 증거금 ≈ {margin.toFixed(2)} USDT
        </p>
      )}

      {error && <p className="text-xs text-down">{error}</p>}

      <div className="mt-1 grid grid-cols-2 gap-2">
        <button
          onClick={() => submit('long')}
          disabled={busy}
          className="rounded bg-up py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          롱 (Buy)
        </button>
        <button
          onClick={() => submit('short')}
          disabled={busy}
          className="rounded bg-down py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          숏 (Sell)
        </button>
      </div>
      <p className="text-[10px] leading-tight text-muted">
        체결가·손익은 서버가 실시간 시세로 계산합니다.
      </p>
    </div>
  );
}
