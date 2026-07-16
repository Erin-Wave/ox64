import { useEffect } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';

/**
 * 현재 보는 심볼 + 보유 포지션들의 심볼 가격을 주기적으로 폴링해 prices 맵을 갱신한다.
 * 차트 WS 는 현재 심볼만 실시간 갱신하므로, 다른 심볼 포지션의 PnL 이 멈추던 버그를 해결.
 * (브라우저에서 바이낸스 REST 는 접근 가능 — 서버 403 문제와 무관.)
 */
export function useMarkPrices() {
  const symbol = useMarketStore((s) => s.symbol);
  const setPrice = useMarketStore((s) => s.setPrice);
  const positions = useTradingStore((s) => s.positions);

  // 필요한 심볼 집합(현재 + 포지션들)을 문자열 키로 만들어 의존성에 사용
  const posSymbols = positions.map((p) => p.symbol).join(',');

  useEffect(() => {
    // 가상 심볼(OXUSDT)은 바이낸스에 없는 심볼이라 배치 요청에 섞이면 전체가 실패한다 — 제외.
    const symbols = [...new Set([symbol, ...positions.map((p) => p.symbol)])].filter((s) => !isVirtualSymbol(s));
    if (symbols.length === 0) return;
    let alive = true;

    const poll = async () => {
      try {
        const q = encodeURIComponent(JSON.stringify(symbols));
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${q}`);
        if (!res.ok || !alive) return;
        const arr = (await res.json()) as { symbol: string; price: string }[];
        for (const x of arr) {
          const p = Number(x.price);
          if (p && isFinite(p)) setPrice(x.symbol, p);
        }
      } catch {
        /* 네트워크 오류 무시 (다음 주기 재시도) */
      }
    };

    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, posSymbols, setPrice]);
}
