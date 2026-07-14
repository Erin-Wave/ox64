import type { Candle } from '@/types';

// 바이낸스 스팟 REST. 선물(fapi) 스트리밍이 일부 지역/IP 에서 차단되는 반면
// 스팟은 어디서나 접근 가능하고 주요 종목 가격이 사실상 동일 → 스팟으로 통일.
const SPOT_API = 'https://api.binance.com';

/** 초기 차트용 과거 캔들(REST). websocket 은 이후 실시간 갱신만 담당. */
export async function fetchKlines(
  symbol: string,
  interval = '1m',
  limit = 500,
): Promise<Candle[]> {
  const url = `${SPOT_API}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
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
