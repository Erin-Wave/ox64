import { useEffect, useState } from 'react';
import { useMarketStore, selectLastPrice } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import type { Side } from '@/types';

type Tab = 'market' | 'limit';

/** 주문 패널 (OKX 스타일). 체결가는 서버가 결정.
 * Easy 모드: 시장가만. Standard 모드: 시장가 + 지정가 + SL/TP. */
export default function OrderPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore(selectLastPrice);
  const tradingMode = useSettingsStore((s) => s.tradingMode);
  const openMarket = useTradingStore((s) => s.openMarket);
  const limitOpen = useTradingStore((s) => s.limitOpen);
  const balance = useTradingStore((s) => s.balance);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);

  const [tab, setTab] = useState<Tab>('market');
  const [size, setSize] = useState('0.01');
  const [leverage, setLeverage] = useState(10);
  const [limitPrice, setLimitPrice] = useState('');
  const [useSlTp, setUseSlTp] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');

  const standard = tradingMode === 'standard';
  const effectiveTab: Tab = standard ? tab : 'market';

  // 지정가 탭을 처음 열 때 현재가로 기본값 채움
  useEffect(() => {
    if (effectiveTab === 'limit' && !limitPrice && lastPrice) setLimitPrice(String(lastPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTab, lastPrice]);

  const coin = symbol.replace('USDT', '');
  const refPrice = effectiveTab === 'limit' ? Number(limitPrice) || lastPrice : lastPrice;

  const parseSlTp = () => ({
    stopLoss: useSlTp && stopLoss ? Number(stopLoss) : null,
    takeProfit: useSlTp && takeProfit ? Number(takeProfit) : null,
  });

  const submit = (side: Side) => {
    const sz = Number(size);
    if (!sz || sz <= 0 || busy) return;
    const { stopLoss: sl, takeProfit: tp } = parseSlTp();
    if (effectiveTab === 'limit') {
      const lp = Number(limitPrice);
      if (!lp || lp <= 0) return;
      limitOpen({ symbol, side, size: sz, leverage, limitPrice: lp, stopLoss: sl, takeProfit: tp });
    } else {
      openMarket({ symbol, side, size: sz, leverage, stopLoss: sl, takeProfit: tp });
    }
  };

  const notional = refPrice ? refPrice * Number(size || 0) : 0;
  const margin = notional / leverage;

  // 가용 잔고 기준 빠른 수량 설정(pct = 증거금으로 쓸 잔고 비율)
  const setPct = (pct: number) => {
    if (!refPrice) return;
    const sz = (balance * leverage * pct) / refPrice;
    setSize(sz > 0 ? sz.toFixed(4) : '0');
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {/* 주문 타입 탭 */}
      {standard ? (
        <div className="flex gap-1 rounded-md bg-panel2 p-1 text-xs">
          <button
            onClick={() => setTab('market')}
            className={`flex-1 rounded py-1.5 text-center font-semibold transition ${
              effectiveTab === 'market' ? 'bg-elevated text-text' : 'text-muted hover:text-text'
            }`}
          >
            시장가
          </button>
          <button
            onClick={() => setTab('limit')}
            className={`flex-1 rounded py-1.5 text-center font-semibold transition ${
              effectiveTab === 'limit' ? 'bg-elevated text-text' : 'text-muted hover:text-text'
            }`}
          >
            지정가
          </button>
        </div>
      ) : (
        <div className="flex gap-1 rounded-md bg-panel2 p-1 text-xs">
          <span className="flex-1 rounded bg-elevated py-1.5 text-center font-semibold text-text">시장가</span>
        </div>
      )}

      {/* 지정가 */}
      {effectiveTab === 'limit' && (
        <div>
          <label className="mb-1.5 block text-xs text-muted">지정가</label>
          <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
            <input
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              inputMode="decimal"
              className="w-full bg-transparent px-3 py-2 text-sm font-semibold text-text outline-none"
            />
            <span className="px-3 text-xs text-muted">USDT</span>
          </div>
        </div>
      )}

      {/* 레버리지 */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs text-muted">레버리지</span>
          <span className="rounded bg-panel2 px-2 py-0.5 text-xs font-bold text-accent">{leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={125}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="w-full accent-up"
        />
        <div className="mt-0.5 flex justify-between text-[10px] text-muted">
          <span>1x</span>
          <span>125x</span>
        </div>
      </div>

      {/* 수량 */}
      <div>
        <label className="mb-1.5 block text-xs text-muted">수량</label>
        <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
          <input
            value={size}
            onChange={(e) => setSize(e.target.value)}
            inputMode="decimal"
            className="w-full bg-transparent px-3 py-2 text-sm font-semibold text-text outline-none"
          />
          <span className="px-3 text-xs text-muted">{coin}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1">
          {[0.25, 0.5, 0.75, 1].map((p) => (
            <button
              key={p}
              onClick={() => setPct(p)}
              disabled={!refPrice}
              className="rounded bg-panel2 py-1 text-[11px] text-muted transition hover:bg-elevated hover:text-text disabled:opacity-40"
            >
              {p === 1 ? 'Max' : `${p * 100}%`}
            </button>
          ))}
        </div>
      </div>

      {/* SL / TP (Standard 전용) */}
      {standard && (
        <div>
          <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={useSlTp}
              onChange={(e) => setUseSlTp(e.target.checked)}
              className="accent-up"
            />
            손절(SL) / 익절(TP) 설정
          </label>
          {useSlTp && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                <input
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  inputMode="decimal"
                  placeholder="손절가"
                  className="w-full bg-transparent px-2.5 py-2 text-xs font-semibold text-text outline-none placeholder:text-muted"
                />
              </div>
              <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                <input
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  inputMode="decimal"
                  placeholder="익절가"
                  className="w-full bg-transparent px-2.5 py-2 text-xs font-semibold text-text outline-none placeholder:text-muted"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 정보 */}
      <div className="space-y-1 rounded-md bg-panel2 p-2.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted">가용</span>
          <span className="text-text">{balance.toFixed(2)} USDT</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">명목가</span>
          <span className="text-text">{notional ? notional.toFixed(2) : '—'} USDT</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">증거금</span>
          <span className={margin > balance ? 'text-down' : 'text-text'}>
            {margin ? margin.toFixed(2) : '—'} USDT
          </span>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-downDim px-2.5 py-1.5 text-xs text-down">{error}</p>
      )}

      {/* 롱/숏 */}
      <div className="mt-auto grid grid-cols-2 gap-2">
        <button
          onClick={() => submit('long')}
          disabled={busy}
          className="rounded-md bg-up py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          롱 · Buy
        </button>
        <button
          onClick={() => submit('short')}
          disabled={busy}
          className="rounded-md bg-down py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          숏 · Sell
        </button>
      </div>
      <p className="text-center text-[10px] leading-tight text-muted">
        체결가·손익은 서버가 실시간 시세로 계산합니다.
      </p>
    </div>
  );
}
