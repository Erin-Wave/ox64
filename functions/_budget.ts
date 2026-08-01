// ── D1 쓰기 예산 계량기 + 자동 쓰기 차단(서킷 브레이커) ────────────────────────────────
// ⚠⚠ 존재 이유: 2026-08-01 에 7월분 **$47** 이 청구됐다 — 전액 D1 "rows written" 초과분
// (9,700만 행 vs 포함분 5,000만, $1/100만 행). 이 사이트는 Workers Paid($5/월)를 넘기면 안 된다.
// **Cloudflare 에는 D1 지출 상한(hard cap) 기능이 없다** — 예산 알림(Budget alert)은 사후 통보일 뿐이라
// "넘기면 멈춘다"는 방어는 코드에서만 만들 수 있다. 그게 이 파일이다.
//
// 계량 대상 = **스스로 반복해서 도는 자동 쓰기 경로만**:
//   (1) 마켓메이커 봇 틱 — 분당 24틱 이상 영구히 돈다(§6 "비용의 주인은 봇이다")
//   (2) `repeating` 조건부 주문 체결 — 조건이 참인 동안 계속 체결된다
// 사람이 버튼을 눌러 만드는 쓰기(수동 주문·청산·게임)는 사람 손 속도에 묶여 폭주할 수 없으므로 계량하지
// 않는다. 즉 이 숫자는 **총계가 아니라 "폭주 가능한 몫"** 이고, 정확한 총계는 아래 명령이 진실원본이다:
//   npm run d1:budget        (Cloudflare Analytics / d1 insights 실측)
// 봇이 전체 쓰기의 95% 이상을 만들기 때문에 실무적으로는 이 계량기 ≈ 총계다.
//
// ⚠ 계량기 자체도 쓰기다(행 1개). 그래서 별도 문장을 새로 만들지 않고 **이미 도는 batch 에 얹는다**
// (봇 틱은 5행 → 6행). 그 이상으로 정밀하게 세려고 경로마다 문장을 추가하면 계량기가 비용의 원인이 된다.
import type { Env, D1PreparedStatement } from './_shared';
import { todayKst } from './_shared';

/** D1 Paid 플랜에 월 단위로 포함된 rows written. 넘으면 100만 행당 $1 이 붙는다. */
export const MONTHLY_ROW_BUDGET = 50_000_000;
/** 자동 쓰기를 멈추는 지점(포함분의 90%). 사람이 직접 하는 거래는 이 뒤에도 계속 가능해야 하므로,
 * 남긴 10% 는 "봇이 멈춘 뒤에도 유저가 청산/주문은 할 수 있는" 여유분이다. */
export const BLOCK_AT_ROWS = 45_000_000;
/** 하루 평균 예산 — 이 페이스를 계속 넘기면 월 포함분을 넘긴다(31일 기준으로 보수적으로 계산). */
export const DAILY_ROW_BUDGET = Math.floor(MONTHLY_ROW_BUDGET / 31);

// ⚠ 계량 단가 — 각 자동 작업이 D1 에 남기는 행 수의 **보수적(넉넉한) 추정치**다. 정확할 필요는 없고
// "과소평가하지 않는 것"이 중요하다(과소평가하면 차단이 늦게 걸려 돈이 나간다). 근거:
//   봇 틱 6행  = 상태 UPDATE 1 + 캔들 upsert 3(1m/1h/1d) + 봇 수수료 카운터 1 + 이 계량기 1
//   반복 체결 20행 = users 1 + positions 1~3 + orders 3 + fee_ledger 4(또는 봇 정산/체결테이프/캔들) +
//                    conditional_orders 1 + 계량기 1 … 경로에 따라 12~19 이므로 20 으로 잡는다
// (D1 은 INSERT 1건을 "2 + 인덱스 수" 행으로 센다 — §6 D1 예산)
export const ROWS_PER_BOT_TICK = 6;
export const ROWS_PER_REPEAT_FILL = 20;

/** KST 기준 이번 달 접두사('YYYY-MM') — 청구 사이클이 UTC 월이라 하루 경계가 최대 9시간 어긋날 수 있지만,
 * 차단 임계값을 포함분의 90% 로 잡아둔 이유가 이런 오차를 흡수하기 위함이다. */
function monthKst(): string {
  return todayKst().slice(0, 7);
}

/** 오늘(KST) 계량값에 rows 를 더하는 문장. ⚠ 반드시 이미 실행되는 batch 에 얹을 것(단독 실행 금지). */
export function meterStmt(env: Env, rows: number): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO usage_meter (day, rows_est) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET rows_est = usage_meter.rows_est + excluded.rows_est',
  ).bind(todayKst(), Math.max(0, Math.round(rows)));
}

// 이번 달 누적을 매 틱 읽으면 읽기가 틱마다 하나씩 늘어난다(읽기는 싸지만 공짜는 아니다) — isolate 안에서
// 짧게 캐시한다. Workers isolate 는 재사용되므로 실질적으로 isolate 당 분당 1회 조회가 된다.
// ⚠ 차단이 걸린 뒤엔 캐시를 더 길게 잡는다(어차피 그 달엔 안 풀린다) — 차단 상태에서 조회를 계속하는 게
// 제일 무의미하다.
let cache: { at: number; rows: number } | null = null;
const CACHE_MS = 60_000;
const CACHE_MS_BLOCKED = 10 * 60_000;

/** 이번 달 자동 쓰기 누적 추정치. 실패하면 0 을 돌려준다 — **계량기 고장이 시장을 멈추면 안 된다**
 * (테이블 미생성 등으로 조회가 깨졌을 때 봇이 통째로 서는 게 더 큰 사고다. 그 경우 §6 의 월 점검이 잡는다). */
export async function monthlyAutoRows(env: Env): Promise<number> {
  const now = Date.now();
  const ttl = cache && cache.rows >= BLOCK_AT_ROWS ? CACHE_MS_BLOCKED : CACHE_MS;
  if (cache && now - cache.at < ttl) return cache.rows;
  try {
    const row = await env.DB.prepare("SELECT COALESCE(SUM(rows_est), 0) AS n FROM usage_meter WHERE day LIKE ?")
      .bind(`${monthKst()}%`)
      .first<{ n: number }>();
    cache = { at: now, rows: row?.n ?? 0 };
  } catch {
    cache = { at: now, rows: 0 };
  }
  return cache.rows;
}

/** 이번 달 자동 쓰기가 차단선을 넘었는가 — 봇 틱과 반복 조건부가 실행 전에 이걸 물어본다.
 * true 면 그 작업을 **그냥 하지 않는다**(에러가 아니라 조용한 후퇴 — 다음 달 1일에 자동으로 풀린다). */
export async function autoWritesBlocked(env: Env): Promise<boolean> {
  return (await monthlyAutoRows(env)) >= BLOCK_AT_ROWS;
}

/** 계량기 현황(운영 점검용) — 오늘/이번 달 누적과 남은 예산. */
export async function budgetStatus(env: Env): Promise<{
  day: string;
  dayRows: number;
  monthRows: number;
  monthBudget: number;
  blockAt: number;
  blocked: boolean;
}> {
  const day = todayKst();
  const [today, month] = await Promise.all([
    env.DB.prepare('SELECT rows_est AS n FROM usage_meter WHERE day = ?').bind(day).first<{ n: number }>(),
    monthlyAutoRows(env),
  ]);
  return {
    day,
    dayRows: today?.n ?? 0,
    monthRows: month,
    monthBudget: MONTHLY_ROW_BUDGET,
    blockAt: BLOCK_AT_ROWS,
    blocked: month >= BLOCK_AT_ROWS,
  };
}
