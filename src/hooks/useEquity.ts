import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { quoteOf, USDT_KRW, type Quote } from '@/symbols';

/**
 * 평가자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익) — **지갑(결제통화)별로** 따로, 그리고 합산.
 *
 * ⚠ 증거금 항을 빠뜨리면 안 된다 — 진입할 때 증거금은 잔고에서 이미 빠져나가지만(그게 곧 담보다)
 * 청산하면 `balance += margin + pnl` 로 돌아오므로 **증거금은 순자산의 일부**다. 예전에 이걸
 * 빼먹어서 증거금 비중을 크게 잡으면 진입 즉시 강제청산되던 치명적 버그가 있었다(CLAUDE.md §4).
 * 서버의 강제청산·리필 판정(`_trading.ts liquidateIfBankrupt`, `api/refill.ts`)과 **같은 식**이다.
 *
 * ⚠ 지갑이 둘이다(USDT / 원화 — 2026-09-24). 강제청산은 지갑별(`wallets[q]`), 리필·랭킹은 **합산**(`total`,
 * 원화는 ÷환율로 USDT 환산)이다 — 원화가 남아 있으면 환전하면 되므로 파산이 아니다.
 *
 * `known` = 판정에 필요한 값(보유 심볼 현재가 + 원화 노출이 있으면 환율)을 전부 아는지. 하나라도 모르면
 * **판정에 쓰면 안 된다**(리필 버튼·파산 팝업이 잘못 뜬다).
 *
 * ⚠ 한 곳에만 둔다 — 예전엔 Header 가 자기 안에서 계산했는데, 파산 팝업이 같은 식을 또 적으면
 * 둘 중 하나만 고쳐질 여지가 생긴다(버튼은 활성인데 팝업은 안 뜨는 식).
 */
export function useEquity(): {
  equity: number;
  wallets: Record<Quote, number>;
  rate: number | null;
  known: boolean;
  broke: boolean;
} {
  const balance = useTradingStore((s) => s.balance);
  const krwBalance = useTradingStore((s) => s.krwBalance);
  const positions = useTradingStore((s) => s.positions);
  const prices = useMarketStore((s) => s.prices);

  const wallets: Record<Quote, number> = { USDT: balance, KRW: krwBalance };
  let known = true;
  for (const p of positions) {
    const q = quoteOf(p.symbol);
    const margin = (p.entryPrice * p.size) / p.leverage;
    const live = prices[p.symbol];
    if (live == null) known = false;
    const u = live == null ? 0 : (live - p.entryPrice) * p.size * (p.side === 'long' ? 1 : -1);
    wallets[q] += margin + u;
  }
  const rate = prices[USDT_KRW] ?? null;
  const hasKrw = krwBalance !== 0 || positions.some((p) => quoteOf(p.symbol) === 'KRW');
  if (hasKrw && !rate) known = false;
  const equity = wallets.USDT + (hasKrw && rate ? wallets.KRW / rate : 0);

  return { equity, wallets, rate, known, broke: known && equity <= 0 };
}
