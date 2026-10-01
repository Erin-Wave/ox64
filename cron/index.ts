// 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker — 메인 ox64 Pages 프로젝트와
// 별도로 배포된다(cron/wrangler.toml 참고). 매 1분 두 가지를 차례로 돌린다(runTick):
//   (1) runMarketMakerBursts() — 가상 코인 마켓메이커 봇, 아무도 안 켜놔도 가격/거래량이 계속 살아있게
//   (2) sweepTriggers()        — 전 유저의 강제청산·지정가·SL/TP·조건부(무한 반복 포함) 평가.
//                                접속(폴링) 때 도는 checkTriggers 와 같은 함수를 공유한다.
// 같은 D1(ox64) 을 바인딩해서 메인 앱과 데이터를 공유한다.
//
// ⚠⚠⚠ **실제 일은 cron 이 아니라 Durable Object(`MarketClock`) 안에서 돈다**(2026-10-01). cron(scheduled)
// invocation 은 무료 플랜에서 CPU 10ms 가 **엄격히** 적용되는데(prod: 정확히 10ms 에서 매번 exceededCpu), 이 일은
// 콜드 isolate 에서 봇 코드 첫 컴파일만으로 그 근처를 쓴다(최적화 후에도 10~14ms). DO 요청은 CPU 를 **따로**
// 계산하고 한도가 요청당 30초다(공식 DO 한도표 + prod 실측: DO 안에서 70~120ms 를 연속 13회 써도 정상, 그동안
// 호출한 쪽 CPU 는 0~2ms). 그래서 cron 은 DO 를 깨우기만 하고(CPU ~1ms), 버스트 → sweep 순서·범위 전달은 예전과
// 똑같이 DO 안의 runTick 이 한다(의미 변화 없음). ⚠ 서비스 바인딩은 이 용도로 못 쓴다 — 호출 체인 CPU 를 합산한다.
// DO 저장소는 쓰지 않는다(데이터는 전부 D1). 인스턴스는 하나(`idFromName`)다. ⚠ DO 는 실행을 줄 세우지 **않는다** — 입력 게이트는
// DO 자기 저장소에만 걸리고 D1·fetch 를 기다리는 동안 다른 요청이 끼어든다. 그래서 MarketClock 이 직접 한 번에 하나만 돌린다(409).
// 비용(무료): DO 요청 1,440/일(한도 10만), duration ≈ 1.5초 × 128MB × 1,440 ≈ 270 GB-s/일(한도 13,000).
//
// @cloudflare/workers-types 를 의존성으로 두지 않는 프로젝트 관례(functions/_shared.ts 참고)를
// 그대로 따라 ScheduledEvent/ExecutionContext/DO 네임스페이스도 필요한 최소 형태만 직접 선언한다.
import { sweepTriggers, rangeOfPath } from '../functions/_trading';
import type { PriceRanges } from '../functions/_trading';
import { runMarketMakerBursts, VIRTUAL_PAIRS } from '../functions/api/spot';
import type { Env as TradingEnv, D1Database } from '../functions/_shared';

interface DurableObjectStubLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown, opts?: { locationHint?: string }): DurableObjectStubLike;
}
interface Env {
  DB: D1Database;
  CLOCK?: DurableObjectNamespaceLike; // MarketClock(§ 위) — 없으면(바인딩 누락) cron 이 직접 돈다
  CRON_SECRET?: string; // 로컬 테스트/수동 재실행용 fetch 핸들러 보호(옵션)
}
interface MinimalScheduledEvent {
  cron: string;
  scheduledTime: number;
}
interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
type TickResult = { sweep: { checked: number; liquidated: number }; busy?: boolean };

