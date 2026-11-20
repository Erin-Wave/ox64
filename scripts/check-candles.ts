// npm run check:candles — 가상 코인 1분봉 묶음(functions/api/spot.ts § 닫힌 1분봉 묶음)의 저장·조회 규칙 점검.
//
// 왜 있는가: 봇이 만든 1분봉은 분마다 한 행이 아니라 ①상태 행의 대기 묶음에 모였다가 ②그 시간이 끝나면 한 시간치 한 행으로
// 넘어간다(2026-11-20, D1 쓰기 절감). 그래서 1분봉 하나가 사는 곳이 넷이다(분 단위 행 · 묶음 테이블 · 대기 묶음 · 진행 중 봉).
// 여기서 틀리면 **차트 과거가 조용히 틀어진다** — 봉이 사라지거나, 두 번 세어져 거래량이 배가 되거나, 넘어가는 순간 시가·종가가
// 바뀐다. 캔들의 저장 형식·넘기는 시점·합치는 규칙을 바꿨으면 반드시 돌릴 것. 합격 = 세 점검 모두 불일치 0.
//
//   A. 부호화 왕복  — 봉 → 텍스트 → 봉이 한 비트도 안 바뀐다
//   B. 넘기기       — 닫힌 봉을 무작위 간격으로 흘려보내며(한산한 구간·시계가 뒤로 가는 틱 포함) 매 순간
//                     "지금까지 닫힌 봉 = 테이블 + 대기 묶음"(빠짐·중복 없음), 테이블 행에는 그 시간의 봉만
//   C. 합치기       — 네 출처에 무작위로 흩은 봉(같은 봉이 두 곳에 보이는 경합 포함)을 합친 결과가 느린 교과서 식과 같다
import { advancePack, assembleSourceBars, encodePackBar, parsePack } from '../functions/api/spot';

