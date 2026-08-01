import { useEffect } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { isVirtualSymbol } from '@/symbols';

/**
 * 가상 코인을 보고 있을 때만 1초마다 그 코인의 /api/spot 을 폴링해 호가/체결을 갱신한다.
 * 항상 폴링하지 않고 실제로 그 심볼을 보고 있을 때만 요청을 보낸다.
 * ⚠ 이 폴링이 곧 봇 마켓메이커(runMarketMaker)를 구동하는 클럭이기도 하다 — 주기를 짧게(3s→1.5s→1s)
 * 잡아 호가/체결/기준가가 자주 갱신되고 크로스되는 유저 물량이 그만큼 빨리 체결된다(체결 딜레이 감소).
 * 봇 재호가 게이트(BOT_TICK_MIN/MAX_MS=0.45~1.1s)와 맞물려, OX 를 보고 있으면 사실상 매 폴링(1s)마다
 * 재호가+대기 지정가 sweep 이 돌아 지정가가 ~1초 안에 체결된다.
 *
 * ⚠⚠ **탭이 백그라운드면 폴링을 멈춘다**(2026-08-01, D1 예산 — CLAUDE.md §6). 이 폴링은 "호가창을
 * 보여주는 것"과 "봇 클럭"을 겸하는데, 보이지 않는 탭에서는 앞쪽이 **순수한 낭비**다: 화면을 아무도 안
 * 보는데 초당 한 번씩 봇 틱(≈7행)을 돌려 하루 60만 행을 쓴다. 배경 탭을 하루 열어두는 것만으로 봇 쓰기가
 * 3배가 되어 일일 차단선(BOT_BLOCK_DAY_ROWS)에 닿을 수 있었다.
 * 멈춰도 잃는 게 없다 — 시장은 cron(매 1분 24틱)이 계속 굴리고, 대기 지정가 체결도 cron 의
 * sweepRestingOxPendings/sweepTriggers 가 그대로 처리한다(= 탭을 아예 닫아둔 것과 동일한 동작).
 * 돌아오면 즉시 1회 폴링해 호가창을 최신으로 맞춘다.
 */
export function useSpotPoll() {
  const symbol = useMarketStore((s) => s.symbol);
  const authed = useTradingStore((s) => s.authed);
  const spotRefresh = useTradingStore((s) => s.spotRefresh);
  const spotClear = useTradingStore((s) => s.spotClear);
  const active = authed && isVirtualSymbol(symbol);

  useEffect(() => {
    if (!active) return;
    // ⚠ 폴링 대상은 "지금 보고 있는 가상 코인" 이다 — 심볼을 안 넘기면 어느 코인을 보든 첫 번째
    // 가상 코인의 호가창이 그려진다(가상 코인이 둘 이상이면 바로 티가 난다).
    spotClear(); // 이전 코인의 호가/체결이 잠깐 남아 보이지 않게
    let t: number | undefined;
    const tick = () => spotRefresh(symbol);
    const start = () => {
      if (t !== undefined) return;
      tick(); // 돌아온 직후 한 번은 즉시(호가창이 낡은 채로 1초 기다리지 않게)
      t = window.setInterval(tick, 1000);
    };
    const stop = () => {
      if (t === undefined) return;
      clearInterval(t);
      t = undefined;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [active, symbol, spotRefresh, spotClear]);
}
