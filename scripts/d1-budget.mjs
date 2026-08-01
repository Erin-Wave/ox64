#!/usr/bin/env node
// ── D1 쓰기 예산 점검 (npm run d1:budget) ────────────────────────────────────────────────
// ⚠ 왜 있는가: 2026-08-01 에 7월분 $47 이 청구됐다 — 전액 D1 "rows written" 초과분(9,700만 행 vs 포함분
// 5,000만, 100만 행당 $1). Cloudflare 는 D1 에 **지출 상한(hard cap) 기능을 제공하지 않으므로**, 넘기기
// 전에 사람이 알아채는 것 + 코드가 스스로 멈추는 것(functions/_budget.ts) 두 겹으로 막아야 한다.
// 이 스크립트가 첫 번째 겹이다: **하루 단위로 "이 페이스면 월 포함분을 넘기는가"를 판정**한다.
//
// 두 가지 데이터 소스를 쓴다:
//   1) CLOUDFLARE_API_TOKEN 이 있으면 → GraphQL Analytics(`d1AnalyticsAdaptiveGroups`)
//      = 이번 달 **일별 정확한 총계**. 누적/남은 예산/예상 초과 요금까지 계산된다.
//   2) 없으면 → `wrangler d1 insights` 폴백. ⚠ 이 명령은 **상위 5개 쿼리만** 돌려주므로 총계가 아니라
//      하한(과소 추정)이다. 봇이 쓰기의 95% 이상을 만들기 때문에 실무적으로는 충분하지만, 숫자를
//      "최소 이만큼"으로 읽어야 한다.
//
// 토큰 만들기(1) — dash.cloudflare.com → 우상단 프로필 → API Tokens → Create Token → Custom token
//   권한: Account · Account Analytics · Read  (그 하나로 충분하다. 쓰기 권한 주지 말 것)
//   그 뒤: setx CLOUDFLARE_API_TOKEN "값"   (PowerShell 은 $env:CLOUDFLARE_API_TOKEN="값")
import { spawnSync } from 'node:child_process';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '7bed0008b7981f7f7ce113249440038a';
const DB_NAME = 'ox64';
const MONTHLY_BUDGET = 50_000_000; // Paid 플랜 월 포함분(rows written)
const PRICE_PER_MILLION = 1.0; // 초과분 $1 / 100만 행

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const bar = (frac, width = 28) => {
  const on = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(on) + '░'.repeat(width - on);
};

/** 이번 달 1일 ~ 오늘(UTC — 청구 사이클이 UTC 월 기준이다). */
function monthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { start: iso(start), end: iso(now), dayOfMonth: now.getUTCDate(), daysInMonth };
}

function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', shell: true });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} 실패:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/** 정확한 일별 총계 — GraphQL Analytics. 토큰이 없거나 스키마가 거부하면 null 을 돌려 폴백하게 한다. */
async function viaGraphql({ start, end }) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  const query = `query($account:String!,$start:Date!,$end:Date!){
    viewer{ accounts(filter:{accountTag:$account}){
      d1AnalyticsAdaptiveGroups(filter:{date_geq:$start,date_leq:$end},limit:10000,orderBy:[date_ASC]){
        dimensions{ date databaseId } sum{ rowsWritten rowsRead }
      } } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: ACCOUNT_ID, start, end } }),
  });
  const body = await res.json().catch(() => null);
  const groups = body?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(groups)) {
    const msg = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    console.error(`  (GraphQL 사용 불가 → insights 폴백: ${msg})\n`);
    return null;
  }
  const byDay = new Map();
  for (const g of groups) {
    const d = g.dimensions.date;
    byDay.set(d, (byDay.get(d) ?? 0) + (g.sum.rowsWritten ?? 0));
  }
  return { byDay, exact: true };
}

/** 폴백 — `wrangler d1 insights`(상위 5개 쿼리만). 총계의 하한값과 원인 쿼리 목록을 준다. */
function viaInsights() {
  const rows = JSON.parse(wrangler(['d1', 'insights', DB_NAME, '--sort-by', 'writes', '--count', '5', '--timePeriod', '1d', '--json']));
  const total = rows.reduce((a, r) => a + (r.totalRowsWritten ?? 0), 0);
  return { total, rows, exact: false };
}

const { start, end, dayOfMonth, daysInMonth } = monthRange();
const dailyBudget = Math.floor(MONTHLY_BUDGET / daysInMonth);

console.log(`\n  D1 쓰기 예산 점검 — ${DB_NAME}  (${start} ~ ${end}, UTC 청구 사이클)`);
console.log(`  월 포함분 ${fmt(MONTHLY_BUDGET)} 행 · 하루 평균 예산 ${fmt(dailyBudget)} 행\n`);

const gql = await viaGraphql({ start, end });
let over = false;

if (gql) {
  const days = [...gql.byDay.entries()].sort();
  let cum = 0;
  console.log('  날짜         일 쓰기       예산비   누적          비고');
  console.log('  ' + '─'.repeat(66));
  for (const [day, rows] of days) {
    cum += rows;
    const pct = rows / dailyBudget;
    const flag = pct > 1 ? '⚠ 일 예산 초과' : pct > 0.7 ? '· 주의' : '';
    console.log(
      `  ${day}  ${fmt(rows).padStart(11)}  ${(pct * 100).toFixed(0).padStart(5)}%  ${fmt(cum).padStart(11)}  ${flag}`,
    );
  }
  const projected = days.length ? (cum / dayOfMonth) * daysInMonth : 0;
  const overage = Math.max(0, projected - MONTHLY_BUDGET);
  over = projected > MONTHLY_BUDGET;
  console.log('  ' + '─'.repeat(66));
  console.log(`\n  이번 달 누적   ${fmt(cum)} 행  (포함분의 ${((cum / MONTHLY_BUDGET) * 100).toFixed(1)}%)`);
  console.log(`  ${bar(cum / MONTHLY_BUDGET)}`);
  console.log(`  월말 예상      ${fmt(projected)} 행  → 예상 초과 요금 $${(overage / 1_000_000 * PRICE_PER_MILLION).toFixed(2)}`);
  console.log(`  남은 예산      ${fmt(Math.max(0, MONTHLY_BUDGET - cum))} 행`);
} else {
  const { total, rows } = viaInsights();
  over = total > dailyBudget;
  console.log(`  최근 24시간 쓰기(상위 5개 쿼리 합, 과소 추정): ${fmt(total)} 행`);
  console.log(`  ${bar(total / dailyBudget)}  일 예산의 ${((total / dailyBudget) * 100).toFixed(0)}%`);
  console.log(`  이 페이스의 월 환산: ${fmt(total * daysInMonth)} 행\n`);
  console.log('  쓰기 상위 쿼리:');
  for (const r of rows) {
    const q = r.query.replace(/\s+/g, ' ').slice(0, 78);
    console.log(`   ${fmt(r.totalRowsWritten).padStart(11)} 행  (${fmt(r.numberOfTimesRun)}회)  ${q}`);
  }
}

console.log(
  over
    ? '\n  ❌ 초과 페이스 — 위 상위 쿼리가 원인이다. CLAUDE.md §6 "D1 예산"의 원칙(봇 경로에 per-tick INSERT 금지)을 확인할 것.\n'
    : '\n  ✅ 예산 내. (자동 경로는 월 포함분 90% 에서 스스로 멈춘다 — functions/_budget.ts)\n',
);
process.exit(over ? 1 : 0);
