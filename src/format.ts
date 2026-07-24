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
  if (a >= 1e20) return trunc(v / 1e20, a >= 1e21 ? 1 : 2) + '해';
  if (a >= 1e16) return trunc(v / 1e16, a >= 1e17 ? 1 : 2) + '경';
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

/** VIP 수수료율(분수, 예 0.0003)을 퍼센트 문자열로 — 뒤 0 트림, 최대 소수 4자리(0.0002% 같은 상위 등급
 * 저율까지 구분). ⚠ '%' 는 붙이지 않는다(호출부가 붙임). 예: 0.0003→"0.03", 0.00001→"0.001", 0.000002→"0.0002".
 * 예전 toFixed(3) 은 0.001% 미만을 전부 "0" 으로 뭉갰다(VIP5+ 추가로 4자리 필요). */
export function fmtFeeRate(rate: number | null | undefined): string {
  if (rate == null || !isFinite(rate)) return '—';
  return (rate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** 퍼센트 값을 세자리 콤마 + 지정 소수자리로(예 ROE 1234.5 → "1,234.5"). % 기호는 호출부에서 붙인다.
 * 고배율 ROE 는 수천~수만 %가 나와 콤마가 필요하다. */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 편집 가능한 숫자 입력칸의 "표시값"에 세자리 콤마를 넣는다 — 상태(진실원본)는 콤마 없는 raw 문자열로
 * 두고, value 로 넘길 때만 이걸 통과시킨다(onChange 에서는 unfmtNum 으로 콤마를 제거해 raw 로 저장).
 * 정수부에만 콤마를 넣고 소수부·입력 중인 '.'·선행 '-' 는 그대로 둔다(부분 입력 "12." "0.00" 도 안 깨짐).
 * 숫자로 변환하지 않고 문자열을 직접 다루므로 큰 수의 정밀도 손실도 없다. */
export function fmtNumInput(s: string | number | null | undefined): string {
  if (s == null) return '';
  const cleaned = String(s).replace(/,/g, '');
  if (cleaned === '') return '';
  const neg = cleaned.startsWith('-') ? '-' : '';
  const body = neg ? cleaned.slice(1) : cleaned;
  const dot = body.indexOf('.');
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const rest = dot < 0 ? '' : body.slice(dot); // '.' 포함
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg}${grouped}${rest}`;
}

/** fmtNumInput 의 역 — 입력칸 onChange 에서 콤마를 제거해 raw 숫자 문자열로 되돌린다. */
export function unfmtNum(s: string): string {
  return s.replace(/,/g, '');
}
