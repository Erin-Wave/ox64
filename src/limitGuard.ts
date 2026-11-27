import { fmtPrice } from '@/format';

/** 지정가가 현재가에서 이 배수를 넘게 벗어나면(위로 2배 초과 · 아래로 절반 미만) 주문 전에 확인을 받는다(2026-11-28 요청).
 * 자릿수 하나를 잘못 친 가격(0.0148 → 0.148)이 그대로 나가는 걸 막는 용도라 **거부가 아니라 확인**이다 — 일부러 멀리 거는 주문도 있다.
 * ⚠ 불리한 쪽(현재가보다 비싼 매수·싼 매도)이 특히 위험하다: 실제 코인은 시세가 지정가를 넘는 순간 **지정가 그대로** 체결되고
 * (§ CLAUDE.md 지정가), 가상 코인은 호가 몫을 즉시 체결한 뒤 나머지가 그 가격의 벽으로 남아 봇에 흡수된다. */
export const FAR_LIMIT_RATIO = 2;

export type LimitDir = 'buy' | 'sell';

const fmtRatio = (r: number) => r.toLocaleString('ko-KR', { maximumFractionDigits: r >= 100 ? 0 : 1 });

/** 경고 문구(벗어난 가격이 없거나 현재가를 모르면 null). 여러 가격(분할 주문의 양 끝)이면 가장 많이 벗어난 하나로 쓴다. */
export function farLimitWarning(prices: number[], dir: LimitDir, last: number | null | undefined, prec: number, unit: string): string | null {
  if (!(last != null && last > 0)) return null;
  const far = prices.filter((p) => p > 0 && isFinite(p) && (p > last * FAR_LIMIT_RATIO || p < last / FAR_LIMIT_RATIO));
  if (!far.length) return null;
  const dev = (p: number) => Math.abs(Math.log(p / last));
  const p = far.reduce((a, b) => (dev(b) > dev(a) ? b : a));
  const up = p > last;
  const ratio = up ? p / last : last / p;
  const rel = up ? `${fmtRatio(ratio)}배` : `1/${fmtRatio(ratio)}`;
  const label = dir === 'buy' ? '매수' : '매도';
  // 친 가격은 친 자릿수 그대로(현재가 자릿수로 자르면 0.003663 이 0.00366 으로 보인다).
  const decimals = (v: number) => Math.min(12, (String(v).split('.')[1] ?? '').length);
  const px = (v: number) => `${fmtPrice(v, Math.max(prec, decimals(v)))} ${unit}`;
  const crosses = dir === 'buy' ? up : !up; // 현재가보다 불리한 가격 = 바로 체결된다
  const why = crosses
    ? `현재가보다 ${up ? '비싼 매수' : '싼 매도'}라 바로 체결되고, 체결가가 현재가보다 크게 불리할 수 있습니다.`
    : `체결되려면 가격이 지금의 ${rel}까지 ${up ? '올라야' : '내려가야'} 합니다.`;
  return `⚠ ${label} 지정가 ${px(p)} 는 현재가 ${px(last)} 의 ${rel} 입니다.\n${why}\n\n그래도 주문할까요?`;
}

/** 확인창 — 경고할 게 없거나 "확인"을 누르면 true. */
export function confirmFarLimit(prices: number[], dir: LimitDir, last: number | null | undefined, prec: number, unit: string): boolean {
  const msg = farLimitWarning(prices, dir, last, prec, unit);
  return msg == null || window.confirm(msg);
}
