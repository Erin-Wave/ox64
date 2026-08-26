import { type Ctx, bad, json, safe, missingEnv, getSession, loadState } from '../_shared';
import { checkTriggers } from '../_trading';
import { loadSpotMarket, loadSpotCandles, runMarketMaker, VIRTUAL_PAIRS, type TickCtx } from './spot';

/** GET /api/state — 로그인 사용자의 잔고+포지션+주문
 *
 * ⚠ **`?tick=<pair>` 통합 폴링 모드**(2026-08-14, 무료 플랜 전환): OX 화면은 원래 폴링을 셋 따로 돌렸다 —
 * 호가(1s) · 캔들(1s) · 계정상태(2.5s). 같은 화면을 그리는 데이터인데 왕복만 셋으로 나뉘어 있어서
 * **OX 화면 1인이 시간당 8,640요청**이었고, 무료 플랜의 하루 10만 요청에서 "하루 총 시청 시간 11.4시간"이
 * 천장이 됐다(D1 읽기·쓰기보다 이게 먼저 닿는다). 한 요청으로 합치면 신선도를 1초 그대로 두고도 요청이
 * **1/2.4** 로 줄어 천장이 27시간이 된다.
 * 계정 상태(state)는 매 틱이 아니라 클라가 `&state=1` 을 붙일 때만 실어 보낸다(≈3초에 한 번) — 매번 실으면
 * 요청은 줄어도 계정 읽기가 2.5배로 늘어 읽기 쪽이 손해다.
 *
 * ⚠ 이 핸들러가 `api/spot.ts` 를 import 하는 방향이어야 한다(반대로 spot 이 `_trading` 을 import 하면
 * `_trading → api/spot` 과 순환이 된다 — `_budget.ts` 가 todayKst 를 복사해 둔 것과 같은 이유).
 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(async () => {
    const envErr = missingEnv(env);
    if (envErr) return bad(envErr, 500);
    const sess = await getSession(request, env);
    if (!sess) return bad('unauthorized', 401);

    const url = new URL(request.url);
    // ⚠ 주문내역 증분 조회(§ loadState ordersSince) — 클라가 가진 마지막 주문 시각. 없으면 전체를 준다
    // (최초 로드·새로고침). 주문 액션(POST /api/order)은 항상 전체를 돌려주므로 어긋나도 곧 복구된다.
    const since = Number(url.searchParams.get('ordersSince')) || undefined;

    const pair = url.searchParams.get('tick');
    if (pair) {
      // ⚠ 페어는 화이트리스트 검증(§ spot.ts) — 검증 없이 쓰면 임의 문자열로 유령 페어를 만들 수 있다.
      if (!VIRTUAL_PAIRS.includes(pair)) return bad('알 수 없는 페어');
      // 이 폴링이 곧 봇 마켓메이커 클럭이다(예전 /api/spot 폴링이 하던 역할). 봇 실패가 유저 요청을
      // 막으면 안 되지만 조용히 삼키지도 않는다 — 봇이 죽어도 화면은 멀쩡해 보여 원인 추적이 어렵다.
      // ⚠ 반환된 컨텍스트(§ TickCtx)를 아래 loadSpotMarket 에 넘긴다 — 봇 틱이 이미 읽은 상태 행과
      // 대기 주문을 호가창이 다시 읽지 않게 하는 것뿐이고, 실패하면 null 이라 예전처럼 각자 읽는다.
      let tickCtx: TickCtx | undefined;
      try {
        tickCtx = await runMarketMaker(env, pair);
      } catch (e) {
        console.error(`[ox64] runMarketMaker(${pair}) failed:`, e instanceof Error ? e.message : e);
      }
      const interval = url.searchParams.get('interval') || '1m';
      const bars = Math.min(1000, Math.max(1, Number(url.searchParams.get('bars')) || 2));
      const wantState = url.searchParams.get('state') === '1';
      const [market, candles, state] = await Promise.all([
        loadSpotMarket(env, sess.uid, pair, tickCtx),
        loadSpotCandles(env, pair, interval, bars),
        // 계정 상태를 실을 때만 트리거 평가(checkTriggers)도 함께 돈다 = 이 요청이 체결 클럭이 된다.
        // 안 실을 땐 계정 데이터를 한 행도 읽지 않는다.
        wantState ? checkTriggers(env, sess.uid).then((marks) => loadState(env, sess.uid, marks, since)) : Promise.resolve(null),
      ]);
      return json({ market, candles, state });
    }

    // 지정가/SL/TP 체결 체크 — 폴링 시점마다 평가(서버에 cron 없음, functions/_trading.ts 참고).
    // 반환된 마크가격을 loadState 에 넘겨 클라가 청산가/평가자산을 서버와 동일 시세로 즉시 계산하게 한다.
    const marks = await checkTriggers(env, sess.uid);
    const state = await loadState(env, sess.uid, marks, since);
    if (!state) return bad('unauthorized', 401);
    return json(state);
  });
}
