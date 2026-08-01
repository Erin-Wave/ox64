// ── D1 쓰기 예산 계량기 + 자동 쓰기 차단(서킷 브레이커) ────────────────────────────────
// ⚠⚠ 존재 이유: 2026-08-01 에 7월분 **$47** 이 청구됐다 — 전액 D1 "rows written" 초과분
// (9,700만 행 vs 포함분 5,000만, $1/100만 행). 이 사이트는 Workers Paid($5/월)를 넘기면 안 된다.
// **Cloudflare 에는 D1 지출 상한(hard cap) 기능이 없다** — 예산 알림(Budget alert)은 사후 통보일 뿐이라
// "넘기면 멈춘다"는 방어는 코드에서만 만들 수 있다. 그게 이 파일이다.
//
// ── 계량 지점(딱 두 곳) ────────────────────────────────────────────────────────────────
//   (1) 봇 틱          — `spot.ts marketMakerTick` 이 틱당 ROWS_PER_BOT_TICK
//   (2) **모든 체결**  — `_shared.ts feeAccrualStmts` 가 체결당 ROWS_PER_FILL
// (2)를 `feeAccrualStmts` 에 둔 이유: 그 함수가 **모든 체결 경로가 반드시 지나는 유일한 병목**이다
// (시장가 진입·청산, 지정가 체결, 지정가 청산, SL/TP, 조건부 1회성·반복, 강제청산, OX 호가창 walking —
// 11개 호출 지점 전부). 경로마다 계량을 흩뿌리면 새 경로를 추가할 때 빠뜨리고, 그게 곧 다음 청구서다.
// ⚠ 그래서 조건부 체결 경로에 계량을 **따로 넣으면 이중 계산**이 된다(예전에 그렇게 했다가 정리).
//
// 계량하지 않는 것: 주문 생성/취소/수정, 로그인, 퍼즐, 던전. 전부 사람 손 속도에 묶여 있고 체결 batch 보다
// 훨씬 작다(1~5행). 즉 이 숫자는 **총계가 아니라 "폭주 가능한 몫"** 이고, 정확한 총계는 `npm run d1:budget`.
//
// ── 차단(2단) ──────────────────────────────────────────────────────────────────────────
// 폭주할 수 있는 경로는 딱 둘이고, **위험한 쪽을 먼저 끊는다**:
//   `repeating` 조건부 체결 → REPEAT_BLOCK_DAY_ROWS 에서 정지 (개수 제한이 없어 N배로 늘어나는 유일한 경로)
//   마켓메이커 봇 틱       → BOT_BLOCK_DAY_ROWS 에서 정지 (봇 단독으로는 여기 못 닿는다 = 최후 방어선)
// 둘 다 월 MONTH_BLOCK_ROWS 도 함께 본다. **수동 거래·강제청산·지정가·SL/TP·1회성 조건부는 절대 막지
// 않는다** — 돈이 걸린 기능을 DB 비용 때문에 막는 건 더 큰 사고다. 날짜/달이 바뀌면 자동으로 풀린다.
import type { Env, D1PreparedStatement } from './_shared';

/** D1 Paid 플랜에 월 단위로 포함된 rows written(넘으면 100만 행당 $1). */
export const MONTHLY_ROW_BUDGET = 50_000_000;
/** 월 차단선 — 포함분의 90%. 남긴 10% 는 "자동 경로가 멈춘 뒤에도 유저가 청산/주문은 할 수 있는" 여유분. */
export const MONTH_BLOCK_ROWS = 45_000_000;
/** ⚠ **일일 차단선** — 월 상한만으로는 부족하다. 반복 조건부는 개수 제한이 없어서 3개만 걸면 하루 100만 행
 * (월 3,100만)이 되는데, 그건 월 차단선(4,500만) 아래라 **월 계량기로는 절대 안 걸리면서** 하루 목표치는
 * 넘긴다. 그래서 일일선을 따로 둔다. 이 값 × 31 = 2,790만 < 4,500만 이므로 **일일선이 곧 월 보증**이다. */
