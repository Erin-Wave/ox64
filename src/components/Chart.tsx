import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type WhitespaceData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fetchKlines, fetchPricePrecision } from '@/services/binanceRest';
import { klineStream } from '@/services/binanceWs';
import type { Series } from '@/services/indicators';
import {
  INDICATOR_DEFS,
  OVERLAY_TYPES,
  OSCILLATOR_TYPES,
  indicatorTitle,
  type IndicatorFormat,
  type IndicatorType,
  type LineStyleName,
} from '@/services/indicatorDefs';
import { api } from '@/services/api';
import { useMarketStore } from '@/store/useMarketStore';
import { useChartStore, type IndicatorConfig, type ChartColorScheme } from '@/store/useChartStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { INTERVAL_GROUPS, intervalSec, KST_OFFSET, isVirtualSymbol } from '@/symbols';
import { fmtPrice, fmtPriceShort, fmtQtyShort, virtualPrecision } from '@/format';
import Clock from '@/components/Clock';
import type { Candle } from '@/types';

const IND_COLORS = ['#f0b90b', '#4a90e2', '#c77dff', '#00c076', '#ff6b6b', '#3bb2d0', '#e08fd6'];

// 차트 캔버스 색(배경/격자/축 텍스트/캔들) — UI 크롬은 index.css 의 CSS 변수로,
// Lightweight Charts 는 캔버스 렌더링이라 여기서 별도로 applyOptions() 해줘야 함.
// 라이트/고대비는 사이트 테마 고정 배색, 다크일 때만 거래소 프리셋(바이낸스/OKX/트레이딩뷰)으로 세분화.
type ChartColors = { bg: string; text: string; grid: string; border: string; up: string; down: string };
const LIGHT_THEME: ChartColors = { bg: '#ffffff', text: '#6b727a', grid: '#e7e9ec', border: '#d6dadf', up: '#00875c', down: '#d1293f' };
const HIGH_CONTRAST_THEME: ChartColors = { bg: '#000000', text: '#c8c8c8', grid: '#333333', border: '#ffffff', up: '#00ff80', down: '#ff1744' };
const DARK_SCHEMES: Record<ChartColorScheme, ChartColors> = {
  binance: { bg: '#0b0d0f', text: '#7c828b', grid: '#191c21', border: '#282c33', up: '#0ecb81', down: '#f6465d' },
  okx: { bg: '#14151a', text: '#76808f', grid: '#1d1f26', border: '#2f333d', up: '#00b897', down: '#ff5b5b' },
  tradingview: { bg: '#131722', text: '#787b86', grid: '#1e222d', border: '#2a2e39', up: '#26a69a', down: '#ef5350' },
};
function chartColors(theme: 'dark' | 'light' | 'high-contrast', colorScheme: ChartColorScheme): ChartColors {
  if (theme === 'light') return LIGHT_THEME;
  if (theme === 'high-contrast') return HIGH_CONTRAST_THEME;
  return DARK_SCHEMES[colorScheme];
}

// ⚠ 거래량 막대 색은 **반드시 캔들 색에서 파생**시킨다. 예전엔 `rgba(0,192,118,0.45)` 처럼 하드코딩해서
// 테마/프리셋을 바꿔도 거래량만 바이낸스 배색으로 남아 캔들과 따로 놀았다(라이트 테마에선 특히 튐).
// 색을 새로 쓰지 말고 항상 이 함수를 거칠 것.
const VOL_ALPHA = 0.45;
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const v = parseInt(n, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}
function volColors(c: ChartColors): { up: string; down: string } {
  return { up: withAlpha(c.up, VOL_ALPHA), down: withAlpha(c.down, VOL_ALPHA) };
}

type IndSeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
/** 인디케이터 인스턴스 하나 = 선 키 → 시리즈 (indicatorDefs 의 lines 와 1:1) */
type IndSeriesMap = Map<string, IndSeries>;
/** 레전드 값: 선 키 → 그 시점 값 */
type IndLegendValue = Record<string, number>;

