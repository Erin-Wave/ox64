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
import { useMarketStore } from '@/store/useMarketStore';
import { useChartStore } from '@/store/useChartStore';
import { useTradingStore } from '@/store/useTradingStore';
import { INTERVAL_GROUPS, intervalSec, KST_OFFSET } from '@/symbols';
import { fmtPrice, fmtVol } from '@/format';
import type { Candle } from '@/types';

const toChart = (t: number) => (t + KST_OFFSET) as UTCTimestamp;
const fmtKst = (realSec: number) => {
  const d = new Date((realSec + KST_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
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
  const orders = useTradingStore((s) => s.orders);
  const positions = useTradingStore((s) => s.positions);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbU = useRef<ISeriesApi<'Line'> | null>(null);
  const bbB = useRef<ISeriesApi<'Line'> | null>(null);
  const bbL = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const volMap = useRef<Map<number, number>>(new Map());
  const priceLines = useRef<IPriceLine[]>([]);
  const hovering = useRef(false);
  const lastCalc = useRef(0);

  const [legend, setLegend] = useState<Candle | null>(null);
  const [countdown, setCountdown] = useState('');
  const [showOpts, setShowOpts] = useState(false);
  const [prec, setPrec] = useState(2); // 현재 심볼 가격 소수 자릿수

  // ── 차트 생성 (1회) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0b0d0f' },
        textColor: '#7c828b',
        fontFamily: 'Proxima Nova, sans-serif',
      },
      grid: { vertLines: { color: '#191c21' }, horzLines: { color: '#191c21' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#282c33' },
      timeScale: { borderColor: '#282c33', timeVisible: true, secondsVisible: false },
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
      upColor: '#00c076',
      downColor: '#f6465d',
      borderVisible: false,
      wickUpColor: '#00c076',
      wickDownColor: '#f6465d',
    });
    chartRef.current = chart;
    candleRef.current = candle;

    chart.subscribeCrosshairMove((param) => {
      const c = candleRef.current;
      if (!c || param.time == null) {
        hovering.current = false;
        const l = candlesRef.current.at(-1);
        if (l) setLegend(l);
        return;
      }
      const d = param.seriesData.get(c) as CandlestickData | undefined;
      if (!d) return;
      hovering.current = true;
      const real = (param.time as number) - KST_OFFSET;
      setLegend({ time: real, open: d.open, high: d.high, low: d.low, close: d.close, volume: volMap.current.get(real) });
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRef.current = bbU.current = bbB.current = bbL.current = rsiRef.current = null;
      volRef.current = null;
    };
  }, []);

  // ── 인디케이터 동기화 (candlesRef 기준 재계산) ────────────────
  const syncIndicators = () => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || candles.length === 0) return;
    const closes = candles.map((c) => c.close);
    const times = candles.map((c) => c.time);

    // EMA(20)
    if (opts.ema) {
      if (!emaRef.current) emaRef.current = chart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      emaRef.current.setData(line(ema(closes, 20), times));
    } else if (emaRef.current) {
      chart.removeSeries(emaRef.current);
      emaRef.current = null;
    }

    // Bollinger(20,2)
    if (opts.bb) {
      const bands = bollinger(closes, 20, 2);
      if (!bbU.current) bbU.current = chart.addLineSeries({ color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
      if (!bbB.current) bbB.current = chart.addLineSeries({ color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      if (!bbL.current) bbL.current = chart.addLineSeries({ color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
      bbU.current.setData(line(bands.upper, times));
      bbB.current.setData(line(bands.basis, times));
      bbL.current.setData(line(bands.lower, times));
    } else {
      for (const r of [bbU, bbB, bbL]) if (r.current) { chart.removeSeries(r.current); r.current = null; }
    }

    // 거래량 히스토그램 — 최하단
    if (opts.volume) {
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

    // RSI(14) — 별도 스케일
    if (opts.rsi) {
      if (!rsiRef.current) {
        rsiRef.current = chart.addLineSeries({ color: '#c77dff', lineWidth: 1, priceScaleId: 'rsi', priceLineVisible: false, lastValueVisible: false });
        rsiRef.current.createPriceLine({ price: 70, color: '#f6465d40', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
        rsiRef.current.createPriceLine({ price: 30, color: '#00c07640', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      }
      rsiRef.current.setData(line(rsi(closes, 14), times));
    } else if (rsiRef.current) {
      chart.removeSeries(rsiRef.current);
      rsiRef.current = null;
    }

    // 하단 영역 스택 배치: [캔들] / [RSI] / [거래량]
    const volH = opts.volume ? 0.15 : 0;
    const rsiH = opts.rsi ? 0.16 : 0;
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: Math.max(0.04, volH + rsiH + 0.02) } });
    if (opts.rsi) chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 1 - volH - rsiH, bottom: volH } });
    if (opts.volume) chart.priceScale('vol').applyOptions({ scaleMargins: { top: 1 - volH, bottom: 0 } });
  };

  // ── 데이터 로드 + WS 구독 (symbol/interval 변경 시) ───────────
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    let cancelled = false;
    candlesRef.current = [];
    volMap.current.clear();

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
        // 기본 표시 = 최근 ~38봉 (모바일 가독성). 이후 왼쪽으로 당기면 과거봉 추가 로드.
        const len = candles.length;
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 38), to: len + 2 });
        syncIndicators();
        const l = candles.at(-1);
        if (l && !hovering.current) setLegend(l);
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
        syncIndicators();
        // 프리펜드로 인덱스가 fresh.length 만큼 밀리므로 보이던 구간 그대로 유지
        if (before) ts.setVisibleLogicalRange({ from: before.from + fresh.length, to: before.to + fresh.length });
        if (fresh.length < 450) noMore = true; // 더 받을 게 거의 없음(과거 데이터 끝 근처)
      } catch {
        /* 다음 시도 때 재시도 */
      } finally {
        loadingMore = false;
      }
    };
    const onRange = (range: { from: number; to: number } | null) => {
      if (range && range.from < 10) loadOlder();
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
          syncIndicators();
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

  // 인디케이터 토글 변경 시 즉시 반영
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { syncIndicators(); }, [opts.ema, opts.bb, opts.rsi, opts.volume]);

  // ── 매매 마커 (B/S) ──────────────────────────────────────────
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    if (!opts.tradeMarkers) { c.setMarkers([]); return; }
    const markers: SeriesMarker<Time>[] = orders
      .filter((o) => o.symbol === symbol)
      .map((o) => {
        const long = o.side === 'long';
        return {
          time: toChart(Math.floor(o.createdAt / 1000)) as Time,
          position: (long ? 'belowBar' : 'aboveBar') as SeriesMarker<Time>['position'],
          color: long ? '#00c076' : '#f6465d',
          shape: (long ? 'arrowUp' : 'arrowDown') as SeriesMarker<Time>['shape'],
          text: o.kind === 'close' ? 'C' : long ? 'B' : 'S',
        };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
    c.setMarkers(markers);
  }, [orders, symbol, opts.tradeMarkers]);

  // ── 포지션 평단 수평선 ───────────────────────────────────────
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    for (const pl of priceLines.current) c.removePriceLine(pl);
    priceLines.current = [];
    if (!opts.positionLine) return;
    const mine = positions.filter((p) => p.symbol === symbol);
    if (mine.length === 0) return;
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
  }, [positions, symbol, opts.positionLine]);

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
              <div className="absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-border bg-panel p-1.5 shadow-2xl">
                {(
                  [
                    ['volume', '거래량'],
                    ['ema', 'EMA (20)'],
                    ['bb', 'Bollinger (20,2)'],
                    ['rsi', 'RSI (14)'],
                    ['showCountdown', '다음 봉 카운트다운'],
                    ['tradeMarkers', '내 매매 표시 (B/S)'],
                    ['positionLine', '포지션 평단선'],
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
            <span className="text-muted">{fmtKst(legend.time)}</span>
            <span className="text-muted">시 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.open, prec)}</span></span>
            <span className="text-muted">고 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.high, prec)}</span></span>
            <span className="text-muted">저 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.low, prec)}</span></span>
            <span className="text-muted">종 <span className={up ? 'text-up' : 'text-down'}>{fmtPrice(legend.close, prec)}</span></span>
            <span className="text-muted">거래량 <span className="text-text">{fmtVol(legend.volume)}</span></span>
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
