#!/usr/bin/env node
// ── 무료 플랜 사용량 점검 (npm run d1:budget) ─────────────────────────────────────────────
// ⚠ 왜 있는가: 2026-08-01 에 7월분 $47 이 청구됐다(D1 rows written 초과분). 2026-08-14 부터는 무료 플랜이라 넘기면 돈이 아니라
// **그 종류의 작업이 실패한다**(= 거래가 멈춘다). Cloudflare 엔 지출·사용 상한(hard cap) 스위치가 없으므로, 사람이 먼저 알아채는 것
// (이 스크립트) + 코드가 스스로 멈추는 것(functions/_budget.ts) 두 겹으로 막는다.
//
// ⚠⚠ **운영 방침(2026-10-17) = 월 허용량은 무료 사용량의 96%, 하루 허용량은 월 허용량의 3.3%** → 30일 기준 **하루 한도의 95.04%**
// (무료 한도는 날마다 리셋된다). 이 스크립트는 최근 날짜별로 D1 쓰기·읽기와 Workers+Pages 요청 수를 그 선과 비교하고, 하나라도
// 넘은 날이 있으면 exit 1.
//
// 데이터: GraphQL Analytics(일별 정확한 총계). 토큰은 CLOUDFLARE_API_TOKEN(권한 Account Analytics · Read) 이 있으면 그것,
// 없으면 **wrangler 로그인 토큰**을 쓴다(먼저 `wrangler d1 info` 를 한 번 불러 만료된 토큰을 갱신시킨다).
//   사용: npm run d1:budget            (최근 14일)
//         npm run d1:budget -- 30      (최근 30일)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '7bed0008b7981f7f7ce113249440038a';
const DB_NAME = 'ox64';
// 무료 한도(하루, UTC 자정 = 한국 09:00 리셋)
const LIMITS = { write: 100_000, read: 5_000_000, req: 100_000 };
const TARGET = 0.96 * 0.033 * 30; // 0.9504 — 운영 상한(functions/_budget.ts DAY_TARGET_ROWS 95,000 과 같은 선)

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (v, lim) => `${((v / lim) * 100).toFixed(1)}%`;

function wranglerToken() {
  // 만료된 OAuth 토큰을 갱신시킨다(wrangler 명령을 하나 부르면 알아서 refresh 한다).
  spawnSync(`npx wrangler d1 info ${DB_NAME} --json`, { encoding: 'utf8', shell: true });
  const candidates = [
    process.env.APPDATA && join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.wrangler', 'config', 'default.toml'),
  ].filter(Boolean);
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const m = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(f, 'utf8'));
    if (m) return m[1];
  }
  return null;
}

const token = process.env.CLOUDFLARE_API_TOKEN || wranglerToken();
if (!token) {
  console.error('토큰이 없습니다 — `npx wrangler login` 하거나 CLOUDFLARE_API_TOKEN(Account Analytics · Read)을 설정하세요.');
  process.exit(2);
}

async function gql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: ACCOUNT_ID, ...variables } }),
  });
  const body = await res.json().catch(() => null);
  if (body?.errors?.length) console.error(`  (GraphQL: ${body.errors[0].message})`);
  return body?.data?.viewer?.accounts?.[0] ?? {};
}

const daysBack = Math.max(1, Number(process.argv[2]) || 14);
const end = new Date();
const start = new Date(end.getTime() - (daysBack - 1) * 86_400_000);
const iso = (d) => d.toISOString().slice(0, 10);
const s = iso(start);
const e = iso(end);

const days = new Map();
const day = (k) => {
  if (!days.has(k)) days.set(k, { write: 0, read: 0, req: 0 });
  return days.get(k);
};

const d1 = await gql(
  `query($account:String!,$s:Date!,$e:Date!){ viewer{ accounts(filter:{accountTag:$account}){
     d1AnalyticsAdaptiveGroups(filter:{date_geq:$s,date_leq:$e},limit:1000){ dimensions{ date } sum{ rowsWritten rowsRead } }
   } } }`,
  { s, e },
);
for (const g of d1.d1AnalyticsAdaptiveGroups ?? []) {
  day(g.dimensions.date).write += g.sum.rowsWritten;
  day(g.dimensions.date).read += g.sum.rowsRead;
}
// 요청 한도는 계정 전체(이 계정의 다른 Worker 포함) — Workers + Pages Functions 를 합친다.
const req = await gql(
  `query($account:String!,$s:Time!,$e:Time!){ viewer{ accounts(filter:{accountTag:$account}){
     workersInvocationsAdaptive(filter:{datetime_geq:$s,datetime_lt:$e},limit:10000){ dimensions{ date } sum{ requests } }
     pagesFunctionsInvocationsAdaptiveGroups(filter:{datetime_geq:$s,datetime_lt:$e},limit:10000){ dimensions{ date } sum{ requests } }
   } } }`,
  { s: `${s}T00:00:00Z`, e: `${e}T23:59:59Z` },
);
for (const g of [...(req.workersInvocationsAdaptive ?? []), ...(req.pagesFunctionsInvocationsAdaptiveGroups ?? [])]) {
  day(g.dimensions.date).req += g.sum.requests;
}

console.log(`\n  무료 플랜 사용량 — 하루 운영 상한 ${(TARGET * 100).toFixed(2)}% (쓰기 ${fmt(LIMITS.write * TARGET)} · 읽기 ${fmt(LIMITS.read * TARGET)} · 요청 ${fmt(LIMITS.req * TARGET)})`);
console.log('  날짜(UTC)     D1 쓰기          D1 읽기              요청            ');
console.log('  ' + '─'.repeat(78));
let over = false;
for (const [k, v] of [...days.entries()].sort()) {
  const flags = [];
  for (const kind of ['write', 'read', 'req']) if (v[kind] > LIMITS[kind] * TARGET) flags.push(kind);
  if (flags.length) over = true;
  console.log(
    `  ${k}  ${fmt(v.write).padStart(8)} ${pct(v.write, LIMITS.write).padStart(6)}  ${fmt(v.read).padStart(10)} ${pct(v.read, LIMITS.read).padStart(6)}  ${fmt(v.req).padStart(8)} ${pct(v.req, LIMITS.req).padStart(6)}  ${flags.length ? '⚠ 상한 초과: ' + flags.join(',') : ''}`,
  );
}
console.log(
  over
    ? `\n  ❌ 상한(${(TARGET * 100).toFixed(2)}%)을 넘은 날이 있다 — \`npx wrangler d1 insights ox64 --sort-by writes|reads --timePeriod 1d --json\` 로 원인 쿼리를 찾을 것(CLAUDE.md §6).\n`
    : '\n  ✅ 모든 날이 상한 안이다. (코드 쪽 차단선은 functions/_budget.ts — 재체결 → 반복 조건부 → 새 진입 → 봇 순)\n',
);
process.exit(over ? 1 : 0);
