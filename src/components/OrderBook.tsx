import { useEffect, useMemo, useState } from 'react';
import { orderbookStream, type OrderBookLevel, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { fmtPrice, precisionFromTick } from '@/format';

const fmtQty = (q: number) => (q >= 1000 ? q.toFixed(1) : q.toFixed(4));
const GROUP_MULTS = [1, 5, 10, 50, 100]; // 심볼 tick 단위의 배수 — "모아보기" 단계

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

/** 호가창 — 클릭하면 그 가격이 지정가 주문 입력에 채워진다(차트 클릭과 동일한 신호 재사용).
 * 상단의 "모아보기" 단계 선택으로 인접 호가를 묶어서 볼 수 있다. */
export default function OrderBook() {
  const symbol = useMarketStore((s) => s.symbol);
  const precisions = useMarketStore((s) => s.precisions);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [groupMult, setGroupMult] = useState(1);

  useEffect(() => {
    setBook(null);
    setGroupMult(1); // 심볼마다 tick 단위가 달라서 배수 선택을 리셋
    const sub = orderbookStream(symbol, 20).subscribe({ next: setBook });
    return () => sub.unsubscribe();
  }, [symbol]);

  const prec = precisionOf(precisions, symbol);
  const tick = Math.pow(10, -prec);
  const groupStep = tick * groupMult;
  const pick = (price: number) => useMarketStore.getState().setChartClickPrice(price);

  const asks = useMemo(() => (book ? aggregate(book.asks, groupStep, 'ask').slice(0, 8) : []), [book, groupStep]);
  const bids = useMemo(() => (book ? aggregate(book.bids, groupStep, 'bid').slice(0, 8) : []), [book, groupStep]);

  const maxQty = Math.max(1e-9, ...bids.map((b) => b.qty), ...asks.map((a) => a.qty));
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const groupPrec = precisionFromTick(groupStep);

  return (
    <div className="border-b border-border bg-panel p-2 text-xs md:border-b-0 md:border-t">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase text-muted">호가창</span>
        <select
          value={groupMult}
          onChange={(e) => setGroupMult(Number(e.target.value))}
          className="cursor-pointer rounded bg-panel2 px-1.5 py-0.5 text-[10px] font-semibold text-text outline-none ring-1 ring-border hover:ring-elevated"
        >
          {GROUP_MULTS.map((m) => (
            <option key={m} value={m}>
              모아보기 {fmtPrice(tick * m, precisionFromTick(tick * m))}
            </option>
          ))}
        </select>
      </div>
      {!book ? (
        <div className="py-6 text-center text-muted">불러오는 중…</div>
      ) : (
        <>
          {/* 매도(ask) — 스프레드에 가까운 최우선호가가 아래에 오도록 역순 렌더 */}
          <div className="space-y-0.5">
            {[...asks].reverse().map((a) => (
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

          <div className="my-1 flex items-center justify-between border-y border-border px-1.5 py-1 text-[11px] text-muted">
            <span>스프레드</span>
            <span className="text-text">{spread != null ? fmtPrice(spread, groupPrec) : '—'}</span>
          </div>

          {/* 매수(bid) — 최우선호가가 스프레드 바로 아래 */}
          <div className="space-y-0.5">
            {bids.map((b) => (
              <button
                key={b.price}
                onClick={() => pick(b.price)}
                className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
              >
                <span
                  className="absolute inset-y-0 right-0 bg-upDim"
                  style={{ width: `${Math.min(100, (b.qty / maxQty) * 100)}%` }}
                />
                <span className="relative z-10 font-medium text-up">{fmtPrice(b.price, groupPrec)}</span>
                <span className="relative z-10 text-muted">{fmtQty(b.qty)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
