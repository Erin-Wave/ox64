/**
 * 상자깡 밸런스 시뮬레이션 — `npm run sim:crate`
 *
 * ⚠ **`functions/_crateData.ts` 의 확률·가격·재료 가치를 건드렸다면 반드시 이걸 돌릴 것.**
 * 드롭 테이블은 순수 함수라(D1 접근 없음) 수십만 번 개봉을 몇 초에 굴릴 수 있고, 그러지 않으면
 * "슬롯 하나 확률을 조금 올렸을 뿐"이 회수율 100%를 넘겨 **돈이 무한히 불어나는 인플레 경로**가 된다.
 *
 * 회수율은 두 가지 플레이 정책으로 잰다(둘 다 나온 상자를 재귀적으로 끝까지 깐다):
 *   · naive   — 재료를 머지하지 않고 즉시 전부 판매
 *   · optimal — 모든 재료를 자기 카테고리 최고 레벨까지 머지한 뒤 판매,
 *               상자조각은 Lv4 2개마다 상자로 바꿔 그것도 마저 깐다
 *
 * 합격선(§ CLAUDE.md "상자깡 밸런스"):
 *   - naive   회수율 **65~75%** — 상자만 까고 다 팔면 반드시 적자여야 인플레가 안 생긴다
 *   - optimal 회수율 **105~118%** — 머지를 끝까지 해야 비로소 흑자(= 이 게임의 유일한 성장 동력)
 *   - 두 정책의 비(optimal/naive)가 1.4 이상 — 머지의 존재 이유가 숫자로 드러나야 한다
 *   - 잭팟 기여분이 optimal 회수율의 5% 미만 — 넘으면 "많이 까면 확률적으로 이긴다"가 되어
 *     밸런스의 주인이 머지가 아니라 잭팟이 된다(도박성은 체감용이지 수익원이 아니다)
 *   - 상자조각 경로 수익성 > 1.5배 — Lv4 조각을 파는 것보다 상자로 바꾸는 게 확실히 이득이어야 한다
 */
import {
  BROKE_CRATES as BROKE_CRATES_SIM,
  DAILY_COINS as DAILY_COINS_SIM,
  DAILY_CRATES as DAILY_CRATES_SIM,
  RESCUE_COINS as RESCUE_COINS_SIM,
  RESCUE_CRATES as RESCUE_CRATES_SIM,
  RESCUE_DAILY_LIMIT as RESCUE_LIMIT_SIM,
  CATS,
  CAT_BY_KEY,
  CRATES,
  JACKPOTS,
  MAT_JACKPOT,
  MERGE_MULT,
  SHARD_CRATE_ODDS,
  matValue,
  rollCrate,
  rollShardCrate,
  slotsOf,
  type MatCat,
  type RewardItem,
} from '../functions/_crateData';

const RUNS = Number(process.env.SIM_RUNS ?? 200_000); // 상자 레벨당 개봉 수

type Inv = Map<string, number>;
const key = (cat: MatCat, lv: number) => `${cat}:${lv}`;
const add = (inv: Inv, cat: MatCat, lv: number, n: number) => inv.set(key(cat, lv), (inv.get(key(cat, lv)) ?? 0) + n);

interface Run {
  coins: number;
  inv: Inv;
  jackpotCoins: number;
  opened: number;
}

/**
 * 상자 `count` 개를 깐다. 나온 상자는 큐에 넣어 **재귀적으로 끝까지** 깐다(그게 실제 회수액이다 —
 * 나온 상자를 "가격"으로 환산하면 상자에서 상자가 나오는 경로가 통째로 과대평가된다).
 */
