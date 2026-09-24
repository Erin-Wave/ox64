import { useEffect, useMemo, useRef, useState } from 'react';
import { orderbookStream, type OrderBookLevel, type OrderBookSnapshot } from '@/services/binanceWs';
import { useMarketStore, precisionOf, selectLastPrice, selectLastTakerSide } from '@/store/useMarketStore';
import { useChartStore } from '@/store/useChartStore';
import { useTradingStore } from '@/store/useTradingStore';
import { baseOf, isVirtualSymbol, quoteOf } from '@/symbols';
import { bithumbOrderbookStream } from '@/services/bithumb';
import { fmtMoney, fmtMoneyShort, fmtPct, fmtPrice, fmtPriceShort, fmtQtyShort, fmtUsd, fmtUsdShort, precisionFromTick } from '@/format';
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

/** 호가 목록 높이를 **실제 단계 수만큼** 줄이되(묶어보기·거래소 단계 상한으로 빈칸이 생기면 그만큼 체결이 올라온다),
 * 늘어날 땐 즉시 · 줄어들 땐 `holdMs` 동안 계속 적을 때만 줄인다 — 단계 수가 틱마다 9↔10 으로 흔들려도 패널이
 * 오르내리지 않게(예전 "height 와리가리" 제보의 원인이 바로 그 흔들림이었다). `resetKey`(심볼·묶음 단위·행 수·
 * 배치)가 바뀌면 기다리지 않고 바로 맞춘다 — 묶어보기를 눌렀는데 1초 넘게 빈칸이 남으면 반응이 굼떠 보인다. */
function useStickyCount(n: number, resetKey: string, holdMs = 1500): number {
  const [shown, setShown] = useState(n);
  const keyRef = useRef(resetKey);
  const reset = keyRef.current !== resetKey;
  useEffect(() => {
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      setShown(n);
      return;
    }
    if (n >= shown) {
      if (n !== shown) setShown(n);
      return;
    }
    const t = window.setTimeout(() => setShown(n), holdMs);
    return () => window.clearTimeout(t);
  }, [n, shown, resetKey, holdMs]);
  return reset ? n : Math.max(n, shown);
}
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
/** 묶은 호가 한 단계 — 수량과 함께 **총금액(Σ 가격×수량)** 도 합쳐 둔다(묶음 가격 × 합계수량으로 근사하지 않는다). */
interface BookRow {
  price: number;
  qty: number;
  mine: number;
  notional: number;
  mineNotional: number;
  /** 마지막 체결가인데 지금 그 가격에 남은 호가가 없어 끼워 넣은 빈 행(§ withLastTrade) */
  phantom?: boolean;
}

/** 마지막 체결가 행이 호가창에 없으면(체결이 그 가격대를 다 먹었다) **수량 없는 행으로 제자리에 끼워 넣는다** —
 * 테두리가 "여기서 체결됐고 지금은 남은 호가가 없다"를 그대로 보여주게. 가상 코인은 체결이 그 단계를 소진한 뒤
 * 다음 사다리가 한 칸 너머에서 시작하므로 이게 없으면 테두리가 거의 안 보였다(실측: 실제 코인은 90~100% 행이 남아 있음). */
function withLastTrade(list: BookRow[], side: 'bid' | 'ask', target: number | null): BookRow[] {
  if (target == null || list.some((r) => r.price === target)) return list;
  const out = [...list, { price: target, qty: 0, mine: 0, notional: 0, mineNotional: 0, phantom: true }];
  out.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
  return out;
}
function aggregate(levels: OrderBookLevel[], step: number, side: 'bid' | 'ask'): BookRow[] {
  const map = new Map<number, BookRow>();
  for (const l of levels) {
    const bucket = step > 0 ? snapToGrid(l.price, step, side === 'bid' ? 'down' : 'up') : l.price;
    const cur = map.get(bucket) ?? { price: bucket, qty: 0, mine: 0, notional: 0, mineNotional: 0 };
    cur.qty += l.qty;
    cur.mine += l.mine ?? 0;
    cur.notional += l.price * l.qty;
    cur.mineNotional += l.price * (l.mine ?? 0);
    map.set(bucket, cur);
  }
  const out = [...map.values()];
  out.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
  return out;
}

