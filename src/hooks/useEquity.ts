import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';

/**
 * 평가자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익).
 *
 * ⚠ 증거금 항을 빠뜨리면 안 된다 — 진입할 때 증거금은 `users.balance` 에서 이미 빠져나가지만(그게 곧
 * 담보다) 청산하면 `balance += margin + pnl` 로 돌아오므로 **증거금은 순자산의 일부**다. 예전에 이걸
 * 빼먹어서 증거금 비중을 크게 잡으면 진입 즉시 강제청산되던 치명적 버그가 있었다(CLAUDE.md §4).
 * 서버의 강제청산·리필 판정(`_trading.ts liquidateIfBankrupt`, `api/refill.ts`)과 **같은 식**이다.
 *
 * `known` = 보유 심볼의 현재가를 전부 알고 있는지. 하나라도 모르면 equity 는 그 포지션의 미실현손익을
 * 0 으로 친 값이라 **판정에 쓰면 안 된다**(리필 버튼·파산 팝업이 잘못 뜬다).
 *
 * ⚠ 한 곳에만 둔다 — 예전엔 Header 가 자기 안에서 계산했는데, 파산 팝업이 같은 식을 또 적으면
 * 둘 중 하나만 고쳐질 여지가 생긴다(버튼은 활성인데 팝업은 안 뜨는 식).
 */
export function useEquity(): { equity: number; known: boolean; broke: boolean } {
  const balance = useTradingStore((s) => s.balance);
  const positions = useTradingStore((s) => s.positions);
  const prices = useMarketStore((s) => s.prices);

  const known = positions.every((p) => prices[p.symbol] != null);
  const equity =
    balance +
    positions.reduce((a, p) => {
      const margin = (p.entryPrice * p.size) / p.leverage;
      const live = prices[p.symbol];
      const u = live == null ? 0 : (live - p.entryPrice) * p.size * (p.side === 'long' ? 1 : -1);
      return a + margin + u;
    }, 0);

  return { equity, known, broke: known && equity <= 0 };
}
