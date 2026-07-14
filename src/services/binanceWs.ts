import { webSocket, type WebSocketSubject } from 'rxjs/webSocket';
import { Observable, Subject } from 'rxjs';
import { filter, map, retry, share } from 'rxjs/operators';
import type { Candle, KlineTick } from '@/types';

/**
 * 바이낸스 선물 실시간 kline 스트림 (RxJS).
 *
 * - 브라우저 Native WebSocket 을 RxJS webSocket 으로 래핑.
 * - retry 로 끊김 자동 재연결.
 * - share() 로 다중 구독 시 소켓 하나만 유지.
 *
 * 참고: 스팟 스트림 = wss://stream.binance.com:9443
 *   (선물 fstream 은 일부 지역/IP 에서 소켓은 열리나 데이터가 안 내려와 실시간이 얼어붙음.
 *    스팟은 전역 접근 가능 + 주요 종목 가격 사실상 동일 → 스팟으로 통일. 메시지 포맷은 동일.)
 */
const FSTREAM = 'wss://stream.binance.com:9443/ws';

interface BinanceKlineMsg {
  e: string; // event type
  s: string; // symbol
  k: {
    t: number; // kline start time (ms)
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean; // is closed
  };
}

/** 심볼+인터벌 하나의 실시간 kline 틱 스트림을 만든다. */
export function klineStream(symbol: string, interval = '1m'): Observable<KlineTick> {
  const stream = `${symbol.toLowerCase()}@kline_${interval}`;
  const socket$: WebSocketSubject<unknown> = webSocket({
    url: `${FSTREAM}/${stream}`,
  });

  return socket$.pipe(
    filter((m): m is BinanceKlineMsg => !!m && (m as BinanceKlineMsg).e === 'kline'),
    map((m): KlineTick => {
      const k = m.k;
      const candle: Candle = {
        time: Math.floor(k.t / 1000),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
      };
      return { symbol: m.s, candle, isClosed: k.x };
    }),
    retry({ delay: 2000 }), // 재연결 백오프
    share(), // 소켓 공유
  );
}

/** 최근가 스트림(틱마다 close 값). 여러 패널에서 공유. */
export function priceStream(symbol: string): { price$: Observable<number>; stop: () => void } {
  const stopper = new Subject<void>();
  const price$ = klineStream(symbol, '1m').pipe(map((t) => t.candle.close));
  return { price$, stop: () => stopper.next() };
}
