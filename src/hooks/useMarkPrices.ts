import { useEffect } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';
import { fetchPricePrecision } from '@/services/binanceRest';
import { fetchOkxPrices } from '@/services/okxRest';

const VIRTUAL_PREC = 4; // OX/USDT 가상 심볼 소수 자릿수 (Chart.tsx 와 동일)

/**
 * 현재 보는 심볼 + 보유 포지션들의 심볼 가격을 주기적으로 폴링해 prices 맵을 갱신한다.
 * ⚠ **가격 소스 = OKX**(서버 체결가와 동일, functions/_shared.fetchPrice). 예전엔 바이낸스였는데, 서버는
 * 실제 코인 체결가를 OKX 에서 받으므로(바이낸스는 Worker 에서 403) 클라 mark 가 바이낸스면 둘이 미세하게
 * 달라 **고배율 진입 즉시 손익/평단이 크게 튀었다**(200배면 0.05% 괴리도 10% ROE, PEPE 는 -57%). mark 를
 * OKX 로 통일해 체결가=mark 로 맞춘다(진입 손익 ~0 에서 시작). OKX 가 지역 차단이면 바이낸스로 폴백.
 * 차트 캔들은 그대로 바이낸스(전역 접근·전 인터벌) — 실제 코인의 현재가/PnL mark 만 OKX 로 온다.
 * 아울러 보유/미체결/현재 심볼의 가격 정밀도(소수 자릿수)도 채운다 — 예전엔 차트가 현재 심볼만
 * 채워서, 다른 심볼 포지션의 진입가/청산가/현재가가 소수 2자리로 폴백되던 버그가 있었다.
 */
export function useMarkPrices() {
  const symbol = useMarketStore((s) => s.symbol);
  const setPrice = useMarketStore((s) => s.setPrice);
  const setPrecision = useMarketStore((s) => s.setPrecision);
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);

  // 필요한 심볼 집합을 문자열 키로 만들어 의존성에 사용
  const posSymbols = positions.map((p) => p.symbol).join(',');
  const pendSymbols = pendingOrders.map((o) => o.symbol).join(',');

  // ── 가격 폴링 (현재 + 보유 포지션 심볼) ──
  useEffect(() => {
    // 가상 심볼(OXUSDT)은 바이낸스에 없는 심볼이라 배치 요청에 섞이면 전체가 실패한다 — 제외.
    const symbols = [...new Set([symbol, ...positions.map((p) => p.symbol)])].filter((s) => !isVirtualSymbol(s));
    if (symbols.length === 0) return;
    let alive = true;

    const poll = async () => {
      try {
        // 1순위: OKX(서버 체결 소스와 동일 → 진입 손익 ~0). 전부 실패(지역 차단 등)면 바이낸스 폴백.
        let prices = await fetchOkxPrices(symbols);
        if (!alive) return;
        if (Object.keys(prices).length === 0) {
          const q = encodeURIComponent(JSON.stringify(symbols));
          const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${q}`);
          if (!res.ok || !alive) return;
          const arr = (await res.json()) as { symbol: string; price: string }[];
          prices = {};
          for (const x of arr) {
            const p = Number(x.price);
            if (p && isFinite(p)) prices[x.symbol] = p;
          }
        }
        for (const [sym, p] of Object.entries(prices)) setPrice(sym, p);
      } catch {
        /* 네트워크 오류 무시 (다음 주기 재시도) */
      }
    };

    poll();
    // 현재 심볼의 현재가가 이 폴링으로만 갱신되므로(차트 WS 는 mark 를 안 쓴다) 짧게 잡아 반응성을 유지.
    const t = setInterval(poll, 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, posSymbols, setPrice]);

  // ── 가격 정밀도 확보 (현재 + 보유 + 미체결 심볼, 없는 것만 1회 조회) ──
  useEffect(() => {
    const syms = [...new Set([symbol, ...posSymbols.split(','), ...pendSymbols.split(',')].filter(Boolean))];
    const have = useMarketStore.getState().precisions;
    for (const s of syms) {
      if (have[s] != null) continue;
      if (isVirtualSymbol(s)) {
        setPrecision(s, VIRTUAL_PREC);
        continue;
      }
      fetchPricePrecision(s)
        .then(({ precision }) => setPrecision(s, precision))
        .catch(() => {
          /* 조회 실패 시 다음 변경 때 재시도 */
        });
    }
  }, [symbol, posSymbols, pendSymbols, setPrecision]);
}
