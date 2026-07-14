import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fetchKlines } from '@/services/binanceRest';
import { klineStream } from '@/services/binanceWs';
import { useMarketStore } from '@/store/useMarketStore';

/**
 * TradingView Lightweight Charts (Canvas, 60fps).
 * - 초기: REST 로 과거 500봉 로드.
 * - 실시간: websocket kline 틱마다 series.update() 로 마지막 봉만 갱신.
 */
export default function Chart() {
  const symbol = useMarketStore((s) => s.symbol);
  const interval = useMarketStore((s) => s.interval);
  const setLastPrice = useMarketStore((s) => s.setLastPrice);
  const setConnected = useMarketStore((s) => s.setConnected);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // 차트 인스턴스 생성 (마운트 1회)
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0b0d0f' },
        textColor: '#7c828b',
        fontFamily: 'Proxima Nova, sans-serif',
      },
      grid: {
        vertLines: { color: '#191c21' },
        horzLines: { color: '#191c21' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#282c33' },
      timeScale: { borderColor: '#282c33', timeVisible: true, secondsVisible: false },
      autoSize: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: '#00c076',
      downColor: '#f6465d',
      borderVisible: false,
      wickUpColor: '#00c076',
      wickDownColor: '#f6465d',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // 심볼/인터벌 변경 시 데이터 (재)로드 + 실시간 구독
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    let cancelled = false;

    (async () => {
      try {
        const candles = await fetchKlines(symbol, interval, 500);
        if (cancelled) return;
        series.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })) satisfies CandlestickData[],
        );
        chartRef.current?.timeScale().fitContent();
      } catch (e) {
        console.error('[chart] initial load failed', e);
      }
    })();

    const sub = klineStream(symbol, interval).subscribe({
      next: (tick) => {
        setConnected(true);
        setLastPrice(tick.candle.close);
        series.update({
          time: tick.candle.time as UTCTimestamp,
          open: tick.candle.open,
          high: tick.candle.high,
          low: tick.candle.low,
          close: tick.candle.close,
        });
      },
      error: () => setConnected(false),
    });

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [symbol, interval, setLastPrice, setConnected]);

  return <div ref={containerRef} className="h-full w-full" />;
}