/** 체결 강세·약세 **레벨** — "이 가격이 그 시점의 평균보다 싼가/비싼가"를 0~±50 으로 매긴다.
 * (+)=평균보다 비싸게 체결(강세) / (−)=평균보다 싸게 체결(약세) / 0=평균 근처.
 *
 * ⚠ 직전 체결 대비 상승·하락(틱 방향)이 아니다 — 그건 테이커 방향(행 색)과 거의 같은 정보라 화면에
 * 새로 알려주는 게 없다. 여기서 보려는 건 "지금 이 가격이 싼 가격인지"이므로 **최근 체결들의 중심**과
 * 비교한다.
 *
 * ⚠ 기준은 그 체결 **직전 STRENGTH_WINDOW 건**(trailing)이다. 목록 전체에 "지금의 중심" 하나를 쓰면
 * 가격이 추세를 타는 동안 옛 행들이 전부 한쪽 색으로 다시 칠해지고(리페인트) 목록이 통째로 빨갛거나
 * 파래져서 읽을 수가 없다. 각 행이 자기 시점 기준을 갖고 있으면 새 체결이 들어와도 레벨이 안 변한다.
 *
 * ⚠⚠ 중심·산포는 평균/평균절대편차가 아니라 **중앙값 / 중앙절대편차**다(robust). 예전엔 평균을 썼는데,
 * 대량 시장가가 호가를 훑으며 찍는 프린트들이 **자기들끼리 잣대를 부풀려서** 뒤로 갈수록 z 가 오히려
 * 작아졌다("대량 매수했는데 가격은 오르는데 바 길이가 다 똑같다" 제보). 중앙값은 창의 소수를 차지하는
 * 그 프린트들에 안 끌려가므로, 스윕이 진행될수록 레벨이 실제로 커진다.
 *
 * ⚠⚠ z→레벨 매핑은 **꺾은선**이다. 평상시 틱 노이즈(z≈1~3)와 대량 체결(z가 수십~수백)은 자릿수가
 * 100배 차이라 한 가지 눈금으로는 둘 다 못 담는다 — 선형으로 잡으면 스윕이 전부 최대 레벨에 박히고
 * (실제로 그랬다), 스윕에 맞춰 눈금을 늘리면 평상시 바가 사라진다. 그래서 **무릎(z=2.5)까지는 선형**
 * (평상시 화면 느낌 유지: 평균 18레벨)이고 그 위는 **로그로 압축**해 z=600 까지 레벨 30→50 으로 늘린다.
 * 실측(6,000틱 시뮬): 평상시 평균 18.3레벨·포화 0%, 4.66→4.76 스윕 8건이 38→45 로 단조 증가.
 *
 * ⚠ 계산은 **표시할 행에 대해서만** 한다(필터·자르기 뒤). 창이 120건이고 중앙값 계산에 정렬이 두 번
 * 들어가는데 버퍼 400건 전부에 돌리면 폴링마다 수십만 연산이 된다. 창은 **필터 이전 원본 테이프**에서
 * 가져와야 한다 — 걸러낸 목록의 중심은 "시장의 중심"이 아니다(고래만 보기 필터면 고래끼리의 평균이 된다). */
type Strength = { lvl: number; ref: number };
const STRENGTH_WINDOW = 120; // 기준을 잡는 최근 체결 수
const STRENGTH_MIN_SAMPLES = 8; // 이보다 적으면 기준이 의미 없어 레벨 0
const STRENGTH_MAX_LEVEL = 50;
const STRENGTH_KNEE_Z = 2.5; // 여기까지는 선형(평상시 구간)
const STRENGTH_KNEE_LEVEL = 30;
const STRENGTH_TAIL_T = 3; // 로그 꼬리의 완만함
const STRENGTH_TAIL_Z = 600; // 이 이상 벗어나면 최대 레벨(≈ 노이즈의 600배)
const STRENGTH_TAIL_DEN = Math.log1p((STRENGTH_TAIL_Z - STRENGTH_KNEE_Z) / STRENGTH_TAIL_T);

