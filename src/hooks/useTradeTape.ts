import { useEffect } from 'react';
import { aggTradeStream } from '@/services/binanceWs';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';

/**
 * 현재 심볼의 체결 테이프를 useMarketStore.recentTrades 에 채운다 — OrderBook.tsx 의 "체결" 탭과
 * Header.tsx 의 현재가 색상(마지막 체결이 매수면 매수색, 매도면 매도색)이 둘 다 이걸 구독한다.
 * OrderBook 이 렌더되지 않을 때(Easy 모드 등)도 Header 색상은 동작해야 해서 App 레벨에서 항상 구동.
 */
export function useTradeTape() {
  const symbol = useMarketStore((s) => s.symbol);
  const virtual = isVirtualSymbol(symbol);
  const pushTrade = useMarketStore((s) => s.pushTrade);
  const mergeTrades = useMarketStore((s) => s.mergeTrades);
  const spotTrades = useTradingStore((s) => s.spotTrades);

  useEffect(() => {
    if (virtual) return; // 가상 심볼은 아래 spotTrades 이펙트가 대신 채움
    const sub = aggTradeStream(symbol).subscribe({
      next: (t) => pushTrade(symbol, { price: t.price, qty: t.qty, takerSide: t.takerSide, time: t.time }),
    });
    return () => sub.unsubscribe();
  }, [symbol, virtual, pushTrade]);

  useEffect(() => {
    if (!virtual) return;
    // ⚠ 갈아끼우지 않고 **새로 들어온 것만 얹는다**(mergeTrades) — 서버가 매 폴링 최근 50건만 주는데
    // 그대로 교체하면 버퍼가 영영 50건이라 체결 필터를 켰을 때 화면이 계속 빈다(§ MAX_TRADES).
    mergeTrades(
      symbol,
      spotTrades.map((t) => ({ price: t.price, qty: t.size, takerSide: t.takerSide, time: t.createdAt })),
    );
  }, [virtual, symbol, spotTrades, mergeTrades]);
}