interface Bar {
  b: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  ot?: number;
  ct?: number;
  bv?: number;
  sv?: number;
}
interface Row {
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  open_at: number;
  close_at: number;
  buy_volume: number | null;
  sell_volume: number | null;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR;

// 재현 가능한 난수(mulberry32)
let seed = 20261120;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

/** 그럴듯한 봉 하나 — 가격은 유효숫자 4자리, 거래량은 정수이거나 소수(부동소수 잡음 포함). */
function randomBar(bucket: number, usedTimes?: Set<number>): Bar {
  const base = Math.pow(10, int(-3, 5)) * (1 + rnd() * 8.999);
  const px = () => Number((base * (1 + (rnd() - 0.5) * 0.01)).toPrecision(4));
  const ps = [px(), px(), px(), px()];
  const v = rnd() < 0.7 ? int(1, 5_000_000) : rnd() * 10_000 + 0.1 + 0.2; // 0.30000000000000004 같은 값도 그대로 왕복해야 한다
  const bv = rnd() * v;
  const pick = () => {
    for (;;) {
      const t = bucket + int(0, MIN - 1);
      if (!usedTimes || !usedTimes.has(t)) {
        usedTimes?.add(t);
        return t;
      }
    }
  };
  const t1 = pick();
  const t2 = pick();
  const bar: Bar = { b: bucket, o: ps[0], h: Math.max(...ps), l: Math.min(...ps), c: ps[3], v, ot: Math.min(t1, t2), ct: Math.max(t1, t2) };
  if (rnd() < 0.95) {
    bar.bv = bv;
    bar.sv = v - bv;
  }
  return bar;
}

const same = (a: Bar, b: Bar) => encodePackBar(a) === encodePackBar(b);
let failed = 0;
const fail = (msg: string) => {
  failed++;
  if (failed <= 10) console.log('  ✗ ' + msg);
};

// ── A. 부호화 왕복 ─────────────────────────────────────────────────────────────────────────
{
  const N = 50_000;
  let bad = 0;
  const T0 = Math.floor(Date.UTC(2026, 10, 20) / MIN) * MIN;
  const bars: Bar[] = [];
  for (let i = 0; i < N; i++) bars.push(randomBar(T0 + int(0, 500_000) * MIN));
  // 한 봉씩
  for (const bar of bars) {
    const back = parsePack(encodePackBar(bar));
    if (back.length !== 1) {
      bad++;
      continue;
    }
    const r = back[0];
    const eq =
      r.b === bar.b && r.o === bar.o && r.h === bar.h && r.l === bar.l && r.c === bar.c && r.v === bar.v && r.ot === bar.ot && r.ct === bar.ct && r.bv === bar.bv && r.sv === bar.sv;
    if (!eq) bad++;
  }
  // 여러 봉을 이은 텍스트
  const joined = parsePack(bars.slice(0, 5000).map(encodePackBar).join(','));
  if (joined.length !== 5000 || joined.some((r, i) => !same(r, bars[i]))) bad++;
  // 깨진 입력은 던지지 않고 버린다
  if (parsePack('[1,2,3').length !== 0 || parsePack(null).length !== 0 || parsePack('').length !== 0) bad++;
  if (parsePack('[29919026,1,1,1,1,5,0,0,null,null],"x",[1],[29919027,2,2,2,2,7,10,20,3,4]').length !== 2) bad++;
  const avg = bars.slice(0, 5000).map(encodePackBar).join(',').length / 5000;
  console.log(`A. 부호화 왕복        ${N.toLocaleString()}봉 · 불일치 ${bad} · 봉당 평균 ${avg.toFixed(0)}자`);
  if (bad) fail(`부호화 왕복 불일치 ${bad}`);
}

// ── B. 넘기기 ──────────────────────────────────────────────────────────────────────────────
{
  const T0 = hourOf(Date.UTC(2026, 10, 20, 3));
  const DAYS = 40;
  let now = T0 + int(0, MIN - 1);
  let live: Bar | null = null; // 진행 중 1분봉
  let pending: string | null = null; // 상태 행의 대기 묶음
  const table = new Map<number, string>(); // 묶음 테이블(시간 → bars)
  const allClosed: Bar[] = []; // 지금까지 닫힌 봉(정답)
  let commits = 0;
  let flushStmts = 0;
  let backwards = 0;
  let maxPendingBars = 0;
  let maxPendingChars = 0;
  let bad = 0;
  const flushesPerHour = new Map<number, number>();

  const audit = (liveBucket: number) => {
    const got: string[] = [];
    for (const [hour, text] of table) {
      for (const b of parsePack(text)) {
        if (hourOf(b.b) !== hour) bad++; // 테이블 행에는 그 시간의 봉만
        got.push(encodePackBar(b));
      }
    }
    const pend = parsePack(pending);
    for (const b of pend) got.push(encodePackBar(b));
    // 다 끝난 시간의 봉은 대기 묶음에 남지 않는다(맨 앞 봉이 진행 중 시간인데 뒤에 옛 봉이 섞인 경우 = 시계 역행만 예외)
    if (pend.length && hourOf(pend[0].b) < hourOf(liveBucket)) bad++;
    const want = allClosed.map(encodePackBar).sort();
    got.sort();
    if (want.length !== got.length || want.some((w, i) => w !== got[i])) bad++;
  };

  while (now < T0 + DAYS * 86_400_000) {
    // 다음 커밋까지의 간격 — 보고 있을 때(1초) · cron(60초) · 한산해서 체결이 없던 구간(몇 분~몇 시간)
    const r = rnd();
    now += r < 0.5 ? int(900, 1100) : r < 0.93 ? int(55_000, 65_000) : r < 0.995 ? int(2, 20) * MIN : int(1, 5) * HOUR;
    let t = now;
    if (rnd() < 0.002) {
      t = now - int(1, 90) * 1000; // 시계가 뒤로 간 틱(다른 isolate 의 시계)
      backwards++;
    }
    const bucket = Math.floor(t / MIN) * MIN;
    const closed: Bar[] = [];
    // accrueLive 와 같은 규칙: 버킷이 바뀌면 옛 봉을 닫되, 미래 버킷이면(시계 역행) 닫지 않고 버린다
    if (!live || live.b !== bucket) {
      if (live && live.b < bucket) {
        closed.push(live);
        allClosed.push(live);
      }
      live = randomBar(bucket);
    }
    const res = advancePack(pending, closed, live.b);
    for (const g of res.flush) {
      flushStmts++;
      flushesPerHour.set(g.bucket, (flushesPerHour.get(g.bucket) ?? 0) + 1);
      table.set(g.bucket, table.has(g.bucket) ? `${table.get(g.bucket)},${g.bars}` : g.bars); // PACK_FLUSH_SQL 의 ON CONFLICT
    }
    pending = res.pending;
    commits++;
    const n = pending ? parsePack(pending).length : 0;
    maxPendingBars = Math.max(maxPendingBars, n);
    maxPendingChars = Math.max(maxPendingChars, pending?.length ?? 0);
    if (commits % 97 === 0 || res.flush.length) audit(live.b);
  }
  audit(live!.b);
  const hours = table.size;
  const multi = [...flushesPerHour.values()].filter((n) => n > 1).length;
  console.log(
    `B. 넘기기             ${DAYS}일 · 커밋 ${commits.toLocaleString()} · 닫힌 봉 ${allClosed.length.toLocaleString()} · 묶음 ${hours}행(문장 ${flushStmts}) · 불일치 ${bad}`,
  );
  console.log(
    `                      한 시간에 문장 2개 이상 ${multi}시간(시계 역행 ${backwards}회) · 대기 묶음 최대 ${maxPendingBars}봉 / ${maxPendingChars.toLocaleString()}자`,
  );
  if (bad) fail(`넘기기 불일치 ${bad}`);
  if (maxPendingBars > 120) fail(`대기 묶음이 두 시간치를 넘었다(${maxPendingBars}봉)`);
  if (flushStmts > hours * 1.05) fail(`넘기는 문장이 시간 수보다 5% 넘게 많다(${flushStmts} / ${hours})`);
}

// ── C. 합치기 ──────────────────────────────────────────────────────────────────────────────
{
  /** 교과서 식 — 그 분에 들어온 모든 조각: 시가 = 가장 이른 시각, 종가 = 가장 늦은 시각, 고저 = 극값, 거래량 = 합. */
  const naive = (parts: Bar[]): Row => {
    let first = parts[0];
    let last = parts[0];
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    let buy: number | null = null;
    let sell: number | null = null;
    for (const p of parts) {
      if (p.ot! < first.ot!) first = p;
      if (p.ct! > last.ct!) last = p;
      hi = Math.max(hi, p.h);
      lo = Math.min(lo, p.l);
      vol += p.v;
      if (p.bv != null) buy = (buy ?? 0) + p.bv;
      if (p.sv != null) sell = (sell ?? 0) + p.sv;
    }
    return { bucket: first.b, open: first.o, high: hi, low: lo, close: last.c, volume: vol, open_at: first.ot!, close_at: last.ct!, buy_volume: buy, sell_volume: sell };
  };
  const close = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

  const ROUNDS = 400;
  let bad = 0;
  let bars = 0;
  let dups = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const T0 = hourOf(Date.UTC(2026, 10, 1)) + int(0, 2000) * HOUR;
    const minutes = int(30, 600);
    const liveBucket = T0 + (minutes - 1) * MIN;
    const byBucket = new Map<number, Bar[]>(); // 정답용: 분 → 모든 조각
    const rowParts = new Map<number, Bar[]>(); // 분 단위 행으로 갈 조각(유저 체결·옛 봇 봉)
    const packText = new Map<number, string[]>(); // 시간 → 묶음 조각들
    const pend: string[] = [];
    let live: Bar | undefined;
    const put = (b: Bar) => {
      const g = byBucket.get(b.b);
      if (g) g.push(b);
      else byBucket.set(b.b, [b]);
    };
    for (let m = 0; m < minutes; m++) {
      const bucket = T0 + m * MIN;
      if (rnd() < 0.06) continue; // 체결 없던 분
      const used = new Set<number>(); // 한 분 안에서 시각이 겹치지 않게(겹치면 "먼저 넣은 쪽"이 이겨 정답이 순서에 달린다)
      const isLive = bucket === liveBucket;
      // 봇 봉 — 어디에 사는가: 옛 구간은 분 단위 행, 그 뒤는 묶음, 진행 중 시간은 대기 묶음, 마지막 분은 진행 중 봉
      if (rnd() < 0.97) {
        const bot = randomBar(bucket, used);
        put(bot);
        if (isLive) {
          live = bot;
          if (rnd() < 0.3) {
            pend.push(encodePackBar(bot)); // 경합: 같은 봉이 대기 묶음에도 보인다 → 한 번만
            dups++;
          }
        } else if (m < minutes * 0.3) {
          const g = rowParts.get(bucket);
          if (g) g.push(bot);
          else rowParts.set(bucket, [bot]);
        } else if (hourOf(bucket) === hourOf(liveBucket) && rnd() < 0.9) {
          pend.push(encodePackBar(bot));
        } else {
          const h = hourOf(bucket);
          const g = packText.get(h) ?? [];
          g.push(encodePackBar(bot));
          packText.set(h, g);
          if (rnd() < 0.05) {
            pend.push(encodePackBar(bot)); // 경합: 방금 테이블로 넘어간 봉이 대기 묶음에도 → 한 번만
            dups++;
          }
          if (rnd() < 0.03) {
            // 같은 분이 한 번 더 닫힌 경우(시계 역행) — 다른 조각이라 둘 다 합쳐야 한다
            const again = randomBar(bucket, used);
            put(again);
            g.push(encodePackBar(again));
          }
        }
      }
      // 유저 체결(분 단위 행) — 0~3건
      for (let k = int(0, 3) - 1; k > 0; k--) {
        const u = randomBar(bucket, used);
        u.ct = u.ot; // 유저 체결은 한 순간에 끝난다
        put(u);
        const g = rowParts.get(bucket);
        if (g) g.push(u);
        else rowParts.set(bucket, [u]);
      }
    }
    const rows: Row[] = [...rowParts.values()].map(naive); // 분 단위 행은 SQL upsert 가 이미 합쳐 둔 것
    // 묶음 행 순서·조각 순서를 뒤섞는다(조회는 내림차순으로 읽고, 덧붙은 조각은 뒤에 온다)
    const packs = [...packText.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => ({ bars: parts.join(',') }));
    // 구간도 무작위로 — 구간 밖 봉은 빠져야 한다
    const from = rnd() < 0.5 ? -Infinity : T0 + int(0, minutes - 1) * MIN;
    const to = rnd() < 0.5 ? Infinity : T0 + int(1, minutes) * MIN;
    const got = assembleSourceBars(rows as never, packs, pend.join(',') || null, live as never, from, to) as Row[];
    const want = [...byBucket.entries()]
      .filter(([b]) => b >= from && b < to)
      .sort((a, b) => a[0] - b[0])
      .map(([, parts]) => naive(parts));
    bars += want.length;
    if (got.length !== want.length) {
      bad++;
      continue;
    }
    for (let i = 0; i < want.length; i++) {
      const g = got[i];
      const w = want[i];
      const ok =
        g.bucket === w.bucket &&
        g.open === w.open &&
        g.close === w.close &&
        g.high === w.high &&
        g.low === w.low &&
        g.open_at === w.open_at &&
        g.close_at === w.close_at &&
        close(g.volume, w.volume) &&
        close(g.buy_volume, w.buy_volume) &&
        close(g.sell_volume, w.sell_volume);
      if (!ok) {
        bad++;
        if (bad <= 3) console.log('    got ', JSON.stringify(g), '\n    want', JSON.stringify(w));
      }
    }
  }
  console.log(`C. 합치기             ${ROUNDS}판 · ${bars.toLocaleString()}봉 · 두 곳에 보인 봉 ${dups} · 불일치 ${bad}`);
  if (bad) fail(`합치기 불일치 ${bad}`);
}

if (failed) {
  console.log(`\n❌ 실패 ${failed}건`);
  process.exit(1);
}
console.log('\n✅ 1분봉 묶음 — 빠진 봉·두 번 센 봉·바뀐 시가/종가 없음');