// ⚠ 마켓메이커 틱 예산은 **가상 코인 수와 무관하게 고정**이다 — 코인마다 12틱씩 돌리면 비용이 코인 수에
// 그대로 비례한다. 그래서 총량을 정해두고 코인들이 나눠 쓴다.
// ⚠⚠ 예전엔 이 값의 상한을 **invocation당 D1 쿼리 수**가 정했다(틱 하나가 벽 조회+배치+sweep 으로
// ~14쿼리라 24틱 ≈ 340쿼리). 지금은 틱이 순수 계산이고 커밋이 페어당 1회라 **틱 수가 쿼리 수를 거의
// 안 늘린다**(§ spot.ts runBotTicks) → 무료 플랜의 빡빡한 한도(invocation당 50쿼리) 안에서도 틱을 넉넉히
// 돌릴 수 있다. 이제 이 값을 정하는 기준은 쿼리가 아니라 **CPU 시간(무료 10ms/invocation)** 이다.
// ⚠⚠⚠ **2026-10-01 사고: cron 이 매번 CPU 초과(exceededCpu)로 죽었다.** 옛 실측 "24틱 ≈ 3.5ms" 는 관심도·호가
// 지속 모델 이전 값이었고, cron 은 "한가한 머신"에서 돌아 거의 매번 **콜드 isolate(JIT 전)** 라 같은 계산이 몇 배
// 든다(로컬 Node 콜드 실측: 봇 2페어만 6~7ms). Cloudflare 는 가끔 넘는 건 봐주지만 계속 넘으면 끊는다 —
// 끊기면 그때까지 커밋된 것만 남아 **뒤에 도는 페어(EW)의 1분봉이 10~30분씩 비고, 마지막에 도는 트리거
// sweep(강제청산·SL/TP·조건부)이 통째로 증발**했다. 그래서 일을 DO 로 옮겼고(§ 파일 머리), 겸사겸사 버스트의 중간
// 틱은 사다리를 만들지 않고(§ spot.ts LadderDebt) 테이프를 풀지 않으며(§ spot.ts appendTape) 읽기를 batch 로
// 묶었다(D1 호출 1회 ≈ CPU 0.45ms). 이 값을 늘리거나 틱 루프에 계산을 더할 땐
// `cd cron && npx wrangler tail --format json` 으로 scheduled(≈1ms)와 durableObject 이벤트의 `cpuTime` 을 볼 것.
const MM_TICK_BUDGET = 24;
const MM_BUDGET_PER_PAIR = Math.max(1, Math.floor(MM_TICK_BUDGET / VIRTUAL_PAIRS.length));

/** cron 이 깨우는 시계 — 매 분의 일(runTick)을 **DO 요청 안에서** 돈다(§ 파일 머리: CPU 를 따로 받는다). */
export class MarketClock {
  constructor(
    _state: unknown,
    private readonly env: Env,
  ) {}

  // ⚠ 한 번에 하나만(2026-10-01) — 실행이 1분을 넘기거나 수동 재실행(fetch 핸들러)이 겹치면 runTick 두 개가 섞여 돌았다. 각 쓰기의
  // 가드 덕에 돈은 안 새지만 쿼리·CPU 를 두 배로 쓰고 같은 주문을 서로 선점하려 다툰다. 겹친 쪽은 409 로 그냥 물러난다.
  private running = false;

  async fetch(): Promise<Response> {
    if (this.running) return new Response(JSON.stringify({ busy: true }), { status: 409, headers: { 'content-type': 'application/json' } });
    this.running = true;
    try {
      const r = await runTick(this.env);
      console.log(`[ox64-clock] sweep checked=${r.sweep.checked} liquidated=${r.sweep.liquidated}`);
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    } finally {
      this.running = false;
    }
  }
}

/** 시계(DO)에 이번 분의 일을 맡긴다. ⚠ DO 는 D1(APAC)과 가까운 곳에 두도록 `locationHint` 를 준다 — 첫 호출 위치에
 * 만들어지는데 cron 은 아무 데서나 돌기 때문(멀면 D1 왕복만큼 벽시계가 늘어난다, CPU 와는 무관). 바인딩이 없으면
 * (로컬 dev 등) 예전처럼 직접 돈다. */
async function runViaClock(env: Env): Promise<TickResult> {
  if (!env.CLOCK) {
    // ⚠ 운영에서 이게 찍히면 바인딩이 빠진 것이다 — cron(CPU 10ms)에서 직접 돌면 2026-10-01 의 CPU 초과 사고가 되풀이된다.
    console.warn('[ox64-cron] CLOCK 바인딩 없음 — cron 안에서 직접 실행(로컬 dev 전용이어야 한다)');
    return runTick(env);
  }
  const stub = env.CLOCK.get(env.CLOCK.idFromName('market-clock'), { locationHint: 'apac' });
  const res = await stub.fetch('https://market-clock/tick', { method: 'POST' });
  if (res.status === 409) return { sweep: { checked: 0, liquidated: 0 }, busy: true }; // 앞 실행이 아직 도는 중 — 이번 분은 양보
  if (!res.ok) throw new Error(`MarketClock ${res.status}: ${await res.text()}`);
  return (await res.json()) as TickResult;
}

