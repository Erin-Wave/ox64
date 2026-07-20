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

/** 누적 거래대금처럼 아주 큰 금액을 짧게(K/M/B/T) — VIP 진행도 표시 전용.
 * fmtVol 과 달리 T(조) 단위까지 가고, 정수부가 3자리 이상이면 소수를 떨어뜨려 폭을 줄인다. */
export function fmtBig(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const unit = a >= 1e12 ? ['T', 1e12] : a >= 1e9 ? ['B', 1e9] : a >= 1e6 ? ['M', 1e6] : a >= 1e3 ? ['K', 1e3] : ['', 1];
  const n = v / (unit[1] as number);
  return n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2) + (unit[0] as string);
}

/** 큰 금액을 한국식 단위(만/억/조)로 — VIP 기준이 "100만/1억/100억/1조" 라 K/M/B/T 보다 직관적이다.
 * ⚠ 반올림이 아니라 **내림**이다. VIP 진행도에 쓰는데 999,999 를 "100만" 으로 올려 보여주면 기준선을
 * 이미 넘은 것처럼 읽혀서("100만인데 왜 아직 VIP0?") 혼란스럽다 — 모자란 쪽으로 표시하는 게 안전하다. */
export function fmtKor(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const trunc = (n: number, d: number) => {
    const f = Math.pow(10, d);
    return (Math.trunc(n * f) / f).toFixed(d);
  };
  if (a >= 1e12) return trunc(v / 1e12, a >= 1e13 ? 1 : 2) + '조';
  if (a >= 1e8) return trunc(v / 1e8, a >= 1e9 ? 1 : 2) + '억';
  if (a >= 1e4) return trunc(v / 1e4, a >= 1e5 ? 0 : 1) + '만';
  return Math.trunc(v).toLocaleString();
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
