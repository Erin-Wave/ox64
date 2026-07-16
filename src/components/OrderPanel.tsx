import { useEffect, useState } from 'react';
import { useMarketStore, selectLastPrice } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';
import type { Side } from '@/types';

type Tab = 'market' | 'limit';
type Unit = 'coin' | 'usdt';

/** 주문 패널 (OKX 스타일). 체결가는 서버가 결정.
 * Easy 모드: 시장가만. Standard 모드: 시장가 + 지정가 + SL/TP. */
export default function OrderPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore(selectLastPrice);
  const chartClickPrice = useMarketStore((s) => s.chartClickPrice);
  const chartClickNonce = useMarketStore((s) => s.chartClickNonce);
  const tradingMode = useSettingsStore((s) => s.tradingMode);
  const openMarket = useTradingStore((s) => s.openMarket);
  const limitOpen = useTradingStore((s) => s.limitOpen);
  const balance = useTradingStore((s) => s.balance);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);
  const oxBalance = useTradingStore((s) => s.oxBalance);
  const spotBook = useTradingStore((s) => s.spotBook);
  const spotPlace = useTradingStore((s) => s.spotPlace);
  const virtual = isVirtualSymbol(symbol);

  const [tab, setTab] = useState<Tab>('market');
  const [size, setSize] = useState('0.01'); // 항상 코인 수량이 진실원본, unit 은 표시만 바꿈
  const [unit, setUnit] = useState<Unit>('coin');
  const [pct, setPct] = useState(0); // 수량 슬라이더(가용 잔고*레버리지 대비 비중, 0~100)
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

  // 차트 또는 호가창을 클릭하면 그 가격으로 지정가 탭 전환 + 값 채움 (Standard 모드에서만 의미 있음)
  useEffect(() => {
    if (chartClickNonce === 0 || chartClickPrice == null || !standard) return;
    setTab('limit');
    setLimitPrice(String(chartClickPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartClickNonce]);

  // ── 가상 코인(OX/USDT): 레버리지/SL·TP 없는 매수/매도 지정가 매칭 ──────
  if (virtual) {
    const submitSpot = (side: 'buy' | 'sell') => {
      const sz = Number(size);
      if (!sz || sz <= 0 || busy) return;
      let price: number;
      if (standard) {
        price = Number(limitPrice);
        if (!price || price <= 0) return;
      } else {
        // Easy 모드: 반대편 최우선호가 기준으로 소폭 불리하게 넣어 즉시 체결(마켓성 지정가)
        const ref = side === 'buy' ? spotBook.asks[0]?.price : spotBook.bids[0]?.price;
        if (!ref) return;
        price = side === 'buy' ? ref * 1.01 : ref * 0.99;
      }
      spotPlace(side, price, sz);
    };
    const applyPctSpot = (fraction: number) => {
      const sz = oxBalance * fraction;
      setSize(sz > 0 ? sz.toFixed(4) : '0');
    };

    return (
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="rounded-md bg-panel2 p-2.5 text-xs leading-relaxed text-muted">
          OX/USDT 는 외부 시세가 없는 가상 코인입니다. 레버리지 없이 유저 간 지정가 주문이 직접 매칭됩니다.
        </div>

        {standard && (
          <>
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
            <div>
              <label className="mb-1.5 block text-xs text-muted">수량 (OX)</label>
              <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                <input
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  inputMode="decimal"
                  className="w-full bg-transparent px-3 py-2 text-sm font-semibold text-text outline-none"
                />
              </div>
            </div>
          </>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] text-muted">비중(보유 OX 기준)</span>
            <span className="rounded bg-panel2 px-2 py-0.5 text-[11px] font-bold text-accent">{pct}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={pct}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPct(v);
              applyPctSpot(v / 100);
            }}
            className="w-full accent-up"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-muted">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>

        <div className="space-y-1 rounded-md bg-panel2 p-2.5 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">보유 USDT</span>
            <span className="text-text">{balance.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">보유 OX</span>
            <span className="text-text">{oxBalance.toFixed(4)}</span>
          </div>
        </div>

        {error && <p className="rounded-md bg-downDim px-2.5 py-1.5 text-xs text-down">{error}</p>}

        <div className="mt-auto grid grid-cols-2 gap-2">
          <button
            onClick={() => submitSpot('buy')}
            disabled={busy}
            className="rounded-md bg-up py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            매수 · Buy
          </button>
          <button
            onClick={() => submitSpot('sell')}
            disabled={busy}
            className="rounded-md bg-down py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            매도 · Sell
          </button>
        </div>
      </div>
    );
  }

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

  // 가용 잔고 기준 수량 설정(fraction = 증거금으로 쓸 잔고 비율, 0~1).
  // SAFETY: 슬라이더 100% 그대로 계산하면 toFixed 반올림/서버 fetch 시점 가격차로
  // 증거금이 잔고를 살짝 넘어 주문이 거부되는 경우가 있어 0.1% 여유를 둔다.
  const SAFETY = 0.999;
  const applyPct = (fraction: number) => {
    if (!refPrice) return;
    const sz = (balance * leverage * fraction * SAFETY) / refPrice;
    setSize(sz > 0 ? sz.toFixed(6) : '0');
  };

  // 수량 입력값 표시 단위 변환(코인 ↔ USDT). size(코인) 는 그대로 두고 표시만 바꾼다.
  const displaySize = unit === 'coin' ? size : refPrice ? (Number(size || 0) * refPrice).toFixed(2) : '';
  const onSizeInput = (v: string) => {
    if (unit === 'coin') {
      setSize(v);
    } else if (refPrice) {
      const usdt = Number(v);
      setSize(usdt > 0 ? (usdt / refPrice).toFixed(6) : '0');
    }
  };
  const toggleUnit = () => setUnit((u) => (u === 'coin' ? 'usdt' : 'coin'));

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
        {standard && (
          <>
            <label className="mb-1.5 block text-xs text-muted">수량</label>
            <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
              <input
                value={displaySize}
                onChange={(e) => onSizeInput(e.target.value)}
                inputMode="decimal"
                className="w-full bg-transparent px-3 py-2 text-sm font-semibold text-text outline-none"
              />
              <button
                onClick={toggleUnit}
                disabled={!refPrice}
                title="단위 전환"
                className="mr-1 rounded px-2 py-1 text-xs font-semibold text-muted transition hover:bg-elevated hover:text-text disabled:opacity-40"
              >
                {unit === 'coin' ? coin : 'USDT'} ⇄
              </button>
            </div>
          </>
        )}
        <div className={standard ? 'mt-2' : ''}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] text-muted">비중(가용 잔고 기준)</span>
            <span className="rounded bg-panel2 px-2 py-0.5 text-[11px] font-bold text-accent">{pct}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={pct}
            disabled={!refPrice}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPct(v);
              applyPct(v / 100);
            }}
            className="w-full accent-up disabled:opacity-40"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-muted">
            <span>0%</span>
            <span>100%</span>
          </div>
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
    </div>
  );
}
