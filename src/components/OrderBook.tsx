import { useEffect, useMemo, useState } from 'react';
import { orderbookStream, type OrderBookLevel, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';
import { fmtPrice, precisionFromTick } from '@/format';
import type { TickerTrade } from '@/types';

const EMPTY_TRADES: TickerTrade[] = [];
// 수량은 세자리 콤마로. 큰 물량(≥1000)은 소수 1자리, 작은 물량은 최대 4자리(뒤 0 은 자동으로 떨어짐).
const fmtQty = (q: number) => q.toLocaleString(undefined, { maximumFractionDigits: q >= 1000 ? 1 : 4 });
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const GROUP_MULTS = [1, 10, 100, 1000]; // 심볼 tick 단위의 10배씩 — 그룹 버튼을 눌러서 순환

// 같은 가격대(step 배수)로 수량을 합쳐서 보여준다. bid 는 아래로(floor), ask 는 위로(ceil) 반올림 —
// 스프레드에서 먼 방향으로 묶어야 "이 가격대에 이만큼 쌓여있다"는 의미가 유지된다.
//
// ⚠ `price / step` 을 그냥 floor/ceil 하면 **정확히 격자 위에 있는 가격이 한 틱 통째로 밀린다**.
// 이진 부동소수에서 1.45/0.0001 = 14499.999999999998 이라 floor 가 14499 를 주고, 유저가 1.45 에 건
// 주문이 호가창에 1.4499 로 표시된다("분명 1.1 에 올렸는데 1.0999… 로 보인다"던 버그). 나눈 값이
// 정수에서 1e-9 이내면 그 정수로 간주해 흡수한다. 곱한 뒤 toFixed 로 자릿수도 정리(2.3/0.01 처럼
// 곱셈에서 다시 오차가 붙는 경우 방지).
const GRID_EPS = 1e-9;
function snapToGrid(price: number, step: number, dir: 'down' | 'up'): number {
  const ticks = price / step;
  const idx = dir === 'down' ? Math.floor(ticks + GRID_EPS) : Math.ceil(ticks - GRID_EPS);
  return Number((idx * step).toFixed(10));
}
function aggregate(levels: OrderBookLevel[], step: number, side: 'bid' | 'ask'): OrderBookLevel[] {
  if (!(step > 0)) return levels;
  const map = new Map<number, { qty: number; mine: number }>();
  for (const l of levels) {
    const bucket = snapToGrid(l.price, step, side === 'bid' ? 'down' : 'up');
    const cur = map.get(bucket) ?? { qty: 0, mine: 0 };
    cur.qty += l.qty;
    cur.mine += l.mine ?? 0;
    map.set(bucket, cur);
  }
  const out = [...map.entries()].map(([price, v]) => ({ price, qty: v.qty, mine: v.mine }));
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
    ? {
        bids: spotBook.bids.map((b) => ({ price: b.price, qty: b.size, mine: b.mine ?? 0 })),
        asks: spotBook.asks.map((a) => ({ price: a.price, qty: a.size, mine: a.mine ?? 0 })),
      }
    : book;

  const prec = precisionOf(precisions, symbol);
  const tick = Math.pow(10, -prec);
  const groupStep = tick * GROUP_MULTS[groupIdx];
  const cycleGroup = () => setGroupIdx((i) => (i + 1) % GROUP_MULTS.length);
  const pick = (price: number) => useMarketStore.getState().setChartClickPrice(price);

  // 정렬: bids=가격 높은 순(최우선매수=맨 위), asks=가격 낮은 순(최우선매도=맨 위) — 그대로 위→아래 렌더.
  // ⚠ 예전엔 상위 8개만 잘라서 보여줬는데, 스프레드에서 먼 곳에 큰 물량을 걸어두면(예: 벽처럼 큰
  // 지정가) 정작 그 주문이 8번째 밖으로 밀려 화면에서 통째로 안 보이는 버그가 있었다. 서버가 애초에
  // 가격대별 최대 BOOK_LIMIT(40) 단계까지 주므로(loadSpotMarket), 프론트도 넉넉히 보여준다(스크롤 처리).
  // ⚠ 이 값을 줄일 땐 서버 LIMIT 과 같이 맞출 것.
  const BOOK_DEPTH = 22;
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
            <div className="max-h-40 overflow-y-auto">
              {bids.map((b) => (
                <button
                  key={b.price}
                  onClick={() => pick(b.price)}
                  title={b.mine ? `이 가격에 내 주문 ${fmtQty(b.mine)}` : undefined}
                  className={`relative flex w-full items-center justify-between overflow-hidden rounded-sm px-1.5 py-px text-right leading-[14px] transition hover:bg-panel2 ${
                    b.mine ? 'ring-1 ring-inset ring-accent/70' : ''
                  }`}
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-upDim"
                    style={{ width: `${Math.min(100, (b.qty / maxQty) * 100)}%` }}
                  />
                  {/* 내 물량은 같은 막대 위에 더 진하게 겹쳐 그려서 "이 중 얼마가 내 것"인지도 보인다 */}
                  {!!b.mine && (
                    <span
                      className="absolute inset-y-0 left-0 bg-accent/30"
                      style={{ width: `${Math.min(100, (b.mine / maxQty) * 100)}%` }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1 font-medium text-up">
                    {!!b.mine && <span className="h-1 w-1 shrink-0 rounded-full bg-accent" />}
                    {fmtPrice(b.price, groupPrec)}
                  </span>
                  <span className={`relative z-10 ${b.mine ? 'font-semibold text-accent' : 'text-muted'}`}>{fmtQty(b.qty)}</span>
                </button>
              ))}
            </div>
            {/* 우: 매도(ask) — 최우선호가(가격 가장 낮음)가 맨 위 */}
            <div className="max-h-40 overflow-y-auto">
              {asks.map((a) => (
                <button
                  key={a.price}
                  onClick={() => pick(a.price)}
                  title={a.mine ? `이 가격에 내 주문 ${fmtQty(a.mine)}` : undefined}
                  className={`relative flex w-full items-center justify-between overflow-hidden rounded-sm px-1.5 py-px text-right leading-[14px] transition hover:bg-panel2 ${
                    a.mine ? 'ring-1 ring-inset ring-accent/70' : ''
                  }`}
                >
                  <span
                    className="absolute inset-y-0 right-0 bg-downDim"
                    style={{ width: `${Math.min(100, (a.qty / maxQty) * 100)}%` }}
                  />
                  {!!a.mine && (
                    <span
                      className="absolute inset-y-0 right-0 bg-accent/30"
                      style={{ width: `${Math.min(100, (a.mine / maxQty) * 100)}%` }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1 font-medium text-down">
                    {!!a.mine && <span className="h-1 w-1 shrink-0 rounded-full bg-accent" />}
                    {fmtPrice(a.price, groupPrec)}
                  </span>
                  <span className={`relative z-10 ${a.mine ? 'font-semibold text-accent' : 'text-muted'}`}>{fmtQty(a.qty)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

      {tab === 'trades' &&
        (trades.length === 0 ? (
          <div className="py-4 text-center text-muted">체결 내역이 없습니다</div>
        ) : (
          <div className="max-h-40 overflow-auto">
            {trades.map((t, i) => {
              const color = t.takerSide === 'sell' ? 'text-down' : t.takerSide === 'buy' ? 'text-up' : 'text-text';
              return (
                <div key={`${t.time}-${i}`} className="flex items-center justify-between px-1.5 py-px leading-[14px]">
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
