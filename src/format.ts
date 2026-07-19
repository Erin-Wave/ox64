// 가격/거래량 표시 포맷 유틸.

/** tickSize(예 0.01, 0.00000001) → 소수 자릿수. */
export function precisionFromTick(tick: number): number {
  if (!(tick > 0)) return 2;
  const s = tick.toFixed(12).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** 심볼 정밀도(prec)에 맞춘 가격 문자열. */
export function fmtPrice(v: number | null | undefined, prec: number): string {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: prec, maximumFractionDigits: prec });
}

/** 거래량 축약(K/M/B) — 공간이 좁은 차트 우측 축 티커 등 전용. */
export function fmtVol(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

/** 수량(코인 개수 등)을 세자리 콤마로. 소수는 최대 8자리까지 표기하되 뒤 0 은 자동으로 떨어진다
 * (예 1234567 → "1,234,567", 0.0123 → "0.0123", 3000 → "3,000"). */
export function fmtQty(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

/** USDT 금액(잔고·손익·증거금 등)을 세자리 콤마 + 소수 2자리로(예 9973.3 → "9,973.30"). */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
