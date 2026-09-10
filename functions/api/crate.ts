import { type Ctx, type Env, bad, json, safe, missingEnv, getSession, todayKst } from '../_shared';
import {
  CATS,
  CAT_BY_KEY,
  CRATES,
  CRATE_BY_LEVEL,
  BROKE_CRATES,
  DAILY_COINS,
  DAILY_CRATES,
  RESCUE_COINS,
  RESCUE_CRATES,
  RESCUE_DAILY_LIMIT,
  JACKPOTS,
  MAX_OPEN_AT_ONCE,
  MERGE_MULT,
  SHARD_CRATE_ODDS,
  SHOP_MAX_BUY,
  START_COINS,
  invKey,
  isValidMat,
  matValue,
  parseInvKey,
  rollCrate,
  rollShardCrate,
  slotsOf,
  type MatCat,
  type RewardItem,
} from '../_crateData';

/**
 * GET  /api/crate
 * POST /api/crate { action: 'buy',    level, count }
 * POST /api/crate { action: 'open',   level, count }
 * POST /api/crate { action: 'merge',  cat, level, times }   ← shard 최고 레벨이면 랜덤 상자가 나온다
 * POST /api/crate { action: 'mergeAll' }
 * POST /api/crate { action: 'sell',   cat, level, count }    ← count 생략/음수면 전량
 * POST /api/crate { action: 'sellAll', maxLevel }            ← 그 레벨 이하 재료 일괄 판매(상자조각 제외)
 * POST /api/crate { action: 'refill' }
 *
 * "상자깡"(ox64.app/c) — 상자를 까서 재료·돈을 얻고, 같은 재료 2개를 합쳐(merge) 레벨을 올려 값을
 * 불리는 미니게임. 코인 트레이딩·퍼즐·던전과 완전히 분리된 별도 재화(crate_stats.coins)이고 계정만
 * 공유한다(세션 쿠키).
 *
 * ⚠ 서버 권위: 드롭 추첨(rollCrate)·머지·판매·잔고를 전부 서버가 계산한다. 클라가 보내는 건
 * "무엇을 몇 개" 뿐이고 결과값은 절대 신뢰하지 않는다(트레이딩의 "체결가는 서버가 fetch" 와 같은 사상).
 *
 * ⚠ D1 비용(§6): 한 요청이 **읽기 1행 + 쓰기 1행**이다. 유저의 모든 상태(코인·인벤토리·보유 상자·
 * 도감·통계)가 crate_stats 한 행에 JSON 칸으로 들어있어서, 상자를 10개 까든 재료가 30종이든 쓰기가
 * 늘지 않는다. **아이템을 행으로 쪼개는 설계로 되돌리지 말 것** — 개봉 한 번이 수십 행이 된다.
 * 폴링도 없다(싱글플레이라 남의 상태를 볼 이유가 없다).
 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(() => handleGet(request, env));
}
export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handlePost(request, env));
}

interface CrateRow {
  user_id: string;
  coins: number;
  inv_json: string;
  crates_json: string;
  seen_json: string;
  opened: number;
  merged: number;
  spent: number;
  earned: number;
  best_coins: number;
  jackpots: number;
  version: number;
  refill_count: number;
  refill_date: string | null;
}

/** 메모리에서 굴리는 작업 상태 — 계산이 끝나면 통째로 한 문장에 커밋한다. */
interface Work {
  row: CrateRow;
  inv: Record<string, number>;
  crates: Record<string, number>;
  seen: Set<string>;
  coins: number;
  opened: number;
  merged: number;
  spent: number;
  earned: number;
  jackpots: number;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * ⚠ `schema.sql` 의 `crate_stats` 정의와 **한 글자도 다르면 안 된다** — 아래 자동 생성이 쓰는 SQL 이다.
 * 컬럼을 추가할 땐 이 문자열과 schema.sql 을 같이 고칠 것(신규 DB 는 schema.sql, prod 는 이쪽이 만든다).
 */
const CREATE_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS crate_stats (' +
  "user_id TEXT PRIMARY KEY, coins REAL NOT NULL DEFAULT 600, inv_json TEXT NOT NULL DEFAULT '{}'," +
  " crates_json TEXT NOT NULL DEFAULT '{}', seen_json TEXT NOT NULL DEFAULT '[]'," +
  ' opened INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0, spent REAL NOT NULL DEFAULT 0,' +
  ' earned REAL NOT NULL DEFAULT 0, best_coins REAL NOT NULL DEFAULT 600, jackpots INTEGER NOT NULL DEFAULT 0,' +
  ' version INTEGER NOT NULL DEFAULT 0, refill_count INTEGER NOT NULL DEFAULT 0, refill_date TEXT,' +
  ' created_at INTEGER NOT NULL)';

/**
 * 상태 행을 읽는다. 없으면 INSERT 하되 **없을 때만** 쓴다(계정당 평생 1회) — 던전에서 배운 교훈:
 * 매 요청 `INSERT OR IGNORE` 를 때리면 그 자체가 쓰기 비용이 된다(§8).
 *
 * ⚠ 테이블 자체가 없으면 **그 자리에서 만든다**. 이 프로젝트의 원칙은 "마이그레이션을 코드 배포보다
 * 먼저"(§5)지만, 그건 **기존 테이블에 컬럼을 더하는 경우**의 규칙이다(그건 자동화가 위험하다 — 잘못된
 * 순서로 돌면 이미 도는 거래 batch 가 통째로 롤백된다). 이건 완전히 격리된 신규 테이블이고 `CREATE
 * TABLE IF NOT EXISTS` 라 멱등하며, 여러 요청이 동시에 들어와도 안전하다. 정상 경로(테이블이 이미
 * 있는 경우)에서는 catch 가 아예 안 타므로 **쿼리·비용 증가가 0** 이다.
 * ⚠ 그래도 새 컬럼을 더할 땐 이 자동 생성에 기대지 말 것 — `IF NOT EXISTS` 는 컬럼을 더해주지 않는다.
 */
async function loadRow(env: Env, uid: string): Promise<CrateRow> {
  let row: CrateRow | null = null;
  try {
    row = await env.DB.prepare('SELECT * FROM crate_stats WHERE user_id = ?').bind(uid).first<CrateRow>();
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
    await env.DB.prepare(CREATE_TABLE_SQL).run();
  }
  if (row) return row;
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO crate_stats (user_id, coins, best_coins, created_at) VALUES (?,?,?,?)')
    .bind(uid, START_COINS, START_COINS, now)
    .run();
  return {
    user_id: uid,
    coins: START_COINS,
    inv_json: '{}',
    crates_json: '{}',
    seen_json: '[]',
    opened: 0,
    merged: 0,
    spent: 0,
    earned: 0,
    best_coins: START_COINS,
    jackpots: 0,
    version: 0,
    refill_count: 0,
    refill_date: null,
  };
}

function toWork(row: CrateRow): Work {
  const inv = parseJson<Record<string, number>>(row.inv_json, {});
  const crates = parseJson<Record<string, number>>(row.crates_json, {});
  const seenArr = parseJson<string[]>(row.seen_json, []) as string[];
  return {
    row,
    inv,
    crates,
    seen: new Set(Array.isArray(seenArr) ? seenArr : []),
    coins: row.coins,
    opened: row.opened,
    merged: row.merged,
    spent: row.spent,
    earned: row.earned,
    jackpots: row.jackpots,
  };
}

const invCount = (w: Work, cat: MatCat, level: number) => w.inv[invKey(cat, level)] ?? 0;
function addMat(w: Work, cat: MatCat, level: number, n: number) {
  const k = invKey(cat, level);
  const next = (w.inv[k] ?? 0) + n;
  if (next <= 0) delete w.inv[k];
  else w.inv[k] = next;
  if (n > 0) w.seen.add(k);
}
function addCrate(w: Work, level: number, n: number) {
  const k = String(level);
  const next = (w.crates[k] ?? 0) + n;
  if (next <= 0) delete w.crates[k];
  else w.crates[k] = next;
}

/**
 * 계산 결과를 한 문장으로 커밋한다. `WHERE version = ?` 가드가 read-modify-write 의 lost update 를
 * 막는다 — 인벤토리 전체가 JSON 한 칸이라 두 요청이 겹치면 뒤에 쓴 쪽이 상대의 보상을 통째로
 * 지워버릴 수 있다(더블클릭 한 번이면 재현된다). 0행이면 호출자가 "다시 시도"를 돌려준다.
 */
async function commit(env: Env, w: Work, extra?: { refillCount: number; refillDate: string }): Promise<boolean> {
  const bestCoins = Math.max(w.row.best_coins, w.coins);
  const res = await env.DB.prepare(
    'UPDATE crate_stats SET coins=?, inv_json=?, crates_json=?, seen_json=?, opened=?, merged=?, spent=?, earned=?,' +
      ' best_coins=?, jackpots=?, refill_count=?, refill_date=?, version=version+1 WHERE user_id=? AND version=?',
  )
    .bind(
      w.coins,
      JSON.stringify(w.inv),
      JSON.stringify(w.crates),
      JSON.stringify([...w.seen]),
      w.opened,
      w.merged,
      w.spent,
      w.earned,
      bestCoins,
      w.jackpots,
      extra ? extra.refillCount : w.row.refill_count,
      extra ? extra.refillDate : w.row.refill_date,
      w.row.user_id,
      w.row.version,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ── 응답 ────────────────────────────────────────────────────────────────────────

/** 재료 인벤토리를 전부 팔았을 때의 값 — 리필 자격(빈털터리 판정)과 "총자산" 표시에 쓴다. */
function inventoryValue(w: Work): number {
  let sum = 0;
  for (const [k, n] of Object.entries(w.inv)) {
    const parsed = parseInvKey(k);
    if (parsed) sum += matValue(parsed.cat, parsed.level) * n;
  }
  return sum;
}
function crateValue(w: Work): number {
  let sum = 0;
  for (const [k, n] of Object.entries(w.crates)) sum += (CRATE_BY_LEVEL.get(Number(k))?.price ?? 0) * n;
  return sum;
}

/**
 * 확률 공시 — 상점에 그대로 표시한다(가챠 확률 공개). 클라에 드롭 테이블을 중복 정의하지 않고
 * 서버 값을 그대로 렌더하게 하는 건 VIP 등급표(loadState.vipTiers)와 같은 패턴이다.
 */
function shopPayload() {
  return CRATES.map((def) => ({
    level: def.level,
    name: def.name,
    emoji: def.emoji,
    price: def.price,
    desc: def.desc,
    odds: slotsOf(def.level).map((s) => ({
      p: s.p,
      jackpot: s.jackpot ?? null,
      kind: s.drop.kind,
      cat: s.drop.kind === 'mat' ? s.drop.cat : null,
      level: s.drop.kind === 'coin' ? 0 : s.drop.level,
      min: s.drop.min,
      max: s.drop.max,
    })),
  }));
}

function statePayload(w: Work) {
  const today = todayKst();
  const usedToday = w.row.refill_date === today ? w.row.refill_count : 0;
  const invValue = inventoryValue(w);
  const netWorth = w.coins + invValue + crateValue(w);
  const cheapest = CRATES[0].price;
  return {
    coins: w.coins,
    inv: w.inv,
    crates: w.crates,
    seen: [...w.seen],
    invValue,
    netWorth,
    stats: {
      opened: w.opened,
      merged: w.merged,
      spent: w.spent,
      earned: w.earned,
      bestCoins: Math.max(w.row.best_coins, w.coins),
      jackpots: w.jackpots,
    },
    /** 오늘 일일 지원을 아직 안 받았나 — 조건 없이 누구나 하루 한 번 받는다. */
    dailyReady: usedToday === 0,
    /** 남은 파산 구제 횟수(일일 지원과 별개). */
    rescueLeft: Math.max(0, RESCUE_DAILY_LIMIT - Math.max(0, usedToday - 1)),
    /**
     * 파산 판정 — 가진 걸 전부 팔아도 상자를 몇 개도 못 사는 상태. 예전엔 "가장 싼 상자 1개"
     * (100골드) 였는데, 상자 하나로는 같은 재료가 안 모여 머지가 성립하지 않으므로 회생이 안 된다.
     */
    broke: netWorth < cheapest * BROKE_CRATES,
    // ── 클라가 중복 정의하면 안 되는 기준표(서버가 진실원본) ──
    mergeMult: MERGE_MULT,
    cats: CATS.map((c) => ({
      cat: c.cat,
      name: c.name,
      emoji: c.emoji,
      color: c.color,
      maxLevel: c.maxLevel,
      desc: c.desc,
      values: Array.from({ length: c.maxLevel }, (_, i) => matValue(c.cat, i + 1)),
    })),
    shop: shopPayload(),
    shardOdds: SHARD_CRATE_ODDS,
    jackpotTiers: JACKPOTS.map((j) => ({ tier: j.tier, p: j.p, mult: j.mult, label: j.label })),
    limits: {
      maxBuy: SHOP_MAX_BUY,
      maxOpen: MAX_OPEN_AT_ONCE,
      dailyCrates: DAILY_CRATES,
      dailyCoins: DAILY_COINS,
      rescueCrates: RESCUE_CRATES,
      rescueCoins: RESCUE_COINS,
      brokeCrates: BROKE_CRATES,
    },
  };
}

// ── 랭킹 ────────────────────────────────────────────────────────────────────────

interface BoardRow {
  user_id: string;
  name: string;
  coins: number;
  inv_json: string;
  crates_json: string;
  opened: number;
  merged: number;
  jackpots: number;
  best_coins: number;
}

/** 랭킹에 실어 보낼 한 사람 — 재료·상자는 값으로 환산해 "총자산"까지 같이 준다. */
export interface BoardEntry {
  name: string;
  me: boolean;
  coins: number;
  netWorth: number;
  opened: number;
  merged: number;
  jackpots: number;
  bestCoins: number;
}

const BOARD_LIMIT = 100;

/**
 * 소지 골드 순위.
 *
 * ⚠ D1 비용(§6): **읽기 한 쿼리, 쓰기 0**. 정렬은 `coins` 컬럼으로 SQL 이 하고 `LIMIT` 으로 자른다 —
 * 총자산(재료+상자 환산)은 JSON 을 파싱해야 나오는 파생값이라 SQL 로는 못 자르기 때문에, 상위 100명을
 * 먼저 뽑고 그 안에서만 계산한다. 지금 이 게임의 유저 수는 두 자리라 사실상 전부 들어오지만, 유저가
 * 늘어도 한 요청이 읽는 행 수가 100 을 안 넘게 묶어두는 게 목적이다.
 * ⚠ 랭킹은 **열려 있는 동안 5초마다** 폴링되므로(트레이딩 랭킹과 같은 주기) 여기에 쓰기를 추가하면
 * 그게 곧 "스스로 반복해서 도는 쓰기 경로"가 된다(§6). 읽기 전용으로 유지할 것.
 */
async function loadBoard(env: Env, uid: string) {
  const res = await env.DB.prepare(
    'SELECT c.user_id, u.name, c.coins, c.inv_json, c.crates_json, c.opened, c.merged, c.jackpots, c.best_coins' +
      ' FROM crate_stats c JOIN users u ON u.id = c.user_id ORDER BY c.coins DESC LIMIT ?',
  )
    .bind(BOARD_LIMIT)
    .all<BoardRow>();

  const entries: BoardEntry[] = (res.results ?? []).map((r) => {
    const inv = parseJson<Record<string, number>>(r.inv_json, {});
    const crates = parseJson<Record<string, number>>(r.crates_json, {});
    let held = 0;
    for (const [k, n] of Object.entries(inv)) {
      const parsed = parseInvKey(k);
      if (parsed) held += matValue(parsed.cat, parsed.level) * n;
    }
    for (const [k, n] of Object.entries(crates)) held += (CRATE_BY_LEVEL.get(Number(k))?.price ?? 0) * n;
    return {
      name: r.name,
      me: r.user_id === uid,
      coins: r.coins,
      netWorth: r.coins + held,
      opened: r.opened,
      merged: r.merged,
      jackpots: r.jackpots,
      bestCoins: r.best_coins,
    };
  });
  return { entries, updatedAt: Date.now() };
}

async function handleGet(request: Request, env: Env): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  // ?board=1 이면 랭킹만 — 5초마다 폴링되는 경로라 내 인벤토리·상점표까지 실어 보낼 이유가 없다.
  if (new URL(request.url).searchParams.get('board') === '1') return json(await loadBoard(env, sess.uid));
  return json(statePayload(toWork(await loadRow(env, sess.uid))));
}

const RETRY_MSG = '동시에 처리된 요청이 있습니다. 다시 시도해주세요';

async function handlePost(request: Request, env: Env): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  const uid = sess.uid;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad('invalid json');
  }

  const w = toWork(await loadRow(env, uid));
  const action = String(body.action ?? '');

  // ── 상자 구매 ────────────────────────────────────────────────────────────────
  if (action === 'buy') {
    const level = Math.round(Number(body.level));
    const count = Math.round(Number(body.count ?? 1));
    const def = CRATE_BY_LEVEL.get(level);
    if (!def) return bad('없는 상자입니다');
    if (!(count >= 1 && count <= SHOP_MAX_BUY)) return bad(`한 번에 1~${SHOP_MAX_BUY}개까지 살 수 있습니다`);
    const cost = def.price * count;
    if (w.coins < cost) return bad(`골드가 부족합니다 (${cost.toLocaleString()} 필요)`);
    w.coins -= cost;
    w.spent += cost;
    addCrate(w, level, count);
    if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
    return json({ ...statePayload(w), bought: { level, count, cost } });
  }

  // ── 상자 개봉 ────────────────────────────────────────────────────────────────
  if (action === 'open') {
    const level = Math.round(Number(body.level));
    const count = Math.round(Number(body.count ?? 1));
    if (!CRATE_BY_LEVEL.has(level)) return bad('없는 상자입니다');
    if (!(count >= 1 && count <= MAX_OPEN_AT_ONCE)) return bad(`한 번에 1~${MAX_OPEN_AT_ONCE}개까지 깔 수 있습니다`);
    const have = w.crates[String(level)] ?? 0;
    if (have < count) return bad('보유한 상자가 부족합니다');
    addCrate(w, level, -count);

    // 상자별 결과를 따로 담는다 — 클라가 한 상자씩 차례로 애니메이션을 재생한다.
    const results: RewardItem[][] = [];
    let jackpotHit = 0;
    for (let i = 0; i < count; i++) {
      const rewards = rollCrate(level);
      for (const r of rewards) {
        if (r.jackpot) jackpotHit++;
        if (r.kind === 'coin') {
          w.coins += r.count;
          w.earned += r.count;
        } else if (r.kind === 'mat' && r.cat) {
          addMat(w, r.cat, r.level, r.count);
        } else if (r.kind === 'crate') {
          addCrate(w, r.level, r.count);
        }
      }
      results.push(rewards);
    }
    w.opened += count;
    w.jackpots += jackpotHit;
    if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
    return json({ ...statePayload(w), opened: { level, count, results } });
  }

  // ── 머지 ─────────────────────────────────────────────────────────────────────
  // 같은 카테고리·같은 레벨 2개 → 다음 레벨 1개. 카테고리는 절대 안 바뀐다.
  // 상자조각만 예외: 최고 레벨(Lv4) 2개는 다음 레벨이 없으므로 **랜덤 상자**가 된다.
  if (action === 'merge') {
    const cat = String(body.cat ?? '') as MatCat;
    const level = Math.round(Number(body.level));
    const times = Math.max(1, Math.round(Number(body.times ?? 1)));
    if (!isValidMat(cat, level)) return bad('없는 재료입니다');
    const def = CAT_BY_KEY.get(cat)!;
    const have = invCount(w, cat, level);
    if (have < 2 * times) return bad('재료가 부족합니다 (2개가 필요합니다)');

    if (level >= def.maxLevel) {
      if (cat !== 'shard') return bad(`${def.name}은(는) Lv${def.maxLevel}이 최고 레벨입니다`);
      // 상자조각 Lv4 2개 → 랜덤 상자 1개(확률적으로 더 높은 레벨이 나온다)
      const gained: number[] = [];
      for (let i = 0; i < times; i++) {
        const lv = rollShardCrate();
        addCrate(w, lv, 1);
        gained.push(lv);
      }
      addMat(w, cat, level, -2 * times);
      w.merged += times;
      if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
      return json({ ...statePayload(w), shardCrates: gained });
    }

    addMat(w, cat, level, -2 * times);
    addMat(w, cat, level + 1, times);
    w.merged += times;
    if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
    return json({ ...statePayload(w), merged: { cat, from: level, to: level + 1, times } });
  }

  // ── 전부 머지 ────────────────────────────────────────────────────────────────
  // 낮은 레벨부터 올려서 연쇄시킨다(Lv1 4개 → Lv2 2개 → Lv3 1개가 한 번에 된다).
  // ⚠ 상자조각 최고 레벨은 **건드리지 않는다** — 그건 상자를 뽑는 도박이라 유저가 직접 눌러야 한다.
  if (action === 'mergeAll') {
    let total = 0;
    for (const def of CATS) {
      for (let lv = 1; lv < def.maxLevel; lv++) {
        const have = invCount(w, def.cat, lv);
        const pairs = Math.floor(have / 2);
        if (pairs <= 0) continue;
        addMat(w, def.cat, lv, -2 * pairs);
        addMat(w, def.cat, lv + 1, pairs);
        total += pairs;
      }
    }
    if (total === 0) return bad('합칠 수 있는 재료가 없습니다');
    w.merged += total;
    if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
    return json({ ...statePayload(w), mergedAll: total });
  }

  // ── 판매 ─────────────────────────────────────────────────────────────────────
  if (action === 'sell') {
    const cat = String(body.cat ?? '') as MatCat;
    const level = Math.round(Number(body.level));
    if (!isValidMat(cat, level)) return bad('없는 재료입니다');
    const have = invCount(w, cat, level);
    if (have <= 0) return bad('보유한 재료가 없습니다');
    const asked = Number(body.count);
    const count = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), have) : have;
    const gain = matValue(cat, level) * count;
    addMat(w, cat, level, -count);
    w.coins += gain;
    w.earned += gain;
    if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
    return json({ ...statePayload(w), sold: { cat, level, count, gain } });
  }

  // ── 일괄 판매 ────────────────────────────────────────────────────────────────
  // "Lv2 이하 전부 팔기" 처럼 자잘한 재료를 한 번에 정리하는 편의 기능.
  // ⚠ 상자조각은 제외한다 — 팔면 손해인 재료라(상자로 바꾸는 게 1.7배) 실수로 날리면 뼈아프다.
  if (action === 'sellAll') {
    const maxLevel = Math.round(Number(body.maxLevel ?? 1));
    if (!(maxLevel >= 1 && maxLevel <= 6)) return bad('잘못된 레벨입니다');
    let gain = 0;
    let count = 0;
    for (const def of CATS) {
      if (def.cat === 'shard') continue;
      for (let lv = 1; lv <= Math.min(maxLevel, def.maxLevel); lv++) {
        const have = invCount(w, def.cat, lv);
        if (have <= 0) continue;
        gain += matValue(def.cat, lv) * have;
        count += have;
        addMat(w, def.cat, lv, -have);
      }
    }
    if (count === 0) return bad('팔 재료가 없습니다');
    w.coins += gain;
    w.earned += gain;
    if (!(await commit(env, w))) return bad(RETRY_MSG, 409);
    return json({ ...statePayload(w), sold: { cat: null, level: maxLevel, count, gain } });
  }

  // ── 지원(일일 지원 + 파산 구제) ──────────────────────────────────────────────
  // 트레이딩 refill.ts 와 같은 패턴 — 별도 리셋 cron 없이 "요청 시점에 KST 날짜를 비교"한다.
  //
  // ⚠⚠ 지원은 **돈이 아니라 상자로** 준다. 이 게임은 상자만 까면 회수율이 70% 라 흑자를 내려면
  // 머지를 해야 하는데, 머지에는 같은 재료 2개가 필요하고 그러려면 상자를 여러 개 까야 한다. 즉
  // 골드를 조금씩 쥐여주면 그 돈으로 상자 한두 개를 까고 재료가 흩어진 채 끝나 **70% 손실만 반복**된다
  // (실제로 한 명이 전 재산을 잃고 그 상태에서 회복하지 못했다). 상자를 한꺼번에 여러 개 줘야 같은
  // 재료가 모여 머지가 성립하고, 거기서부터 스스로 굴러간다.
  if (action === 'refill') {
    const today = todayKst();
    const usedToday = w.row.refill_date === today ? w.row.refill_count : 0;

    if (usedToday === 0) {
      // 그날 첫 수령 = 일일 지원. 조건이 없다 — 부자에겐 푼돈이고 빈털터리에겐 생명줄이라
      // 그 자체로 따라잡기 장치가 된다(하루 400골드 상당이라 상위권 순위엔 영향이 없다).
      addCrate(w, 1, DAILY_CRATES);
      w.coins += DAILY_COINS;
      if (!(await commit(env, w, { refillCount: 1, refillDate: today }))) return bad(RETRY_MSG, 409);
      w.row.refill_count = 1;
      w.row.refill_date = today;
      return json({ ...statePayload(w), granted: { kind: 'daily', crates: DAILY_CRATES, coins: DAILY_COINS } });
    }

    // 그 뒤로는 파산 구제 — 진짜로 회생이 막혔을 때만
    const netWorth = w.coins + inventoryValue(w) + crateValue(w);
    if (netWorth >= CRATES[0].price * BROKE_CRATES)
      return bad('아직 상자를 살 수 있습니다 (재료를 팔면 골드가 됩니다)');
    if (usedToday - 1 >= RESCUE_DAILY_LIMIT)
      return bad(`오늘 구제 횟수를 모두 썼습니다 (${RESCUE_DAILY_LIMIT}/${RESCUE_DAILY_LIMIT}) — 내일 다시 받을 수 있습니다`);
    addCrate(w, 1, RESCUE_CRATES);
    w.coins += RESCUE_COINS;
    if (!(await commit(env, w, { refillCount: usedToday + 1, refillDate: today }))) return bad(RETRY_MSG, 409);
    // commit 에 넘긴 카운트를 응답에도 반영해야 남은 횟수가 즉시 맞다(row 는 읽은 시점 값이다).
    w.row.refill_count = usedToday + 1;
    w.row.refill_date = today;
    return json({ ...statePayload(w), granted: { kind: 'rescue', crates: RESCUE_CRATES, coins: RESCUE_COINS } });
  }

  return bad('알 수 없는 액션');
}
