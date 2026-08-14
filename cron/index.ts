// 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker — 메인 ox64 Pages 프로젝트와
// 별도로 배포된다(cron/wrangler.toml 참고). scheduled() 가 매 1분 두 가지를 번갈아 돌린다:
//   (1) runMarketMakerBurst() — OX/USDT 마켓메이커 봇, 아무도 안 켜놔도 가격/거래량이 계속 살아있게
//   (2) sweepTriggers()       — 전 유저의 강제청산·지정가·SL/TP·조건부(무한 반복 포함) 평가.
//                               접속(폴링) 때 도는 checkTriggers 와 같은 함수를 공유한다.
// 같은 D1(ox64) 을 바인딩해서 메인 앱과 데이터를 공유한다.
//
// @cloudflare/workers-types 를 의존성으로 두지 않는 프로젝트 관례(functions/_shared.ts 참고)를
// 그대로 따라 ScheduledEvent/ExecutionContext 도 필요한 최소 형태만 직접 선언한다.
import { sweepTriggers, rangeOfPath } from '../functions/_trading';
import type { PriceRanges } from '../functions/_trading';
import { runMarketMakerBurst, marketMakerTickBudget, VIRTUAL_PAIRS } from '../functions/api/spot';
import type { Env as TradingEnv, D1Database } from '../functions/_shared';

interface Env {
  DB: D1Database;
  CRON_SECRET?: string; // 로컬 테스트/수동 재실행용 fetch 핸들러 보호(옵션)
}
interface MinimalScheduledEvent {
  cron: string;
  scheduledTime: number;
}
interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// ⚠ 마켓메이커 틱 예산은 **가상 코인 수와 무관하게 고정**이다 — 코인마다 12틱씩 돌리면 비용이 코인 수에
// 그대로 비례한다. 그래서 총량을 정해두고 코인들이 나눠 쓴다.
// ⚠⚠ 예전엔 이 값의 상한을 **invocation당 D1 쿼리 수**가 정했다(틱 하나가 벽 조회+배치+sweep 으로
// ~14쿼리라 24틱 ≈ 340쿼리). 지금은 틱이 순수 계산이고 커밋이 페어당 1회라 **틱 수가 쿼리 수를 거의
// 안 늘린다**(§ spot.ts runBotTicks) → 무료 플랜의 빡빡한 한도(invocation당 50쿼리) 안에서도 틱을 넉넉히
// 돌릴 수 있다. 이제 이 값을 정하는 기준은 쿼리가 아니라 **CPU 시간(무료 10ms/invocation)** 이다 —
// 실측 24틱 ≈ 3.5ms 라 여유가 있지만, 늘릴 땐 그쪽을 먼저 계산할 것.
const MM_TICK_BUDGET = 24;
const MM_BUDGET_PER_PAIR = Math.max(1, Math.floor(MM_TICK_BUDGET / VIRTUAL_PAIRS.length));

async function runTick(env: Env): Promise<{ sweep: { checked: number; liquidated: number } }> {
  // 전부 env.DB 만 사용 — SESSION_SECRET 은 이 워커엔 없어도 무방.
  // ⚠ 마켓메이커는 단발 틱(runMarketMaker)이 아니라 "버스트"(runMarketMakerBurst)로 돌린다 — 아무도 앱을
  // 안 켜놨을 땐 이 cron 만이 유일한 클럭이라, 여러 틱을 몰아 그 구간의 거래량/가격 움직임을 만들어야
  // 차트가 살아있다(예전엔 단발 틱이라 접속자 없으면 사실상 멈춤). cron 주기는 wrangler.toml 참고.
  const tradingEnv = env as unknown as TradingEnv;
  // ⚠ 백오프 판정(유저가 보고 있으면 cron 이 물러난다)은 페어마다 따로 — 한쪽 코인만 보고 있을 수 있다.
  const ranges: PriceRanges = {};
  for (const p of VIRTUAL_PAIRS) {
    // ⚠ 봇 실패가 트리거 평가를 막으면 안 된다 — 마켓메이커는 "재미"지만 sweepTriggers 는 **돈**이다
    // (강제청산·지정가·SL/TP·조건부). 예전엔 그냥 await 라 봇이 한 번 던지면 runTick 전체가 중단돼
    // 그 분의 청산/체결이 통째로 스킵됐다(2026-07-31 에 D1 storage timeout 으로 실제 발생).
    // 한 페어가 터져도 다른 페어는 계속 돈다(페어별 try/catch).
    try {
      const ticks = await marketMakerTickBudget(tradingEnv, p, MM_BUDGET_PER_PAIR);
      const range = rangeOfPath(await runMarketMakerBurst(tradingEnv, p, ticks));
      if (range) ranges[p] = range;
    } catch (e) {
      console.error(`[ox64-cron] marketMaker(${p}) failed:`, e instanceof Error ? e.message : e);
    }
  }
  // ⚠ 트리거 평가는 **이번 실행에 딱 한 번**이다(2026-08-14). 예전엔 "봇 틱 → 평가"를 4라운드 번갈아
  // 돌려 가격 경로를 4번 샘플링했는데, sweep 한 번이 D1 쿼리 ~18개라 4라운드면 그것만으로 무료 플랜의
  // invocation당 쿼리 한도(50)를 넘긴다. 대신 봇 버스트가 **지나온 가격 경로의 최저/최고**를 넘겨서
  // 그 구간을 한 번에 판정한다(§ _trading.ts runTriggers ranges) — 4점만 찍어보는 것보다 오히려
  // 정확하다(그 사이 지나간 딥/스파이크를 하나도 안 놓친다).
  const r = await sweepTriggers(tradingEnv, undefined, ranges);
  return { sweep: { checked: r.checked, liquidated: r.liquidated } };
}

export default {
  async scheduled(_event: MinimalScheduledEvent, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    ctx.waitUntil(
      runTick(env).then((r) => {
        console.log(
          `[ox64-cron] sweep checked=${r.sweep.checked} liquidated=${r.sweep.liquidated}`,
        );
      }),
    );
  },

  // 수동 트리거(로컬 테스트/즉시 재실행용): POST + 헤더 "x-cron-secret: <CRON_SECRET>"
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.CRON_SECRET || request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const result = await runTick(env);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  },
};
