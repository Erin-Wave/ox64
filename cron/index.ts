// 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker — 메인 ox64 Pages 프로젝트와
// 별도로 배포된다(cron/wrangler.toml 참고). 매 1분 두 가지를 차례로 돌린다(DO 요청 둘 — § MarketClock):
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
// 똑같다 — 2026-11-20 부터 둘이 **따로따로의 DO 요청**이다(§ MarketClock). ⚠ 서비스 바인딩은 이 용도로 못 쓴다 — 호출 체인 CPU 를 합산한다.
// DO 저장소는 쓰지 않는다(데이터는 전부 D1). 인스턴스는 하나(`idFromName`)다. ⚠ DO 는 실행을 줄 세우지 **않는다** — 입력 게이트는
// DO 자기 저장소에만 걸리고 D1·fetch 를 기다리는 동안 다른 요청이 끼어든다. 그래서 MarketClock 이 직접 한 번에 하나만 돌린다(409).
// 비용(무료): DO 요청 2,880/일(분당 2 — 한도 10만), duration ≈ 1.5초 × 128MB × 1,440 ≈ 270 GB-s/일(한도 13,000).
//
// @cloudflare/workers-types 를 의존성으로 두지 않는 프로젝트 관례(functions/_shared.ts 참고)를
// 그대로 따라 ScheduledEvent/ExecutionContext/DO 네임스페이스도 필요한 최소 형태만 직접 선언한다.
import { sweepTriggers, rangeOfPath } from '../functions/_trading';
import type { PriceRanges } from '../functions/_trading';
import { runMarketMakerBursts } from '../functions/api/spot';
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

// ⚠⚠ **봇 틱은 코인마다 고정(12 = 5초 틱)이다**(2026-11-20). 틱은 순수 계산이고 커밋이 코인당 1회라 **틱 수가 D1 쓰기·쿼리를
// 늘리지 않는다**(§ spot.ts runBotTicks) — 틱 수를 정하는 건 CPU 뿐이고, 이 일은 DO 안에서 돌아 한도가 요청당 30초다(§ 파일 머리).
// 예전엔 "총량 24 를 코인 수로 나눠" 썼는데 그건 이 일이 cron(CPU 10ms) 안에서 돌던 시절의 제약이었다. 나눠 쓰면 코인을 늘릴수록
// 틱 하나가 덮는 시간이 길어진다 — 4코인이면 10초, 6코인이면 15초로 틱 상한(`DT_MAX_SEC`)에 닿고 그 너머는 **시장이 벽시계보다
// 느리게 흐른다**. 봇은 1초·5초 틱에서만 검증했다(`npm run sim:bot`). 2코인인 지금은 예전과 똑같은 24틱이다.
// ⚠ 코인을 늘리면 DO 의 CPU 가 그만큼 는다(실측: 2코인 × 12틱 = 콜드 5~11ms) — 추가한 뒤 `cd cron && npx wrangler tail --format json`
// 으로 durableObject 이벤트의 `cpuTime` 을 볼 것(scheduled 는 ≈1ms 여야 한다).
// ⚠⚠⚠ **2026-10-01 사고: cron 이 매번 CPU 초과(exceededCpu)로 죽었다.** 옛 실측 "24틱 ≈ 3.5ms" 는 관심도·호가 지속 모델 이전
// 값이었고, cron 은 "한가한 머신"에서 돌아 거의 매번 **콜드 isolate(JIT 전)** 라 같은 계산이 몇 배 든다(로컬 Node 콜드 실측: 봇
// 2페어만 6~7ms). Cloudflare 는 가끔 넘는 건 봐주지만 계속 넘으면 끊는다 — 끊기면 그때까지 커밋된 것만 남아 **뒤에 도는
// 페어(EW)의 1분봉이 10~30분씩 비고, 마지막에 도는 트리거 sweep(강제청산·SL/TP·조건부)이 통째로 증발**했다. 그래서 일을 DO 로
// 옮겼고(§ 파일 머리), 겸사겸사 버스트의 중간 틱은 사다리를 만들지 않고(§ spot.ts LadderDebt) 테이프를 풀지 않으며
// (§ spot.ts appendTape) 읽기를 batch 로 묶었다(D1 호출 1회 ≈ CPU 0.45ms).
// ⚠ 봇 버스트와 트리거 평가는 **DO 요청 둘**로 돈다(2026-11-20, § MarketClock) — 요청마다 D1 호출 한도를 따로 받으므로 코인이 늘어도
// 트리거 평가의 몫이 줄지 않는다. 실측 한도는 호출 하나에 1,000회이고 batch 하나가 1회다(문서는 무료 50 이라 적지만 그 값으로 막히지
// 않았다). 버스트 한 번 = 읽기 batch 1 + 코인마다 커밋 batch 1(정산하는 분엔 + 봇 카운터 조회 1).
const MM_TICKS_PER_PAIR = 12;