function openAll(level: number, count: number, run: Run) {
  const queue: number[] = [];
  for (let i = 0; i < count; i++) queue.push(level);
  while (queue.length) {
    const lv = queue.pop()!;
    run.opened++;
    for (const r of rollCrate(lv) as RewardItem[]) {
      if (r.kind === 'coin') {
        run.coins += r.count;
        if (r.jackpot) run.jackpotCoins += r.count;
      } else if (r.kind === 'mat') {
        add(run.inv, r.cat!, r.level, r.count);
        if (r.jackpot) run.jackpotCoins += matValue(r.cat!, r.level) * r.count;
      } else {
        for (let i = 0; i < r.count; i++) queue.push(r.level);
      }
    }
  }
}

/** 재료를 즉시 전부 판매. */
function sellNaive(inv: Inv): number {
  let sum = 0;
  for (const [k, n] of inv) {
    const [cat, lv] = k.split(':');
    sum += matValue(cat as MatCat, Number(lv)) * n;
  }
  return sum;
}

/**
 * 최적 플레이 — 낮은 레벨부터 2개씩 합쳐 최고 레벨까지 올린 뒤 판매. 홀수로 남는 1개는 그대로
 * 팔리므로 "짝수가 안 맞아 생기는 손실"이 자연히 반영된다(이론 상한이 아니라 실제 도달 가능한 값).
 * 상자조각은 Lv4 2개마다 상자를 뽑아 그것까지 마저 깐다(그 상자에서 또 조각이 나오므로 재귀).
 */
function sellOptimal(run: Run): number {
  let coins = 0;
  for (let guard = 0; guard < 64; guard++) {
    const inv = run.inv;
    run.inv = new Map();
    let madeCrate = false;
    for (const def of CATS) {
      for (let lv = 1; lv < def.maxLevel; lv++) {
        const have = inv.get(key(def.cat, lv)) ?? 0;
        if (have < 2) continue;
        const pairs = Math.floor(have / 2);
        inv.set(key(def.cat, lv), have - pairs * 2);
        inv.set(key(def.cat, lv + 1), (inv.get(key(def.cat, lv + 1)) ?? 0) + pairs);
      }
    }
    // 상자조각 최고 레벨 2개 → 랜덤 상자 → 그 상자도 깐다(결과가 다시 inv 에 쌓인다)
    const shardTop = CAT_BY_KEY.get('shard')!.maxLevel;
    const tops = inv.get(key('shard', shardTop)) ?? 0;
    const pairs = Math.floor(tops / 2);
    if (pairs > 0) {
      inv.set(key('shard', shardTop), tops - pairs * 2);
      madeCrate = true;
      for (const [k, n] of inv) if (n > 0) run.inv.set(k, n);
      for (let i = 0; i < pairs; i++) openAll(rollShardCrate(), 1, run);
      continue;
    }
    for (const [k, n] of inv) if (n > 0) run.inv.set(k, n);
    if (!madeCrate) break;
  }
  coins += sellNaive(run.inv);
  // ⚠ 판 재료는 반드시 비운다 — 회수율 시뮬은 이 함수를 한 번만 부르지만 회생 시뮬은 날마다 부르므로,
  // 비우지 않으면 **같은 재료를 매일 다시 판다**(그 버그로 14일 뒤 자산이 650만 G 로 나왔다).
  run.inv.clear();
  return coins;
}