async function runTick(env: Env): Promise<TickResult> {
  // 전부 env.DB 만 사용 — SESSION_SECRET 은 이 워커엔 없어도 무방.
  // ⚠ 마켓메이커는 단발 틱(runMarketMaker)이 아니라 "버스트"(runMarketMakerBurst)로 돌린다 — 아무도 앱을
  // 안 켜놨을 땐 이 cron 만이 유일한 클럭이라, 여러 틱을 몰아 그 구간의 거래량/가격 움직임을 만들어야
  // 차트가 살아있다(예전엔 단발 틱이라 접속자 없으면 사실상 멈춤). cron 주기는 wrangler.toml 참고.
  const tradingEnv = env as unknown as TradingEnv;
  // ⚠ 백오프 판정(유저가 보고 있으면 cron 이 물러난다)은 페어마다 따로 — 한쪽 코인만 보고 있을 수 있다
  // (§ spot.ts burstTicks). 읽기는 전 페어를 batch 하나로 묶는다(§ spot.ts runMarketMakerBursts — D1 호출도 CPU 다).
  const ranges: PriceRanges = {};
  const seed: Record<string, number> = {}; // 방금 커밋한 기준가 = 아래 sweep 의 가상 코인 시세(다시 안 읽는다)
  // ⚠ 봇 실패가 트리거 평가를 막으면 안 된다 — 마켓메이커는 "재미"지만 sweepTriggers 는 **돈**이다
  // (강제청산·지정가·SL/TP·조건부). 예전엔 그냥 await 라 봇이 한 번 던지면 runTick 전체가 중단돼
  // 그 분의 청산/체결이 통째로 스킵됐다(2026-07-31 에 D1 storage timeout 으로 실제 발생).
  // 한 페어가 터져도 다른 페어는 계속 돈다(runMarketMakerBursts 안의 페어별 try/catch).
  try {
    const bursts = await runMarketMakerBursts(tradingEnv, MM_BUDGET_PER_PAIR);
    for (const [p, b] of Object.entries(bursts)) {
      const range = rangeOfPath(b.path);
      if (range) ranges[p] = range;
      if (b.ref != null) seed[p] = b.ref;
    }
  } catch (e) {
    console.error('[ox64-cron] marketMaker failed:', e instanceof Error ? e.message : e);
  }
  // ⚠ 트리거 평가는 **이번 실행에 딱 한 번**이다(2026-08-14). 예전엔 "봇 틱 → 평가"를 4라운드 번갈아
  // 돌려 가격 경로를 4번 샘플링했는데, sweep 한 번이 D1 쿼리 ~18개라 4라운드면 그것만으로 무료 플랜의
  // invocation당 쿼리 한도(50)를 넘긴다. 대신 봇 버스트가 **지나온 가격 경로의 최저/최고**를 넘겨서
  // 그 구간을 한 번에 판정한다(§ _trading.ts runTriggers ranges) — 4점만 찍어보는 것보다 오히려
  // 정확하다(그 사이 지나간 딥/스파이크를 하나도 안 놓친다).
  const r = await sweepTriggers(tradingEnv, undefined, ranges, seed);
  return { sweep: { checked: r.checked, liquidated: r.liquidated } };
}

export default {
  async scheduled(_event: MinimalScheduledEvent, env: Env, _ctx: MinimalExecutionContext): Promise<void> {
    // ⚠ 여기서 일을 직접 하지 않는다 — DO 에 맡기고 기다리기만 한다(§ 파일 머리). 실패하면 이번 분은 건너뛴다
    // (다음 분이 최대 2분치를 따라잡는다 — § spot.ts ELAPSED_MAX_MS). 직접 돌리는 폴백을 두지 않는 이유: DO 가 일을
    // 끝낸 뒤 응답만 실패한 경우 sweep 이 두 번 돌아 반복 조건부가 한 번 더 체결될 수 있다.
    // ⚠ waitUntil 이 아니라 **직접 기다리고 실패는 던진다**(2026-10-01) — 예전엔 waitUntil 안에서 잡아 삼켜서 Cron Events 에 늘 "성공"으로
    // 남았다(DO 가 죽어도 대시보드로는 알 수 없었다). 기다리는 동안 이쪽 CPU 는 거의 0 이다(일은 DO 가 한다).
    try {
      const r = await runViaClock(env);
      console.log(`[ox64-cron] sweep checked=${r.sweep.checked} liquidated=${r.sweep.liquidated}${r.busy ? ' (busy — 앞 실행 진행 중)' : ''}`);
    } catch (e) {
      console.error('[ox64-cron] MarketClock failed:', e instanceof Error ? e.message : e);
      throw e;
    }
  },

  // 수동 트리거(로컬 테스트/즉시 재실행용): POST + 헤더 "x-cron-secret: <CRON_SECRET>"
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.CRON_SECRET || request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const result = await runViaClock(env);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  },
};
