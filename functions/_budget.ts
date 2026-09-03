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
// ── 차단(3단) ──────────────────────────────────────────────────────────────────────────
// 스스로 반복해서 도는(=폭주할 수 있는) 경로는 셋이고, **잃는 게 적은 쪽부터** 끊는다:
//   ① 큰 지정가의 재체결   → NIBBLE_BLOCK_DAY_ROWS (주문은 살아있고 나중에 이어서 채워진다)
//   ② `repeating` 조건부  → REPEAT_BLOCK_DAY_ROWS (주문 하나가 쉬는 건 국지적)
//   ③ 마켓메이커 봇       → BOT_BLOCK_DAY_ROWS    (멈추면 가상 코인 시장이 통째로 선다 = 최후 방어선)
// **수동 거래·강제청산·지정가 첫 체결·SL/TP·1회성 조건부는 절대 막지 않는다** — 돈이 걸린 기능을 DB
// 비용 때문에 막는 건 더 큰 사고다. 날짜(KST)가 바뀌면 자동으로 풀린다.
import type { Env, D1PreparedStatement } from './_shared';

/** ⚠⚠ **무료 플랜 기준이다**(2026-08-14 전환). Paid 와 성격이 완전히 다르다:
 *   Paid — 포함분을 넘기면 **돈이 더 나간다**(100만 행당 $1). 아파도 서비스는 돈다.
 *   Free — 한도를 넘기면 **그 종류의 작업이 실패한다**("further operations of that type will fail with
 *          an error"). 즉 쓰기 한도를 넘기는 순간 봇이 아니라 **거래 자체가 멈춘다**.
 * 그래서 임계값은 "아끼려고"가 아니라 **서비스가 죽지 않게** 잡는다 — 정상 운영치의 몇 배 위, 그러나
 * 한도보다는 확실히 아래. */
export const FREE_DAY_ROW_LIMIT = 100_000; // D1 Free: rows written / day
export const FREE_DAY_READ_LIMIT = 5_000_000; // D1 Free: rows read / day (참고용 — 계량 대상 아님)

/** 계량되지 않는 잔여분(주문 생성/취소/수정, 로그인, 퍼즐, 던전 — 전부 사람 손 속도, 하루 수천 행)과
 * "차단이 걸린 뒤에도 유저가 청산/주문은 할 수 있어야 한다"는 여유분으로 남겨두는 몫. */
const DAY_RESERVE_ROWS = 20_000;

/** ⚠ 차단은 **덜 아픈 것부터** 3단이다. 위험한 순서가 아니라 **잃는 게 적은 순서**로 끊는다.
 *  1) nibble — 시장 깊이보다 큰 지정가의 **재**체결. 멈춰도 주문은 살아있고 잠시 뒤 이어서 채워진다.
 *     (개수 제한이 없고 조건이 유지되는 한 영원히 반복되는, 실측상 가장 큰 폭주 경로다 — prod 에서
 *      주문 하나가 하루 3,000건을 체결했다.)
 *  2) repeat — `continuous` 무한 조건부 체결. 주문 하나가 쉬는 건 국지적이다.
 *  3) bot    — 마켓메이커. 멈추면 가상 코인 시장이 통째로 선다 → **최후 방어선**.
 * 셋 다 날짜(KST)가 바뀌면 자동으로 풀린다. 수동 거래·강제청산·지정가 첫 체결·SL/TP·1회성 조건부는
 * **절대 막지 않는다** — 돈이 걸린 기능을 DB 비용 때문에 막는 건 더 큰 사고다. */
export const NIBBLE_BLOCK_DAY_ROWS = 45_000;
export const REPEAT_BLOCK_DAY_ROWS = 55_000;
export const BOT_BLOCK_DAY_ROWS = FREE_DAY_ROW_LIMIT - DAY_RESERVE_ROWS; // 80,000

/** 월 누적은 무료 플랜에선 한도가 아니다(매일 리셋) — `npm run d1:budget` 표시용으로만 남긴다. */
export const MONTHLY_ROW_BUDGET = FREE_DAY_ROW_LIMIT * 31;

