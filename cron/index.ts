// 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker — 메인 ox64 Pages 프로젝트와
// 별도로 배포된다(cron/wrangler.toml 참고). scheduled() 가 매 1분 두 가지를 번갈아 돌린다:
//   (1) runMarketMakerBurst() — OX/USDT 마켓메이커 봇, 아무도 안 켜놔도 가격/거래량이 계속 살아있게
//   (2) sweepTriggers()       — 전 유저의 강제청산·지정가·SL/TP·조건부(무한 반복 포함) 평가.
//                               접속(폴링) 때 도는 checkTriggers 와 같은 함수를 공유한다.
// 같은 D1(ox64) 을 바인딩해서 메인 앱과 데이터를 공유한다.
//
// @cloudflare/workers-types 를 의존성으로 두지 않는 프로젝트 관례(functions/_shared.ts 참고)를
// 그대로 따라 ScheduledEvent/ExecutionContext 도 필요한 최소 형태만 직접 선언한다.
import { sweepTriggers } from '../functions/_trading';
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

// 한 cron 실행 안에서 "봇 틱 → 트리거 평가"를 몇 번 번갈아 돌릴지.
// ⚠ 봇 틱 총량(SWEEP_ROUNDS × MM_TICKS_PER_ROUND)은 예전 단일 버스트(BOT_BURST_TICKS=12)와 같게 유지한다 —
// 거래량/가격 움직임의 양은 그대로 두고, 그 사이사이에 트리거를 평가해 **봇이 만든 가격 경로를 여러 번
// 샘플링**하는 것이 목적이다(한 번만 훑으면 그 1분 안에 지나간 딥/스파이크를 조건부가 통째로 놓친다).
// 라운드 사이에 sleep 을 두지 않는 이유: OX 가격은 벽시계가 아니라 **봇 틱이 돌 때만** 움직이므로,
// 틱 그룹 사이에서 평가하는 것만으로 샘플링 목적이 달성된다(실제 코인 시세는 아래 캐시로 1회만 fetch).
const SWEEP_ROUNDS = 4;

// ⚠ 마켓메이커 틱 예산은 **가상 코인 수와 무관하게 고정**이다. 코인마다 12틱씩 돌리면 D1 쓰기도,
// invocation당 쿼리 수(한도 1,000)도 코인 수에 그대로 비례해 늘어난다 — 가상 코인을 못 늘리는 진짜
// 이유가 그것이었다. 그래서 총량을 정해두고 코인들이 나눠 쓴다(1코인이면 지금까지와 정확히 동일한
// 라운드당 3틱). 코인이 늘면 코인당 틱이 줄어 시장 움직임이 그만큼 성기어지는데, 실제로 누가 보고
// 있는 코인은 /api/spot 폴링이 초당 한 번씩 따로 틱을 돌려주므로(runMarketMaker) 체감 차이는 작다.
// ⚠ 총량을 정하는 기준은 **invocation당 D1 쿼리 한도(1,000)** 다. 한 틱이 약 14쿼리(벽 조회 + 봇 조회 +
// 배치 ~11문장 + sweep)를 쓰므로 총 틱 24 ≈ 340쿼리 + 트리거 sweep ≈ 400 으로 한도의 절반 아래다.
// 예전(사다리를 44행으로 쓰던 시절)엔 한 틱이 ~73쿼리라 12틱만으로 950 을 먹어 코인을 못 늘렸다.
// 코인을 더 늘릴 땐 이 값을 그대로 두고 코인당 틱이 줄게 두거나(움직임이 성겨짐), 한도를 다시 계산해
// 올릴 것 — 무심코 "코인 수 × 12" 로 두면 4~5종에서 쿼리 한도에 부딪힌다.
const MM_TICK_BUDGET = 24;
const MM_BUDGET_PER_PAIR = Math.max(SWEEP_ROUNDS, Math.floor(MM_TICK_BUDGET / VIRTUAL_PAIRS.length));

async function runTick(env: Env): Promise<{ sweep: { rounds: number; checked: number; liquidated: number } }> {
  // 전부 env.DB 만 사용 — SESSION_SECRET 은 이 워커엔 없어도 무방.
  // ⚠ 마켓메이커는 단발 틱(runMarketMaker)이 아니라 "버스트"(runMarketMakerBurst)로 돌린다 — 아무도 앱을
  // 안 켜놨을 땐 이 cron 만이 유일한 클럭이라, 여러 틱을 몰아 그 구간의 거래량/가격 움직임을 만들어야
  // 차트가 살아있다(예전엔 단발 틱이라 접속자 없으면 사실상 멈춤). cron 주기는 wrangler.toml 참고.
  const tradingEnv = env as unknown as TradingEnv;
  let prices: Record<string, number> | undefined; // 실제 코인 시세는 이 실행 안에서 재사용(OX 는 매 라운드 새로)
  let checked = 0;
  let liquidated = 0;
  // ⚠ 백오프 판정은 라운드 루프 **밖에서 한 번만** — 라운드마다 하면 직전 라운드가 찍은 last_run 을 보고
  // "누가 폴링 중"이라고 오판해 cron 이 스스로 물러난다(§ marketMakerTickBudget). 페어마다 따로 판정한다
  // (한쪽 코인만 보고 있을 수 있으므로 — 그 코인은 cron 이 물러나고 나머지는 예산을 그대로 쓴다).
  const ticksByPair = new Map<string, number>();
  for (const p of VIRTUAL_PAIRS) {
    ticksByPair.set(p, Math.max(1, Math.floor((await marketMakerTickBudget(tradingEnv, p, MM_BUDGET_PER_PAIR)) / SWEEP_ROUNDS)));
  }
  for (let i = 0; i < SWEEP_ROUNDS; i++) {
    // ⚠ 봇 실패가 트리거 평가를 막으면 안 된다 — 마켓메이커는 "재미"지만 sweepTriggers 는 **돈**이다
    // (강제청산·지정가·SL/TP·조건부). 예전엔 그냥 await 라 봇이 한 번 던지면 runTick 전체가 중단돼
    // 그 분의 청산/체결이 통째로 스킵됐다(2026-07-31 에 D1 storage timeout 으로 실제 발생). 봇은
    // 다음 라운드/다음 cron 에서 재시도하면 그만이므로 여기서 삼키고 로그만 남긴다.
    // 한 페어가 터져도 다른 페어는 계속 돈다(페어별 try/catch).
    for (const p of VIRTUAL_PAIRS) {
      try {
        await runMarketMakerBurst(tradingEnv, p, ticksByPair.get(p)!);
      } catch (e) {
        console.error(`[ox64-cron] marketMaker(${p}) round=${i} failed:`, e instanceof Error ? e.message : e);
      }
    }
    const r = await sweepTriggers(tradingEnv, prices);
    prices = r.prices;
    checked = r.checked; // 매 라운드 같은 유저 집합 — 마지막 값이 곧 "이번 실행에서 훑은 유저 수"
    liquidated += r.liquidated;
  }
  return { sweep: { rounds: SWEEP_ROUNDS, checked, liquidated } };
}

export default {
  async scheduled(_event: MinimalScheduledEvent, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    ctx.waitUntil(
      runTick(env).then((r) => {
        console.log(
          `[ox64-cron] sweep rounds=${r.sweep.rounds} checked=${r.sweep.checked} liquidated=${r.sweep.liquidated}`,
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