// 계량되지 않는 잔여분(주문 생성/취소/수정, 퍼즐, 던전 — 전부 사람 손 속도, 실측상 하루 수만 행)을 감안해
// **하루 100만 행 목표치 아래로** 잡는다. 정상 운영은 20~60만/일 이라 여기 닿지 않는다.
export const BOT_BLOCK_DAY_ROWS = 800_000;
/** 반복 조건부는 봇보다 먼저 끊는다 — 봇이 멈추면 시장이 통째로 죽지만, 반복 주문 하나가 쉬는 건 국지적이다.
 * 정상 사용(봇 20~60만/일 + 사람 거래)은 이 선에 닿지 않는다. */
export const REPEAT_BLOCK_DAY_ROWS = 600_000;

// ⚠ 계량 단가 — 각 작업이 D1 에 남기는 행 수의 **보수적(넉넉한) 추정치**다. 정확할 필요는 없고
// "과소평가하지 않는 것"이 중요하다(과소평가하면 차단이 늦게 걸려 돈이 나간다). 근거:
//   봇 틱 7행 = 상태 UPDATE 1 + 캔들 upsert 3(1m/1h/1d) + 봇 수수료 카운터 1 + 이 계량기 1 = 6
//               ⚠ 실측 평균은 6.3 이다 — 캔들 upsert 가 **새 버킷이면 2행**(행 1 + PK 인덱스 1)이라
//               분/시/일이 넘어갈 때 조금 더 든다. 과소평가는 차단을 늦게 걸리게 하므로 7 로 올려 잡는다.
//   체결 20행 = users 1 + positions 1~3 + orders 3 + fee_ledger 4 + 계량기 1
//               (+ OX 는 체결테이프 3 + 캔들 3 + 봇 정산 1 + 재고 2 + 사다리 1 → 20 근처)
// ⚠ D1 은 한 문장의 비용을 **"바뀐 행 1 + 갱신된 인덱스 항목 수"** 로 센다(암묵 PK 인덱스도 포함).
// 실측: spot_trades INSERT 3(=1+PK+1), fee_ledger INSERT 4(=1+PK+2), 비인덱스 컬럼 UPDATE 1.
// 그래서 **인덱스를 하나 더 다는 것은 그 테이블 모든 INSERT 비용을 올리는 결정**이다.
export const ROWS_PER_BOT_TICK = 7;
export const ROWS_PER_FILL = 20;

/** KST(UTC+9) 기준 오늘 날짜. ⚠ `_shared.todayKst` 와 같은 로직이지만 **일부러 복사**했다 —
 * `_shared.ts` 가 이 파일의 `meterStmt` 를 쓰므로, 여기서 `_shared` 의 값을 import 하면 런타임 순환
 * 의존이 된다(타입 import 는 컴파일 시 지워지므로 무해). 2줄짜리 함수라 복사가 순환보다 싸다. */
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 오늘(KST) 계량값에 rows 를 더하는 문장. ⚠ 반드시 **이미 실행되는 batch 에 얹을 것**(단독 실행 금지) —
 * 계량기가 왕복을 늘리면 계량기 자체가 비용이 된다. 봇 틱 단가 7 = 실제 ~6행 + 이 문장 1행. */
export function meterStmt(env: Env, rows: number): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO usage_meter (day, rows_est) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET rows_est = usage_meter.rows_est + excluded.rows_est',
  ).bind(todayKst(), Math.max(0, Math.round(rows)));
}

// 누적을 매 틱 읽으면 읽기가 틱마다 하나씩 늘어난다(읽기는 싸지만 공짜는 아니다) — isolate 안에서 짧게
// 캐시한다. Workers isolate 는 재사용되므로 실질적으로 isolate 당 분당 1회 조회가 된다.
// ⚠ 차단이 걸린 뒤엔 캐시를 길게 잡는다(그 날/달엔 어차피 안 풀린다) — 차단 상태에서 조회를 계속하는 게
// 제일 무의미하다. 캐시가 최대 60초 낡을 수 있어 차단이 그만큼 늦게 걸리지만, 60초분(수백 행)은 무해하다.
let cache: { at: number; day: number; month: number } | null = null;
const CACHE_MS = 60_000;
const CACHE_MS_BLOCKED = 10 * 60_000;