// ⚠ 계량 단가 — 각 작업이 D1 에 남기는 행 수의 **보수적(넉넉한) 추정치**다. 정확할 필요는 없고
// "과소평가하지 않는 것"이 중요하다(과소평가하면 차단이 늦게 걸려 돈이 나간다). 근거:
//   봇 틱 7행 = 상태 UPDATE 1 + 캔들 upsert 3(1m/1h/1d) + 봇 수수료 카운터 1 + 이 계량기 1 = 6
//               ⚠ 실측 평균은 6.3 이다 — 캔들 upsert 가 **새 버킷이면 2행**(행 1 + PK 인덱스 1)이라
//               분/시/일이 넘어갈 때 조금 더 든다. 과소평가는 차단을 늦게 걸리게 하므로 7 로 올려 잡는다.
//   체결 24행 = users 1 + positions 1~3 + orders 3 + fee_ledger 4 + 계량기 1
//               (+ OX 는 체결테이프 3~18 + 캔들 3 + 봇 정산 1 + 재고 2 + 사다리 1)
//               ⚠ 20 → 24 (2026-09-03): OX 체결 테이프가 walking 한 가격대별로 **최대 6줄**을 찍는다
//               (§ spot.ts USER_PRINT_MAX — 예전엔 1줄로 집계). 3행 × 6줄 = 18행이 최악이고 실사용
//               평균은 2~4줄이라 +6 정도다. 이 단가가 곧 반복 조건부·재체결 차단선의 환산율이므로
//               **줄 상한을 올리면 여기도 같이 올릴 것**(과소평가는 차단을 늦게 걸리게 한다).
// ⚠ D1 은 한 문장의 비용을 **"바뀐 행 1 + 갱신된 인덱스 항목 수"** 로 센다(암묵 PK 인덱스도 포함).
// 실측: spot_trades INSERT 3(=1+PK+1), fee_ledger INSERT 4(=1+PK+2), 비인덱스 컬럼 UPDATE 1.
// 그래서 **인덱스를 하나 더 다는 것은 그 테이블 모든 INSERT 비용을 올리는 결정**이다.
// ⚠ 봇 단가는 이제 "틱당"이 아니라 **"커밋당"** 이라 여기 없다 — 버스트는 틱을 몇 개 돌든 상태 행을
// 한 번만 쓴다(§ spot.ts ROWS_PER_BOT_COMMIT). 틱 수와 쓰기가 분리된 게 이번 전환의 핵심이다.
export const ROWS_PER_FILL = 24;

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
let cache: { at: number; day: number } | null = null;
const CACHE_MS = 60_000;
const CACHE_MS_BLOCKED = 10 * 60_000;

/** 오늘(KST) 자동 쓰기 누적 추정치.
 * ⚠ 실패하면 0 을 돌려준다 — **계량기 고장이 시장을 멈추면 안 된다**(테이블 미생성 등으로 조회가 깨졌을 때
 * 봇이 통째로 서는 게 더 큰 사고다. 그 경우는 `npm run d1:budget` 월 점검이 잡는다).
 *
 * ⚠ **오늘 한 행만 읽는다**(2026-08-20). 예전엔 `WHERE day LIKE '2026-08%'` 로 이번 달 전체를 SUM 해서
 * 월 누적까지 한 번에 구했는데, 그 월 누적을 **차단 판정에 쓰지 않는다**(무료 플랜의 한도는 일 단위라
 * 월선은 표시용으로만 남겼다 — MONTHLY_ROW_BUDGET 주석). 대가는 조회 하나가 **그 달의 날짜 수만큼**
 * 행을 읽는 것이었다: 월말이면 31행, prod 실측 평균 19행 × 하루 1,026회 = **하루 1.99만 행**을 "쓰지도
 * 않는 숫자"에 썼다. 오늘 행 하나(PK 조회 1행)면 판정에 필요한 값이 전부 나온다.
 * 월 누적이 필요한 곳(budgetStatus)은 호출 빈도가 낮으니 거기서 따로 읽는다. */
