import { type Ctx, type Env, bad, json, safe, missingEnv, getSession, todayKst } from '../_shared';

/**
 * POST /api/puzzle { action: 'start', level }
 * POST /api/puzzle { action: 'open', gameId, x, y }
 * POST /api/puzzle { action: 'abandon', gameId }
 * POST /api/puzzle { action: 'refill' }
 * GET  /api/puzzle
 *
 * "스핑크스 보석찾기" 확장판 — 코인 트레이딩(users.balance)과 완전히 분리된 별도 재화(puzzle_stats).
 * 격자 보드에 여러 칸을 차지하는 보석이 숨어 있고, 칸을 하나씩 열 때마다(코스트 소모) 그 칸이 보석
 * 조각인지 빈 땅인지만 알려준다(위치 힌트 없음 — 원작과 동일). 보석 하나의 전체 칸을 다 열어야 그
 * 보석을 획득한 것으로 치고, 목표 보석을 전부 획득하면 클리어(재화 보상). 재화가 0이 되면 게임오버.
 *
 * ⚠ 서버 권위: 보드의 정답 배치(puzzle_games.board)는 서버만 알고 있고 클라 응답에는 절대 포함하지
 * 않는다 — publicGame() 이 "이미 연 칸"만 걸러 내려준다. 개발자도구로 미리 들여다볼 수 없다.
 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(() => handleGet(request, env));
}
export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handlePost(request, env));
}

// ── 보석 모양(상대좌표, 배치 시 무작위 회전/반전 후 정규화) ──────────────────────────
const SHAPES = {
  single: [[0, 0]],
  domino: [
    [0, 0],
    [1, 0],
  ],
  tromino: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  square: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  cross: [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 2],
  ],
  big: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0, 2],
    [1, 2],
  ],
} as const;

const GEM_TYPES = [
  { key: 'sapphire', label: '사파이어', shape: SHAPES.single, color: '#38bdf8' },
  { key: 'emerald', label: '에메랄드', shape: SHAPES.domino, color: '#34d399' },
  { key: 'ruby', label: '루비', shape: SHAPES.tromino, color: '#f87171' },
  { key: 'amethyst', label: '자수정', shape: SHAPES.square, color: '#a78bfa' },
  { key: 'topaz', label: '토파즈', shape: SHAPES.cross, color: '#fbbf24' },
  { key: 'diamond', label: '다이아몬드', shape: SHAPES.big, color: '#e5e7eb' },
] as const;
const GEM_TYPE_BY_KEY = new Map<string, (typeof GEM_TYPES)[number]>(GEM_TYPES.map((t) => [t.key, t]));

// 레벨 1~10 난이도표 — 보드 크기·보석 구성(plan: [gemTypeIndex, 개수][])·클리어 보상이 완만하게 커진다.
// ⚠ 힌트가 없는(칸을 열어야만 조각/빈땅을 아는) 설계라 실측 없이 잡은 초기값이다 — 실플레이 후
// reward/plan 을 이 표에서만 조정하면 되도록 한곳에 모아뒀다(VIP_TIERS 와 같은 패턴).
export const LEVELS = [
  { level: 1, size: 6, plan: [[0, 3]] as [number, number][], reward: 12 },
  { level: 2, size: 6, plan: [[0, 2], [1, 2]] as [number, number][], reward: 22 },
  { level: 3, size: 7, plan: [[0, 2], [1, 2], [2, 1]] as [number, number][], reward: 32 },
  { level: 4, size: 7, plan: [[1, 2], [2, 2]] as [number, number][], reward: 38 },
  { level: 5, size: 8, plan: [[1, 1], [2, 2], [3, 1]] as [number, number][], reward: 46 },
  { level: 6, size: 8, plan: [[2, 2], [3, 2]] as [number, number][], reward: 54 },
  { level: 7, size: 9, plan: [[2, 1], [3, 2], [4, 1]] as [number, number][], reward: 64 },
  { level: 8, size: 10, plan: [[3, 2], [4, 2]] as [number, number][], reward: 76 },
  { level: 9, size: 11, plan: [[4, 2], [5, 1], [3, 1]] as [number, number][], reward: 90 },
  { level: 10, size: 12, plan: [[4, 2], [5, 2]] as [number, number][], reward: 105 },
] as const;

const OPEN_COST = 1;
const PUZZLE_REFILL_AMOUNT = 40;
const PUZZLE_REFILL_DAILY_LIMIT = 5;

type Cell = readonly [number, number];
function rotate(cells: readonly Cell[], times: number): Cell[] {
  let out: Cell[] = cells.map((c) => [...c] as unknown as Cell);
  for (let i = 0; i < times; i++) out = out.map(([x, y]) => [y, -x] as Cell);
  return out;
}
function flipX(cells: readonly Cell[]): Cell[] {
  return cells.map(([x, y]) => [-x, y] as Cell);
}
function normalize(cells: readonly Cell[]): Cell[] {
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - minX, y - minY] as Cell);
}
function randomTransform(shape: readonly Cell[]): Cell[] {
  let out = rotate(shape, Math.floor(Math.random() * 4));
  if (Math.random() < 0.5) out = flipX(out);
  return normalize(out);
}

interface GemMeta {
  typeKey: string;
  label: string;
  color: string;
  size: number;
  revealedCount: number;
  cells: [number, number][]; // 이 보석 인스턴스가 차지하는 절대좌표 전체(연결 방향 계산용 — 안 연 칸도 포함)
}

function generateBoard(level: number): { size: number; board: Record<string, string>; gems: Record<string, GemMeta> } {
  const cfg = LEVELS[level - 1];
  const size = cfg.size;
  const occupied = new Set<string>();
  const board: Record<string, string> = {};
  const gems: Record<string, GemMeta> = {};
  let seq = 0;
  for (const [typeIdx, count] of cfg.plan) {
    const type = GEM_TYPES[typeIdx];
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const shape = randomTransform(type.shape);
        const w = Math.max(...shape.map((c) => c[0])) + 1;
        const h = Math.max(...shape.map((c) => c[1])) + 1;
        if (w > size || h > size) continue;
        const ox = Math.floor(Math.random() * (size - w + 1));
        const oy = Math.floor(Math.random() * (size - h + 1));
        const cells = shape.map(([dx, dy]) => [ox + dx, oy + dy] as Cell);
        if (cells.some(([x, y]) => occupied.has(`${x},${y}`))) continue;
        const gemId = `g${seq++}`;
        for (const [x, y] of cells) {
          occupied.add(`${x},${y}`);
          board[`${x},${y}`] = gemId;
        }
        gems[gemId] = {
          typeKey: type.key,
          label: type.label,
          color: type.color,
          size: cells.length,
          revealedCount: 0,
          cells: cells.map(([x, y]) => [x, y]),
        };
        break;
        // 300회 시도해도 못 놓으면 그 보석 인스턴스는 조용히 스킵(낮은 밀도로 설계돼 거의 발생 안 함)
      }
    }
  }
  return { size, board, gems };
}

interface PuzzleStatsRow {
  user_id: string;
  currency: number;
  best_level: number;
  games_played: number;
  games_won: number;
  refill_count: number;
  refill_date: string | null;
}
interface PuzzleGameRow {
  id: string;
  user_id: string;
  level: number;
  size: number;
  board: string;
  gems: string;
  revealed: string;
  spent: number;
  status: string;
  created_at: number;
  updated_at: number;
}

// 열린 칸이 같은 보석의 어느 방향으로 더 이어지는지 알려주는 연결 정보(퍼즐 조각의 "부위") — 위치를
// 직접 찍어주진 않되(안 연 칸이 어디인지는 여전히 몰라야 함), "이 조각은 오른쪽/아래로 이어진다"는
// 방향은 알려줘서 색깔+모양으로 다음에 열 칸을 유추해가는 원작 방식을 재현한다.
interface Connects {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}
function connectsFor(gem: GemMeta, x: number, y: number): Connects {
  const set = new Set(gem.cells.map(([cx, cy]) => `${cx},${cy}`));
  return {
    up: set.has(`${x},${y - 1}`),
    down: set.has(`${x},${y + 1}`),
    left: set.has(`${x - 1},${y}`),
    right: set.has(`${x + 1},${y}`),
  };
}

async function ensureStats(env: Env, uid: string): Promise<PuzzleStatsRow> {
  await env.DB.prepare('INSERT OR IGNORE INTO puzzle_stats (user_id, created_at) VALUES (?, ?)').bind(uid, Date.now()).run();
  const row = await env.DB.prepare('SELECT * FROM puzzle_stats WHERE user_id = ?').bind(uid).first<PuzzleStatsRow>();
  return row!;
}

// 이 보드에 실제로 배치된 보석을 종류별로 묶은 목록("찾아야 할 보석" 범례) — 위치는 안 알려주고
// 색깔·모양·개수·그중 몇 개를 찾았는지만 준다(원작처럼 색/부위를 보고 유추하되, 뭘 찾아야 하는지는
// 처음부터 보여줌). 다 찾은 종류는 found===total 이 되고, 클라가 그 줄을 지워진 것처럼 표시한다.
function legendOf(gems: Record<string, GemMeta>) {
  const byType = new Map<string, { typeKey: string; label: string; color: string; shape: number[][]; total: number; found: number }>();
  for (const g of Object.values(gems)) {
    let entry = byType.get(g.typeKey);
    if (!entry) {
      const shape = (GEM_TYPE_BY_KEY.get(g.typeKey)?.shape ?? [[0, 0]]) as unknown as number[][];
      entry = { typeKey: g.typeKey, label: g.label, color: g.color, shape, total: 0, found: 0 };
      byType.set(g.typeKey, entry);
    }
    entry.total++;
    if (g.revealedCount >= g.size) entry.found++;
  }
  return [...byType.values()];
}

function publicGame(row: PuzzleGameRow) {
  const board: Record<string, string> = JSON.parse(row.board);
  const gems: Record<string, GemMeta> = JSON.parse(row.gems);
  const revealed: string[] = JSON.parse(row.revealed);
  const cells = revealed.map((coord) => {
    const [x, y] = coord.split(',').map(Number);
    const gemId = board[coord] ?? null;
    if (gemId) {
      const g = gems[gemId];
      return { x, y, gemId, label: g.label, color: g.color, connects: connectsFor(g, x, y) };
    }
    return { x, y, gemId: null as string | null };
  });
  const gemsTotal = Object.keys(gems).length;
  const gemsFound = Object.values(gems).filter((g) => g.revealedCount >= g.size).length;
  return {
    id: row.id,
    level: row.level,
    size: row.size,
    gemsTotal,
    gemsFound,
    cells,
    legend: legendOf(gems),
    spent: row.spent,
    status: row.status,
  };
}

async function loadPuzzleState(env: Env, uid: string) {
  const stats = await ensureStats(env, uid);
  const today = todayKst();
  const refillsLeft =
    stats.refill_date === today ? Math.max(0, PUZZLE_REFILL_DAILY_LIMIT - stats.refill_count) : PUZZLE_REFILL_DAILY_LIMIT;
  const activeRow = await env.DB.prepare(
    "SELECT * FROM puzzle_games WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(uid)
    .first<PuzzleGameRow>();
  return {
    currency: stats.currency,
    bestLevel: stats.best_level,
    gamesPlayed: stats.games_played,
    gamesWon: stats.games_won,
    refillsLeft,
    activeGame: activeRow ? publicGame(activeRow) : null,
    // 등급표(VIP_TIERS)와 같은 패턴 — 클라에 같은 표를 중복 정의하지 않고 서버 값을 그대로 쓴다.
    // types: 이 레벨에 어떤 보석이 몇 개 나오는지(색/모양/개수) — 시작 전에도 "뭘 찾아야 하는지" 보여줌.
    levels: LEVELS.map((l) => ({
      level: l.level,
      size: l.size,
      reward: l.reward,
      gemsTotal: l.plan.reduce((s, [, c]) => s + c, 0),
      costPerOpen: OPEN_COST,
      types: l.plan.map(([typeIdx, count]) => {
        const t = GEM_TYPES[typeIdx];
        return { typeKey: t.key, label: t.label, color: t.color, shape: t.shape as unknown as number[][], count };
      }),
    })),
  };
}

async function handleGet(request: Request, env: Env): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  return json(await loadPuzzleState(env, sess.uid));
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  const uid = sess.uid;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('invalid json');
  }

  if (body.action === 'start') {
    const level = Math.round(Number(body.level));
    const cfg = LEVELS[level - 1];
    if (!cfg) return bad('잘못된 레벨입니다');
    const stats = await ensureStats(env, uid);
    if (stats.currency <= 0) return bad('재화가 부족합니다. 리필을 이용해주세요');
    // 진행 중이던 판이 있으면 포기 처리(이미 쓴 코스트는 환불하지 않음 — 새 판은 언제든 다시 시작 가능)
    await env.DB.prepare("UPDATE puzzle_games SET status = 'abandoned', updated_at = ? WHERE user_id = ? AND status = 'active'")
      .bind(Date.now(), uid)
      .run();
    const { size, board, gems } = generateBoard(level);
    const now = Date.now();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO puzzle_games (id,user_id,level,size,board,gems,revealed,spent,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,'active',?,?)",
    )
      .bind(id, uid, level, size, JSON.stringify(board), JSON.stringify(gems), JSON.stringify([]), now, now)
      .run();
    return json(await loadPuzzleState(env, uid));
  }

  if (body.action === 'open') {
    const gameId = String(body.gameId ?? '');
    const x = Math.round(Number(body.x));
    const y = Math.round(Number(body.y));
    const row = await env.DB.prepare('SELECT * FROM puzzle_games WHERE id = ? AND user_id = ?').bind(gameId, uid).first<PuzzleGameRow>();
    if (!row) return bad('게임을 찾을 수 없습니다');
    if (row.status !== 'active') return bad('이미 종료된 게임입니다');
    if (!(x >= 0 && x < row.size && y >= 0 && y < row.size)) return bad('범위를 벗어났습니다');
    const revealed: string[] = JSON.parse(row.revealed);
    const coord = `${x},${y}`;
    if (revealed.includes(coord)) return bad('이미 연 칸입니다');

    // 코스트를 먼저 원자적으로 차감(잔여 재화 확인 겸용) — 실패하면 게임 상태는 그대로 둔다.
    const deduct = await env.DB.prepare('UPDATE puzzle_stats SET currency = currency - ? WHERE user_id = ? AND currency >= ?')
      .bind(OPEN_COST, uid, OPEN_COST)
      .run();
    if (deduct.meta.changes === 0) return bad('재화가 부족합니다');

    const board: Record<string, string> = JSON.parse(row.board);
    const gems: Record<string, GemMeta> = JSON.parse(row.gems);
    const gemId = board[coord] ?? null;
    revealed.push(coord);
    let justCompleted: { label: string; color: string } | null = null;
    if (gemId) {
      gems[gemId].revealedCount++;
      if (gems[gemId].revealedCount === gems[gemId].size) {
        justCompleted = { label: gems[gemId].label, color: gems[gemId].color };
      }
    }
    const allFound = Object.values(gems).every((g) => g.revealedCount >= g.size);
    const now = Date.now();
    let status = row.status;
    let reward = 0;

    if (allFound) {
      status = 'won';
      reward = LEVELS[row.level - 1].reward;
      await env.DB.prepare(
        'UPDATE puzzle_stats SET currency = currency + ?, best_level = MAX(best_level, ?), games_played = games_played + 1, games_won = games_won + 1 WHERE user_id = ?',
      )
        .bind(reward, row.level, uid)
        .run();
    } else {
      const cur = await env.DB.prepare('SELECT currency FROM puzzle_stats WHERE user_id = ?').bind(uid).first<{ currency: number }>();
      if ((cur?.currency ?? 0) <= 0) {
        status = 'lost';
        await env.DB.prepare('UPDATE puzzle_stats SET games_played = games_played + 1 WHERE user_id = ?').bind(uid).run();
      }
    }

    await env.DB.prepare('UPDATE puzzle_games SET gems = ?, revealed = ?, spent = spent + ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(gems), JSON.stringify(revealed), OPEN_COST, status, now, gameId)
      .run();

    // loadPuzzleState().activeGame 은 status='active' 인 판만 찾으므로, 이 오픈으로 방금 끝난(won/lost)
    // 판은 거기서 null 로 빠진다 — 클라가 "이번 오픈으로 뭐가 어떻게 됐는지" 확정적으로 알 수 있도록
    // gameStatus/cell/justCompleted/reward 를 따로 실어보낸다(클라는 로컬에 들고 있던 보드에 이 결과만
    // 이어붙이면 되고, 서버가 다시 내려준 activeGame 스냅샷에 의존할 필요가 없다).
    const state = await loadPuzzleState(env, uid);
    return json({
      ...state,
      gameStatus: status,
      cell: gemId
        ? { x, y, gemId, label: gems[gemId].label, color: gems[gemId].color, connects: connectsFor(gems[gemId], x, y) }
        : { x, y, gemId: null },
      justCompleted,
      reward: status === 'won' ? reward : 0,
    });
  }

  if (body.action === 'abandon') {
    const gameId = String(body.gameId ?? '');
    await env.DB.prepare("UPDATE puzzle_games SET status = 'abandoned', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'")
      .bind(Date.now(), gameId, uid)
      .run();
    return json(await loadPuzzleState(env, uid));
  }

  if (body.action === 'refill') {
    const stats = await ensureStats(env, uid);
    if (stats.currency > 0) return bad('재화가 남아있는 동안에는 리필할 수 없습니다');
    const today = todayKst();
    const usedToday = stats.refill_date === today ? stats.refill_count : 0;
    if (usedToday >= PUZZLE_REFILL_DAILY_LIMIT)
      return bad(`오늘 리필 횟수를 모두 사용했습니다 (${PUZZLE_REFILL_DAILY_LIMIT}/${PUZZLE_REFILL_DAILY_LIMIT})`);
    await env.DB.prepare('UPDATE puzzle_stats SET currency = currency + ?, refill_count = ?, refill_date = ? WHERE user_id = ?')
      .bind(PUZZLE_REFILL_AMOUNT, usedToday + 1, today, uid)
      .run();
    return json(await loadPuzzleState(env, uid));
  }

  return bad('알 수 없는 액션');
}
