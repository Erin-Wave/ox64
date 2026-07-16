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
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fetchKlines, fetchPricePrecision } from '@/services/binanceRest';
import { klineStream } from '@/services/binanceWs';
import { ema, bollinger, rsi } from '@/services/indicators';
import { api } from '@/services/api';
import { useMarketStore } from '@/store/useMarketStore';
import { useChartStore, type IndicatorConfig, type IndicatorType } from '@/store/useChartStore';
import { useSettingsStore, type Theme } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { INTERVAL_GROUPS, intervalSec, KST_OFFSET, isVirtualSymbol } from '@/symbols';
import { fmtPrice, fmtVol } from '@/format';
import type { Candle } from '@/types';

const IND_LABEL: Record<IndicatorType, string> = { ema: 'EMA', bb: 'Bollinger', rsi: 'RSI' };
const IND_COLORS = ['#f0b90b', '#4a90e2', '#c77dff', '#00c076', '#ff6b6b', '#3bb2d0', '#e08fd6'];

// 테마별 차트 캔버스 색(배경/격자/축 텍스트/캔들) — UI 크롬은 index.css 의 CSS 변수로,
// Lightweight Charts 는 캔버스 렌더링이라 여기서 별도로 applyOptions() 해줘야 함.
const CHART_THEME: Record<Theme, { bg: string; text: string; grid: string; border: string; up: string; down: string }> = {
  dark: { bg: '#0b0d0f', text: '#7c828b', grid: '#191c21', border: '#282c33', up: '#00c076', down: '#f6465d' },
  light: { bg: '#ffffff', text: '#6b727a', grid: '#e7e9ec', border: '#d6dadf', up: '#00875c', down: '#d1293f' },
  'high-contrast': { bg: '#000000', text: '#c8c8c8', grid: '#333333', border: '#ffffff', up: '#00ff80', down: '#ff1744' },
};

type BbSeries = { upper: ISeriesApi<'Line'>; basis: ISeriesApi<'Line'>; lower: ISeriesApi<'Line'> };
type BbValues = { upper: number; basis: number; lower: number };
type IndLegendValue = number | BbValues;