export async function meterRows(env: Env): Promise<{ day: number }> {
  const now = Date.now();
  const blocked = cache && cache.day >= NIBBLE_BLOCK_DAY_ROWS;
  if (cache && now - cache.at < (blocked ? CACHE_MS_BLOCKED : CACHE_MS)) return { day: cache.day };
  const today = todayKst();
  try {
    const row = await env.DB.prepare('SELECT rows_est FROM usage_meter WHERE day = ?')
      .bind(today)
      .first<{ rows_est: number }>();
    cache = { at: now, day: row?.rows_est ?? 0 };
    // 차단이 걸렸으면 로그를 남긴다 — 조용한 후퇴라 로그가 없으면 "봇이 왜 멈췄지?" 를 알 방법이 없다
    // (`cd cron && npx wrangler tail` 또는 Pages 로그로 확인). 캐시 갱신 시에만 찍어 매 호출 도배를 막는다.
    if (cache.day >= NIBBLE_BLOCK_DAY_ROWS) {
      console.log(
        `[budget] 자동 쓰기 차단 — 오늘 ${cache.day} 행 / 무료 한도 ${FREE_DAY_ROW_LIMIT}` +
          ` (재체결 ${NIBBLE_BLOCK_DAY_ROWS} · 반복조건부 ${REPEAT_BLOCK_DAY_ROWS} · 봇 ${BOT_BLOCK_DAY_ROWS})`,
      );
    }
  } catch {
    cache = { at: now, day: 0 };
  }
  return { day: cache.day };
}

const BLOCK_AT: Record<'nibble' | 'repeat' | 'bot', number> = {
  nibble: NIBBLE_BLOCK_DAY_ROWS,
  repeat: REPEAT_BLOCK_DAY_ROWS,
  bot: BOT_BLOCK_DAY_ROWS,
};

/** 이 자동 경로를 지금 돌려도 되는가. `kind` 는 **잃는 게 적은 순서**로 끊긴다(위 BLOCK_AT):
 *  - `'nibble'` = 시장 깊이보다 큰 지정가의 재체결(가장 먼저 — 주문은 살아있고 나중에 이어서 채워진다)
 *  - `'repeat'` = `repeating` 조건부 체결(개수 제한이 없어 N배로 늘어난다)
 *  - `'bot'`    = 마켓메이커 봇(최후 방어선 — 멈추면 가상 코인 시장이 통째로 선다)
 * true 면 그 작업을 **그냥 하지 않는다**(에러가 아니라 조용한 후퇴 — 날짜가 바뀌면 자동 해제). */
export async function autoWritesBlocked(env: Env, kind: 'bot' | 'repeat' | 'nibble'): Promise<boolean> {
  const { day } = await meterRows(env);
  return day >= BLOCK_AT[kind];
}

/** 계량기 현황(운영 점검용). */
export async function budgetStatus(env: Env): Promise<{
  day: string;
  dayRows: number;
  monthRows: number;
  monthBudget: number;
  dayBudget: number;
  nibbleBlocked: boolean;
  repeatBlocked: boolean;
  botBlocked: boolean;
}> {
  const { day } = await meterRows(env);
  // 월 누적은 여기서만 필요하다(운영 점검용) — 뜨거운 경로인 meterRows 에서 빼낸 이유는 그 주석 참고.
  const month =
    (
      await env.DB.prepare('SELECT COALESCE(SUM(rows_est),0) AS m FROM usage_meter WHERE day LIKE ?')
        .bind(`${todayKst().slice(0, 7)}%`)
        .first<{ m: number }>()
    )?.m ?? 0;
  return {
    day: todayKst(),
    dayRows: day,
    monthRows: month,
    monthBudget: MONTHLY_ROW_BUDGET,
    dayBudget: FREE_DAY_ROW_LIMIT,
    nibbleBlocked: day >= NIBBLE_BLOCK_DAY_ROWS,
    repeatBlocked: day >= REPEAT_BLOCK_DAY_ROWS,
    botBlocked: day >= BOT_BLOCK_DAY_ROWS,
  };
}
