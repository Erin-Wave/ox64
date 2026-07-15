import { useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';

/**
 * 로그인 상태일 때 5초마다 서버 상태를 재조회한다.
 * 서버(functions/_trading.ts checkTriggers)는 이 폴링(또는 /api/order 호출) 시점에만
 * 지정가/SL/TP 체결 조건을 평가한다(Pages Functions 는 cron 을 지원하지 않음) —
 * 즉 이 훅이 지정가·SL·TP 가 실제로 체결되게 만드는 트리거 역할을 한다.
 */
export function useTriggerPoll() {
  const authed = useTradingStore((s) => s.authed);
  const refresh = useTradingStore((s) => s.refresh);

  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => {
      refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [authed, refresh]);
}
