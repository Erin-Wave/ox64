// 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker — 메인 ox64 Pages 프로젝트와
// 별도로 배포된다(cron/wrangler.toml 참고). scheduled() 가 5분마다 두 가지를 돌린다:
//   (1) sweepForcedLiquidations() — 강제청산(계좌 파산), 접속 여부 무관하게 걸려야 함
//   (2) runMarketMaker()          — OX/USDT 마켓메이커 봇, 아무도 안 켜놔도 꾸준히(느려도 무방) 체결이 생기게
// 같은 D1(ox64) 을 바인딩해서 메인 앱과 데이터를 공유한다.
//
// @cloudflare/workers-types 를 의존성으로 두지 않는 프로젝트 관례(functions/_shared.ts 참고)를
// 그대로 따라 ScheduledEvent/ExecutionContext 도 필요한 최소 형태만 직접 선언한다.
import { sweepForcedLiquidations } from '../functions/_trading';
import { runMarketMakerBurst } from '../functions/api/spot';
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

async function runTick(env: Env): Promise<{ liquidation: { checked: number; liquidated: number } }> {
  // 둘 다 env.DB 만 사용 — SESSION_SECRET 은 이 워커엔 없어도 무방.
  // ⚠ 마켓메이커는 단발 틱(runMarketMaker)이 아니라 "버스트"(runMarketMakerBurst)로 돌린다 — 아무도 앱을
  // 안 켜놨을 땐 이 cron 만이 유일한 클럭이라, 한 번에 여러 틱을 몰아 최근 구간의 거래량/가격 움직임을
  // 만들어야 차트가 살아있다(예전엔 단발 틱이라 접속자 없으면 사실상 멈춤). cron 주기는 wrangler.toml 참고.
  const tradingEnv = env as unknown as TradingEnv;
  const [liquidation] = await Promise.all([sweepForcedLiquidations(tradingEnv), runMarketMakerBurst(tradingEnv)]);
  return { liquidation };
}

export default {
  async scheduled(_event: MinimalScheduledEvent, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    ctx.waitUntil(
      runTick(env).then((r) => {
        console.log(`[ox64-cron] liquidation checked=${r.liquidation.checked} liquidated=${r.liquidation.liquidated}`);
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