function simulate(level: number, runs: number, policy: 'naive' | 'optimal') {
  const price = CRATES.find((c) => c.level === level)!.price;
  const run: Run = { coins: 0, inv: new Map(), jackpotCoins: 0, opened: 0 };
  openAll(level, runs, run);
  const matCoins = policy === 'naive' ? sellNaive(run.inv) : sellOptimal(run);
  const total = run.coins + matCoins;
  return {
    rate: total / (runs * price),
    jackpotShare: run.jackpotCoins / total,
    crateMult: run.opened / runs, // 산 상자 1개당 실제로 깐 상자 수(재귀 배율)
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

console.log(`\n=== 상자깡 밸런스 시뮬레이션 (상자당 ${num(RUNS)}회 개봉) ===\n`);

console.log('── 재료 가치표 (머지 배수 ' + MERGE_MULT + ', 2개 → 1개) ──');
for (const c of CATS) {
  const row: string[] = [];
  for (let lv = 1; lv <= c.maxLevel; lv++) row.push(`Lv${lv} ${num(matValue(c.cat, lv))}`);
  const lift = Math.pow(MERGE_MULT / 2, c.maxLevel - 1);
  console.log(`${c.emoji} ${c.name.padEnd(5)} ${row.join(' · ').padEnd(52)} Lv1→Lv${c.maxLevel} 가치 ×${lift.toFixed(2)}`);
}

console.log('\n── 상자별 회수율 ──');
console.log('상자        가격      naive     optimal   비율    재귀배율   잭팟비중');
let fail = 0;
for (const def of CRATES) {
  const naive = simulate(def.level, RUNS, 'naive');
  const opt = simulate(def.level, RUNS, 'optimal');
  const ratio = opt.rate / naive.rate;
  const ok = naive.rate >= 0.62 && naive.rate <= 0.78 && opt.rate >= 1.0 && opt.rate <= 1.2 && ratio >= 1.35;
  if (!ok) fail++;
  console.log(
    `${def.name.padEnd(10)} ${num(def.price).padStart(6)}   ${pct(naive.rate).padStart(7)}   ${pct(opt.rate).padStart(7)}` +
      `   ×${ratio.toFixed(2)}   ×${opt.crateMult.toFixed(2)}      ${pct(opt.jackpotShare).padStart(6)}   ${ok ? '✔' : '✘'}`,
  );
}

console.log('\n── 극한 확률 잭팟 (모든 상자 공통, 배수는 그 상자 가격 기준) ──');
let jackpotEv = 0;
for (const j of JACKPOTS) {
  jackpotEv += j.p * j.mult;
  console.log(
    `${j.label.padEnd(10)} 1/${num(1 / j.p).padStart(9)}   ×${String(j.mult).padStart(5)}   ` +
      `기대기여 ${pct(j.p * j.mult).padStart(6)}   (Lv1 상자 기준 ${num(100 * j.mult)}골드)`,
  );
}
const matJp = MAT_JACKPOT.drop as { kind: 'mat'; cat: MatCat; level: number };
console.log(
  `${'정수 Lv6'.padEnd(10)} 1/${num(1 / MAT_JACKPOT.p).padStart(9)}   ` +
    `        가치 ${num(matValue(matJp.cat, matJp.level))}골드`,
);
console.log(`잭팟 기대기여 합계: ${pct(jackpotEv)} (가격 대비 — 5% 넘으면 밸런스의 주인이 바뀐다)`);

console.log('\n── 상자조각 경로 (Lv4 2개 → 랜덤 상자) ──');
const shardTopValue = matValue('shard', 4);
let crateEv = 0;
for (const o of SHARD_CRATE_ODDS) {
  const price = CRATES.find((c) => c.level === o.level)!.price;
  crateEv += o.p * price;
  console.log(`  Lv${o.level} 상자 ${pct(o.p).padStart(6)}  (가격 ${num(price)})`);
}
console.log(
  `  Lv4 조각 2개 판매가 ${num(shardTopValue * 2)}골드  vs  상자 기대가치 ${num(crateEv)}골드  ` +
    `→ ×${(crateEv / (shardTopValue * 2)).toFixed(2)} ${crateEv / (shardTopValue * 2) >= 1.5 ? '✔' : '✘'}`,
);

console.log('\n── 상자별 드롭 슬롯 수(공시용) ──');
for (const def of CRATES) console.log(`  ${def.name}: ${slotsOf(def.level).length}개 슬롯(전부 독립시행)`);

console.log(`\n${fail === 0 ? '✔ 전 상자 합격선 통과' : `✘ ${fail}개 상자가 합격선을 벗어남`}\n`);

// ── 파산 회생 시뮬레이션 ────────────────────────────────────────────────────────
/**
 * ⚠⚠ **전 재산을 잃은 사람이 실제로 회복할 수 있는가** — 이 게임은 상자만 까면 회수율이 70% 라
 * 가난할수록 회복이 구조적으로 어렵다(머지하려면 같은 재료 2개가 필요한데 상자를 조금밖에 못 까면
 * 재료가 흩어진 채 끝난다). 그래서 지원을 **골드가 아니라 상자로** 주는데, 그게 정말로 회생시키는지는
 * 감이 아니라 여기서 확인한다. 실제로 한 명이 올인 나고 회복하지 못해 추가된 검증이다.
 *
 * 합격선: 지원을 받는 플레이어가 **며칠 안에 파산선(상자 3개 값)을 벗어나고, 자산이 우상향**할 것.
 */
function simulateRecovery(days: number, opts: { support: boolean }) {
  const price = CRATES[0].price;
  const brokeLine = price * BROKE_CRATES_SIM;
  const run: Run = { coins: 0, inv: new Map(), jackpotCoins: 0, opened: 0 };
  let brokeUntil = -1;
  const daily: number[] = [];

  for (let day = 0; day < days; day++) {
    if (opts.support) {
      // 일일 지원(조건 없음) + 파산이면 구제 4회
      run.coins += DAILY_COINS_SIM;
      openAll(1, DAILY_CRATES_SIM, run);
      for (let i = 0; i < RESCUE_LIMIT_SIM; i++) {
        if (run.coins + sellNaive(run.inv) >= brokeLine) break;
        run.coins += RESCUE_COINS_SIM;
        openAll(1, RESCUE_CRATES_SIM, run);
      }
    }
    // 하루 플레이: 살 수 있는 만큼 사서 까고, 최고 레벨까지 합쳐서 판다(optimal 정책)
    const buy = Math.floor(run.coins / price);
    if (buy > 0) {
      run.coins -= buy * price;
      openAll(1, buy, run);
    }
    run.coins += sellOptimal(run);
    const worth = run.coins;
    daily.push(worth);
    if (worth >= brokeLine && brokeUntil < 0) brokeUntil = day + 1;
  }
  return { final: daily[daily.length - 1], escapedOnDay: brokeUntil, daily };
}

console.log('── 파산 회생 (골드 0 · 재료 0 에서 시작, 매일 최적 플레이) ──');
console.log(
  `지원: 일일 Lv1 상자 ${DAILY_CRATES_SIM}개 + ${num(DAILY_COINS_SIM)} G / ` +
    `구제 상자 ${RESCUE_CRATES_SIM}개 + ${num(RESCUE_COINS_SIM)} G ×${RESCUE_LIMIT_SIM}회 (파산 중일 때만)`,
);
const RECOVERY_RUNS = 60;
for (const support of [true, false]) {
  let escaped = 0;
  let sumDay = 0;
  let sumFinal = 0;
  let worstFinal = Infinity;
  for (let i = 0; i < RECOVERY_RUNS; i++) {
    const r = simulateRecovery(14, { support });
    if (r.escapedOnDay > 0) {
      escaped++;
      sumDay += r.escapedOnDay;
    }
    sumFinal += r.final;
    worstFinal = Math.min(worstFinal, r.final);
  }
  const label = support ? '지원 있음' : '지원 없음(참고)';
  console.log(
    `  ${label.padEnd(16)} 파산 탈출 ${escaped}/${RECOVERY_RUNS}회` +
      (escaped ? ` (평균 ${(sumDay / escaped).toFixed(1)}일)` : '        ') +
      `  14일 뒤 평균 ${num(sumFinal / RECOVERY_RUNS).padStart(9)} G  최악 ${num(worstFinal).padStart(8)} G` +
      `  ${support ? (escaped === RECOVERY_RUNS ? '✔' : '✘') : ''}`,
  );
}
console.log();
process.exit(fail === 0 ? 0 : 1);
