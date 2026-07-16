// 강제청산 전용 Cron Worker — 메인 ox64 Pages 프로젝트와 별도로 배포된다(cron/wrangler.toml 참고).
// scheduled() 가 매시 정각 sweepForcedLiquidations() 를 돌려서, 아무도 접속하지 않아도
// 강제청산(계좌 파산)만큼은 걸리게 한다. 같은 D1(ox64) 을 바인딩해서 메인 앱과 데이터를 공유.
//
// @cloudflare/workers-types 를 의존성으로 두지 않는 프로젝트 관례(functions/_shared.ts 참고)를
// 그대로 따라 ScheduledEvent/ExecutionContext 도 필요한 최소 형태만 직접 선언한다.
import { sweepForcedLiquidations } from '../functions/_trading';
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

export default {
  async scheduled(_event: MinimalScheduledEvent, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    // sweepForcedLiquidations 는 env.DB 만 사용 — SESSION_SECRET 은 이 워커엔 없어도 무방.
    ctx.waitUntil(
      sweepForcedLiquidations(env as unknown as TradingEnv).then((r) => {
        console.log(`[liquidation-cron] checked=${r.checked} liquidated=${r.liquidated}`);
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
    const result = await sweepForcedLiquidations(env as unknown as TradingEnv);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  },
};
