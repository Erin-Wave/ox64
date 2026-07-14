import type { Candle } from '@/types';
import { precisionFromTick } from '@/format';

// 바이낸스 스팟 REST. 선물(fapi) 스트리밍이 일부 지역/IP 에서 차단되는 반면
// 스팟은 어디서나 접근 가능하고 주요 종목 가격이 사실상 동일 → 스팟으로 통일.
const SPOT_API = 'https://api.binance.com';

/** 심볼별 가격 정밀도(소수 자릿수)와 최소단위 — exchangeInfo PRICE_FILTER.tickSize 기반. */
export async function fetchPricePrecision(symbol: string): Promise<{ precision: number; minMove: number }> {
  const res = await fetch(`${SPOT_API}/api/v3/exchangeInfo?symbol=${symbol.toUpperCase()}`);
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const d = (await res.json()) as {
    symbols?: { filters?: { filterType: string; tickSize?: string }[] }[];
  };
  const f = d.symbols?.[0]?.filters?.find((x) => x.filterType === 'PRICE_FILTER');
  const tick = Number(f?.tickSize ?? 0);
  const precision = precisionFromTick(tick);
  return { precision, minMove: tick > 0 ? tick : Math.pow(10, -precision) };
}

/** 과거 캔들(REST). endTimeMs 를 주면 그 시각 이전 구간을 받아 과거 스크롤 로드에 쓴다. */
export async function fetchKlines(
  symbol: string,
  interval = '1m',
  limit = 500,
  endTimeMs?: number,
): Promise<Candle[]> {
  let url = `${SPOT_API}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
  if (endTimeMs) url += `&endTime=${Math.floor(endTimeMs)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines fetch failed: ${res.status}`);
  const rows: unknown[][] = await res.json();
  // [ openTime, open, high, low, close, volume, closeTime, ... ]
  return rows.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}