const toChart = (t: number) => (t + KST_OFFSET) as UTCTimestamp;
const fmtKst = (realSec: number, withSeconds = false) => {
  const d = new Date((realSec + KST_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(d.getUTCSeconds())}` : base;
};
const line = (arr: (number | null)[], times: number[]): LineData[] => {
  const out: LineData[] = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] != null) out.push({ time: toChart(times[i]), value: arr[i]! });
  return out;
};

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

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const indSeriesRef = useRef<Map<string, ISeriesApi<'Line'> | BbSeries>>(new Map());
  // syncIndicators() 가 candlesRef 와 나란한 인덱스로 채워두는 원본 계산값 —
  // 크로스헤어가 벗어났을 때(마지막 값) 또는 hover 시점 조회에 사용.
  const indValuesRef = useRef<
    Map<string, (number | null)[] | { upper: (number | null)[]; basis: (number | null)[]; lower: (number | null)[] }>
  >(new Map());
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
  const [showOpts, setShowOpts] = useState(false);
  const [prec, setPrec] = useState(2); // 현재 심볼 가격 소수 자릿수
  const precRef = useRef(prec);
  precRef.current = prec;

  // 크로스헤어가 벗어나 있을 때(또는 최초) 보여줄 "마지막 봉" 기준 지표값.
  // indValuesRef 는 그냥 ref 라 여기서 최신값을 읽어도 클로저 staleness 문제가 없다.
  const lastIndLegend = (): Record<string, IndLegendValue> => {
    const out: Record<string, IndLegendValue> = {};
    for (const [id, arr] of indValuesRef.current) {
      if (Array.isArray(arr)) {
        const v = arr.at(-1);
        if (v != null) out[id] = v;
      } else {
        const u = arr.upper.at(-1);
        const b = arr.basis.at(-1);
        const l = arr.lower.at(-1);
        if (u != null && b != null && l != null) out[id] = { upper: u, basis: b, lower: l };
      }
    }
    return out;
  };

  // ── 차트 생성 (1회) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const initTheme = CHART_THEME[useSettingsStore.getState().theme];
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
      const nextInd: Record<string, IndLegendValue> = {};
      for (const [id, s] of indSeriesRef.current) {
        if ('upper' in s) {
          const u = param.seriesData.get(s.upper) as LineData | undefined;
          const b = param.seriesData.get(s.basis) as LineData | undefined;
          const lo = param.seriesData.get(s.lower) as LineData | undefined;
          if (u && b && lo) nextInd[id] = { upper: u.value, basis: b.value, lower: lo.value };
        } else {
          const v = param.seriesData.get(s) as LineData | undefined;
          if (v) nextInd[id] = v.value;
        }
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

  // ── 테마 변경 시 차트 캔버스(배경/격자/축/캔들) 재도색 ──────────
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;
    const c = CHART_THEME[theme];
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    candle.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
  }, [theme]);

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
    const closes = candles.map((c) => c.close);
    const times = candles.map((c) => c.time);

    // 더 이상 존재하지 않는 인디케이터 인스턴스의 시리즈 제거
    const activeIds = new Set(o.indicators.map((i) => i.id));
    for (const [id, ref] of indSeriesRef.current) {
      if (activeIds.has(id)) continue;
      if ('upper' in ref) {
        chart.removeSeries(ref.upper);
        chart.removeSeries(ref.basis);
        chart.removeSeries(ref.lower);
      } else {
        chart.removeSeries(ref);
      }
      indSeriesRef.current.delete(id);
      indValuesRef.current.delete(id);
    }

    o.indicators.forEach((ind: IndicatorConfig, idx: number) => {
      const color = IND_COLORS[idx % IND_COLORS.length];
      if (ind.type === 'ema') {
        let s = indSeriesRef.current.get(ind.id) as ISeriesApi<'Line'> | undefined;
        if (!s) {
          s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
          indSeriesRef.current.set(ind.id, s);
        }
        const vals = ema(closes, ind.period);
        s.setData(line(vals, times));
        indValuesRef.current.set(ind.id, vals);
      } else if (ind.type === 'bb') {
        let s = indSeriesRef.current.get(ind.id) as BbSeries | undefined;
        if (!s) {
          s = {
            upper: chart.addLineSeries({ color, lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }),
            basis: chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
            lower: chart.addLineSeries({ color, lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }),
          };
          indSeriesRef.current.set(ind.id, s);
        }
        const bands = bollinger(closes, ind.period, ind.mult ?? 2);
        s.upper.setData(line(bands.upper, times));
        s.basis.setData(line(bands.basis, times));
        s.lower.setData(line(bands.lower, times));
        indValuesRef.current.set(ind.id, bands);
      } else if (ind.type === 'rsi') {
        let s = indSeriesRef.current.get(ind.id) as ISeriesApi<'Line'> | undefined;
        if (!s) {
          s = chart.addLineSeries({ color, lineWidth: 1, priceScaleId: 'rsi', priceLineVisible: false, lastValueVisible: false });
          s.createPriceLine({ price: 70, color: '#f6465d40', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
          s.createPriceLine({ price: 30, color: '#00c07640', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
          indSeriesRef.current.set(ind.id, s);
        }
        const vals = rsi(closes, ind.period);
        s.setData(line(vals, times));
        indValuesRef.current.set(ind.id, vals);
      }
    });

    // 거래량 히스토그램 — 최하단
    if (o.volume) {
      if (!volRef.current) {
        // lastValueVisible=true → 우측 축에 최신 거래량 티커(1.23M 형식) 표시
        volRef.current = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: true });
      }
      volRef.current.setData(
        candles.map((c) => ({
          time: toChart(c.time),
          value: c.volume ?? 0,
          color: c.close >= c.open ? 'rgba(0,192,118,0.45)' : 'rgba(246,70,93,0.45)',
        })) as HistogramData[],
      );
    } else if (volRef.current) {
      chart.removeSeries(volRef.current);
      volRef.current = null;
    }

    // 하단 영역 스택 배치: [캔들] / [RSI] / [거래량]
    const hasRsi = o.indicators.some((i) => i.type === 'rsi');
    const volH = o.volume ? 0.15 : 0;
    const rsiH = hasRsi ? 0.16 : 0;
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: Math.max(0.04, volH + rsiH + 0.02) } });
    if (hasRsi) chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 1 - volH - rsiH, bottom: volH } });
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
      const VIRTUAL_PREC = 4;
      setPrec(VIRTUAL_PREC);
      setPrecision(symbol, VIRTUAL_PREC);
      candle.applyOptions({ priceFormat: { type: 'price', precision: VIRTUAL_PREC, minMove: Math.pow(10, -VIRTUAL_PREC) } });

      const load = async () => {
        try {
          const { candles } = await api.spotCandles(interval, 500);
          if (cancelled) return;
          candlesRef.current = candles;
          for (const c of candles) volMap.current.set(c.time, c.volume ?? 0);
          candle.setData(
            candles.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
          );
          if (candles.length) {
            const len = candles.length;
            const initBars = optsRef.current.visibleBars;
            chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - initBars), to: len + 2 });
          }
          syncIndicatorsRef.current();
          const l = candles.at(-1);
          setConnected(true);
          if (l) {
            setPrice(symbol, l.close);
            if (!hovering.current) setLegend(l);
          }
          if (!hovering.current) setIndLegend(lastIndLegend());
        } catch (e) {
          console.error('[chart] spot candle load failed', e);
          setConnected(false);
        }
      };
      load();
      const t = window.setInterval(load, 3000);
      return () => {
        cancelled = true;
        window.clearInterval(t);
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
        setPrice(symbol, tick.candle.close);
        const bar = tick.candle;
        candle.update({ time: toChart(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        volRef.current?.update({
          time: toChart(bar.time),
          value: bar.volume ?? 0,
          color: bar.close >= bar.open ? 'rgba(0,192,118,0.45)' : 'rgba(246,70,93,0.45)',
        } as HistogramData);
        volMap.current.set(bar.time, bar.volume ?? 0);
        const arr = candlesRef.current;
        if (arr.length && arr[arr.length - 1].time === bar.time) arr[arr.length - 1] = bar;
        else arr.push(bar);
        if (!hovering.current) setLegend(bar);
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
    if (mine.length === 0) return;

    if (opts.positionLine) {
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
  }, [positions, symbol, opts.positionLine, opts.slTpLines]);

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
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [interval, opts.showCountdown]);

  const up = legend ? legend.close >= legend.open : true;

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
              <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-panel p-1.5 shadow-2xl">
                {(
                  [
                    ['volume', '거래량'],
                    ['showCountdown', '다음 봉 카운트다운'],
                    ['tradeMarkers', '내 매매 표시 (B/S)'],
                    ['positionLine', '포지션 평단선'],
                    ['slTpLines', 'SL/TP 수평선'],
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
                {opts.indicators.map((ind, idx) => (
                  <div key={ind.id} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-text hover:bg-panel2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: IND_COLORS[idx % IND_COLORS.length] }}
                    />
                    <span className="w-16 shrink-0">{IND_LABEL[ind.type]}</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={ind.period}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(500, Number(e.target.value) || 1));
                        opts.updateIndicator(ind.id, { period: v });
                      }}
                      className="w-14 rounded bg-panel2 px-1 py-0.5 text-right text-xs text-text outline-none ring-1 ring-border"
                    />
                    {ind.type === 'bb' && (
                      <input
                        type="number"
                        min={0.5}
                        max={5}
                        step={0.5}
                        value={ind.mult ?? 2}
                        onChange={(e) => {
                          const v = Math.max(0.5, Math.min(5, Number(e.target.value) || 2));
                          opts.updateIndicator(ind.id, { mult: v });
                        }}
                        className="w-12 rounded bg-panel2 px-1 py-0.5 text-right text-xs text-text outline-none ring-1 ring-border"
                        title="표준편차 배수"
                      />
                    )}
                    <button
                      onClick={() => opts.removeIndicator(ind.id)}
                      className="ml-auto shrink-0 rounded px-1.5 text-muted hover:bg-elevated hover:text-down"
                      title="삭제"
                    >
                      ✕
                    </button>
                  </div>
                ))}

                <div className="mt-1 flex gap-1 px-1">
                  {(['ema', 'bb', 'rsi'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => opts.addIndicator(t)}
                      className="flex-1 rounded bg-panel2 px-1.5 py-1 text-[11px] font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
                    >
                      + {IND_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 차트 영역 */}
      <div className="relative flex-1">
        {/* OHLCV 레전드 */}
        {legend && (
          <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
            <span className="font-semibold text-text">{symbol.replace('USDT', '')}</span>
            <span className="text-muted">{fmtKst(legend.time, subMinute)}</span>
            <span className="text-muted">시 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.open, prec)}</span></span>
            <span className="text-muted">고 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.high, prec)}</span></span>
            <span className="text-muted">저 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.low, prec)}</span></span>
            <span className="text-muted">종 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.close, prec)}</span></span>
            <span className="text-muted">거래량 <span className="text-text">{fmtVol(legend.volume)}</span></span>
            {opts.indicators.map((ind, idx) => {
              const val = indLegend[ind.id];
              if (val == null) return null;
              const color = IND_COLORS[idx % IND_COLORS.length];
              return (
                <span key={ind.id} style={{ color }}>
                  {IND_LABEL[ind.type]}({ind.period})
                  {typeof val === 'number' ? (
                    <> {ind.type === 'rsi' ? val.toFixed(1) : fmtPrice(val, prec)}</>
                  ) : (
                    <>
                      {' '}
                      U {fmtPrice(val.upper, prec)} B {fmtPrice(val.basis, prec)} L {fmtPrice(val.lower, prec)}
                    </>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {/* 카운트다운 */}
        {opts.showCountdown && countdown && (
          <div className="pointer-events-none absolute right-2 top-1.5 z-10 rounded bg-panel2/80 px-2 py-0.5 text-[11px] font-semibold text-accent">
            {countdown}
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