/** 중앙값(입력 배열은 그대로 둔다). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** trades[i] 의 강세·약세 레벨. trades 는 최신이 [0] 이므로 **뒤쪽(i+1…)이 그 이전 체결**이다. */
function strengthAt(trades: TickerTrade[], i: number): Strength {
  const price = trades[i].price;
  const win: number[] = [];
  for (let j = i + 1; j < trades.length && win.length < STRENGTH_WINDOW; j++) win.push(trades[j].price);
  if (win.length < STRENGTH_MIN_SAMPLES) return { lvl: 0, ref: price };
  const center = median(win);
  const devs = win.map((w) => Math.abs(w - center));
  let scale = median(devs);
  // 창의 절반 이상이 같은 가격이면 중앙절대편차가 0 이 된다(호가가 거의 안 움직이는 구간) → 평균으로 폴백.
  if (!(scale > 0)) scale = devs.reduce((a, b) => a + b, 0) / devs.length;
  if (!(scale > 0)) return { lvl: 0, ref: center };
  const z = Math.abs(price - center) / scale;
  const raw =
    z <= STRENGTH_KNEE_Z
      ? (z / STRENGTH_KNEE_Z) * STRENGTH_KNEE_LEVEL
      : STRENGTH_KNEE_LEVEL +
        (STRENGTH_MAX_LEVEL - STRENGTH_KNEE_LEVEL) *
          Math.min(1, Math.log1p((z - STRENGTH_KNEE_Z) / STRENGTH_TAIL_T) / STRENGTH_TAIL_DEN);
  const step = Math.min(STRENGTH_MAX_LEVEL, Math.round(raw));
  return { lvl: price >= center ? step : -step, ref: center };
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

/** 호가창 + 체결내역 탭. 배치는 설정(bookLayout) — 좌우: 매수(좌)·매도(우) 2열, 각 열 최우선호가가 맨 위 /
 * 상하: 매도(위, 최우선매도가 가운데 쪽)·현재가·매수(아래). 수치는 코인 수량 또는 총금액(상단 버튼, bookUnit).
 * 클릭하면 그 가격이 지정가 주문 입력에 채워진다.
 * 체결 탭 데이터는 useTradeTape(App.tsx 에서 항상 구동)이 채우는 useMarketStore.recentTrades 를 그대로 구독. */
export default function OrderBook() {
  const symbol = useMarketStore((s) => s.symbol);
  const precisions = useMarketStore((s) => s.precisions);
  const trades = useMarketStore((s) => s.recentTrades[s.symbol] ?? EMPTY_TRADES);
  const virtual = isVirtualSymbol(symbol);
  const spotBook = useTradingStore((s) => s.spotBook);
  const spotPair = useTradingStore((s) => s.spotPair);
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
  const bookUnit = useChartStore((s) => s.bookUnit);
  const setBookUnit = useChartStore((s) => s.setBookUnit);
  const vertical = useChartStore((s) => s.bookLayout) === 'vertical';
  const lastPrice = useMarketStore(selectLastPrice);
  const lastTakerSide = useMarketStore(selectLastTakerSide);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const blinkRef = useRef<{ obj: TickerTrade | undefined; n: number }>({ obj: undefined, n: 0 });
  const [groupIdx, setGroupIdx] = useState(0);
  const [tab, setTab] = useState<'book' | 'trades'>('book');

  useEffect(() => {
    if (virtual) return; // 가상 심볼은 useSpotPoll 이 채우는 store.spotBook 을 대신 사용
    setBook(null);
    setGroupIdx(0); // 심볼마다 tick 단위가 달라서 배수 선택을 리셋
    // 원화 심볼은 빗썸 호가(30단계, 브라우저 직결), 나머지 실제 코인은 바이낸스 부분 호가(최대 20단계).
    const stream = quoteOf(symbol) === 'KRW' ? bithumbOrderbookStream(symbol) : orderbookStream(symbol, 20);
    const sub = stream.subscribe({ next: setBook });
    return () => sub.unsubscribe();
  }, [symbol, virtual]);

  // 가상 심볼은 spot_orders 호가(price/size)를 OrderBookLevel(price/qty) 형태로 매핑해 재사용
  // ⚠ 다른 코인의 호가면 그리지 않는다 — 심볼 전환 직후 폴링이 비우기 전 한 프레임(§ spotPair)
  const activeBook: OrderBookSnapshot | null = virtual
    ? spotPair !== symbol
      ? null
      : {
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
  // ── 마지막 체결가 행 ── 매수 체결(테이커 매수)은 매도호가를 먹었으니 매도 쪽, 매도 체결은 매수 쪽 행을 표시한다.
  // 묶어보기 중이면 그 가격이 속한 묶음 — aggregate 와 같은 snapToGrid 라 값이 정확히 같다. 그 행이 없으면(다 먹혀
  // 사라졌으면) 빈 행으로 끼워 넣는다(§ withLastTrade — 방향을 모르는 체결은 끼워 넣지 않고 있는 행만 표시).
  const lastTrade = trades[0];
  const lastBid = lastTrade && lastTrade.takerSide !== 'buy' ? snapToGrid(lastTrade.price, groupStep, 'down') : null;
  const lastAsk = lastTrade && lastTrade.takerSide !== 'sell' ? snapToGrid(lastTrade.price, groupStep, 'up') : null;
  const insertBid = lastTrade?.takerSide === 'sell' ? lastBid : null;
  const insertAsk = lastTrade?.takerSide === 'buy' ? lastAsk : null;
  const asks = useMemo(
    () => (activeBook ? withLastTrade(aggregate(activeBook.asks, groupStep, 'ask'), 'ask', insertAsk).slice(0, rows) : []),
    [activeBook, groupStep, rows, insertAsk],
  );
  const bids = useMemo(
    () => (activeBook ? withLastTrade(aggregate(activeBook.bids, groupStep, 'bid'), 'bid', insertBid).slice(0, rows) : []),
    [activeBook, groupStep, rows, insertBid],
  );

  // 막대 길이·표시 수치는 고른 단위(수량/총금액)로 — 금액으로 보면 비싼 가격대의 같은 수량이 더 길게 보인다.
  const quote = quoteOf(symbol);
  const valOf = (l: BookRow) => (bookUnit === 'qty' ? l.qty : l.notional);
  const mineOf = (l: BookRow) => (bookUnit === 'qty' ? l.mine : l.mineNotional);
  const fmtVal = (v: number) => (bookUnit === 'qty' ? fmtQty(v) : fmtMoneyShort(v, quote, quote === 'KRW' ? 5 : 6));
  const maxVal = Math.max(1e-9, ...bids.map(valOf), ...asks.map(valOf));
  // 호가 목록 높이 = 실제 단계 수(최소 1행, 최대 설정 행 수). ⚠ 훅이라 배치와 무관하게 셋 다 항상 부른다.
  const bookKey = `${symbol}|${groupIdx}|${rows}|${vertical ? 'v' : 'h'}`;
  const hRows = useStickyCount(Math.max(bids.length, asks.length), bookKey);
  const askRows = useStickyCount(asks.length, bookKey);
  const bidRows = useStickyCount(bids.length, bookKey);
  const hgt = (n: number) => ({ height: Math.max(1, Math.min(rows, n)) * ROW_PX });
  const groupPrec = precisionFromTick(groupStep);

  // 체결 목록: 틱 방향을 원본에 붙인 뒤 필터를 걸고, 설정한 행 수만큼 자른다.
  // ⚠ 필터가 세면 목록이 텅 빌 수 있다 — 클라가 들고 있는 테이프(useMarketStore MAX_TRADES)가 유한하기
  // 때문이다. 그래서 헤더에 "필터" 뱃지를 띄워 왜 비었는지 알 수 있게 하고, 뱃지를 누르면 바로 끈다.
  const hasBound = filterMin != null || filterMax != null;
  const filtering = filterOn && hasBound;
  const shownTrades = useMemo(() => {
    const pass = (t: TickerTrade) => {
      if (!filtering) return true;
      const v = filterBasis === 'qty' ? t.qty : t.price * t.qty;
      return (filterMin == null || v >= filterMin) && (filterMax == null || v <= filterMax);
    };
    // 먼저 걸러서 화면에 나갈 행만 고르고(≤ rows), 레벨은 그 행들에 대해서만 계산한다 —
    // 단 창(기준 체결들)은 **원본 테이프**에서 가져온다(§ strengthAt).
    const out: (TickerTrade & Strength)[] = [];
    for (let i = 0; i < trades.length && out.length < rows; i++) {
      if (!pass(trades[i])) continue;
      out.push({ ...trades[i], ...strengthAt(trades, i) });
    }
    return out;
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
      className="rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-panel2 hover:text-text"
    >
      {fmtPrice(groupStep, groupPrec)}
    </button>
  );
  // 호가 수치 단위 — 코인 수량 ⇄ 총금액(가격×수량). 지금 단위를 보여주고 누르면 바뀐다(주문 패널 단위 버튼과 같은 모양).
  const unitBtn = (
    <button
      onClick={() => setBookUnit(bookUnit === 'qty' ? 'notional' : 'qty')}
      title={bookUnit === 'qty' ? `코인 수량(${baseOf(symbol)}) — 누르면 총금액(${quote})으로` : `총금액(${quote}) — 누르면 코인 수량(${baseOf(symbol)})으로`}
      className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-muted transition hover:bg-panel2 hover:text-text"
    >
      {bookUnit === 'qty' ? baseOf(symbol) : quote} ⇄
    </button>
  );
  const bookTools = (
    <div className="ml-auto flex items-center gap-0.5">
      {unitBtn}
      {groupBtn}
    </div>
  );
  const sectionTitle = (label: string) => <span className="px-2 py-0.5 text-[11px] font-semibold text-text">{label}</span>;

  // 필터가 걸려 있으면 체결 탭에 뱃지로 알린다(목록이 비어도 "왜 비었는지"가 보이게). 누르면 즉시 해제.
  // ⚠ 거래대금 기준 필터 값은 **그 심볼의 결제통화** 단위다(원화 심볼이면 원).
  const unit = filterBasis === 'qty' ? baseOf(symbol) : quoteOf(symbol);
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
      className="min-w-0 truncate rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent transition hover:bg-accent/25"
    >
      필터 {filterText} {unit}
    </button>
  ) : null;

  // ⚠ 체결 목록은 **고정 높이**다(maxHeight 아님) — 체결이 한 건씩 흘러들어오며(dripTrades) 높이가 오르내리면
  // 아래 컴포넌트가 통째로 밀린다("height 와리가리" 제보). 호가 목록은 반대로 **실제 단계 수만큼 압축**한다
  // (묶어보기·거래소 단계 상한으로 생긴 빈칸은 쓸모없는 공간이라 그만큼 체결이 올라오게) — 대신 줄어들 땐
  // 잠깐 기다려 흔들림을 흡수한다(§ useStickyCount).
  const listH = { height: rows * ROW_PX };
  const MID_PX = 22; // 상하 배치의 가운데 현재가 줄
  // 새 체결마다 1씩 오르는 번호 — 체결 테이프 맨 앞 객체가 바뀔 때만 센다(같은 렌더를 두 번 해도 안 늘어난다).
  if (blinkRef.current.obj !== lastTrade) blinkRef.current = { obj: lastTrade, n: blinkRef.current.n + 1 };
  const blinkKey = blinkRef.current.n;
  // 한 단계 행. 좌우 배치는 막대가 가운데(스프레드) 쪽에서 바깥으로, 상하 배치는 둘 다 오른쪽에서 자란다.
  const row = (l: BookRow, side: 'bid' | 'ask') => {
    const v = valOf(l);
    const mine = mineOf(l);
    const isLast = side === 'bid' ? l.price === lastBid : l.price === lastAsk;
    const fromRight = vertical || side === 'ask';
    const bar = side === 'bid' ? 'bg-upDim' : 'bg-downDim';
    const tip = [
      bookUnit === 'notional' ? `총금액 ${fmtMoney(v, quote)} ${quote} · 수량 ${fmtQty(l.qty)}` : '',
      l.mine ? `이 가격에 내 주문 ${fmtQty(l.mine)}` : '',
      isLast ? (l.phantom ? '마지막 체결가 — 지금 이 가격엔 남은 호가가 없습니다' : '마지막 체결가') : '',
    ]
      .filter(Boolean)
      .join('\n');
    return (
      <button
        key={l.price}
        onClick={() => pick(l.price)}
        title={tip || undefined}
        className={`relative flex w-full items-center justify-between overflow-hidden rounded-sm px-1.5 py-px text-right leading-[14px] transition hover:bg-panel2 ${
          l.mine ? 'ring-1 ring-inset ring-accent/70' : ''
        }`}
      >
        <span
          className={`absolute inset-y-0 ${fromRight ? 'right-0' : 'left-0'} ${bar}`}
          style={{ width: `${Math.min(100, (v / maxVal) * 100)}%` }}
        />
        {/* 내 물량은 같은 막대 위에 더 진하게 겹쳐 그려서 "이 중 얼마가 내 것"인지도 보인다 */}
        {!!l.mine && (
          <span
            className={`absolute inset-y-0 ${fromRight ? 'right-0' : 'left-0'} bg-accent/30`}
            style={{ width: `${Math.min(100, (mine / maxVal) * 100)}%` }}
          />
        )}
        {/* 마지막 체결가 테두리 — 체결 1건마다 key 가 바뀌어 새로 그려지므로 **같은 가격에 연달아 체결돼도 매번 깜빡인다** */}
        {isLast && (
          <span key={blinkKey} className="trade-blink pointer-events-none absolute inset-0 rounded-sm ring-1 ring-inset ring-text/80" />
        )}
        <span className={`relative z-10 flex items-center gap-1 font-medium ${side === 'bid' ? 'text-up' : 'text-down'}`}>
          {!!l.mine && <span className="h-1 w-1 shrink-0 rounded-full bg-accent" />}
          {fmtPriceShort(l.price, groupPrec, 9)}
        </span>
        <span className={`relative z-10 ${l.mine ? 'font-semibold text-accent' : 'text-muted'}`}>{l.phantom ? '—' : fmtVal(v)}</span>
      </button>
    );
  };
  const bookBody = !activeBook ? (
    <div className="flex items-center justify-center text-muted" style={vertical ? { height: rows * ROW_PX * 2 + MID_PX } : listH}>
      불러오는 중…
    </div>
  ) : vertical ? (
    // 상하: 매도(위) — 최우선매도가 **맨 아래**(가운데 줄 바로 위)에 오도록 뒤집어 그리고, 단계가 모자라면 아래로 붙인다.
    <div>
      <div className="flex flex-col justify-end overflow-hidden" style={hgt(askRows)}>
        {[...asks].reverse().map((a) => row(a, 'ask'))}
      </div>
      <div
        className="flex items-center justify-between border-y border-border/60 px-1.5"
        style={{ height: MID_PX }}
        title="현재가 · 최우선 매도−매수 호가 차이"
      >
        <span
          className={`text-[13px] font-bold ${lastTakerSide === 'buy' ? 'text-up' : lastTakerSide === 'sell' ? 'text-down' : 'text-text'}`}
        >
          {lastPrice != null ? fmtPriceShort(lastPrice, prec, 9) : '—'}
        </span>
        {bids[0] && asks[0] && (
          <span className="text-[10px] text-muted">스프레드 {fmtPriceShort(Math.max(0, asks[0].price - bids[0].price), groupPrec, 9)}</span>
        )}
      </div>
      <div className="overflow-hidden" style={hgt(bidRows)}>
        {bids.map((b) => row(b, 'bid'))}
      </div>
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-1.5">
      {/* 좌: 매수(bid) — 최우선호가(가격 가장 높음)가 맨 위 */}
      <div className="overflow-hidden" style={hgt(hRows)}>
        {bids.map((b) => row(b, 'bid'))}
      </div>
      {/* 우: 매도(ask) — 최우선호가(가격 가장 낮음)가 맨 위 */}
      <div className="overflow-hidden" style={hgt(hRows)}>
        {asks.map((a) => row(a, 'ask'))}
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
                    : `최근 ${STRENGTH_WINDOW}건 중앙값 ${fmtPriceShort(t.ref, prec, 9)} 대비 ${
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
              {/* 호가창 단위 버튼(수량 ⇄ 총금액)을 체결에도 똑같이 따른다 — 툴팁엔 반대쪽 값 */}
              <span
                className={`truncate text-right ${color}`}
                title={
                  bookUnit === 'qty'
                    ? `거래대금 ${fmtUsd(t.price * t.qty)} ${quote}`
                    : `수량 ${fmtQty(t.qty)} ${baseOf(symbol)}`
                }
              >
                {bookUnit === 'qty' ? fmtQty(t.qty) : fmtVal(t.price * t.qty)}
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
          {bookTools}
        </div>
        {bookBody}
        <div className="mb-1 mt-1.5 flex items-center gap-1 border-t border-border pt-1.5">
          {sectionTitle('체결')}
          <div className="ml-auto flex min-w-0 max-w-[70%] items-center">{filterBadge}</div>
        </div>
        {tradesBody}
      </div>
    );

  return (
    <div className="border-b border-border bg-panel p-1.5 text-[11px] md:border-b-0 md:border-t">
      <div className="mb-1 flex items-center gap-1">
        {tabBtn('book', '호가')}
        {tabBtn('trades', '체결')}
        {tab === 'book' ? (
          bookTools
        ) : (
          // 체결 탭에서도 단위를 바꿀 수 있게(호가와 같은 값을 공유한다)
          <div className="ml-auto flex min-w-0 max-w-[80%] items-center gap-0.5">
            {filterBadge}
            {unitBtn}
          </div>
        )}
      </div>

      {tab === 'book' ? bookBody : tradesBody}
    </div>
  );
}
