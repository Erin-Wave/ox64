import { useEffect, useMemo, useState } from 'react';
import { orderbookStream, type OrderBookLevel, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useChartStore } from '@/store/useChartStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';
import { fmtPct, fmtPrice, fmtPriceShort, fmtQtyShort, fmtUsd, fmtUsdShort, precisionFromTick } from '@/format';
import type { TickerTrade } from '@/types';

const EMPTY_TRADES: TickerTrade[] = [];
// 수량은 세자리 콤마로. 큰 물량(≥1000)은 소수 1자리, 작은 물량은 최대 4자리(뒤 0 은 자동으로 떨어짐).
// ⚠ 1e9 이상은 한국식 단위로 축약한다 — 유저가 1e30 개짜리 벽을 걸면 수량 칸이 호가창을 통째로 밀어낸다.
const fmtQty = (q: number) =>
  Math.abs(q) >= 1e9 ? fmtQtyShort(q, 9) : q.toLocaleString(undefined, { maximumFractionDigits: q >= 1000 ? 1 : 4 });
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
// 한 행의 높이(px). 행 마크업이 `leading-[14px]` + `py-px` 라 폰트 크기 설정과 무관하게 항상 16px 이다 —
// 이 값으로 "설정한 개수만큼만" 높이를 잡는다(설정 개수를 바꿀 땐 행 마크업의 leading/padding 과 같이 볼 것).
const ROW_PX = 16;
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

/** 체결 강세·약세 **레벨** — "이 가격이 그 시점의 평균보다 싼가/비싼가"를 0~±3 으로 매긴다.
 * (+)=평균보다 비싸게 체결(강세) / (−)=평균보다 싸게 체결(약세) / 0=평균 근처.
 *
 * ⚠ 직전 체결 대비 상승·하락(틱 방향)이 아니다 — 그건 테이커 방향(행 색)과 거의 같은 정보라 화면에
 * 새로 알려주는 게 없다. 여기서 보려는 건 "지금 이 가격이 싼 가격인지"이므로 **최근 체결들의 평균**과
 * 비교한다.
 *
 * ⚠ 기준 평균은 **그 체결 직전의 최근 STRENGTH_WINDOW 건**(trailing)이다. 목록 전체에 "지금의 평균"
 * 하나를 쓰면 가격이 추세를 타는 동안 옛 행들이 전부 한쪽 색으로 다시 칠해지고(리페인트) 목록이 통째로
 * 빨갛거나 파래져서 읽을 수가 없다. 각 행이 자기 시점의 평균을 갖고 있으면 새 체결이 들어와도 이미
 * 찍힌 행의 레벨은 변하지 않는다.
 *
 * ⚠ 산포는 표준편차가 아니라 **평균절대편차(MAD)** 로 잰다 — 가격 자체가 큰 값이라(BTC 10만 대)
 * `E[x²] − E[x]²` 는 자릿수 상쇄로 정밀도가 날아간다. MAD 는 제곱을 안 써서 그 문제가 없고 창이
 * 60건뿐이라 매 행마다 직접 훑어도 싸다.
 * 레벨은 **0~±STRENGTH_MAX_LEVEL(20)** 로 잘게 나눈다 — 3단계였을 땐 "조금 싼가 많이 싼가"가 세 칸으로
 * 뭉개져서 목록을 훑어도 미세한 차이가 안 보였다. MAD 0.2배마다 한 레벨이라 평범한 체결이 4~8레벨,
 * 눈에 띄게 벗어난 체결이 12레벨 위, 20레벨은 사실상 이상치다. */
type Strength = { lvl: number; ref: number };
const STRENGTH_WINDOW = 60; // 기준 평균을 내는 최근 체결 수
const STRENGTH_MIN_SAMPLES = 8; // 이보다 적으면 평균이 의미 없어 레벨 0
const STRENGTH_MAX_LEVEL = 20; // 레벨 상한(그 이상 벗어나면 전부 최대 레벨)
const STRENGTH_Z_PER_LEVEL = 0.2; // MAD 이 배수마다 한 레벨씩(=20레벨이면 MAD 4배 = 대략 3σ)
function withStrength(trades: TickerTrade[]): (TickerTrade & Strength)[] {
  const n = trades.length;
  const out = new Array<TickerTrade & Strength>(n);
  const win: number[] = []; // 이 체결 **직전**의 최근 가격들(오래된 것부터)
  for (let i = n - 1; i >= 0; i--) {
    // trades 는 최신이 [0] 이므로 오래된 것(뒤)부터 훑어야 trailing 평균이 성립한다.
    const price = trades[i].price;
    let lvl = 0;
    let ref = price;
    if (win.length >= STRENGTH_MIN_SAMPLES) {
      let sum = 0;
      for (const w of win) sum += w;
      ref = sum / win.length;
      let dev = 0;
      for (const w of win) dev += Math.abs(w - ref);
      const mad = dev / win.length;
      if (mad > 0) {
        const z = Math.abs(price - ref) / mad;
        const step = Math.min(STRENGTH_MAX_LEVEL, Math.round(z / STRENGTH_Z_PER_LEVEL));
        lvl = price >= ref ? step : -step;
      }
    }
    out[i] = { ...trades[i], lvl, ref };
    win.push(price);
    if (win.length > STRENGTH_WINDOW) win.shift();
  }
  return out;
}

