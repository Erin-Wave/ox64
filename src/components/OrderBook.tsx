import { useEffect, useMemo, useState } from 'react';
import { orderbookStream, type OrderBookLevel, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { fmtPrice, precisionFromTick } from '@/format';

const fmtQty = (q: number) => (q >= 1000 ? q.toFixed(1) : q.toFixed(4));
const GROUP_MULTS = [1, 10, 100, 1000]; // 심볼 tick 단위의 10배씩 — "스프레드" 값을 눌러서 순환

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
 * 가운데 "스프레드" 값을 클릭하면 묶어보기 단위가 0.01→0.1→1→10… 식으로 10배씩 순환한다. */
export default function OrderBook() {
  const symbol = useMarketStore((s) => s.symbol);
  const precisions = useMarketStore((s) => s.precisions);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [groupIdx, setGroupIdx] = useState(0);

  useEffect(() => {
    setBook(null);
    setGroupIdx(0); // 심볼마다 tick 단위가 달라서 배수 선택을 리셋
    const sub = orderbookStream(symbol, 20).subscribe({ next: setBook });
    return () => sub.unsubscribe();
  }, [symbol]);

  const prec = precisionOf(precisions, symbol);
  const tick = Math.pow(10, -prec);
  const groupStep = tick * GROUP_MULTS[groupIdx];
  const cycleGroup = () => setGroupIdx((i) => (i + 1) % GROUP_MULTS.length);
  const pick = (price: number) => useMarketStore.getState().setChartClickPrice(price);

  const asks = useMemo(() => (book ? aggregate(book.asks, groupStep, 'ask').slice(0, 8) : []), [book, groupStep]);
  const bids = useMemo(() => (book ? aggregate(book.bids, groupStep, 'bid').slice(0, 8) : []), [book, groupStep]);

  const maxQty = Math.max(1e-9, ...bids.map((b) => b.qty), ...asks.map((a) => a.qty));
  const groupPrec = precisionFromTick(groupStep);

  return (
    <div className="border-b border-border bg-panel p-2 text-xs md:border-b-0 md:border-t">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase text-muted">호가창</div>
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

          {/* 스프레드 값 클릭 = 묶어보기 단위 10배 순환(0.01→0.1→1→10→0.01...) */}
          <button
            onClick={cycleGroup}
            title="클릭하면 묶어보기 단위가 10배씩 바뀝니다"
            className="my-1 flex w-full items-center justify-between rounded border-y border-border px-1.5 py-1 text-[11px] text-muted transition hover:bg-panel2"
          >
            <span>스프레드</span>
            <span className="font-semibold text-text">{fmtPrice(groupStep, groupPrec)}</span>
          </button>

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