const toChart = (t: number) => (t + KST_OFFSET) as UTCTimestamp;
const fmtKst = (realSec: number, withSeconds = false) => {
  const d = new Date((realSec + KST_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(d.getUTCSeconds())}` : base;
};
// ⚠ null 은 건너뛰지 않고 whitespace(`{time}` 만)로 넣는다 — **그 자리에서 선이 끊겨야** 하는 지표가 있다
// (SuperTrend 국면 전환, Ichimoku 후행스팬 끝, 워밍업). 건너뛰면 LWC 가 앞뒤 점을 이어 있지도 않은 선을 그린다.
const line = (arr: Series, times: number[]): (LineData | WhitespaceData)[] =>
  arr.map((v, i) => (v == null ? { time: toChart(times[i]) } : { time: toChart(times[i]), value: v }));
const histData = (arr: Series, times: number[], up: string, down: string): (HistogramData | WhitespaceData)[] =>
  arr.map((v, i) => (v == null ? { time: toChart(times[i]) } : { time: toChart(times[i]), value: v, color: v >= 0 ? up : down }));
/** 선 길이가 봉 수를 넘으면(Ichimoku 선행스팬 = n+kijun) 마지막 봉 뒤로 인터벌만큼 시간을 늘려 붙인다. */
const extendTimes = (times: number[], extra: number, stepSec: number): number[] => {
  const out = times.slice();
  let last = times.length ? times[times.length - 1] : 0;
  for (let i = 0; i < extra; i++) out.push((last += stepSec));
  return out;
};
const LWC_STYLE: Record<LineStyleName, LineStyle> = { solid: LineStyle.Solid, dotted: LineStyle.Dotted, dashed: LineStyle.Dashed };
const fmtIndValue = (fmt: IndicatorFormat, v: number, prec: number): string =>
  fmt === 'price' ? fmtPriceShort(v, prec, 9) : fmt === 'fixed1' ? v.toFixed(1) : fmt === 'fixed2' ? v.toFixed(2) : fmtQtyShort(v, 9);

/** 인디케이터 표시/숨김 아이콘(눈 / 빗금 친 눈). 이모지는 폰트에 따라 깨져서 인라인 SVG 로. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

export default function Chart() {
  const symbol = useMarketStore((s) => s.symbol);
  const interval = useMarketStore((s) => s.interval);
  const setIntervalCode = useMarketStore((s) => s.setInterval);
  const setPrice = useMarketStore((s) => s.setPrice);
  const setPrecision = useMarketStore((s) => s.setPrecision);
  const setConnected = useMarketStore((s) => s.setConnected);

  const opts = useChartStore();
  const theme = useSettingsStore((s) => s.theme);
  const orders = useTradingStore((s) => s.orders);
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);
  const conditionalOrders = useTradingStore((s) => s.conditionalOrders);
  const cancelLimit = useTradingStore((s) => s.cancelLimit);
  const cancelConditional = useTradingStore((s) => s.cancelConditional);
  const balance = useTradingStore((s) => s.balance);
  const prices = useMarketStore((s) => s.prices);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const indSeriesRef = useRef<Map<string, IndSeriesMap>>(new Map());
  // syncIndicators() 가 candlesRef 와 나란한 인덱스로 채워두는 원본 계산값(선 키별) —
  // 크로스헤어가 벗어났을 때(마지막 값) 또는 hover 시점 조회에 사용.
  const indValuesRef = useRef<Map<string, Record<string, Series>>>(new Map());
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const volMap = useRef<Map<number, number>>(new Map());
  const priceLines = useRef<IPriceLine[]>([]);
  const hovering = useRef(false);
  const lastCalc = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const syncIndicatorsRef = useRef<() => void>(() => {});

  const [legend, setLegend] = useState<Candle | null>(null);
  const [indLegend, setIndLegend] = useState<Record<string, IndLegendValue>>({});
  const [countdown, setCountdown] = useState('');
  // 카운트다운 위치 — 트레이딩뷰처럼 우측 가격축의 현재가 티커(마지막 봉 종가 라벨) 바로 아래에 붙인다.
  // top=현재가 y좌표, width=가격축 너비, up=마지막 봉 방향(색상). 가격/스케일 변화마다 갱신.
  const [countdownPos, setCountdownPos] = useState<{ top: number; width: number; up: boolean } | null>(null);
  const countdownPosRef = useRef<{ top: number; width: number; up: boolean } | null>(null);
  const repositionCountdownRef = useRef<() => void>(() => {});

  // 미체결(지정가)·조건부 주문선 옆의 취소(X) 버튼 위치 — 각 주문 가격의 y좌표에 얹는다(카운트다운과 동일 패턴).
  // conditional=true 면 조건부(스탑) 주문(취소는 cancelConditional 로 라우팅, 앰버색으로 구분).
  type PendBtn = { id: string; top: number; axisW: number; sell: boolean; reduceOnly: boolean; conditional: boolean; label: string };
  const [pendBtns, setPendBtns] = useState<PendBtn[]>([]);
  const pendBtnsRef = useRef<PendBtn[]>([]);
  const repositionPendBtnsRef = useRef<() => void>(() => {});
  const [showOpts, setShowOpts] = useState(false);
  const [prec, setPrec] = useState(2); // 현재 심볼 가격 소수 자릿수
  const precRef = useRef(prec);
  precRef.current = prec;

  // 크로스헤어가 벗어나 있을 때(또는 최초) 보여줄 "마지막 봉" 기준 지표값.
  // indValuesRef 는 그냥 ref 라 여기서 최신값을 읽어도 클로저 staleness 문제가 없다.
  const lastIndLegend = (): Record<string, IndLegendValue> => {
    const out: Record<string, IndLegendValue> = {};
    const n = candlesRef.current.length;
    if (n === 0) return out;
    for (const [id, vals] of indValuesRef.current) {
      const rec: IndLegendValue = {};
      let any = false;
      for (const [key, arr] of Object.entries(vals)) {
        // 선행스팬처럼 봉 수보다 긴 선도 "현재 봉" 자리(n-1)의 값을 보여준다
        const v = arr[n - 1];
        if (v != null) {
          rec[key] = v;
          any = true;
        }
      }
      if (any) out[id] = rec;
    }
    return out;
  };

  // 카운트다운을 현재가(마지막 봉 종가) 라벨의 y좌표 바로 아래로 옮긴다(우측 가격축 위, 트레이딩뷰식).
  // 가격/스케일이 바뀔 때마다(WS 틱·폴링·팬/줌·1초 틱·크로스헤어) 호출한다 — refs 만 읽어 stale 문제 없음.
  // 미체결 주문선의 취소(X) 버튼을 각 지정가 y좌표에 재배치한다. 카운트다운과 같은 트리거(팬/줌·틱·1초)
  // 에서 함께 불리도록 repositionCountdown 안에서 호출한다. opts.pendingLine 이 꺼져 있으면 안 그린다.
  const repositionPendBtns = () => {
    const chart = chartRef.current;
    const c = candleRef.current;
    const clear = () => {
      if (pendBtnsRef.current.length) {
        pendBtnsRef.current = [];
        setPendBtns([]);
      }
    };
    if (!chart || !c || !optsRef.current.pendingLine) return clear();
    const axisW = chart.priceScale('right').width();
    const next: PendBtn[] = [];
    for (const o of pendingOrders) {
      if (o.symbol !== symbol) continue;
      const y = c.priceToCoordinate(o.limitPrice);
      if (y == null) continue;
      next.push({
        id: o.id,
        top: y as number,
        axisW,
        sell: o.side === 'short',
        reduceOnly: o.reduceOnly,
        conditional: false,
        label: `${o.reduceOnly ? '청산 ' : ''}${o.side === 'long' ? '매수' : '매도'} ${fmtQtyShort(o.size, 9)}`,
      });
    }
    for (const c2 of conditionalOrders) {
      if (c2.symbol !== symbol) continue;
      const y = c.priceToCoordinate(c2.triggerPrice);
      if (y == null) continue;
      next.push({
        id: c2.id,
        top: y as number,
        axisW,
        sell: c2.side === 'short',
        reduceOnly: false,
        conditional: true,
        label: `조건부${c2.repeating ? '∞' : ''} ${c2.side === 'long' ? '롱' : '숏'} ${
          c2.triggerDir === 'above' ? '≥' : '≤'
        } ${fmtQtyShort(c2.size, 9)}${c2.repeating && c2.repeatMode === 'rearm' && !c2.armed ? ' (재무장 대기)' : ''}`,
      });
    }
    const prev = pendBtnsRef.current;
    // 개수·위치(±1px)·라벨이 그대로면 리렌더 생략
    const same =
      prev.length === next.length &&
      prev.every((p, i) => p.id === next[i].id && Math.abs(p.top - next[i].top) < 1 && p.axisW === next[i].axisW && p.label === next[i].label);
    if (same) return;
    pendBtnsRef.current = next;
    setPendBtns(next);
  };
  repositionPendBtnsRef.current = repositionPendBtns;

  const repositionCountdown = () => {
    repositionPendBtnsRef.current(); // 미체결 취소버튼도 같은 트리거에서 함께 재배치
    const chart = chartRef.current;
    const c = candleRef.current;
    const last = candlesRef.current.at(-1);
    const clear = () => {
      if (countdownPosRef.current) {
        countdownPosRef.current = null;
        setCountdownPos(null);
      }
    };
    if (!chart || !c || !last) return clear();
    const y = c.priceToCoordinate(last.close);
    if (y == null) return clear();
    const next = { top: y as number, width: chart.priceScale('right').width(), up: last.close >= last.open };
    const prev = countdownPosRef.current;
    // 1px 미만 이동·같은 너비/색이면 리렌더 생략(WS 틱이 초당 여러 번 와도 낭비 방지)
    if (prev && Math.abs(prev.top - next.top) < 1 && prev.width === next.width && prev.up === next.up) return;
    countdownPosRef.current = next;
    setCountdownPos(next);
  };
  repositionCountdownRef.current = repositionCountdown;

  // ── 차트 생성 (1회) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const initTheme = chartColors(useSettingsStore.getState().theme, useChartStore.getState().colorScheme);
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: initTheme.bg },
        textColor: initTheme.text,
        fontFamily: 'Proxima Nova, sans-serif',
      },
      grid: { vertLines: { color: initTheme.grid }, horzLines: { color: initTheme.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: initTheme.border },
      timeScale: { borderColor: initTheme.border, timeVisible: true, secondsVisible: false },
      // 하단 크로스헤어 시간 라벨 = yyyy-MM-dd HH:mm:ss (KST, 이미 오프셋된 값이라 UTC 로 포맷)
      localization: {
        timeFormatter: (t: unknown) => {
          const d = new Date((t as number) * 1000);
          const p = (n: number) => String(n).padStart(2, '0');
          return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
        },
      },
      autoSize: true,
    });
    const candle = chart.addCandlestickSeries({
      upColor: initTheme.up,
      downColor: initTheme.down,
      borderVisible: false,
      wickUpColor: initTheme.up,
      wickDownColor: initTheme.down,
    });
    chartRef.current = chart;
    candleRef.current = candle;

    chart.subscribeCrosshairMove((param) => {
      repositionCountdownRef.current(); // 마우스 이동(팬/줌 포함) 시 축 라벨 따라 위치 갱신
      const c = candleRef.current;
      if (!c || param.time == null) {
        hovering.current = false;
        const l = candlesRef.current.at(-1);
        if (l) setLegend(l);
        setIndLegend(lastIndLegend());
        return;
      }
      const d = param.seriesData.get(c) as CandlestickData | undefined;
      if (!d) return;
      hovering.current = true;
      const real = (param.time as number) - KST_OFFSET;
      setLegend({ time: real, open: d.open, high: d.high, low: d.low, close: d.close, volume: volMap.current.get(real) });

      // 인디케이터 값 — 각 시리즈에 그 시점 데이터가 있으면 param.seriesData 에서 바로 조회.
      // whitespace 점(값 없음 = 선이 끊긴 자리)은 건너뛴다.
      const nextInd: Record<string, IndLegendValue> = {};
      for (const [id, m] of indSeriesRef.current) {
        const rec: IndLegendValue = {};
        let any = false;
        for (const [key, s] of m) {
          const v = param.seriesData.get(s) as { value?: number } | undefined;
          if (v && typeof v.value === 'number') {
            rec[key] = v.value;
            any = true;
          }
        }
        if (any) nextInd[id] = rec;
      }
      setIndLegend(nextInd);
    });

    // 차트 클릭 → 클릭한 y좌표의 가격을 지정가 주문 입력에 흘려보낸다(OrderPanel 이 구독).
    chart.subscribeClick((param) => {
      const c = candleRef.current;
      if (!c || !param.point) return;
      const raw = c.coordinateToPrice(param.point.y);
      if (raw == null) return;
      useMarketStore.getState().setChartClickPrice(Number(raw.toFixed(precRef.current)));
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      indSeriesRef.current.clear();
      volRef.current = null;
    };
  }, []);

  // ── 테마/차트 색상 프리셋 변경 시 차트 캔버스(배경/격자/축/캔들) 재도색 ──────────
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;
    const c = chartColors(theme, opts.colorScheme);
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    candle.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    // ⚠ 거래량 막대는 색이 각 데이터 포인트에 박혀 있어서 applyOptions 로는 안 바뀐다 — 테마가 바뀌면
    // 전체를 새 색으로 다시 그려야 캔들과 싱크가 유지된다(안 하면 테마 전환 직후 거래량만 옛 색).
    syncIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, opts.colorScheme]);

  // ── 초봉(1s) 등 1분 미만 타임프레임에서는 축/레전드에 초 단위까지 표시 ──
  const subMinute = intervalSec(interval) < 60;
  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: subMinute } });
  }, [subMinute]);

  // ── 인디케이터 동기화 (candlesRef 기준 재계산) ────────────────
  // opts 를 직접 클로징하지 않고 optsRef 로 항상 최신 값을 읽는다.
  // (WS 구독 이펙트처럼 symbol/interval 변경시에만 재생성되는 이펙트 안에서
  //  옵션 토글 직후 옛 클로저가 다시 실행되며 방금 켠 지표를 지워버리는 버그 방지)
  const syncIndicators = () => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || candles.length === 0) return;
    const o = optsRef.current;
    const times = candles.map((c) => c.time);

    // 더 이상 존재하지 않는 인디케이터 인스턴스의 시리즈 제거
    const activeIds = new Set(o.indicators.map((i) => i.id));
    for (const [id, m] of indSeriesRef.current) {
      if (activeIds.has(id)) continue;
      for (const s of m.values()) chart.removeSeries(s);
      indSeriesRef.current.delete(id);
      indValuesRef.current.delete(id);
    }

    // 레지스트리(indicatorDefs) 기반 — 여기엔 지표 타입 분기가 없다. 선 하나 = 시리즈 하나,
    // own 패널 지표는 priceScaleId = 지표 id 로 자기 축을 갖는다(아래 스택 배치).
    const themeColors = chartColors(useSettingsStore.getState().theme, o.colorScheme);
    const histUp = withAlpha(themeColors.up, 0.6);
    const histDown = withAlpha(themeColors.down, 0.6);
    const stepSec = intervalSec(interval);
    o.indicators.forEach((ind: IndicatorConfig, idx: number) => {
      const def = INDICATOR_DEFS[ind.type];
      const base = IND_COLORS[idx % IND_COLORS.length];
      let found = indSeriesRef.current.get(ind.id);
      if (!found) {
        found = new Map<string, IndSeries>();
        indSeriesRef.current.set(ind.id, found);
      }
      const series = found;
      const scaleId = def.pane === 'own' ? ind.id : 'right';
      const vals = def.compute(candles, ind.params);
      indValuesRef.current.set(ind.id, vals);
      def.lines.forEach((ln, li) => {
        const color = ln.color ?? base;
        let s = series.get(ln.key);
        if (!s) {
          if (ln.kind === 'hist') {
            s = chart.addHistogramSeries({ priceScaleId: scaleId, base: 0, priceLineVisible: false, lastValueVisible: false });
          } else {
            s = chart.addLineSeries({
              color,
              lineWidth: ln.width ?? 1,
              lineStyle: LWC_STYLE[ln.style ?? 'solid'],
              priceScaleId: scaleId,
              priceLineVisible: false,
              lastValueVisible: false,
              // 점 표시(Parabolic SAR): 선은 숨기고 점만 찍는다
              ...(ln.kind === 'dots' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, crosshairMarkerVisible: false } : {}),
            });
          }
          if (li === 0 && def.levels) {
            for (const lv of def.levels) {
              s.createPriceLine({ price: lv.value, color: lv.color ?? '#88888855', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
            }
          }
          series.set(ln.key, s);
        }
        const arr = vals[ln.key] ?? [];
        const t = arr.length > times.length ? extendTimes(times, arr.length - times.length, stepSec) : times;
        if (ln.kind === 'hist') {
          (s as ISeriesApi<'Histogram'>).setData(histData(arr, t, histUp, histDown));
        } else {
          (s as ISeriesApi<'Line'>).setData(line(arr, t));
          // 앞의 지표가 지워지면 배정색(idx)이 바뀌므로 매번 맞춘다 — 레전드 점 색과 어긋나지 않게
          (s as ISeriesApi<'Line'>).applyOptions({ color });
        }
        // 숨김 ≠ 삭제. 시리즈·설정은 그대로 두고 visible 만 끈다(다시 켤 때 재생성 비용 0).
        s.applyOptions({ visible: ind.visible });
      });
    });

    // 거래량 히스토그램 — 최하단
    if (o.volume) {
      if (!volRef.current) {
        // lastValueVisible=true → 우측 축에 최신 거래량 티커(1.23M 형식) 표시
        volRef.current = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: true });
      }
      const vc = volColors(chartColors(useSettingsStore.getState().theme, o.colorScheme));
      volRef.current.setData(
        candles.map((c) => ({
          time: toChart(c.time),
          value: c.volume ?? 0,
          color: c.close >= c.open ? vc.up : vc.down,
        })) as HistogramData[],
      );
    } else if (volRef.current) {
      chart.removeSeries(volRef.current);
      volRef.current = null;
    }

    // 하단 영역 스택 배치: [캔들] / [own 패널 지표들 — 보이는 것만] / [거래량]. 패널이 늘면 높이를 나눠 쓴다
    // (숨긴 지표는 자리를 차지하지 않는다).
    const panes = o.indicators.filter((i) => i.visible && INDICATOR_DEFS[i.type].pane === 'own');
    const volH = o.volume ? 0.15 : 0;
    const paneH = panes.length ? Math.min(0.16, 0.55 / panes.length) : 0;
    const total = volH + paneH * panes.length;
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: Math.max(0.04, total + 0.02) } });
    panes.forEach((ind, i) => {
      chart.priceScale(ind.id).applyOptions({
        scaleMargins: { top: 1 - volH - (panes.length - i) * paneH, bottom: volH + (panes.length - i - 1) * paneH },
      });
    });
    if (o.volume) chart.priceScale('vol').applyOptions({ scaleMargins: { top: 1 - volH, bottom: 0 } });
  };
  syncIndicatorsRef.current = syncIndicators;

  // ── 데이터 로드 + WS 구독 (symbol/interval 변경 시) ───────────
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    let cancelled = false;
    candlesRef.current = [];
    volMap.current.clear();

    // ── 가상 코인(OX/USDT): 바이낸스 REST/WS 대신 spot_trades 기반 캔들을 짧은 폴링으로 ──
    if (isVirtualSymbol(symbol)) {
      // ⚠ 가상 코인은 소수 자릿수가 고정이 아니다 — 호가 단위가 **유효숫자 4자리**라 가격대에 따라
      // 10배씩 바뀐다(1.057→3자리, 0.002434→6자리, 123.4→1자리). 캔들이 올 때마다 최신가 기준으로
      // 다시 적용한다(예전엔 4자리 하드코딩이라 가격대가 바뀌면 축·크로스헤어가 실제 틱과 어긋났다).
      let curPrec = -1;
      const applyPrec = (price: number) => {
        const p = virtualPrecision(price);
        if (p === curPrec) return;
        curPrec = p;
        setPrec(p);
        setPrecision(symbol, p);
        candle.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: Math.pow(10, -p) } });
      };

      let isFirstLoad = true;
      let loadingMore = false;
      let noMore = false;
      // ⚠ **캔들은 이 컴포넌트가 직접 폴링하지 않는다**(2026-08-14, 무료 플랜 전환). 예전엔 1초마다
      // 500봉을 통째로 다시 받았고(하루 1,050만 행 읽기), 그걸 증분으로 줄인 뒤에도 호가 폴링과 **따로**
      // 요청을 보내 OX 화면 1인이 시간당 8,640요청이었다 — 무료 플랜(하루 10만 요청)의 실질 천장이
      // 그것이었다. 지금은 통합 폴링(useSpotPoll → useTradingStore.spotTick)이 호가·체결·캔들을 한
      // 요청으로 받아 스토어에 넣고, 여기선 **그 변화를 구독만** 한다. 몇 봉을 받을지도 스토어가 정한다.
      // 과거봉 추가 로드(loadOlder)만은 사용자가 스크롤할 때만 도는 별개 요청이라 그대로 둔다.
      const FULL_BARS = 500;
      // 이보다 오래 새 봉이 안 들어오면 "끊김"으로 본다(통합 폴링 1초 주기 기준 넉넉하게).
      const STALE_MS = 8000;

      const draw = (arr: Candle[]) => {
        candle.setData(
          arr.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
        );
        syncIndicatorsRef.current();
      };

      /** 통합 폴링이 새로 받아온 봉들을 화면에 반영한다(예전 load() 의 응답 처리 부분 그대로). */
      const onCandles = (fresh: Candle[]) => {
        if (cancelled || fresh.length === 0) return;
        // ⚠ 받아온 걸로 배열을 통째로 갈아끼우면 왼쪽 스크롤로 붙여둔 과거봉이 매번 날아간다
        // (매 폴링마다 리셋되니 사실상 과거 조회 불가) → 최신 구간만 교체하고 그보다 앞선 구간은 보존.
        // ⚠ 단 받아온 폭이 상한(FULL_BARS)에 닿았다는 건 그만큼 오래 쉬었거나 처음이라는 뜻이라,
        // 기존 구간과 사이에 구멍이 있을 수 있다 → 그땐 이어붙이지 말고 통째로 갈아끼운다.
        const prev = fresh.length >= FULL_BARS ? [] : candlesRef.current;
        const cut = fresh[0].time;
        const merged = prev.length ? [...prev.filter((c) => c.time < cut), ...fresh] : fresh;
        candlesRef.current = merged;
        for (const c of fresh) volMap.current.set(c.time, c.volume ?? 0);
        draw(merged);
        // 최초 1회만 표시 범위를 잡는다 — 매 폴링마다 다시 잡으면 사용자가 확대/축소한 뷰가 계속
        // 리셋되는 버그가 있었음(실제 심볼은 초기 로드 1번 + WS 업데이트뿐이라 이 문제가 없음).
        if (isFirstLoad) {
          isFirstLoad = false;
          const len = merged.length;
          const initBars = optsRef.current.visibleBars;
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - initBars), to: len + 2 });
        }
        const l = merged.at(-1);
        setConnected(true);
        if (l) {
          applyPrec(l.close);
          setPrice(symbol, l.close);
          if (!hovering.current) setLegend(l);
        }
        if (!hovering.current) setIndLegend(lastIndLegend());
        repositionCountdownRef.current();
      };

      // ── 과거봉 추가 로드 (왼쪽 스크롤) ── 실제 심볼과 동일한 동작. 예전엔 이 분기가 여기서
      // 곧장 return 해버려서 OX 만 과거 조회가 통째로 없었다(맨 왼쪽까지 가도 아무 일도 안 일어남).
      const loadOlder = async () => {
        if (loadingMore || noMore || cancelled) return;
        if (candlesRef.current.length === 0) return;
        loadingMore = true;
        try {
          const oldest = candlesRef.current[0].time; // sec
          const { candles: older } = await api.spotCandles(symbol, interval, 500, oldest * 1000);
          if (cancelled) return;
          // await 사이에 폴링이 배열을 갱신했을 수 있으므로 최신 상태를 다시 읽는다.
          const cur = candlesRef.current;
          const fresh = older.filter((c) => c.time < cur[0].time);
          if (fresh.length === 0) {
            noMore = true;
            return;
          }
          const ts = chartRef.current?.timeScale();
          const before = ts?.getVisibleLogicalRange();
          candlesRef.current = [...fresh, ...cur];
          for (const c of fresh) volMap.current.set(c.time, c.volume ?? 0);
          draw(candlesRef.current);
          // 프리펜드로 인덱스가 fresh.length 만큼 밀리므로 보이던 구간 그대로 유지
          if (before && ts) ts.setVisibleLogicalRange({ from: before.from + fresh.length, to: before.to + fresh.length });
          if (fresh.length < 450) noMore = true; // 과거 데이터 끝 근처
        } catch {
          /* 다음 스크롤 때 재시도 */
        } finally {
          loadingMore = false;
        }
      };

      let lastBarsSaveV = 0;
      const onRangeV = (range: { from: number; to: number } | null) => {
        repositionCountdownRef.current();
        if (range && range.from < 10) loadOlder();
        if (range) {
          const now = Date.now();
          if (now - lastBarsSaveV > 500) {
            lastBarsSaveV = now;
            const bars = Math.round(range.to - range.from) - 2; // 초기 범위의 +2 여유분 제외
            if (bars > 1) useChartStore.getState().setVisibleBars(bars);
          }
        }
      };
      const tsApiV = chartRef.current?.timeScale();
      tsApiV?.subscribeVisibleLogicalRangeChange(onRangeV);

      // 통합 폴링(useSpotPoll)이 스토어에 새 봉을 넣을 때마다 반영한다. 폴링 주기·탭 숨김 정지·요청
      // 폭은 전부 그쪽이 관리하므로 여기엔 타이머가 없다. 마운트 시점에 이미 값이 있으면 즉시 한 번 그린다.
      let lastAt = 0;
      const myKey = `${symbol}|${interval}`;
      const pump = (candles: Candle[], at: number, key: string) => {
        // ⚠ 키 대조 필수 — 이게 없으면 인터벌을 바꾼 직후 **이전 인터벌의 봉**이 한 번 그려진다.
        if (at === 0 || at === lastAt || key !== myKey) return;
        lastAt = at;
        onCandles(candles);
      };
      const s0 = useTradingStore.getState();
      pump(s0.spotCandles, s0.spotCandlesAt, s0.spotCandlesKey);
      const unsub = useTradingStore.subscribe((st) => pump(st.spotCandles, st.spotCandlesAt, st.spotCandlesKey));
      // ⚠ 연결 표시는 **신선도로** 판정한다 — 예전엔 이 컴포넌트가 직접 fetch 해서 그 catch 로 껐는데,
      // 지금은 통합 폴링이 스토어에서 조용히 재시도하므로 실패가 여기까지 안 온다. 그대로 두면 서버가
      // 죽어도 초록불이 켜져 있다. 요청을 새로 만들지 않고 "마지막 갱신이 얼마나 됐나"만 본다.
      const staleTimer = window.setInterval(() => {
        const at = useTradingStore.getState().spotCandlesAt;
        if (at > 0 && Date.now() - at > STALE_MS) setConnected(false);
      }, 2000);
      return () => {
        cancelled = true;
        window.clearInterval(staleTimer);
        unsub();
        tsApiV?.unsubscribeVisibleLogicalRangeChange(onRangeV);
        setConnected(false);
      };
    }

    // 심볼별 가격 정밀도 적용(우측 축·크로스헤어·레전드) — 소수점 2자리 고정 버그 수정
    fetchPricePrecision(symbol)
      .then(({ precision, minMove }) => {
        if (cancelled) return;
        setPrec(precision);
        setPrecision(symbol, precision);
        candle.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
      })
      .catch(() => {});

    (async () => {
      try {
        const candles = await fetchKlines(symbol, interval, 500);
        if (cancelled) return;
        candlesRef.current = candles;
        for (const c of candles) volMap.current.set(c.time, c.volume ?? 0);
        candle.setData(
          candles.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
        );
        // 기본 표시 봉수 = 사용자가 마지막으로 확대/축소한 값(localStorage, 없으면 ~38봉).
        // 이후 왼쪽으로 당기면 과거봉 추가 로드.
        const len = candles.length;
        const initBars = optsRef.current.visibleBars;
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - initBars), to: len + 2 });
        syncIndicatorsRef.current();
        const l = candles.at(-1);
        if (l && !hovering.current) setLegend(l);
        if (!hovering.current) setIndLegend(lastIndLegend());
        repositionCountdownRef.current();
      } catch (e) {
        console.error('[chart] load failed', e);
      }
    })();

    // ── 과거봉 추가 로드 (왼쪽 스크롤) ──────────────────────────
    let loadingMore = false;
    let noMore = false;
    const loadOlder = async () => {
      const chart = chartRef.current;
      const arr = candlesRef.current;
      if (loadingMore || noMore || !chart || arr.length === 0) return;
      loadingMore = true;
      try {
        const oldest = arr[0].time; // sec
        const older = await fetchKlines(symbol, interval, 500, oldest * 1000 - 1);
        if (cancelled) return;
        const fresh = older.filter((c) => c.time < oldest);
        if (fresh.length === 0) {
          noMore = true;
          return;
        }
        const ts = chart.timeScale();
        const before = ts.getVisibleLogicalRange();
        candlesRef.current = [...fresh, ...arr];
        for (const c of fresh) volMap.current.set(c.time, c.volume ?? 0);
        candle.setData(
          candlesRef.current.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
        );
        syncIndicatorsRef.current();
        // 프리펜드로 인덱스가 fresh.length 만큼 밀리므로 보이던 구간 그대로 유지
        if (before) ts.setVisibleLogicalRange({ from: before.from + fresh.length, to: before.to + fresh.length });
        if (fresh.length < 450) noMore = true; // 더 받을 게 거의 없음(과거 데이터 끝 근처)
      } catch {
        /* 다음 시도 때 재시도 */
      } finally {
        loadingMore = false;
      }
    };
    let lastBarsSave = 0;
    const onRange = (range: { from: number; to: number } | null) => {
      repositionCountdownRef.current(); // 가로 팬/줌으로 가격축 스케일이 바뀌면 카운트다운 위치도 갱신
      if (range && range.from < 10) loadOlder();
      // 사용자가 확대/축소한 봉 개수를 기억해뒀다가 다음 접속 때 기본값으로 사용(과도한 쓰기 방지로 스로틀).
      if (range) {
        const now = Date.now();
        if (now - lastBarsSave > 500) {
          lastBarsSave = now;
          // 초기 로드가 {from: len-N, to: len+2} 로 2봉만큼 여유를 두고 범위를 잡으므로
          // (아래 참고) 저장할 땐 그 여유분을 빼야 다음 로드 때 N 그대로 복원된다.
          // 이걸 안 빼면 로드→저장→로드 때마다 매번 +2씩 불어나는 버그가 있었음.
          const bars = Math.round(range.to - range.from) - 2;
          if (bars > 1) useChartStore.getState().setVisibleBars(bars);
        }
      }
    };
    const tsApi = chartRef.current?.timeScale();
    tsApi?.subscribeVisibleLogicalRangeChange(onRange);

    const sub = klineStream(symbol, interval).subscribe({
      next: (tick) => {
        setConnected(true);
        // ⚠ 실제 코인의 mark(현재가/PnL 기준)는 바이낸스 WS 가 아니라 OKX(useMarkPrices)로 온다 —
        // 서버 체결가가 OKX 라 여기서 바이낸스 close 로 덮어쓰면 진입 즉시 손익/평단이 튄다(§ useMarkPrices).
        // 캔들 자체는 바이낸스 그대로 그린다(아래). setPrice 는 하지 않는다.
        const bar = tick.candle;
        candle.update({ time: toChart(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        const vc = volColors(chartColors(useSettingsStore.getState().theme, optsRef.current.colorScheme));
        volRef.current?.update({
          time: toChart(bar.time),
          value: bar.volume ?? 0,
          color: bar.close >= bar.open ? vc.up : vc.down,
        } as HistogramData);
        volMap.current.set(bar.time, bar.volume ?? 0);
        const arr = candlesRef.current;
        if (arr.length && arr[arr.length - 1].time === bar.time) arr[arr.length - 1] = bar;
        else arr.push(bar);
        if (!hovering.current) setLegend(bar);
        repositionCountdownRef.current(); // 현재가 이동 → 카운트다운도 축 티커 따라 이동
        const now = Date.now();
        if (now - lastCalc.current > 700) {
          lastCalc.current = now;
          syncIndicatorsRef.current();
          if (!hovering.current) setIndLegend(lastIndLegend());
        }
      },
      error: () => setConnected(false),
    });

    return () => {
      cancelled = true;
      sub.unsubscribe();
      tsApi?.unsubscribeVisibleLogicalRangeChange(onRange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  // 인디케이터 추가/삭제/설정 변경, 거래량 토글 시 즉시 반영
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    syncIndicators();
    if (!hovering.current) setIndLegend(lastIndLegend());
  }, [opts.indicators, opts.volume]);

  // ── 매매 마커 (B/S) ──────────────────────────────────────────
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    if (!opts.tradeMarkers) { c.setMarkers([]); return; }
    const markers: SeriesMarker<Time>[] = orders
      .filter((o) => o.symbol === symbol)
      .map((o) => {
        const long = o.side === 'long';
        const liquidation = o.kind === 'liquidation';
        return {
          time: toChart(Math.floor(o.createdAt / 1000)) as Time,
          position: (long ? 'belowBar' : 'aboveBar') as SeriesMarker<Time>['position'],
          color: liquidation ? '#ff9800' : long ? '#00c076' : '#f6465d',
          shape: (long ? 'arrowUp' : 'arrowDown') as SeriesMarker<Time>['shape'],
          text: liquidation ? 'L' : o.kind === 'close' ? 'C' : long ? 'B' : 'S',
        };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
    c.setMarkers(markers);
  }, [orders, symbol, opts.tradeMarkers]);

  // ── 포지션 평단 / SL·TP 수평선 ───────────────────────────────
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    for (const pl of priceLines.current) c.removePriceLine(pl);
    priceLines.current = [];
    const mine = positions.filter((p) => p.symbol === symbol);

    if (opts.positionLine && mine.length > 0) {
      const totSize = mine.reduce((a, p) => a + p.size, 0);
      const avg = mine.reduce((a, p) => a + p.entryPrice * p.size, 0) / totSize;
      const side = mine[0].side;
      priceLines.current.push(
        c.createPriceLine({
          price: avg,
          color: side === 'long' ? '#00c076' : '#f6465d',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '평단',
        }),
      );

      // 청산가(추정) 수평선 — PositionsPanel 과 동일 산식(평가자산=잔고+전 포지션 미실현손익 이 0 되는 가격).
      // 다른 포지션들의 미실현손익이 필요하므로 전 심볼 가격이 있어야 계산 가능(없으면 생략).
      const unrealizedOf = (p: (typeof positions)[number]) => {
        const lv = prices[p.symbol];
        if (lv == null) return null;
        const d = p.side === 'long' ? 1 : -1;
        return (lv - p.entryPrice) * p.size * d;
      };
      if (positions.every((p) => unrealizedOf(p) != null)) {
        const totalU = positions.reduce((a, p) => a + (unrealizedOf(p) ?? 0), 0);
        // 평가자산 = 여유잔고 + Σ(잠긴 증거금 + 미실현손익). PositionsPanel/서버와 동일한 산식(증거금 항 포함).
        const totalMargin = positions.reduce((a, p) => a + (p.entryPrice * p.size) / p.leverage, 0);
        for (const p of mine) {
          const others = totalU - (unrealizedOf(p) ?? 0);
          const d = p.side === 'long' ? 1 : -1;
          const liq = p.entryPrice - (balance + totalMargin + others) / (p.size * d);
          if (liq > 0) {
            priceLines.current.push(
              c.createPriceLine({
                price: liq,
                color: '#ff9800',
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: '청산',
              }),
            );
          }
        }
      }
    }

    if (opts.slTpLines) {
      // 포지션이 여러 개면 각각의 SL/TP 를 전부 그린다(중복 값이면 겹쳐 보임).
      for (const p of mine) {
        if (p.stopLoss != null) {
          priceLines.current.push(
            c.createPriceLine({
              price: p.stopLoss,
              color: '#f6465d',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: 'SL',
            }),
          );
        }
        if (p.takeProfit != null) {
          priceLines.current.push(
            c.createPriceLine({
              price: p.takeProfit,
              color: '#00c076',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: 'TP',
            }),
          );
        }
      }
    }

    // ── 걸어둔 지정가(미체결) 수평선 + 수량 ──
    if (opts.pendingLine) {
      for (const p of pendingOrders.filter((o) => o.symbol === symbol)) {
        priceLines.current.push(
          c.createPriceLine({
            price: p.limitPrice,
            color: p.side === 'long' ? '#00c076' : '#f6465d',
            lineWidth: 1,
            lineStyle: LineStyle.LargeDashed,
            axisLabelVisible: true,
            title: `${p.reduceOnly ? '청산 ' : ''}${p.side === 'long' ? '매수' : '매도'} ${fmtQtyShort(p.size, 9)}`,
          }),
        );
      }
      // ── 조건부(스탑) 주문 수평선 — 트리거 가격에. 지정가/SL·TP(녹/적)와 구분되게 앰버색·점선. ──
      for (const cd of conditionalOrders.filter((o) => o.symbol === symbol)) {
        priceLines.current.push(
          c.createPriceLine({
            price: cd.triggerPrice,
            color: '#f0b90b',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `조건부${cd.repeating ? '∞' : ''} ${cd.side === 'long' ? '롱' : '숏'} ${
              cd.triggerDir === 'above' ? '≥' : '≤'
            } ${fmtQtyShort(cd.size, 9)}`,
          }),
        );
        // 재무장 대기 중이면 "여기까지 돌아오면 다시 무장" 지점도 흐린 점선으로 보여준다
        // (트리거선만 있으면 왜 지금은 안 걸리는지 화면에서 알 수 없다). 재무장가=트리거가면 생략.
        if (cd.repeating && cd.repeatMode === 'rearm' && !cd.armed && cd.rearmPrice != null && cd.rearmPrice !== cd.triggerPrice) {
          priceLines.current.push(
            c.createPriceLine({
              price: cd.rearmPrice,
              color: '#f0b90b80',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: `재무장 ${cd.triggerDir === 'above' ? '≤' : '≥'}`,
            }),
          );
        }
      }
    }
    repositionPendBtnsRef.current(); // 주문선이 바뀌면 취소(X) 버튼 위치도 즉시 갱신
  }, [positions, pendingOrders, conditionalOrders, prices, balance, symbol, opts.positionLine, opts.slTpLines, opts.pendingLine]);

  // ── 다음 봉 카운트다운 ───────────────────────────────────────
  useEffect(() => {
    if (!opts.showCountdown) { setCountdown(''); return; }
    const sec = intervalSec(interval);
    const tick = () => {
      const now = Date.now() / 1000;
      const remain = Math.max(0, Math.ceil(sec - (now % sec)));
      const h = Math.floor(remain / 3600);
      const m = Math.floor((remain % 3600) / 60);
      const s = Math.floor(remain % 60);
      const p = (n: number) => String(n).padStart(2, '0');
      setCountdown(h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`);
      repositionCountdownRef.current(); // 축 드래그/리사이즈 등 이벤트 없는 변화도 1초마다 보정
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [interval, opts.showCountdown]);

  const up = legend ? legend.close >= legend.open : true;
  // 종가 옆 변동률 = 그 봉의 (종가-시가)/시가 (레전드 상하 색과 동일 기준). hover 시 그 봉, 아니면 마지막 봉.
  const chgPct = legend && legend.open ? ((legend.close - legend.open) / legend.open) * 100 : null;

  return (
    <div className="flex h-full flex-col">
      {/* 툴바 */}
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1.5">
        <select
          value={interval}
          onChange={(e) => setIntervalCode(e.target.value)}
          className="cursor-pointer rounded bg-panel2 px-2 py-1 text-xs font-semibold text-text outline-none ring-1 ring-border"
        >
          {INTERVAL_GROUPS.map((g) => (
            <optgroup key={g.name} label={g.name}>
              {g.items.map((it) => (
                <option key={it.code} value={it.code}>
                  {it.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <div className="relative">
          <button
            onClick={() => setShowOpts((v) => !v)}
            className="rounded bg-panel2 px-2 py-1 text-xs text-text ring-1 ring-border transition hover:bg-elevated"
          >
            지표 · 옵션 ▾
          </button>
          {showOpts && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowOpts(false)} />
              <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-panel p-1.5 shadow-2xl">
                {(
                  [
                    ['volume', '거래량'],
                    ['showCountdown', '다음 봉 카운트다운'],
                    ['tradeMarkers', '내 매매 표시 (B/S)'],
                    ['positionLine', '포지션 평단선'],
                    ['slTpLines', 'SL/TP 수평선'],
                    ['pendingLine', '지정가 주문선 (수량)'],
                    ['orderBook', '호가창'],
                  ] as const
                ).map(([k, label]) => (
                  <label
                    key={k}
                    className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs text-text hover:bg-panel2"
                  >
                    {label}
                    <input type="checkbox" checked={opts[k]} onChange={() => opts.toggle(k)} className="accent-up" />
                  </label>
                ))}

                <div className="my-1 border-t border-border" />
                <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted">인디케이터</div>

                {opts.indicators.length === 0 && (
                  <div className="px-2 py-1.5 text-[11px] text-muted">추가된 인디케이터 없음</div>
                )}
                {opts.indicators.map((ind, idx) => {
                  const def = INDICATOR_DEFS[ind.type];
                  return (
                    <div
                      key={ind.id}
                      className={`flex items-center gap-1 rounded px-2 py-1 text-xs text-text hover:bg-panel2 ${ind.visible ? '' : 'opacity-50'}`}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: IND_COLORS[idx % IND_COLORS.length] }} />
                      <span className="w-[4.6rem] shrink-0 truncate" title={`${def.name}${def.pane === 'own' ? ' · 별도 패널' : ''}`}>
                        {def.label}
                      </span>
                      <span className="flex flex-1 items-center justify-end gap-1">
                        {def.params.map((p) => (
                          <input
                            key={p.key}
                            type="number"
                            min={p.min}
                            max={p.max}
                            step={p.step ?? 1}
                            value={ind.params[p.key] ?? p.def}
                            onChange={(e) => opts.updateIndicator(ind.id, { [p.key]: Number(e.target.value) })}
                            className="w-12 rounded bg-panel2 px-1 py-0.5 text-right text-xs text-text outline-none ring-1 ring-border"
                            title={p.label}
                          />
                        ))}
                      </span>
                      {/* 숨김/표시 — 삭제와 별개. 설정을 지우지 않고 잠시 끈다(시리즈 visible 만 토글) */}
                      <button
                        onClick={() => opts.toggleIndicator(ind.id)}
                        className={`shrink-0 rounded p-0.5 hover:bg-elevated ${ind.visible ? 'text-text' : 'text-muted'}`}
                        title={ind.visible ? '숨기기' : '보이기'}
                        aria-pressed={ind.visible}
                      >
                        <EyeIcon off={!ind.visible} />
                      </button>
                      <button
                        onClick={() => opts.removeIndicator(ind.id)}
                        className="shrink-0 rounded px-1 text-muted hover:bg-elevated hover:text-down"
                        title="삭제"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}

                {/* 추가 — 오버레이(캔들 위) / 오실레이터(별도 패널) 그룹. 값은 항상 '' 로 되돌려 같은 지표를 또 고를 수 있게 */}
                <select
                  value=""
                  onChange={(e) => {
                    const t = e.target.value as IndicatorType | '';
                    if (t) opts.addIndicator(t);
                  }}
                  className="mt-1 w-full cursor-pointer rounded bg-panel2 px-2 py-1 text-[11px] font-semibold text-text outline-none ring-1 ring-border"
                >
                  <option value="">+ 인디케이터 추가…</option>
                  <optgroup label="오버레이 (캔들 위)">
                    {OVERLAY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {INDICATOR_DEFS[t].label} — {INDICATOR_DEFS[t].name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="오실레이터 (별도 패널)">
                    {OSCILLATOR_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {INDICATOR_DEFS[t].label} — {INDICATOR_DEFS[t].name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
            </>
          )}
        </div>

        {/* 실시간 시계(KST) — 우측 구석 */}
        <Clock className="ml-auto text-xs font-semibold text-muted" />
      </div>

      {/* 차트 영역 */}
      <div className="relative flex-1">
        {/* OHLCV 레전드 */}
        {legend && (
          <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
            <span className="font-semibold text-text">{symbol.replace('USDT', '')}</span>
            <span className="text-muted">{fmtKst(legend.time, subMinute)}</span>
            {/* 레전드도 축약 — 좁은 한 줄에 OHLCV + 인디케이터가 다 들어가서 한 값만 길어도 줄이 깨진다 */}
            <span className="text-muted">시 <span className={up ? 'text-up' : 'text-down'}>{fmtPriceShort(legend.open, prec, 9)}</span></span>
            <span className="text-muted">고 <span className={up ? 'text-up' : 'text-down'}>{fmtPriceShort(legend.high, prec, 9)}</span></span>
            <span className="text-muted">저 <span className={up ? 'text-up' : 'text-down'}>{fmtPriceShort(legend.low, prec, 9)}</span></span>
            <span className="text-muted">
              종{' '}
              <span className={up ? 'text-up' : 'text-down'}>
                {fmtPrice(legend.close, prec)}
                {chgPct != null && ` (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)`}
              </span>
            </span>
            <span className="text-muted">거래량 <span className="text-text">{fmtQtyShort(legend.volume, 9)}</span></span>
            {opts.indicators.map((ind, idx) => {
              if (!ind.visible) return null;
              const val = indLegend[ind.id];
              if (!val) return null;
              const def = INDICATOR_DEFS[ind.type];
              const parts: string[] = [];
              for (const ln of def.lines) {
                const v = val[ln.key];
                if (v == null) continue;
                const txt = fmtIndValue(def.format, v, prec);
                parts.push(ln.label ? `${ln.label} ${txt}` : txt);
              }
              if (parts.length === 0) return null;
              return (
                <span key={ind.id} style={{ color: IND_COLORS[idx % IND_COLORS.length] }}>
                  {indicatorTitle(ind.type, ind.params)} {parts.join(' ')}
                </span>
              );
            })}
          </div>
        )}
        {/* 다음 봉 카운트다운 — 트레이딩뷰처럼 우측 가격축의 현재가 티커(마지막 봉 종가 라벨) 바로 아래 */}
        {opts.showCountdown && countdown && countdownPos && (
          <div
            className="pointer-events-none absolute z-10 flex justify-center"
            style={{ top: countdownPos.top + 9, right: 0, width: countdownPos.width }}
          >
            <span
              className={`rounded-sm bg-elevated px-1 py-px text-[10px] font-semibold tabular-nums ring-1 ring-border ${
                countdownPos.up ? 'text-up' : 'text-down'
              }`}
            >
              {countdown}
            </span>
          </div>
        )}
        {/* 미체결 지정가·조건부 주문선 옆 취소(X) 버튼 — 각 주문 가격의 y좌표, 우측 가격축 바로 왼쪽에 얹는다. */}
        {opts.pendingLine &&
          pendBtns.map((b) => (
            <button
              key={b.id}
              onClick={() => (b.conditional ? cancelConditional(b.id) : cancelLimit(b.id))}
              title={`${b.label} — 클릭하면 취소`}
              style={{ top: b.top - 8, right: b.axisW + 3 }}
              className={`pointer-events-auto absolute z-20 flex h-4 w-4 items-center justify-center rounded-sm text-[11px] font-bold leading-none ring-1 transition ${
                b.conditional
                  ? 'bg-[#f0b90b]/15 text-[#f0b90b] ring-[#f0b90b]/40 hover:bg-[#f0b90b] hover:text-black'
                  : b.sell
                    ? 'bg-downDim text-down ring-down/40 hover:bg-down hover:text-white'
                    : 'bg-upDim text-up ring-up/40 hover:bg-up hover:text-white'
              }`}
            >
              ×
            </button>
          ))}
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
