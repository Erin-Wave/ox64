import { useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';

/**
 * 로그인 상태일 때 2.5초마다 서버 상태를 재조회한다.
 * 서버(functions/_trading.ts checkTriggers)는 이 폴링(또는 /api/order 호출) 시점에만
 * 지정가/SL/TP 체결 조건을 평가한다(Pages Functions 는 cron 을 지원하지 않음) —
 * 즉 이 훅이 지정가·SL·TP 가 실제로 체결되게 만드는 트리거 역할을 한다.
 * ⚠ 이 주기가 곧 "지금 보고 있지 않은 심볼(OX 안 볼 때 포함)의 지정가·SL/TP 가 체결되는 최대 지연"이자
 * 내 잔고/포지션/PnL 이 갱신되는 주기다 — 5s 는 "내 지정가가 언제 체결됐지?" 체감이 굼떠 2.5s 로 줄였다.
 * (in-flight 가드로 느린 네트워크에서 요청이 쌓이지 않게 한다.)
 */
export function useTriggerPoll() {
  const authed = useTradingStore((s) => s.authed);
  const refresh = useTradingStore((s) => s.refresh);

  useEffect(() => {
    if (!authed) return;
    let inFlight = false;
    const t = setInterval(async () => {
      if (inFlight) return; // 직전 폴링이 아직 안 끝났으면 건너뜀(느린 네트워크에서 중첩 방지)
      inFlight = true;
      try {
        await refresh();
      } finally {
        inFlight = false;
      }
    }, 2500);
    return () => clearInterval(t);
  }, [authed, refresh]);
}
