import { useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';

const BASE_MS = 2500;

/**
 * 로그인 상태일 때 주기적으로 서버 상태를 재조회한다.
 * 서버(functions/_trading.ts checkTriggers)는 이 폴링(또는 /api/order 호출) 시점에 지정가/SL/TP/조건부
 * 체결 조건을 평가하므로(Pages Functions 는 cron 미지원), 이 훅이 곧 "접속 중 체결 클럭"이다.
 * ⚠ 접속을 끊어도 체결이 멈추지는 않는다 — cron 워커(cron/index.ts)가 매 1분 sweepTriggers() 로 전
 * 유저를 훑어 같은 평가를 돌린다. 이 폴링은 그 주기를 ~1초까지 당겨주는 역할(더 빠른 체결 + 화면 갱신).
 * ⚠ 이 주기가 곧 "지금 보고 있지 않은 심볼(OX 안 볼 때 포함)의 지정가·SL/TP 가 체결되는 최대 지연"이자
 * 내 잔고/포지션/PnL 이 갱신되는 주기다 — 5s 는 "내 지정가가 언제 체결됐지?" 체감이 굼떠 2.5s 로 줄였다.
 * (in-flight 가드로 느린 네트워크에서 요청이 쌓이지 않게 한다.)
 *
 * ⚠ **예전엔 연속(continuous) 무한 조건부가 있으면 이 주기를 1초로 당겼다** — 그 모드가 "평가마다 1회"
 * 실행이라 폴링 주기가 곧 매수 간격이었기 때문. 2026-08-01 에 그 모드의 재실행 간격에 **하한 5초**가
 * 생겨서(functions/_shared.ts MIN_CONTINUOUS_COOLDOWN_MS — 1초 간격이면 주문 하나가 월 D1 쓰기 포함분을
 * 혼자 다 먹는다) 2.5초 폴링이면 하한을 충분히 따라잡는다. 그래서 적응형 분기를 없애고 항상 2.5초다.
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
    }, BASE_MS);
    return () => clearInterval(t);
  }, [authed, refresh]);
}