/** 이번 달/오늘 자동 쓰기 누적 추정치(한 번의 조회로 둘 다).
 * ⚠ 실패하면 0 을 돌려준다 — **계량기 고장이 시장을 멈추면 안 된다**(테이블 미생성 등으로 조회가 깨졌을 때
 * 봇이 통째로 서는 게 더 큰 사고다. 그 경우는 `npm run d1:budget` 월 점검이 잡는다). */
export async function meterRows(env: Env): Promise<{ day: number; month: number }> {
  const now = Date.now();
  const blocked = cache && (cache.day >= REPEAT_BLOCK_DAY_ROWS || cache.month >= MONTH_BLOCK_ROWS);
  if (cache && now - cache.at < (blocked ? CACHE_MS_BLOCKED : CACHE_MS)) return { day: cache.day, month: cache.month };
  const today = todayKst();
  try {
    const row = await env.DB.prepare(
      'SELECT COALESCE(SUM(rows_est),0) AS m, COALESCE(SUM(CASE WHEN day = ? THEN rows_est END),0) AS d FROM usage_meter WHERE day LIKE ?',
    )
      .bind(today, `${today.slice(0, 7)}%`)
      .first<{ m: number; d: number }>();
    cache = { at: now, day: row?.d ?? 0, month: row?.m ?? 0 };
    // 차단이 걸렸으면 로그를 남긴다 — 조용한 후퇴라 로그가 없으면 "봇이 왜 멈췄지?" 를 알 방법이 없다
    // (`cd cron && npx wrangler tail` 또는 Pages 로그로 확인). 캐시 갱신 시에만 찍어 매 호출 도배를 막는다.
    if (cache.day >= REPEAT_BLOCK_DAY_ROWS || cache.month >= MONTH_BLOCK_ROWS) {
      console.log(
        `[budget] 자동 쓰기 차단 — 오늘 ${cache.day} / 이번 달 ${cache.month} 행` +
          ` (반복조건부 ${REPEAT_BLOCK_DAY_ROWS} · 봇 ${BOT_BLOCK_DAY_ROWS} · 월 ${MONTH_BLOCK_ROWS})`,
      );
    }
  } catch {
    cache = { at: now, day: 0, month: 0 };
  }
  return { day: cache.day, month: cache.month };
}

/** 이 자동 경로를 지금 돌려도 되는가. `kind`:
 *  - `'repeat'` = `repeating` 조건부 체결(개수 제한이 없어 가장 위험 → 먼저 끊는다)
 *  - `'bot'`    = 마켓메이커 봇 틱(최후 방어선)
 * true 면 그 작업을 **그냥 하지 않는다**(에러가 아니라 조용한 후퇴 — 날짜/달이 바뀌면 자동 해제). */
export async function autoWritesBlocked(env: Env, kind: 'bot' | 'repeat'): Promise<boolean> {
  const { day, month } = await meterRows(env);
  if (month >= MONTH_BLOCK_ROWS) return true;
  return day >= (kind === 'repeat' ? REPEAT_BLOCK_DAY_ROWS : BOT_BLOCK_DAY_ROWS);
}

/** 계량기 현황(운영 점검용). */
export async function budgetStatus(env: Env): Promise<{
  day: string;
  dayRows: number;
  monthRows: number;
  monthBudget: number;
  repeatBlocked: boolean;
  botBlocked: boolean;
}> {
  const { day, month } = await meterRows(env);
  return {
    day: todayKst(),
    dayRows: day,
    monthRows: month,
    monthBudget: MONTHLY_ROW_BUDGET,
    repeatBlocked: day >= REPEAT_BLOCK_DAY_ROWS || month >= MONTH_BLOCK_ROWS,
    botBlocked: day >= BOT_BLOCK_DAY_ROWS || month >= MONTH_BLOCK_ROWS,
  };
}
