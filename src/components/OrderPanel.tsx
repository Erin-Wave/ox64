import { useEffect, useState } from 'react';
import { useMarketStore, selectLastPrice } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtUsd, fmtNumInput, unfmtNum } from '@/format';
import type { Side } from '@/types';

type Tab = 'market' | 'limit' | 'conditional';
type Unit = 'coin' | 'usdt';
type TriggerDir = 'above' | 'below';

/** 주문 패널 (OKX 스타일). 체결가는 서버가 결정.
 * Easy 모드: 시장가만. Standard 모드: 시장가 + 지정가 + SL/TP. */
export default function OrderPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore(selectLastPrice);
  const chartClickPrice = useMarketStore((s) => s.chartClickPrice);
  const chartClickNonce = useMarketStore((s) => s.chartClickNonce);
  const priceTarget = useMarketStore((s) => s.priceTarget);
  const setPriceTarget = useMarketStore((s) => s.setPriceTarget);
  const tradingMode = useSettingsStore((s) => s.tradingMode);
  const openMarket = useTradingStore((s) => s.openMarket);
  const limitOpen = useTradingStore((s) => s.limitOpen);
  const conditionalOpen = useTradingStore((s) => s.conditionalOpen);
  const balance = useTradingStore((s) => s.balance);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);
  const positions = useTradingStore((s) => s.positions);
  const markPrices = useTradingStore((s) => s.markPrices);
  const feeRate = useTradingStore((s) => s.feeRate);
  const vipTier = useTradingStore((s) => s.vipTier);

  const [tab, setTab] = useState<Tab>('market');
  // ⚠ 입력칸의 raw 문자열(현재 unit 기준)이 진실원본 — 코인 수량은 sizeCoin 으로 파생한다. 예전엔 코인 수량을
  // 상태로 두고 USDT 표시를 (코인×가격)으로 매번 재계산했는데, 그 왕복(coin→toFixed(6)→usdt)에서 정밀도가
  // 깨져 USDT 로 입력하면 타이핑이 엉뚱한 값으로 튀었다(예: BTC 에 "1 USDT" → 0.98 로 표시). 이제 입력칸엔
  // 사용자가 친 값을 그대로 두고 sizeCoin 만 파생하므로 USDT 입력이 정상 동작한다.
  const [amtInput, setAmtInput] = useState('0.01');
  const [unit, setUnit] = useState<Unit>('coin');
  const [pct, setPct] = useState(0); // 수량 슬라이더(가용 잔고*레버리지 대비 비중, 0~100)
  const [leverage, setLeverage] = useState(10);
  const [limitPrice, setLimitPrice] = useState('');
  const [triggerPrice, setTriggerPrice] = useState(''); // 조건부 주문 트리거 가격
  const [triggerDir, setTriggerDir] = useState<TriggerDir>('above'); // 이 가격 이상/이하가 되면 시장가 진입
  const [useSlTp, setUseSlTp] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');

  const standard = tradingMode === 'standard';
  const effectiveTab: Tab = standard ? tab : 'market';
  // 이 심볼에 이미 보유 중인 포지션이 있으면 그 레버리지로 고정한다(서버도 물타기 시 기존
  // 레버리지를 그대로 쓰므로, 슬라이더가 다른 값을 보여주면 실제 체결과 화면이 어긋나 보임).
  const existingPosition = positions.find((p) => p.symbol === symbol);

  useEffect(() => {
    if (existingPosition) setLeverage(existingPosition.leverage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingPosition?.leverage]);

  // 지정가/조건부 탭을 처음 열 때 현재가로 기본값 채움
  useEffect(() => {
    if (effectiveTab === 'limit' && !limitPrice && lastPrice) setLimitPrice(String(lastPrice));
    if (effectiveTab === 'conditional' && !triggerPrice && lastPrice) setTriggerPrice(String(lastPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTab, lastPrice]);

  // 차트/호가창 클릭 → 그 가격을 지정가 입력에 채운다. ⚠ 예전엔 클릭만 해도 지정가 탭으로 강제
  // 전환해서, 시장가로 주문하려다 무심코 차트를 클릭하면 시장가 주문이 지정가로 걸리던 버그가 있었다.
  // 이제 이미 지정가 탭일 때만 값을 채운다(시장가 탭에서의 클릭은 조회일 뿐 주문 유형을 바꾸지 않음).
  // priceTarget 이 '' 이 아니면 다른 입력칸(포지션의 청산 지정가)이 클릭을 가져간 상태다 — 여기선 무시.
  useEffect(() => {
    if (chartClickNonce === 0 || chartClickPrice == null || !standard) return;
    if (priceTarget !== '') return;
    if (tab === 'limit') setLimitPrice(String(chartClickPrice));
    else if (tab === 'conditional') setTriggerPrice(String(chartClickPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartClickNonce]);

  const coin = symbol.replace('USDT', '');
  const refPrice =
    effectiveTab === 'limit'
      ? Number(limitPrice) || lastPrice
      : effectiveTab === 'conditional'
        ? Number(triggerPrice) || lastPrice
        : lastPrice;

  // 주문에 쓰는 코인 수량(진실원본은 입력칸 문자열 amtInput). USDT 단위면 현재 기준가로 나눠 코인으로 환산.
  const amtNum = Number(amtInput || 0);
  const sizeCoin = unit === 'coin' ? amtNum : refPrice ? amtNum / refPrice : 0;

  const parseSlTp = () => ({
    stopLoss: useSlTp && stopLoss ? Number(stopLoss) : null,
    takeProfit: useSlTp && takeProfit ? Number(takeProfit) : null,
  });

  const submit = (side: Side) => {
    const sz = sizeCoin;
    if (!sz || sz <= 0 || busy) return;
    if (effectiveTab === 'conditional') {
      const tpx = Number(triggerPrice);
      if (!tpx || tpx <= 0) return;
      conditionalOpen({ symbol, side, size: sz, leverage, triggerPrice: tpx, triggerDir });
      return;
    }
    const { stopLoss: sl, takeProfit: tp } = parseSlTp();
    if (effectiveTab === 'limit') {
      const lp = Number(limitPrice);
      if (!lp || lp <= 0) return;
      limitOpen({ symbol, side, size: sz, leverage, limitPrice: lp, stopLoss: sl, takeProfit: tp });
    } else {
      openMarket({ symbol, side, size: sz, leverage, stopLoss: sl, takeProfit: tp });
    }
  };

  const notional = refPrice ? refPrice * sizeCoin : 0;
  const margin = notional / leverage;
  // 진입 수수료 = 명목가 × VIP 수수료율(서버가 체결 시 실제로 떼는 값과 같은 식). 청산할 때 한 번 더 든다.
  const fee = notional * feeRate;

  // 크로스 마진 가용 증거금 = 여유잔고 + 전 포지션 미실현손익(서버 markPrices 기준 — 서버 가용 판정과
  // 동일 시세). 이익 중이면 그 미실현이익까지 새 주문에 쓸 수 있고, 손실 중이면 가용이 줄어든다.
  const available = Math.max(
    0,
    balance +
      positions.reduce((a, p) => {
        const mark = markPrices[p.symbol];
        if (mark == null) return a;
        return a + (mark - p.entryPrice) * p.size * (p.side === 'long' ? 1 : -1);
      }, 0),
  );

  // 가용 증거금 기준 수량 설정(fraction = 증거금으로 쓸 가용 비율, 0~1).
  // SAFETY: 슬라이더 100% 그대로 계산하면 toFixed 반올림/서버 fetch 시점 가격차로
  // 증거금이 가용을 살짝 넘어 주문이 거부되는 경우가 있어 0.1% 여유를 둔다.
  // ⚠ 서버 가드는 `증거금 + 수수료 <= 가용` 이므로 수수료도 넣고 역산해야 한다. 명목가 1 당 드는 돈은
  // (1/leverage + feeRate) 이므로 명목가 = 가용 / (1/leverage + feeRate). 수수료를 빼먹으면 고배율에서
  // 슬라이더 100% 가 그대로 거부된다(200배면 수수료가 증거금의 ~6% 라 0.1% 여유로는 못 덮는다).
  const SAFETY = 0.999;
  // Number() 로 뒷자리 0 을 떨군다(55000000.000000 → 55000000). 코인은 최대 6자리, USDT 는 2자리로 표기.
  const trimNum = (n: number, d: number) => (n > 0 ? String(Number(n.toFixed(d))) : '0');
  const applyPct = (fraction: number) => {
    if (!refPrice) return;
    const costPerNotional = 1 / leverage + feeRate;
    const szCoin = (available * fraction * SAFETY) / costPerNotional / refPrice; // 코인 수량
    // 슬라이더는 현재 unit 에 맞는 값으로 입력칸에 채운다(USDT 모드면 명목가로).
    setAmtInput(unit === 'coin' ? trimNum(szCoin, 6) : trimNum(szCoin * refPrice, 2));
  };

  // 입력칸 표시값(콤마 포함) — amtInput 을 그대로 보여준다(왕복 재계산 안 함 → USDT 입력이 안 깨진다).
  const displaySize = fmtNumInput(amtInput);
  const onSizeInput = (v: string) => setAmtInput(unfmtNum(v));
  // 단위 전환 시 입력칸 값을 새 단위로 1회 환산한다(현재 수량 유지). 가격이 없으면 값만 유지.
  const toggleUnit = () => {
    const next: Unit = unit === 'coin' ? 'usdt' : 'coin';
    if (refPrice && amtNum > 0) {
      const converted = unit === 'coin' ? amtNum * refPrice : amtNum / refPrice;
      setAmtInput(next === 'usdt' ? trimNum(converted, 2) : trimNum(converted, 6));
    }
    setUnit(next);
  };

  return (
    <div className="flex h-full flex-col gap-2 p-2.5">
      {/* 주문 타입 탭 */}
      {standard ? (
        <div className="flex gap-1 rounded-md bg-panel2 p-1 text-xs">
          <button
            onClick={() => setTab('market')}
            className={`flex-1 rounded py-1 text-center font-semibold transition ${
              effectiveTab === 'market' ? 'bg-elevated text-text' : 'text-muted hover:text-text'
            }`}
          >
            시장가
          </button>
          <button
            onClick={() => setTab('limit')}
            className={`flex-1 rounded py-1 text-center font-semibold transition ${
              effectiveTab === 'limit' ? 'bg-elevated text-text' : 'text-muted hover:text-text'
            }`}
          >
            지정가
          </button>
          <button
            onClick={() => setTab('conditional')}
            className={`flex-1 rounded py-1 text-center font-semibold transition ${
              effectiveTab === 'conditional' ? 'bg-elevated text-text' : 'text-muted hover:text-text'
            }`}
          >
            조건부
          </button>
        </div>
      ) : (
        <div className="flex gap-1 rounded-md bg-panel2 p-1 text-xs">
          <span className="flex-1 rounded bg-elevated py-1 text-center font-semibold text-text">시장가</span>
        </div>
      )}

      {/* 지정가 */}
      {effectiveTab === 'limit' && (
        <div>
          <label className="mb-1 block text-xs text-muted">지정가</label>
          <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
            <input
              value={fmtNumInput(limitPrice)}
              onChange={(e) => setLimitPrice(unfmtNum(e.target.value))}
              onFocus={() => setPriceTarget('')} // 차트 클릭 가격을 이 칸으로 되돌린다
              inputMode="decimal"
              className="w-full bg-transparent px-3 py-1.5 text-sm font-semibold text-text outline-none"
            />
            <span className="px-3 text-xs text-muted">USDT</span>
          </div>
        </div>
      )}

      {/* 조건부(스탑) — 트리거 방향(이상/이하) + 트리거 가격. 넘어서면 시장가로 진입한다. */}
      {effectiveTab === 'conditional' && (
        <div>
          <label className="mb-1 block text-xs text-muted">트리거 조건</label>
          <div className="mb-1.5 flex gap-1 rounded-md bg-panel2 p-1 text-xs">
            <button
              onClick={() => setTriggerDir('above')}
              className={`flex-1 rounded py-1 text-center font-semibold transition ${
                triggerDir === 'above' ? 'bg-elevated text-up' : 'text-muted hover:text-text'
              }`}
            >
              가격 이상 ≥
            </button>
            <button
              onClick={() => setTriggerDir('below')}
              className={`flex-1 rounded py-1 text-center font-semibold transition ${
                triggerDir === 'below' ? 'bg-elevated text-down' : 'text-muted hover:text-text'
              }`}
            >
              가격 이하 ≤
            </button>
          </div>
          <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
            <input
              value={fmtNumInput(triggerPrice)}
              onChange={(e) => setTriggerPrice(unfmtNum(e.target.value))}
              onFocus={() => setPriceTarget('')} // 차트 클릭 가격을 이 칸으로 되돌린다
              inputMode="decimal"
              placeholder="트리거 가격"
              className="w-full bg-transparent px-3 py-1.5 text-sm font-semibold text-text outline-none placeholder:text-muted"
            />
            <span className="px-3 text-xs text-muted">USDT</span>
          </div>
          <p className="mt-1 text-[10px] leading-tight text-muted">
            현재가가 트리거 가격 {triggerDir === 'above' ? '이상' : '이하'}이 되면 <span className="text-text">시장가</span>로 진입합니다.
            물량이 부족해 일부만 체결되면 나머지는 조건이 계속 살아있습니다.
          </p>
        </div>
      )}

      {/* 레버리지 — 보유 포지션이 있으면 그 레버리지로 고정(청산 전까지 변경 불가) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted">
            레버리지 <span className="text-[10px] text-muted">· 크로스</span>
            {existingPosition && <span className="ml-1 text-[10px] text-accent">(포지션 보유 중 고정)</span>}
          </span>
          <span className="rounded bg-panel2 px-2 py-0.5 text-xs font-bold text-accent">크로스 {leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={200}
          value={leverage}
          disabled={!!existingPosition}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="w-full accent-up disabled:opacity-40"
        />
      </div>

      {/* 수량 */}
      <div>
        {standard && (
          <>
            <label className="mb-1 block text-xs text-muted">수량</label>
            <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
              <input
                value={displaySize}
                onChange={(e) => onSizeInput(e.target.value)}
                inputMode="decimal"
                className="w-full bg-transparent px-3 py-1.5 text-sm font-semibold text-text outline-none"
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
        <div className={standard ? 'mt-1.5' : ''}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] text-muted">비중(가용 기준)</span>
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
        </div>
      </div>

      {/* SL / TP (Standard 전용, 조건부 주문 제외 — 조건부는 진입만 예약) */}
      {standard && effectiveTab !== 'conditional' && (
        <div>
          <label className="mb-1 flex cursor-pointer items-center gap-2 text-xs text-muted">
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
                  value={fmtNumInput(stopLoss)}
                  onChange={(e) => setStopLoss(unfmtNum(e.target.value))}
                  inputMode="decimal"
                  placeholder="손절가"
                  className="w-full bg-transparent px-2.5 py-1.5 text-xs font-semibold text-text outline-none placeholder:text-muted"
                />
              </div>
              <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                <input
                  value={fmtNumInput(takeProfit)}
                  onChange={(e) => setTakeProfit(unfmtNum(e.target.value))}
                  inputMode="decimal"
                  placeholder="익절가"
                  className="w-full bg-transparent px-2.5 py-1.5 text-xs font-semibold text-text outline-none placeholder:text-muted"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 정보 */}
      <div className="space-y-0.5 rounded-md bg-panel2 p-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted">가용 (크로스)</span>
          <span className="text-text">{fmtUsd(available)} USDT</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">명목가</span>
          <span className="text-text">{notional ? fmtUsd(notional) : '—'} USDT</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">증거금</span>
          <span className={margin + fee > available ? 'text-down' : 'text-text'}>
            {margin ? fmtUsd(margin) : '—'} USDT
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">
            수수료 <span className="text-[10px] text-muted">VIP{vipTier} · {(feeRate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%</span>
          </span>
          <span className="text-text">{fee ? fmtUsd(fee) : '—'} USDT</span>
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
          className="rounded-md bg-up py-2 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          롱 · Buy
        </button>
        <button
          onClick={() => submit('short')}
          disabled={busy}
          className="rounded-md bg-down py-2 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          숏 · Sell
        </button>
      </div>
    </div>
  );
}
