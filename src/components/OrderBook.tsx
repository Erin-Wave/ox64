import { useEffect, useMemo, useState } from 'react';
import { orderbookStream, type OrderBookLevel, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';
import { fmtPrice, precisionFromTick } from '@/format';
import type { TickerTrade } from '@/types';

const EMPTY_TRADES: TickerTrade[] = [];
const fmtQty = (q: number) => (q >= 1000 ? q.toFixed(1) : q.toFixed(4));
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const GROUP_MULTS = [1, 10, 100, 1000]; // 심볼 tick 단위의 10배씩 — 그룹 버튼을 눌러서 순환

// 같은 가격대(step 배수)로 수량을 합쳐서 보여준다. bid 는 아래로(floor), ask 는 위로(ceil) 반올림 —
// 스프레드에서 먼 방향으로 묶어야 "이 가격대에 이만큼 쌓여있다"는 의미가 유지된다.
function aggregate(levels: OrderBookLevel[], step: number, side: 'bid' | 'ask'): OrderBookLevel[] {
  if (!(step > 0)) return levels;
  const map = new Map<number, number>();
  for (const l of levels) {
    const raw = side === 'bid' ? Math.floor(l.price / step) * step : Math.ceil(l.price / step) * step;
    const bucket = Number(raw.toFixed(8)); // 부동소수점 오차로 버킷이 갈라지는 것 방지
    map.set(bucket, (map.get(bucket) ?? 0) + l.qty);
  }
  const out = [...map.entries()].map(([price, qty]) => ({ price, qty }));
  out.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
  return out;
}

/** 호가창 + 체결내역 탭. 모바일에서도 한눈에 보이도록 매수(좌)·매도(우) 2열로 나란히 표시하고,
 * 각 열은 최우선호가가 맨 위로 오게 정렬한다. 클릭하면 그 가격이 지정가 주문 입력에 채워진다.
 * 체결 탭 데이터는 useTradeTape(App.tsx 에서 항상 구동)이 채우는 useMarketStore.recentTrades 를 그대로 구독. */
export default function OrderBook() {
  const symbol = useMarketStore((s) => s.symbol);
  const precisions = useMarketStore((s) => s.precisions);
  const trades = useMarketStore((s) => s.recentTrades[s.symbol] ?? EMPTY_TRADES);
  const virtual = isVirtualSymbol(symbol);
  const spotBook = useTradingStore((s) => s.spotBook);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [groupIdx, setGroupIdx] = useState(0);
  const [tab, setTab] = useState<'book' | 'trades'>('book');

  useEffect(() => {
    if (virtual) return; // 가상 심볼은 useSpotPoll 이 채우는 store.spotBook 을 대신 사용
    setBook(null);
    setGroupIdx(0); // 심볼마다 tick 단위가 달라서 배수 선택을 리셋
    const sub = orderbookStream(symbol, 20).subscribe({ next: setBook });
    return () => sub.unsubscribe();
  }, [symbol, virtual]);

  // 가상 심볼은 spot_orders 호가(price/size)를 OrderBookLevel(price/qty) 형태로 매핑해 재사용
  const activeBook: OrderBookSnapshot | null = virtual
    ? { bids: spotBook.bids.map((b) => ({ price: b.price, qty: b.size })), asks: spotBook.asks.map((a) => ({ price: a.price, qty: a.size })) }
    : book;

  const prec = precisionOf(precisions, symbol);
  const tick = Math.pow(10, -prec);
  const groupStep = tick * GROUP_MULTS[groupIdx];
  const cycleGroup = () => setGroupIdx((i) => (i + 1) % GROUP_MULTS.length);
  const pick = (price: number) => useMarketStore.getState().setChartClickPrice(price);

  // 정렬: bids=가격 높은 순(최우선매수=맨 위), asks=가격 낮은 순(최우선매도=맨 위) — 그대로 위→아래 렌더.
  // ⚠ 예전엔 상위 8개만 잘라서 보여줬는데, 스프레드에서 먼 곳에 큰 물량을 걸어두면(예: 벽처럼 큰
  // 지정가) 정작 그 주문이 8번째 밖으로 밀려 화면에서 통째로 안 보이는 버그가 있었다. 서버가 애초에
  // 가격대별 최대 15단계까지만 주므로(loadSpotMarket), 프론트도 그만큼 그대로 다 보여준다(스크롤 처리).
  const BOOK_DEPTH = 15;
  const asks = useMemo(() => (activeBook ? aggregate(activeBook.asks, groupStep, 'ask').slice(0, BOOK_DEPTH) : []), [activeBook, groupStep]);
  const bids = useMemo(() => (activeBook ? aggregate(activeBook.bids, groupStep, 'bid').slice(0, BOOK_DEPTH) : []), [activeBook, groupStep]);

  const maxQty = Math.max(1e-9, ...bids.map((b) => b.qty), ...asks.map((a) => a.qty));
  const groupPrec = precisionFromTick(groupStep);

  const tabBtn = (t: typeof tab, label: string) => (
    <button
      onClick={() => setTab(t)}
      className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
        tab === t ? 'bg-elevated text-text' : 'text-muted hover:text-text'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="border-b border-border bg-panel p-1.5 text-[11px] md:border-b-0 md:border-t">
      <div className="mb-1 flex items-center gap-1">
        {tabBtn('book', '호가')}
        {tabBtn('trades', '체결')}
        {tab === 'book' && (
          <button
            onClick={cycleGroup}
            title="클릭하면 묶어보기 단위가 10배씩 바뀝니다"
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-panel2 hover:text-text"
          >
            {fmtPrice(groupStep, groupPrec)}
          </button>
        )}
      </div>

      {tab === 'book' &&
        (!activeBook ? (
          <div className="py-4 text-center text-muted">불러오는 중…</div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {/* 좌: 매수(bid) — 최우선호가(가격 가장 높음)가 맨 위 */}
            <div className="max-h-36 space-y-0.5 overflow-y-auto">
              {bids.map((b) => (
                <button
                  key={b.price}
                  onClick={() => pick(b.price)}
                  className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-upDim"
                    style={{ width: `${Math.min(100, (b.qty / maxQty) * 100)}%` }}
                  />
                  <span className="relative z-10 font-medium text-up">{fmtPrice(b.price, groupPrec)}</span>
                  <span className="relative z-10 text-muted">{fmtQty(b.qty)}</span>
                </button>
              ))}
            </div>
            {/* 우: 매도(ask) — 최우선호가(가격 가장 낮음)가 맨 위 */}
            <div className="max-h-36 space-y-0.5 overflow-y-auto">
              {asks.map((a) => (
                <button
                  key={a.price}
                  onClick={() => pick(a.price)}
                  className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
                >
                  <span
                    className="absolute inset-y-0 right-0 bg-downDim"
                    style={{ width: `${Math.min(100, (a.qty / maxQty) * 100)}%` }}
                  />
                  <span className="relative z-10 font-medium text-down">{fmtPrice(a.price, groupPrec)}</span>
                  <span className="relative z-10 text-muted">{fmtQty(a.qty)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

      {tab === 'trades' &&
        (trades.length === 0 ? (
          <div className="py-4 text-center text-muted">체결 내역이 없습니다</div>
        ) : (
          <div className="max-h-36 space-y-0.5 overflow-auto">
            {trades.map((t, i) => {
              const color = t.takerSide === 'sell' ? 'text-down' : t.takerSide === 'buy' ? 'text-up' : 'text-text';
              return (
                <div key={`${t.time}-${i}`} className="flex items-center justify-between px-1.5 py-0.5">
                  <span className="text-muted">{fmtTime(t.time)}</span>
                  <span className={color}>{fmtPrice(t.price, prec)}</span>
                  <span className="text-muted">{fmtQty(t.qty)}</span>
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