/** 화면이 PC 폭(Tailwind `md` = 768px)인지. ⚠ App.tsx 의 2열 그리드 분기와 **같은 경계**를 써야 한다 —
 * 어긋나면 사이드바가 아직 안 생긴 좁은 화면에서 호가·체결을 세로로 쌓아 화면을 통째로 밀어낸다. */
function useIsDesktop(): boolean {
  const query = '(min-width: 768px)';
  const [is, setIs] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIs(mq.matches);
    onChange(); // 마운트 사이에 회전/리사이즈가 있었을 수 있다
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return is;
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
  // 한 화면에 보여줄 행 수(설정 → 5~50). 호가는 각 열마다, 체결은 목록 전체에 같은 값을 쓴다.
  const rows = useChartStore((s) => s.bookRows);
  // PC 에서 호가·체결 동시 표시(설정). 모바일은 폭이 좁아 항상 탭 — 그래서 화면 폭도 같이 본다.
  // ⚠ 훅 호출을 `&&` 뒤에 두면 안 된다(단축 평가로 렌더마다 호출 여부가 바뀌어 훅 순서가 깨진다).
  const desktop = useIsDesktop();
  const together = useChartStore((s) => s.bookTogether) && desktop;
  // 체결 목록 필터·틱 인디케이터(설정 → 전 심볼 공통).
  const filterOn = useChartStore((s) => s.tradeFilterOn);
  const filterBasis = useChartStore((s) => s.tradeFilterBasis);
  const filterMin = useChartStore((s) => s.tradeFilterMin);
  const filterMax = useChartStore((s) => s.tradeFilterMax);
  const showStrength = useChartStore((s) => s.tradeStrength);
  const toggleChart = useChartStore((s) => s.toggle);
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
  // 지정가) 정작 그 주문이 8번째 밖으로 밀려 화면에서 통째로 안 보이는 버그가 있었다. 지금은 개수를
  // 유저가 정한다(설정 → 호가·체결 표시 개수, 5~50).
  // ⚠ 서버가 주는 단계 수(loadSpotMarket BOOK_LIMIT=50)가 상한이다 — 표시 개수를 더 늘릴 땐 그 값도
  // 같이 올릴 것. 실제 코인은 바이낸스 부분 호가 스트림이 최대 20단계라 그보다 많이는 채워지지 않는다.
  const asks = useMemo(() => (activeBook ? aggregate(activeBook.asks, groupStep, 'ask').slice(0, rows) : []), [activeBook, groupStep, rows]);
  const bids = useMemo(() => (activeBook ? aggregate(activeBook.bids, groupStep, 'bid').slice(0, rows) : []), [activeBook, groupStep, rows]);

  const maxQty = Math.max(1e-9, ...bids.map((b) => b.qty), ...asks.map((a) => a.qty));
  const groupPrec = precisionFromTick(groupStep);

  // 체결 목록: 틱 방향을 원본에 붙인 뒤 필터를 걸고, 설정한 행 수만큼 자른다.
  // ⚠ 필터가 세면 목록이 텅 빌 수 있다 — 클라가 들고 있는 테이프(useMarketStore MAX_TRADES)가 유한하기
  // 때문이다. 그래서 헤더에 "필터" 뱃지를 띄워 왜 비었는지 알 수 있게 하고, 뱃지를 누르면 바로 끈다.
  const hasBound = filterMin != null || filterMax != null;
  const filtering = filterOn && hasBound;
  const shownTrades = useMemo(() => {
    // ⚠ 레벨은 **필터 이전 원본 테이프**로 계산한다 — 걸러낸 목록의 평균은 "시장의 평균"이 아니다
    // (고래만 보기 필터를 켜면 고래 체결끼리의 평균이 되어 전혀 다른 값이 나온다).
    const tape = withStrength(trades);
    if (!filtering) return tape.slice(0, rows);
    return tape
      .filter((t) => {
        const v = filterBasis === 'qty' ? t.qty : t.price * t.qty;
        return (filterMin == null || v >= filterMin) && (filterMax == null || v <= filterMax);
      })
      .slice(0, rows);
  }, [trades, filtering, filterBasis, filterMin, filterMax, rows]);

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

  // 묶어보기 단위 버튼 — 호가 쪽에만 붇는다(체결엔 의미가 없다).
  const groupBtn = (
    <button
      onClick={cycleGroup}
      title="클릭하면 묶어보기 단위가 10배씩 바뀝니다"
      className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-panel2 hover:text-text"
    >
      {fmtPrice(groupStep, groupPrec)}
    </button>
  );
  const sectionTitle = (label: string) => <span className="px-2 py-0.5 text-[11px] font-semibold text-text">{label}</span>;

  // 필터가 걸려 있으면 체결 탭에 뱃지로 알린다(목록이 비어도 "왜 비었는지"가 보이게). 누르면 즉시 해제.
  const unit = filterBasis === 'qty' ? symbol.replace('USDT', '') : 'USDT';
  // 수량 기준이면 수량 포맷(소수 트림), 거래대금이면 금액 포맷 — 뱃지가 "1,000.00 BTC" 처럼 안 보이게.
  const fmtBound = (v: number | null) => (filterBasis === 'qty' ? fmtQtyShort(v, 9) : fmtUsdShort(v, 9));
  const filterText =
    filterMin != null && filterMax != null
      ? `${fmtBound(filterMin)}~${fmtBound(filterMax)}`
      : filterMin != null
        ? `≥ ${fmtBound(filterMin)}`
        : `≤ ${fmtBound(filterMax)}`;
  const filterBadge = filtering ? (
    <button
      onClick={() => toggleChart('tradeFilterOn')}
      title={`체결 필터 — ${filterBasis === 'qty' ? '수량' : '거래대금'} ${
        filterMin != null ? `${filterBasis === 'qty' ? fmtQty(filterMin) : fmtUsd(filterMin)} 이상` : ''
      }${filterMin != null && filterMax != null ? ' · ' : ''}${
        filterMax != null ? `${filterBasis === 'qty' ? fmtQty(filterMax) : fmtUsd(filterMax)} 이하` : ''
      } ${unit}
클릭하면 필터를 끕니다(설정에서 값 변경)`}
      className="ml-auto max-w-[60%] truncate rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent transition hover:bg-accent/25"
    >
      필터 {filterText} {unit}
    </button>
  ) : null;

  // ⚠ 세 목록(매수·매도·체결)은 전부 **고정 높이**다(maxHeight 아님). 예전엔 내용이 적으면 그만큼
  // 줄어들어서, 체결이 한 건씩 흘러들어오거나(dripTrades) 호가 단계가 바뀔 때마다 패널 높이가
  // 오르내려 아래 컴포넌트가 통째로 밀렸다("height 가 와리가리" 제보). 빈 자리는 그냥 비워 둔다.
  const listH = { height: rows * ROW_PX };
  const bookBody = !activeBook ? (
    <div className="flex items-center justify-center text-muted" style={listH}>
      불러오는 중…
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-1.5">
      {/* 좌: 매수(bid) — 최우선호가(가격 가장 높음)가 맨 위 */}
      <div className="overflow-y-auto" style={listH}>
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
              {fmtPriceShort(b.price, groupPrec, 9)}
            </span>
            <span className={`relative z-10 ${b.mine ? 'font-semibold text-accent' : 'text-muted'}`}>{fmtQty(b.qty)}</span>
          </button>
        ))}
      </div>
      {/* 우: 매도(ask) — 최우선호가(가격 가장 낮음)가 맨 위 */}
      <div className="overflow-y-auto" style={listH}>
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
              {fmtPriceShort(a.price, groupPrec, 9)}
            </span>
            <span className={`relative z-10 ${a.mine ? 'font-semibold text-accent' : 'text-muted'}`}>{fmtQty(a.qty)}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const tradesBody =
    shownTrades.length === 0 ? (
      <div className="flex items-center justify-center text-center text-muted" style={listH}>
        {trades.length === 0 ? '체결 내역이 없습니다' : '필터에 맞는 체결이 없습니다'}
      </div>
    ) : (
      <div className="overflow-auto" style={listH}>
        {shownTrades.map((t, i) => {
          const color = t.takerSide === 'sell' ? 'text-down' : t.takerSide === 'buy' ? 'text-up' : 'text-text';
          // 강세·약세 레벨(0~±3) → 가격 칸 배경 바. 레벨이 높을수록 바가 길어지고 아주 조금 진해진다
          // ("은은하게" — 숫자를 읽는 데 방해되면 안 된다). +는 평균보다 비싸게(강세), −는 싸게(약세).
          const lvl = showStrength ? t.lvl : 0;
          const mag = Math.abs(lvl);
          const gapPct = t.ref > 0 ? ((t.price - t.ref) / t.ref) * 100 : 0;
          return (
            // ⚠ 3열은 반드시 **격자**로 — 예전엔 `flex justify-between` 이라 세 칸의 너비가 행마다
            // 제각각 계산돼, 수량 자릿수가 바뀌면(604 vs 6,694) 가운데 가격이 좌우로 흔들렸다.
            <div
              key={`${t.time}-${i}`}
              className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 px-1.5 py-px leading-[14px]"
            >
              <span className="text-muted">{fmtTime(t.time)}</span>
              <span
                className="relative block overflow-hidden rounded-sm"
                title={
                  mag === 0
                    ? undefined
                    : `최근 ${STRENGTH_WINDOW}건 평균 ${fmtPriceShort(t.ref, prec, 9)} 대비 ${
                        gapPct >= 0 ? '+' : ''
                      }${fmtPct(gapPct, 3)}% · ${lvl > 0 ? '강세' : '약세'} ${mag}레벨 (최대 ${STRENGTH_MAX_LEVEL})`
                }
              >
                {mag > 0 && (
                  // ⚠ 바는 **왼쪽에서** 자란다 — 가격 숫자가 오른쪽 정렬이라 오른쪽에 붙이면 바가 숫자
                  // 밑에 깔려 글자를 읽기 어렵고, 레벨(길이)도 눈으로 비교가 안 된다(시작점이 제각각).
                  // 농도는 6~22% — 배경이지 강조가 아니라 낮게 두되, 너무 옅으면 레벨 차이가 안 읽힌다
                  // (4~16% 는 "안 보인다"는 쪽이었고, 3단계 시절의 15~25% 는 숫자를 가릴 만큼 진했다).
                  <span
                    className={`absolute inset-y-0 left-0 ${lvl > 0 ? 'bg-up' : 'bg-down'}`}
                    style={{ width: `${(mag / STRENGTH_MAX_LEVEL) * 100}%`, opacity: 0.06 + (mag / STRENGTH_MAX_LEVEL) * 0.16 }}
                  />
                )}
                <span className={`relative block truncate text-right ${color}`}>{fmtPriceShort(t.price, prec, 9)}</span>
              </span>
              {/* 수량도 같은 방향 색으로 — 가격만 칠하면 목록을 훑을 때 매수/매도 흐름이 한눈에 안 읽힌다. */}
              <span className={`truncate text-right ${color}`} title={`거래대금 ${fmtUsd(t.price * t.qty)} USDT`}>
                {fmtQty(t.qty)}
              </span>
            </div>
          );
        })}
      </div>
    );

  // PC 에서 "같이 보기" 를 켰으면 탭 없이 위(호가)·아래(체결)로 나란히 그린다. 사이드바(18rem)가 좁아
  // 좌우로 나누면 세 칸이 되어 가격/수량이 뭉개지므로 세로로 쌓는다 — 넘치면 사이드바가 스크롤된다.
  if (together)
    return (
      <div className="border-b border-border bg-panel p-1.5 text-[11px] md:border-b-0 md:border-t">
        <div className="mb-1 flex items-center gap-1">
          {sectionTitle('호가')}
          {groupBtn}
        </div>
        {bookBody}
        <div className="mb-1 mt-1.5 flex items-center gap-1 border-t border-border pt-1.5">
          {sectionTitle('체결')}
          {filterBadge}
        </div>
        {tradesBody}
      </div>
    );

  return (
    <div className="border-b border-border bg-panel p-1.5 text-[11px] md:border-b-0 md:border-t">
      <div className="mb-1 flex items-center gap-1">
        {tabBtn('book', '호가')}
        {tabBtn('trades', '체결')}
        {tab === 'book' ? groupBtn : filterBadge}
      </div>

      {tab === 'book' ? bookBody : tradesBody}
    </div>
  );
}
