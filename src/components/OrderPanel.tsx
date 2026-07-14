import { useState } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import type { Side } from '@/types';

/** 시장가 롱/숏 진입 패널 */
export default function OrderPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  const openMarket = useTradingStore((s) => s.openMarket);

  const [size, setSize] = useState('0.01');
  const [leverage, setLeverage] = useState(10);

  const submit = (side: Side) => {
    if (!lastPrice) return;
    const sz = Number(size);
    if (!sz || sz <= 0) return;
    openMarket({ symbol, side, price: lastPrice, size: sz, leverage });
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold text-muted">시장가 주문</h2>

      <label className="text-xs text-muted">수량 ({symbol.replace('USDT', '')})</label>
      <input
        value={size}
        onChange={(e) => setSize(e.target.value)}
        inputMode="decimal"
        className="rounded bg-bg px-2 py-1.5 font-mono text-sm outline-none ring-1 ring-border focus:ring-muted"
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

      <div className="mt-1 grid grid-cols-2 gap-2">
        <button
          onClick={() => submit('long')}
          disabled={!lastPrice}
          className="rounded bg-up py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          롱 (Buy)
        </button>
        <button
          onClick={() => submit('short')}
          disabled={!lastPrice}
          className="rounded bg-down py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          숏 (Sell)
        </button>
      </div>
    </div>
  );
}
