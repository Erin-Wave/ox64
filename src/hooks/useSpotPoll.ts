import { useEffect } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';

/**
 * 가상 코인(OX/USDT)을 보고 있을 때만 3초마다 /api/spot 을 폴링해 잔고/호가/체결을 갱신한다.
 * 항상 폴링하지 않고 실제로 그 심볼을 보고 있을 때만 요청을 보낸다.
 */
export function useSpotPoll() {
  const symbol = useMarketStore((s) => s.symbol);
  const authed = useTradingStore((s) => s.authed);
  const spotRefresh = useTradingStore((s) => s.spotRefresh);
  const active = authed && isVirtualSymbol(symbol);

  useEffect(() => {
    if (!active) return;
    spotRefresh();
    const t = setInterval(spotRefresh, 3000);
    return () => clearInterval(t);
  }, [active, spotRefresh]);
}