/** 봇 버스트가 다음 단계(트리거 평가)에 넘기는 것 — 지나온 가격 범위와 방금 커밋한 기준가. JSON 으로 DO 요청 사이를 건넌다. */
type BurstOut = { ranges: PriceRanges; seed: Record<string, number> };
const NO_BURST: BurstOut = { ranges: {}, seed: {} };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** cron 이 깨우는 시계 — 매 분의 일을 **DO 요청 안에서** 돈다(§ 파일 머리: CPU 를 따로 받는다).
 * ⚠⚠ 요청이 **둘**이다(2026-11-20): `/burst`(봇 시장) → `/sweep`(트리거 평가 = 돈). DO 요청은 들어올 때마다 CPU 30초와
 * D1 호출 한도를 **따로** 받는다(운영 실측: 워커 600회 + DO 요청 600회 × 2 = 전부 성공, 한도는 호출 하나에 1,000회 — 1,000번째에서
 * "Too many API requests by single Worker invocation"). 한 요청에 둘을 몰면 코인이 늘수록 봇이 트리거 평가의 몫을 갉아먹고, 봇이
 * 한도·CPU 로 죽으면 그 분의 강제청산·SL/TP 까지 같이 죽는다. 나누면 서로의 한도·실패에 묶이지 않는다. 순서·의미는 예전 그대로
 * (버스트가 지나온 가격 범위를 sweep 이 받는다). `/tick` 은 둘을 한 요청에서(옛 경로 — 수동 재실행·하위 호환). */
export class MarketClock {
  constructor(
    _state: unknown,
    private readonly env: Env,
  ) {}

  // ⚠ 같은 종류는 한 번에 하나만(2026-10-01) — 실행이 1분을 넘기거나 수동 재실행이 겹치면 두 벌이 섞여 돌았다. 각 쓰기의 가드 덕에
  // 돈은 안 새지만 쿼리·CPU 를 두 배로 쓰고 같은 주문을 서로 선점하려 다툰다. 겹친 쪽은 409 로 그냥 물러난다. 버스트와 sweep 은
  // 서로 다른 일이라 잠금도 따로다(앞 분의 sweep 이 늦게 끝나도 이번 분의 봇은 돈다).
  private bursting = false;
  private sweeping = false;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/burst') {
      if (this.bursting) return json({ busy: true }, 409);
      this.bursting = true;
      try {
        const out = await runBurst(this.env);
        console.log(`[ox64-clock] burst pairs=${Object.keys(out.seed).length}`);
        return json(out);
      } finally {
        this.bursting = false;
      }
    }
    if (this.sweeping) return json({ busy: true }, 409);
    this.sweeping = true;
    try {
      // `/sweep` = 앞 요청이 넘긴 가격 범위로 평가, 그 밖(`/tick`)은 예전처럼 버스트부터 한 요청에서
      const burst = path === '/sweep' ? await readBurst(request) : await runBurst(this.env);
      const r = await runSweep(this.env, burst);
      console.log(`[ox64-clock] sweep checked=${r.sweep.checked} liquidated=${r.sweep.liquidated}`);
      return json(r);
    } finally {
      this.sweeping = false;
    }
  }
}

/** `/sweep` 본문(버스트 결과) — 깨졌으면 범위 없이(시세는 D1 에서 새로 읽는다) 평가한다. 평가 자체를 거르지 않는다(돈이다). */
async function readBurst(request: Request): Promise<BurstOut> {
  try {
    const b = (await request.json()) as Partial<BurstOut>;
    return { ranges: b?.ranges && typeof b.ranges === 'object' ? b.ranges : {}, seed: b?.seed && typeof b.seed === 'object' ? b.seed : {} };
  } catch {
    return NO_BURST;
  }
}

