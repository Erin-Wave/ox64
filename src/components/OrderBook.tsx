import { useEffect, useState } from 'react';
import { orderbookStream, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { fmtPrice } from '@/format';

const fmtQty = (q: number) => (q >= 1000 ? q.toFixed(1) : q.toFixed(4));

/** 호가창 — 클릭하면 그 가격이 지정가 주문 입력에 채워진다(차트 클릭과 동일한 신호 재사용). */
export default function OrderBook() {
  const symbol = useMarketStore((s) => s.symbol);
  const precisions = useMarketStore((s) => s.precisions);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);

  useEffect(() => {
    setBook(null);
    const sub = orderbookStream(symbol, 10).subscribe({ next: setBook });
    return () => sub.unsubscribe();
  }, [symbol]);

  const prec = precisionOf(precisions, symbol);
  const pick = (price: number) => useMarketStore.getState().setChartClickPrice(price);

  const maxQty = book ? Math.max(1e-9, ...book.bids.map((b) => b.qty), ...book.asks.map((a) => a.qty)) : 1;
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  return (
    <div className="border-b border-border bg-panel p-2 text-xs md:border-b-0 md:border-t">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase text-muted">호가창</div>
      {!book ? (
        <div className="py-6 text-center text-muted">불러오는 중…</div>
      ) : (
        <>
          {/* 매도(ask) — 스프레드에 가까운 최우선호가가 아래에 오도록 역순 렌더 */}
          <div className="space-y-0.5">
            {[...book.asks].reverse().map((a) => (
              <button
                key={a.price}
                onClick={() => pick(a.price)}
                className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
              >
                <span
                  className="absolute inset-y-0 right-0 bg-downDim"
                  style={{ width: `${Math.min(100, (a.qty / maxQty) * 100)}%` }}
                />
                <span className="relative z-10 font-medium text-down">{fmtPrice(a.price, prec)}</span>
                <span className="relative z-10 text-muted">{fmtQty(a.qty)}</span>
              </button>
            ))}
          </div>

          <div className="my-1 flex items-center justify-between border-y border-border px-1.5 py-1 text-[11px] text-muted">
            <span>스프레드</span>
            <span className="text-text">{spread != null ? fmtPrice(spread, prec) : '—'}</span>
          </div>

          {/* 매수(bid) — 최우선호가가 스프레드 바로 아래 */}
          <div className="space-y-0.5">
            {book.bids.map((b) => (
              <button
                key={b.price}
                onClick={() => pick(b.price)}
                className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
              >
                <span
                  className="absolute inset-y-0 right-0 bg-upDim"
                  style={{ width: `${Math.min(100, (b.qty / maxQty) * 100)}%` }}
                />
                <span className="relative z-10 font-medium text-up">{fmtPrice(b.price, prec)}</span>
                <span className="relative z-10 text-muted">{fmtQty(b.qty)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
