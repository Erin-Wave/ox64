import { useEffect, useMemo, useState } from 'react';
import { api } from '@/services/api';
import { fetchTakerVolume24h } from '@/services/binanceRest';
import { bithumbPowerStream } from '@/services/bithumb';
import { isVirtualSymbol, quoteOf } from '@/symbols';
import type { TickerTrade } from '@/types';

/**
 * 24시간 체결강도 = 최근 24시간 **매수 체결량의 합 ÷ 매도 체결량의 합 × 100**(빗썸·업비트의 그것 — 건수가 아니라 수량).
 * 처음엔 클라가 들고 있는 테이프(최대 400건 = BTC 는 1분 남짓)로 셌는데, 고래 한두 건에 5%~400% 를 오가서 거래소들처럼
 * 하루치로 바꿨다. 출처는 셋이고 전부 **이미 있는 데이터**라 서버 쓰기는 0 이다:
 * - 실제 코인(USDT) = 바이낸스 15분봉 96개의 taker buy volume(브라우저 직결, `fetchTakerVolume24h`)
 * - 원화 코인 = 빗썸이 직접 계산한 24H 값(구 WebSocket, `bithumbPowerStream`) — 체결마다 갱신된다
 * - 가상 코인 = 서버 1시간봉 24개의 테이커 방향별 거래량(`spot_candles.buy_volume/sell_volume`). 그 칸이 생기기 전의 봉은
 *   방향 정보가 없어 빼고 센다(`hours` = 실제로 센 시간 수 — 생긴 지 24시간이 안 됐으면 그만큼만)
 * REST 로 받는 둘은 `POWER_REFRESH_MS` 마다 다시 받고, 그 사이엔 받은 뒤의 체결(테이프)을 얹어 실시간으로 움직이게 한다
 * (24시간 창에서 빠져나가는 몫은 다음 갱신 때 반영 — 1분 동안의 차이라 무시할 만하다).
 */
export interface TradePower {
  pct: number | null; // null = 아직 값이 없음(받는 중 / 매도 0)
  buy: number;
  sell: number;
  hours: number | null; // 가상 코인: 방향 정보가 있는 시간 수(24 미만이면 표시에 밝힌다). 나머지는 null(=24시간)
}

const POWER_REFRESH_MS = 60_000;
const EMPTY: TickerTrade[] = [];

interface Base {
  symbol: string;
  buy: number;
  sell: number;
  hours: number | null;
  liveAfter: number | null; // 이 시각 뒤의 테이프 체결을 얹는다(REST 출처). null = 출처가 이미 실시간(빗썸 WS)
}

async function loadBase(symbol: string): Promise<Base> {
  if (isVirtualSymbol(symbol)) {
    const { candles } = await api.spotCandles(symbol, '1h', 24);
    let buy = 0;
    let sell = 0;
    let hours = 0;
    for (const c of candles) {
      if (c.buyVolume == null || c.sellVolume == null) continue;
      buy += c.buyVolume;
      sell += c.sellVolume;
      hours++;
    }
    return { symbol, buy, sell, hours, liveAfter: Date.now() };
  }
  const v = await fetchTakerVolume24h(symbol);
  return { symbol, ...v, hours: null, liveAfter: Date.now() };
}

/** `active` 일 때만(체결 목록이 화면에 있을 때) 받는다. */
export function useTradePower(symbol: string, trades: TickerTrade[] = EMPTY, active = true): TradePower | null {
  const [base, setBase] = useState<Base | null>(null);

  useEffect(() => {
    if (!active) return;
    if (quoteOf(symbol) === 'KRW') {
      const sub = bithumbPowerStream(symbol).subscribe((v) => setBase({ symbol, ...v, hours: null, liveAfter: null }));
      return () => sub.unsubscribe();
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // 탭이 숨어 있으면 건너뛴다(돌아오면 다음 주기에 받는다) — 가상 코인은 서버 요청이라 숨은 탭이 쓰면 안 된다(§6)
      if (!document.hidden) {
        try {
          const b = await loadBase(symbol);
          if (!stopped) setBase(b);
        } catch {
          /* 다음 주기에 다시 */
        }
      }
      if (!stopped) timer = setTimeout(tick, POWER_REFRESH_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [symbol, active]);

  return useMemo(() => {
    if (!base || base.symbol !== symbol) return null; // 심볼을 막 바꿨으면 이전 코인 값을 보여주지 않는다
    // 방향 정보가 있는 봉이 하나도 없으면 값을 내지 않는다 — 받은 뒤 몇 초치 체결만으로 세면 그게 곧 옛 400건 문제다
    if (base.hours === 0) return { pct: null, buy: 0, sell: 0, hours: 0 };
    let { buy, sell } = base;
    if (base.liveAfter != null) {
      // 테이프는 최신이 [0] — 받은 시각 이후의 체결만 얹는다
      for (const t of trades) {
        if (t.time <= base.liveAfter) break;
        if (t.takerSide === 'buy') buy += t.qty;
        else if (t.takerSide === 'sell') sell += t.qty;
      }
    }
    return { pct: sell > 0 ? (buy / sell) * 100 : null, buy, sell, hours: base.hours };
  }, [base, symbol, trades]);
}
