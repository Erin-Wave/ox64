// OKX 시세(브라우저용) — 클라이언트 mark(현재가/PnL 기준) 가격을 **서버 체결 소스와 동일한 OKX** 로
// 맞추기 위한 것. 서버(functions/_shared.fetchPrice)는 실제 코인 체결가를 OKX 에서 받는데, 예전엔 클라
// mark 가 바이낸스(차트 WS/useMarkPrices)라 둘이 미세하게 달라(코인별 0.005~0.3%) **고배율에서 진입
// 즉시 손익이 크게 튀고 평단가가 차트에 없던 값처럼 보였다**(200배면 0.05% 괴리도 10% ROE, PEPE 는 -57%).
// 이제 mark 를 OKX 로 통일하면 진입 시 손익이 ~0 에서 시작한다(체결가=mark=OKX). ⚠ 차트 캔들은 그대로
// 바이낸스(전역 접근·전 인터벌 지원). OKX 가 지역 차단이면 호출부가 바이낸스로 폴백한다.

const OKX_MARKET = 'https://www.okx.com/api/v5/market';

/** 'BTCUSDT' → 'BTC-USDT' (OKX instId). USDT 페어 전용. */
function instId(symbol: string): string {
  return symbol.replace(/USDT$/, '') + '-USDT';
}

/** 심볼들의 최신가를 OKX 티커에서 병렬 조회. 실패한 심볼은 결과에서 빠진다(부분 성공 허용).
 * 전부 실패(빈 객체)면 호출부가 바이낸스로 폴백하는 신호로 쓴다. */
export async function fetchOkxPrices(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const r = await fetch(`${OKX_MARKET}/ticker?instId=${instId(s)}`);
        if (!r.ok) return;
        const d = (await r.json()) as { data?: { last: string }[] };
        const p = Number(d.data?.[0]?.last);
        if (p && isFinite(p)) out[s] = p;
      } catch {
        /* 이 심볼만 스킵(다음 폴링 재시도) */
      }
    }),
  );
  return out;
}
