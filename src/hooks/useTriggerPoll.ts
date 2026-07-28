import { useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';

const BASE_MS = 2500;
/** 연속 무한 조건부가 살아있을 때의 폴링 주기 — 이 주기가 곧 "조건이 참인 동안 몇 초마다 사는지"가 된다. */
const REPEAT_MS = 1000;

/**
 * 로그인 상태일 때 주기적으로 서버 상태를 재조회한다.
 * 서버(functions/_trading.ts checkTriggers)는 이 폴링(또는 /api/order 호출) 시점에만
 * 지정가/SL/TP/조건부 체결 조건을 평가한다(Pages Functions 는 cron 을 지원하지 않음) —
 * 즉 이 훅이 지정가·SL·TP·조건부가 실제로 체결되게 만드는 트리거 역할을 한다.
 * ⚠ 이 주기가 곧 "지금 보고 있지 않은 심볼(OX 안 볼 때 포함)의 지정가·SL/TP 가 체결되는 최대 지연"이자
 * 내 잔고/포지션/PnL 이 갱신되는 주기다 — 5s 는 "내 지정가가 언제 체결됐지?" 체감이 굼떠 2.5s 로 줄였다.
 * (in-flight 가드로 느린 네트워크에서 요청이 쌓이지 않게 한다.)
 *
 * ⚠ **연속(continuous) 무한 조건부가 하나라도 있으면 1초 주기로 당긴다** — 그 모드는 "조건이 참인 동안
 * 폴링마다 1회" 실행하므로 이 주기가 곧 매수 간격이 된다(2.5초면 2.5초마다 1회). 조건부가 없거나 전부
 * 재무장 모드면 굳이 빠르게 돌 이유가 없어 2.5초로 돌아간다(D1 부하를 필요할 때만 올린다).
 * 더 촘촘한 간격이 필요하면 주문의 "재실행 간격"을 0으로 두고 이 값을 줄이면 되지만, 폴링 1회가
 * 곧 D1 왕복이라는 점을 감안할 것.
 */
export function useTriggerPoll() {
  const authed = useTradingStore((s) => s.authed);
  const refresh = useTradingStore((s) => s.refresh);
  // 연속 무한 조건부가 있는지 — 있으면 폴링을 당긴다(주문 목록이 바뀔 때만 재계산되게 boolean 으로 구독).
  const fastPoll = useTradingStore((s) =>
    s.conditionalOrders.some((c) => c.repeating && c.repeatMode === 'continuous'),
  );

  useEffect(() => {
    if (!authed) return;
    let inFlight = false;
    const t = setInterval(
      async () => {
        if (inFlight) return; // 직전 폴링이 아직 안 끝났으면 건너뜀(느린 네트워크에서 중첩 방지)
        inFlight = true;
        try {
          await refresh();
        } finally {
          inFlight = false;
        }
      },
      fastPoll ? REPEAT_MS : BASE_MS,
    );
    return () => clearInterval(t);
  }, [authed, refresh, fastPoll]);
}
