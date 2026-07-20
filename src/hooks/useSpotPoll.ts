import { useEffect } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';

/**
 * 가상 코인(OX/USDT)을 보고 있을 때만 1.5초마다 /api/spot 을 폴링해 호가/체결을 갱신한다.
 * 항상 폴링하지 않고 실제로 그 심볼을 보고 있을 때만 요청을 보낸다.
 * ⚠ 이 폴링이 곧 봇 마켓메이커(runMarketMaker)를 구동하는 클럭이기도 하다 — 주기를 짧게(3s→1.5s→1s)
 * 잡아 호가/체결/기준가가 자주 갱신되고 크로스되는 유저 물량이 그만큼 빨리 체결된다(체결 딜레이 감소).
 * 봇 재호가 게이트(BOT_TICK_MIN/MAX_MS=0.45~1.1s)와 맞물려, OX 를 보고 있으면 사실상 매 폴링(1s)마다
 * 재호가+대기 지정가 sweep 이 돌아 지정가가 ~1초 안에 체결된다.
 */
export function useSpotPoll() {
  const symbol = useMarketStore((s) => s.symbol);
  const authed = useTradingStore((s) => s.authed);
  const spotRefresh = useTradingStore((s) => s.spotRefresh);
  const active = authed && isVirtualSymbol(symbol);

  useEffect(() => {
    if (!active) return;
    spotRefresh();
    const t = setInterval(spotRefresh, 1000);
    return () => clearInterval(t);
  }, [active, spotRefresh]);
}
