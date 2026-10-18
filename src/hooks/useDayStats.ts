import { useEffect, useMemo, useState } from 'react';
import { api } from '@/services/api';
import { fetchDaySince } from '@/services/binanceRest';
import { bithumbDayStream } from '@/services/bithumb';
import { isVirtualSymbol, KST_OFFSET, quoteOf } from '@/symbols';
import type { TickerTrade } from '@/types';

/**
 * 오늘(**한국시간 0시부터**) 통계 두 가지 — 매일 0시에 초기화된다. 출처가 같은 데이터라 한 훅에서 같이 받는다.
 *
 * 1) **체결강도** = 오늘 매수 체결량의 합 ÷ 매도 체결량의 합 × 100(빗썸·업비트처럼 — 건수가 아니라 수량). 처음엔 클라 테이프
 *    400건(BTC 는 1분 남짓)으로 셌다가 고래 몇 건에 5%~400% 를 오가서 하루치로, 롤링 24시간이었다가 "초기화는 오전 12시" 요청으로
 *    당일 누적이 됐다(2026-10-18).
 * 2) **기준가** = 0시의 가격(= 전일 종가) — 호가창 가격 옆 등락률(업비트·빗썸 호가창과 같은 기준, 2026-10-18).
 *
 * 출처는 셋이고 전부 **이미 있는 데이터**라 서버 쓰기는 0 이다:
 * - 실제 코인(USDT) = 바이낸스 15분봉(한국 0시 = UTC 15:00 이라 15분 경계에 딱 맞다) — taker buy volume 합 + 0시 봉의 시가
 * - 원화 코인 = 빗썸 v1 시세의 당일 누적 매수량 `abv` · 매도량 `aav` · 전일 종가 `pcp`(빗썸이 KST 0시에 초기화, 차트·호가와 같은 소켓)
 * - 가상 코인 = 서버 1시간봉 24개 — 0시 이후 봉의 `buyVolume/sellVolume` 합 + 0시 직전 봉의 종가(없으면 0시 이후 첫 봉의 시가)
 * REST 로 받는 둘은 `REFRESH_MS` 마다(그리고 0시 직후에) 다시 받고, 그 사이엔 받은 뒤의 체결(테이프)을 얹어 체결강도가 실시간으로 움직인다.
 * ⚠ 당일 누적이라 고래 한 건이 들어오면 **그날 0시까지** 체결강도가 그 값에 눌린다(10/18 0시 1분 EW 매수 지정가 3.49e18 개 체결 — 그날 내내 0%대).
 */
export interface TradePower {
  pct: number | null; // null = 아직 값이 없음(받는 중 / 오늘 매도 0)
  buy: number;
  sell: number;
}
export interface DayStats {
  power: TradePower | null;
  ref: number | null; // 0시 기준가(전일 종가) — 모르면 null(받는 중 / 날이 막 바뀌어 아직 새로 못 받음)
}

const REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;
const KST_MS = KST_OFFSET * 1000;
const EMPTY: TickerTrade[] = [];
const NONE: DayStats = { power: null, ref: null };

/** 이 시각이 속한 한국 날짜의 0시(epoch ms). */
export const kstDayStart = (ms: number) => Math.floor((ms + KST_MS) / DAY_MS) * DAY_MS - KST_MS;

interface Base {
  symbol: string;
  day: number; // 이 값이 센 한국 날짜의 0시 — 날이 바뀌면 낡은 값이다
  buy: number;
  sell: number;
  ref: number | null;
  liveAfter: number | null; // 이 시각 뒤의 테이프 체결을 얹는다(REST 출처). null = 출처가 이미 실시간(빗썸 WS)
}

async function loadBase(symbol: string): Promise<Base> {
  const now = Date.now();
  const day = kstDayStart(now);
  if (isVirtualSymbol(symbol)) {
    const { candles } = await api.spotCandles(symbol, '1h', 24);
    let buy = 0;
    let sell = 0;
    let before: number | null = null; // 0시 직전 봉의 종가(= 전일 종가)
    let after: number | null = null; // 0시 이후 첫 봉의 시가(직전 봉이 없을 때 — 그 시간에 체결이 없었다)
    for (const c of candles) {
      if (c.time * 1000 < day) {
        before = c.close;
        continue;
      }
      after ??= c.open;
      if (c.buyVolume == null || c.sellVolume == null) continue;
      buy += c.buyVolume;
      sell += c.sellVolume;
    }
    return { symbol, day, buy, sell, ref: before ?? after, liveAfter: now };
  }
  const v = await fetchDaySince(symbol, day);
  return { symbol, day, buy: v.buy, sell: v.sell, ref: v.open, liveAfter: now };
}

/** `active` 일 때만(호가·체결이 화면에 있을 때) 받는다. */
export function useDayStats(symbol: string, trades: TickerTrade[] = EMPTY, active = true): DayStats {
  const [base, setBase] = useState<Base | null>(null);

  useEffect(() => {
    if (!active) return;
    if (quoteOf(symbol) === 'KRW') {
      const sub = bithumbDayStream(symbol).subscribe((v) => setBase({ symbol, day: kstDayStart(Date.now()), ...v, liveAfter: null }));
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
      // 0시가 1분 안에 오면 0시 직후에 맞춰 다시 받는다(초기화가 최대 1분 늦지 않게)
      const untilMidnight = kstDayStart(Date.now()) + DAY_MS - Date.now() + 1_000;
      if (!stopped) timer = setTimeout(tick, Math.min(REFRESH_MS, untilMidnight));
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [symbol, active]);

  return useMemo(() => {
    if (!base || base.symbol !== symbol) return NONE; // 심볼을 막 바꿨으면 이전 코인 값을 보여주지 않는다
    // 날이 바뀌었는데 아직 새로 못 받았으면 0시 이후 체결만으로 세고 기준가는 비운다(빗썸은 다음 시세가 오면 바로 바뀐다)
    const today = kstDayStart(Date.now());
    const stale = base.day !== today;
    let buy = stale ? 0 : base.buy;
    let sell = stale ? 0 : base.sell;
    const after = stale ? today : base.liveAfter;
    if (after != null) {
      // 테이프는 최신이 [0] — 받은 시각(또는 0시) 이후의 체결만 얹는다
      for (const t of trades) {
        if (t.time <= after) break;
        if (t.takerSide === 'buy') buy += t.qty;
        else if (t.takerSide === 'sell') sell += t.qty;
      }
    }
    return { power: { pct: sell > 0 ? (buy / sell) * 100 : null, buy, sell }, ref: stale || !(base.ref! > 0) ? null : base.ref };
  }, [base, symbol, trades]);
}