/** 시계(DO)에 이번 분의 일을 맡긴다 — 버스트 요청 다음 sweep 요청. ⚠ DO 는 D1(APAC)과 가까운 곳에 두도록 `locationHint` 를 준다 —
 * 첫 호출 위치에 만들어지는데 cron 은 아무 데서나 돌기 때문(멀면 D1 왕복만큼 벽시계가 늘어난다, CPU 와는 무관). 바인딩이 없으면
 * (로컬 dev 등) 예전처럼 직접 돈다. */
async function runViaClock(env: Env): Promise<TickResult> {
  if (!env.CLOCK) {
    // ⚠ 운영에서 이게 찍히면 바인딩이 빠진 것이다 — cron(CPU 10ms)에서 직접 돌면 2026-10-01 의 CPU 초과 사고가 되풀이된다.
    console.warn('[ox64-cron] CLOCK 바인딩 없음 — cron 안에서 직접 실행(로컬 dev 전용이어야 한다)');
    return runSweep(env, await runBurst(env));
  }
  const stub = env.CLOCK.get(env.CLOCK.idFromName('market-clock'), { locationHint: 'apac' });
  // ⚠ 봇이 실패하거나(앞 분의 버스트가 아직 돌면 409) 응답이 깨져도 **트리거 평가는 돈다** — 범위 없이 지금 시세로(예전 runTick 의
  // try/catch 와 같은 원칙: 봇은 "재미", sweep 은 돈).
  let burst = NO_BURST;
  try {
    const res = await stub.fetch('https://market-clock/burst', { method: 'POST' });
    if (res.ok) burst = (await res.json()) as BurstOut;
    else if (res.status !== 409) console.error(`[ox64-cron] burst ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } catch (e) {
    console.error('[ox64-cron] burst failed:', e instanceof Error ? e.message : e);
  }
  const res = await stub.fetch('https://market-clock/sweep', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(burst),
  });
  if (res.status === 409) return { sweep: { checked: 0, liquidated: 0 }, busy: true }; // 앞 sweep 이 아직 도는 중 — 이번 분은 양보
  if (!res.ok) throw new Error(`MarketClock sweep ${res.status}: ${await res.text()}`);
  return (await res.json()) as TickResult;
}

/** 봇 시장 버스트 — 전부 env.DB 만 사용(SESSION_SECRET 은 이 워커엔 없어도 무방). 실패해도 던지지 않는다(빈 결과). */
async function runBurst(env: Env): Promise<BurstOut> {
  // ⚠ 마켓메이커는 단발 틱(runMarketMaker)이 아니라 "버스트"로 돌린다 — 아무도 앱을 안 켜놨을 땐 이 cron 만이 유일한 클럭이라,
  // 여러 틱을 몰아 그 구간의 거래량/가격 움직임을 만들어야 차트가 살아있다. 백오프(유저가 보고 있으면 cron 이 물러난다)는 페어마다
  // 따로(§ spot.ts burstTicks), 읽기는 전 페어를 batch 하나로(§ spot.ts runMarketMakerBursts). 한 페어가 터져도 다른 페어는 계속 돈다.
  const out: BurstOut = { ranges: {}, seed: {} };
  try {
    const bursts = await runMarketMakerBursts(env as unknown as TradingEnv, MM_TICKS_PER_PAIR);
    for (const [p, b] of Object.entries(bursts)) {
      const range = rangeOfPath(b.path);
      if (range) out.ranges[p] = range;
      if (b.ref != null) out.seed[p] = b.ref; // 방금 커밋한 기준가 = sweep 의 가상 코인 시세(다시 안 읽는다)
    }
  } catch (e) {
    console.error('[ox64-cron] marketMaker failed:', e instanceof Error ? e.message : e);
  }
  return out;
}

/** 트리거 평가 — 전 유저의 강제청산·지정가·SL/TP·조건부. ⚠ 이번 실행에 **딱 한 번**(2026-08-14) — 봇 버스트가 넘긴 **지나온 가격
 * 경로의 최저/최고**로 그 구간을 한 번에 판정한다(§ _trading.ts runTriggers ranges — 점 몇 개를 찍는 것보다 정확하다). */
async function runSweep(env: Env, burst: BurstOut): Promise<TickResult> {
  const r = await sweepTriggers(env as unknown as TradingEnv, undefined, burst.ranges, burst.seed);
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
