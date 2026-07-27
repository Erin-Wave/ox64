import { type Ctx, type Env, type D1PreparedStatement, bad, json, safe, missingEnv, getSession } from '../_shared';
import {
  type EventDef,
  type EventType,
  type Icon,
  type Req,
  HEROES,
  HERO_BY_ID,
  DUNGEONS,
  DUNGEON_BY_ID,
  DEFAULT_DUNGEON_ID,
  MAX_HP,
  MAX_PARTY,
  RUN_MS,
} from '../_dungeonData';
import {
  type Card,
  type LogEntry,
  type PlayerState,
  buildHeroDeck,
  buildDungeonDeck,
  drawUpTo,
  allExhausted,
  isReqMet,
  canContribute,
  applyTrap,
  autoFill,
  pushLog,
} from '../_dungeonEngine';

/**
 * "5분 던전"(ox64.app/5m) — 실시간 협동 카드게임. 트레이딩·퍼즐과 완전히 분리(재화 없음, 승패
 * 통계만 dungeon_stats 에 기록). Durable Objects/WebSocket 대신 기존 OX 마켓메이커와 동일한
 * "D1 + 짧은 폴링" 으로 동기화한다(무료 플랜 유지, 새 인프라 없음).
 *
 * ⚠ **GET(폴링) 경로는 D1 왕복 2회·쓰기 0회로 유지할 것** — 이 GET 이 곧 동기화 수단이라 파티원
 * 수 × 초당 2회로 호출된다. 예전엔 `ensureStats`(INSERT OR IGNORE)를 폴링마다 두 번 불러 **쓰기가
 * 초당 몇 건씩** 나갔는데, D1 무료 플랜은 읽기(5M/일)보다 쓰기(100K/일) 한도가 훨씬 빡빡해서
 * 폴링 간격을 줄이는 순간 한도를 태운다. 지금은 (stats+내 방코드) / (방+파티원) 을 각각 batch 로
 * 묶어 왕복 2회로 읽고, stats 행이 실제로 없을 때만(=계정당 평생 1회) INSERT 한다.
 *
 * ⚠ 동시성: 방/카드 상태는 `version` 컬럼으로 낙관적 동시성 제어 — 여러 파티원이 동시에 카드를
 * 내도 `UPDATE ... WHERE code=? AND version=?` 조건부 갱신(0행이면 재시도)으로 경합을 막는다.
 * 트레이딩의 "조건부 UPDATE" 원자 가드 관용구를 다인원 상태로 일반화한 것.
 *
 * ⚠ D1 batch 는 조건부 UPDATE 가 0행이어도 "성공"으로 본다(CLAUDE.md 의 editLimit/conditionalOpen
 * 교훈과 동일) — 그래서 방 상태 전환(카드 격파→다음 카드 공개, 함정 연쇄, 승패 확정)은 반드시
 * **버전 가드 UPDATE 를 단독으로 먼저 실행해 성공을 확인한 뒤에만** 다른 플레이어 손패 갱신·통계
 * 반영 같은 후속 쓰기를 수행한다(성공 전엔 아무것도 쓰지 않으므로 재시도가 항상 안전하다).
 *
 * 서버 권위: 몬스터/이벤트 덱의 남은 순서(dungeon_rooms.deck_json)와 각 영웅의 남은 개인 덱 순서
 * (dungeon_players.deck_json)는 클라 응답에 절대 포함하지 않는다(개수만). 손패는 파티 전원에게
 * 공개한다(원작처럼 다 같이 보고 소리치며 조합하는 협동 게임이므로).
 */
export function onRequestGet({ request, env }: Ctx): Promise<Response> {
  return safe(() => handleGet(request, env));
}
export function onRequestPost({ request, env }: Ctx): Promise<Response> {
  return safe(() => handlePost(request, env));
}

// ── DB 행 타입 ──────────────────────────────────────────────────────────
interface RoomRow {
  code: string;
  host_user_id: string;
  status: string; // lobby|active|won|lost
  hp: number;
  ends_at: number | null;
  deck_json: string | null;
  current_json: string | null;
  version: number;
  created_at: number;
  started_at: number | null;
  dungeon_id: string | null;
  log_json: string | null;
  total_events: number | null;
  ward: number;
}
interface PlayerRow {
  room_code: string;
  user_id: string;
  name: string;
  hero_id: string;
  hand_json: string;
  deck_json: string;
  discard_json: string;
  exhausted: number;
  used_special: number;
  version: number;
  joined_at: number;
  contributed: number;
}
interface StatsRow {
  user_id: string;
  games_played: number;
  wins: number;
  best_clear_ms: number | null;
}
type ReqMap = Record<string, number>;
interface CurrentCard {
  key: string;
  type: EventType;
  name: string;
  req: ReqMap;
  progress: ReqMap;
  phase?: number; // 보스 전용(1|2)
  /** 보스 2페이즈 요구치 — 1페이즈를 격파하는 순간 `req` 로 승격시켜야 하므로 **현재 카드에 같이
   * 들고 다닌다**(덱에서 이미 뽑아낸 카드라 큐를 다시 뒤져도 없다). 클라에도 그대로 내려가 "다음
   * 페이즈엔 뭐가 필요한지" 미리 보여준다(원작 보스 카드도 양면이 다 보인다). */
  req2?: ReqMap;
  heal?: number; // 포션 전용 회복량(격파 시 파티 체력에 더해진다)
}

const HEROES_OUT = HEROES.map((h) => ({
  id: h.id,
  name: h.name,
  blurb: h.blurb,
  primary: h.primary,
  secondary: h.secondary,
  special: h.special,
}));
const DUNGEONS_OUT = DUNGEONS.map((d) => ({
  id: d.id,
  name: d.name,
  desc: d.desc,
  difficulty: d.difficulty,
  startHp: d.startHp,
  monsters: d.monsters,
  traps: d.traps,
  potions: d.potions,
  boss: d.bossKey,
}));
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 O/0/I/1 제외
const EMPTY_STATS: Omit<StatsRow, 'user_id'> = { games_played: 0, wins: 0, best_clear_ms: null };

function parsePlayer(row: PlayerRow): PlayerState {
  return {
    userId: row.user_id,
    name: row.name,
    heroId: row.hero_id,
    hand: JSON.parse(row.hand_json) as Card[],
    deck: JSON.parse(row.deck_json) as Card[],
    discard: JSON.parse(row.discard_json) as Card[],
    exhausted: !!row.exhausted,
    usedSpecial: !!row.used_special,
    contributed: row.contributed ?? 0,
  };
}
function parseLog(room: RoomRow): LogEntry[] {
  try {
    return room.log_json ? (JSON.parse(room.log_json) as LogEntry[]) : [];
  } catch {
    return [];
  }
}
function publicRoom(room: RoomRow) {
  const queue = room.deck_json ? ((JSON.parse(room.deck_json) as EventDef[]) ?? []) : [];
  const current = room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null;
  const total = room.total_events ?? 0;
  return {
    code: room.code,
    hostUserId: room.host_user_id,
    status: room.status,
    hp: room.hp,
    maxHp: MAX_HP,
    ward: room.ward ?? 0,
    endsAt: room.ends_at,
    startedAt: room.started_at,
    runMs: RUN_MS,
    dungeonId: room.dungeon_id ?? DEFAULT_DUNGEON_ID,
    current,
    // 진행도 — 남은 덱 길이만 노출하지 카드 내용은 절대 안 준다(다음에 뭐가 나올지는 비공개).
    cleared: Math.max(0, total - queue.length - (current ? 1 : 0)),
    totalEvents: total,
    log: parseLog(room),
  };
}
function publicPlayer(p: PlayerRow) {
  return {
    userId: p.user_id,
    name: p.name,
    heroId: p.hero_id,
    hand: JSON.parse(p.hand_json) as Card[], // 파티 전원에게 공개(협동 게임 — 원작도 손패를 서로 보며 진행)
    deckCount: (JSON.parse(p.deck_json) as Card[]).length, // 남은 순서는 비공개, 개수만
    discardCount: (JSON.parse(p.discard_json) as Card[]).length,
    exhausted: !!p.exhausted,
    usedSpecial: !!p.used_special,
    contributed: p.contributed ?? 0,
  };
}
function toCurrentJson(ev: EventDef, phase: 1 | 2): CurrentCard {
  return {
    key: ev.key,
    type: ev.type,
    name: ev.name,
    req: ((phase === 2 ? ev.req2 : ev.req) ?? {}) as ReqMap,
    progress: {},
    phase: ev.type === 'boss' ? phase : undefined,
    req2: ev.type === 'boss' && phase === 1 ? ((ev.req2 ?? {}) as ReqMap) : undefined,
    heal: ev.type === 'potion' ? ev.heal : undefined,
  };
}

/** 덱 큐 맨 앞부터 공개하되, 함정은 즉시 자동 발동(체력↓+전원 손패 버림, ward 있으면 무효화)하고
 * 그 다음 카드를 이어서 공개한다(연쇄 함정도 처리). players 는 그 자리에서 변형된다. */
function revealNext(
  queueIn: EventDef[],
  hpIn: number,
  wardIn: number,
  players: PlayerState[],
): { current: EventDef | null; hp: number; ward: number; queue: EventDef[]; logs: LogEntry[] } {
  let queue = queueIn;
  let hp = hpIn;
  let ward = wardIn;
  const logs: LogEntry[] = [];
  for (;;) {
    if (queue.length === 0) return { current: null, hp, ward, queue, logs };
    const ev = queue[0];
    queue = queue.slice(1);
    if (ev.type === 'trap') {
      const r = applyTrap(ev, hp, players, ward);
      hp = r.hp;
      ward = r.ward;
      logs.push(r.log);
      continue;
    }
    return { current: ev, hp, ward, queue, logs };
  }
}

// ── D1 조회 헬퍼 ────────────────────────────────────────────────────────
async function myRoomCode(env: Env, uid: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT room_code FROM dungeon_players WHERE user_id = ?').bind(uid).first<{ room_code: string }>();
  return row?.room_code ?? null;
}
async function loadRoomByCode(env: Env, code: string): Promise<RoomRow | null> {
  return env.DB.prepare('SELECT * FROM dungeon_rooms WHERE code = ?').bind(code).first<RoomRow>();
}
async function loadPlayerRow(env: Env, code: string, uid: string): Promise<PlayerRow | null> {
  return env.DB.prepare('SELECT * FROM dungeon_players WHERE room_code = ? AND user_id = ?').bind(code, uid).first<PlayerRow>();
}
async function loadPlayerRows(env: Env, code: string): Promise<PlayerRow[]> {
  return (await env.DB.prepare('SELECT * FROM dungeon_players WHERE room_code = ? ORDER BY joined_at ASC').bind(code).all<PlayerRow>())
    .results;
}
async function uniqueCode(env: Env): Promise<string> {
  for (let i = 0; i < 10; i++) {
    let c = '';
    for (let j = 0; j < 6; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const exists = await env.DB.prepare('SELECT 1 FROM dungeon_rooms WHERE code = ?').bind(c).first();
    if (!exists) return c;
  }
  throw new Error('방 코드 생성 실패');
}
function statsUpsertStmts(env: Env, userIds: string[], won: boolean, clearMs: number | null): D1PreparedStatement[] {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const uid of userIds) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO dungeon_stats (user_id, created_at) VALUES (?, ?)').bind(uid, now));
    if (won) {
      stmts.push(
        env.DB.prepare(
          'UPDATE dungeon_stats SET games_played = games_played + 1, wins = wins + 1, best_clear_ms = CASE WHEN best_clear_ms IS NULL OR ? < best_clear_ms THEN ? ELSE best_clear_ms END WHERE user_id = ?',
        ).bind(clearMs, clearMs, uid),
      );
    } else {
      stmts.push(env.DB.prepare('UPDATE dungeon_stats SET games_played = games_played + 1 WHERE user_id = ?').bind(uid));
    }
  }
  return stmts;
}

/** 5분 타이머 만료 확인 — 폴링/액션 요청이 들어올 때 그 자리에서 평가한다(강제청산과 달리 돈이
 * 걸려있지 않으므로 cron 불필요, checkTriggers 와 같은 "접속 시점에 평가" 철학). */
async function expireIfNeeded(env: Env, room: RoomRow): Promise<RoomRow> {
  if (room.status === 'active' && room.ends_at != null && Date.now() > room.ends_at) {
    const log = pushLog(parseLog(room), [{ k: 'lose', m: '시간 초과 — 던전 탈출 실패', t: Date.now() }]);
    const res = await env.DB.prepare(
      "UPDATE dungeon_rooms SET status = 'lost', log_json = ?, version = version + 1 WHERE code = ? AND version = ?",
    )
      .bind(JSON.stringify(log), room.code, room.version)
      .run();
    if (res.meta.changes > 0) {
      const players = await loadPlayerRows(env, room.code);
      await env.DB.batch(statsUpsertStmts(env, players.map((p) => p.user_id), false, null));
      return { ...room, status: 'lost', log_json: JSON.stringify(log), version: room.version + 1 };
    }
    return (await loadRoomByCode(env, room.code)) ?? room;
  }
  return room;
}

interface RoomPatch {
  status: string;
  hp: number;
  ward: number;
  endsAt: number | null;
  deckJson: string | null;
  currentJson: string | null;
  startedAt: number | null;
  logJson: string;
}
async function tryRoomUpdate(env: Env, code: string, expectedVersion: number, patch: RoomPatch): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE dungeon_rooms SET status = ?, hp = ?, ward = ?, ends_at = ?, deck_json = ?, current_json = ?, started_at = ?, log_json = ?, version = version + 1 WHERE code = ? AND version = ?',
  )
    .bind(
      patch.status,
      patch.hp,
      patch.ward,
      patch.endsAt,
      patch.deckJson,
      patch.currentJson,
      patch.startedAt,
      patch.logJson,
      code,
      expectedVersion,
    )
    .run();
  return res.meta.changes > 0;
}

/** 몬스터/포션/보스 요구치에 아이콘 기여분을 반영 — 충족되면 카드 격파→다음 카드 공개(함정 연쇄
 * 자동처리)까지 이어서 처리한다. 여러 파티원이 동시에 기여해도 버전 가드+재시도로 경합을 막는다.
 * expectedKey/expectedPhase 로 "내가 보고 낸 카드"가 아직 그대로인지 확인 — 이미 다른 요청이 그
 * 카드를 격파해 다음 카드로 넘어갔다면 이 기여는 조용히 소실된다(카드가 이미 소모된 뒤라 드묾). */
async function applyContribution(
  env: Env,
  code: string,
  expectedKey: string,
  expectedPhase: number | undefined,
  contributions: ReqMap,
  actorName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let room = await loadRoomByCode(env, code);
    if (!room) return;
    room = await expireIfNeeded(env, room);
    if (room.status !== 'active') return;
    const current = room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null;
    if (!current || current.key !== expectedKey || current.phase !== expectedPhase) return;

    const newProgress: ReqMap = { ...current.progress };
    for (const k of Object.keys(contributions)) newProgress[k] = (newProgress[k] ?? 0) + contributions[k];
    const log = parseLog(room);

    if (!isReqMet(current.req as Req, newProgress)) {
      const ok = await tryRoomUpdate(env, code, room.version, {
        status: room.status,
        hp: room.hp,
        ward: room.ward,
        endsAt: room.ends_at,
        deckJson: room.deck_json,
        currentJson: JSON.stringify({ ...current, progress: newProgress }),
        startedAt: room.started_at,
        logJson: JSON.stringify(log),
      });
      if (ok) return;
      continue;
    }

    // ── 요구치 충족 — 카드 격파 ──
    const now = Date.now();
    if (current.type === 'boss' && current.phase === 1) {
      // 2페이즈 요구치는 현재 카드가 들고 있다(보스는 이미 큐에서 빠진 상태라 덱을 뒤져도 없다).
      const phase2 = current.req2 ?? {};
      const ok = await tryRoomUpdate(env, code, room.version, {
        status: room.status,
        hp: room.hp,
        ward: room.ward,
        endsAt: room.ends_at,
        deckJson: room.deck_json,
        currentJson: JSON.stringify({
          key: current.key,
          type: 'boss',
          name: current.name,
          req: phase2,
          progress: {},
          phase: 2,
        } satisfies CurrentCard),
        startedAt: room.started_at,
        logJson: JSON.stringify(pushLog(log, [{ k: 'phase', m: `«${current.name}» 1페이즈 격파! 2페이즈 시작`, t: now }])),
      });
      if (ok) return;
      continue;
    }

    const playerRows = await loadPlayerRows(env, code);
    const playerStates = playerRows.map(parsePlayer);
    // 함정이 실제로 손패를 건드렸는지 비교하기 위한 사전 스냅샷(아래 followUps 참고).
    const handsBefore = playerStates.map((p) => JSON.stringify([p.hand, p.deck, p.discard, p.exhausted]));
    let hp = room.hp;
    let ward = room.ward;
    const logs: LogEntry[] = [];
    if (current.type === 'potion') {
      const heal = current.heal ?? 1;
      hp = Math.min(MAX_HP, hp + heal);
      logs.push({ k: 'potion', m: `«${current.name}» 을 마셨다 — 체력 +${heal}`, t: now });
    } else {
      logs.push({ k: 'defeat', m: `${actorName} 의 마무리로 «${current.name}» 격파!`, t: now });
    }
    const isFinalBoss = current.type === 'boss' && current.phase === 2;
    let deckQueue: EventDef[] = JSON.parse(room.deck_json ?? '[]') as EventDef[];
    let nextCurrentJson: string | null = null;
    let status = room.status;

    if (isFinalBoss) {
      status = 'won';
      logs.push({ k: 'win', m: '보스를 쓰러뜨렸다 — 던전 클리어!', t: now });
    } else {
      const revealed = revealNext(deckQueue, hp, ward, playerStates);
      hp = revealed.hp;
      ward = revealed.ward;
      deckQueue = revealed.queue;
      logs.push(...revealed.logs);
      if (revealed.current) {
        nextCurrentJson = JSON.stringify(toCurrentJson(revealed.current, 1));
        if (hp <= 0) {
          status = 'lost';
          logs.push({ k: 'lose', m: '파티 체력이 0이 됐다 — 전멸', t: now });
        } else if (allExhausted(playerStates)) {
          status = 'lost';
          logs.push({ k: 'lose', m: '파티 전원이 지쳤다 — 더 낼 카드가 없다', t: now });
        }
      } else {
        status = 'won'; // 안전망 — 정상 흐름에선 보스가 항상 마지막이라 여기 도달하지 않음
        logs.push({ k: 'win', m: '던전 클리어!', t: now });
      }
    }

    const ok = await tryRoomUpdate(env, code, room.version, {
      status,
      hp,
      ward,
      endsAt: room.ends_at,
      deckJson: JSON.stringify(deckQueue),
      currentJson: nextCurrentJson,
      startedAt: room.started_at,
      logJson: JSON.stringify(pushLog(log, logs)),
    });
    if (!ok) continue; // 트랩 효과는 아직 아무데도 안 썼으므로 재시도 안전

    // 여기부턴 이 요청이 전환을 확정지었다 — 함정으로 바뀐 파티원 손패 + 통계 반영.
    //
    // ⚠ **바뀐 사람만, 반드시 버전 가드로** 쓴다. 예전엔 전원의 손패를 이 시점 스냅샷으로 무조건
    // 덮어썼는데, 그 사이에 다른 파티원이 카드를 냈으면 그 사람의 손패가 **낸 카드까지 포함된 옛
    // 상태로 되돌아갔다** — 기여는 이미 집계됐는데 카드는 손에 돌아오는 카드 복사 버그였다(4인에서
    // 동시 입력이 잦을수록 잘 터진다). 지금은 (1)함정이 실제로 건드린 사람만 쓰고 (2)그 사람의
    // version 이 그대로일 때만 쓴다. 가드에 걸린 사람은 그 함정의 버림 효과만 넘어간다(카드가
    // 복사되는 것보다 훨씬 낫고, 그 사람은 어차피 방금 자기 카드를 내면서 손패를 새로 채웠다).
    const followUps: D1PreparedStatement[] = [];
    playerStates.forEach((p, i) => {
      if (JSON.stringify([p.hand, p.deck, p.discard, p.exhausted]) === handsBefore[i]) return;
      followUps.push(
        env.DB.prepare(
          'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, version = version + 1 WHERE room_code = ? AND user_id = ? AND version = ?',
        ).bind(
          JSON.stringify(p.hand),
          JSON.stringify(p.deck),
          JSON.stringify(p.discard),
          p.exhausted ? 1 : 0,
          code,
          p.userId,
          playerRows[i].version,
        ),
      );
    });
    if (status === 'won' || status === 'lost') {
      followUps.push(
        ...statsUpsertStmts(
          env,
          playerStates.map((p) => p.userId),
          status === 'won',
          status === 'won' ? Date.now() - (room.started_at ?? Date.now()) : null,
        ),
      );
    }
    if (followUps.length) await env.DB.batch(followUps);
    return;
  }
}

/** ⚠ 폴링(GET)이 타는 경로 — D1 왕복 2회·쓰기 0회를 반드시 유지할 것(파일 상단 주석 참고). */
async function loadDungeonState(env: Env, uid: string) {
  const head = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT * FROM dungeon_stats WHERE user_id = ?').bind(uid),
    env.DB.prepare('SELECT room_code FROM dungeon_players WHERE user_id = ?').bind(uid),
  ]);
  let stats = (head[0].results[0] as unknown as StatsRow | undefined) ?? null;
  const code = (head[1].results[0] as unknown as { room_code: string } | undefined)?.room_code ?? null;
  if (!stats) {
    // 계정당 평생 1회만 발생하는 쓰기(폴링 경로에서 매번 INSERT OR IGNORE 하지 않는 이유는 상단 주석)
    await env.DB.prepare('INSERT OR IGNORE INTO dungeon_stats (user_id, created_at) VALUES (?, ?)').bind(uid, Date.now()).run();
    stats = { user_id: uid, ...EMPTY_STATS };
  }

  const base = {
    heroes: HEROES_OUT,
    dungeons: DUNGEONS_OUT,
    myUserId: uid,
    handLimit: 5,
  };
  if (!code) {
    return {
      ...base,
      stats: { gamesPlayed: stats.games_played, wins: stats.wins, bestClearMs: stats.best_clear_ms },
      room: null,
      players: [] as ReturnType<typeof publicPlayer>[],
    };
  }

  const body = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT * FROM dungeon_rooms WHERE code = ?').bind(code),
    env.DB.prepare('SELECT * FROM dungeon_players WHERE room_code = ? ORDER BY joined_at ASC').bind(code),
  ]);
  let room = (body[0].results[0] as unknown as RoomRow | undefined) ?? null;
  const players = body[1].results as unknown as PlayerRow[];
  if (!room) {
    return {
      ...base,
      stats: { gamesPlayed: stats.games_played, wins: stats.wins, bestClearMs: stats.best_clear_ms },
      room: null,
      players: [] as ReturnType<typeof publicPlayer>[],
    };
  }

  // 타이머 만료는 드문 이벤트라, 여기서만 추가 쓰기가 발생하고 통계도 다시 읽는다.
  if (room.status === 'active' && room.ends_at != null && Date.now() > room.ends_at) {
    room = await expireIfNeeded(env, room);
    const fresh = await env.DB.prepare('SELECT * FROM dungeon_stats WHERE user_id = ?').bind(uid).first<StatsRow>();
    if (fresh) stats = fresh;
  }

  return {
    ...base,
    stats: { gamesPlayed: stats.games_played, wins: stats.wins, bestClearMs: stats.best_clear_ms },
    room: publicRoom(room),
    players: players.map(publicPlayer),
  };
}

async function handleGet(request: Request, env: Env): Promise<Response> {
  const envErr = missingEnv(env);
  if (envErr) return bad(envErr, 500);
  const sess = await getSession(request, env);
  if (!sess) return bad('unauthorized', 401);
  return json(await loadDungeonState(env, sess.uid));
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

  if (body.action === 'create') {
    if (await myRoomCode(env, uid)) return bad('이미 참가 중인 던전이 있습니다. 먼저 나가주세요');
    const code = await uniqueCode(env);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO dungeon_rooms (code, host_user_id, status, hp, created_at, dungeon_id, log_json) VALUES (?, ?, 'lobby', ?, ?, ?, '[]')",
    )
      .bind(code, uid, DUNGEON_BY_ID.get(DEFAULT_DUNGEON_ID)!.startHp, now, DEFAULT_DUNGEON_ID)
      .run();
    await env.DB.prepare('INSERT INTO dungeon_players (room_code, user_id, name, hero_id, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(code, uid, sess.name, '', now)
      .run();
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'join') {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!code) return bad('방 코드를 입력해주세요');
    const existing = await myRoomCode(env, uid);
    if (existing === code) return json(await loadDungeonState(env, uid)); // 재접속(새로고침 등)
    if (existing) return bad('이미 참가 중인 던전이 있습니다. 먼저 나가주세요');
    const room = await loadRoomByCode(env, code);
    if (!room) return bad('존재하지 않는 방 코드입니다');
    if (room.status !== 'lobby') return bad('이미 시작된 던전입니다');
    const players = await loadPlayerRows(env, code);
    if (players.length >= MAX_PARTY) return bad(`파티 정원이 가득 찼습니다 (최대 ${MAX_PARTY}명)`);
    await env.DB.prepare('INSERT INTO dungeon_players (room_code, user_id, name, hero_id, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(code, uid, sess.name, '', Date.now())
      .run();
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'chooseDungeon') {
    const dungeonId = String(body.dungeonId ?? '');
    const dungeon = DUNGEON_BY_ID.get(dungeonId);
    if (!dungeon) return bad('알 수 없는 던전입니다');
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');
    const room = await loadRoomByCode(env, code);
    if (!room || room.status !== 'lobby') return bad('로비 상태에서만 던전을 바꿀 수 있습니다');
    if (room.host_user_id !== uid) return bad('방장만 던전을 고를 수 있습니다');
    await env.DB.prepare('UPDATE dungeon_rooms SET dungeon_id = ?, hp = ?, version = version + 1 WHERE code = ?')
      .bind(dungeonId, dungeon.startHp, code)
      .run();
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'chooseHero') {
    const heroId = String(body.heroId ?? '');
    if (!HERO_BY_ID.has(heroId)) return bad('알 수 없는 영웅입니다');
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');
    const room = await loadRoomByCode(env, code);
    if (!room || room.status !== 'lobby') return bad('로비 상태에서만 영웅을 선택할 수 있습니다');
    const players = await loadPlayerRows(env, code);
    if (players.some((p) => p.user_id !== uid && p.hero_id === heroId)) return bad('이미 다른 파티원이 선택한 영웅입니다');
    await env.DB.prepare('UPDATE dungeon_players SET hero_id = ?, version = version + 1 WHERE room_code = ? AND user_id = ?')
      .bind(heroId, code, uid)
      .run();
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'start') {
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');
    const room = await loadRoomByCode(env, code);
    if (!room) return bad('방을 찾을 수 없습니다');
    if (room.host_user_id !== uid) return bad('방장만 시작할 수 있습니다');
    if (room.status !== 'lobby') return bad('이미 시작된 던전입니다');
    const rows = await loadPlayerRows(env, code);
    if (rows.length === 0) return bad('인원이 없습니다');
    if (rows.some((p) => !p.hero_id)) return bad('모든 파티원이 영웅을 선택해야 합니다');
    const dungeon = DUNGEON_BY_ID.get(room.dungeon_id ?? DEFAULT_DUNGEON_ID);
    if (!dungeon) return bad('알 수 없는 던전입니다');

    const players: PlayerState[] = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      heroId: r.hero_id,
      hand: [],
      deck: buildHeroDeck(r.hero_id),
      discard: [],
      exhausted: false,
      usedSpecial: false,
      contributed: 0,
    }));
    for (const p of players) drawUpTo(p);
    const deckQueue = buildDungeonDeck(dungeon.id, rows.map((r) => r.hero_id));
    const totalEvents = deckQueue.length;
    const now = Date.now();
    const { current, hp, ward, queue, logs } = revealNext(deckQueue, dungeon.startHp, 0, players);
    const log = pushLog(
      [{ k: 'start', m: `«${dungeon.name}» 입장 — 5분 안에 보스까지 처치하라`, t: now }],
      logs,
    );

    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE dungeon_rooms SET status = 'active', hp = ?, ward = ?, ends_at = ?, deck_json = ?, current_json = ?, started_at = ?, total_events = ?, log_json = ?, version = version + 1 WHERE code = ?",
      ).bind(
        hp,
        ward,
        now + RUN_MS,
        JSON.stringify(queue),
        current ? JSON.stringify(toCurrentJson(current, 1)) : null,
        now,
        totalEvents,
        JSON.stringify(log),
        code,
      ),
    ];
    for (const p of players) {
      stmts.push(
        env.DB.prepare(
          'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, used_special = 0, contributed = 0, version = version + 1 WHERE room_code = ? AND user_id = ?',
        ).bind(JSON.stringify(p.hand), JSON.stringify(p.deck), JSON.stringify(p.discard), p.exhausted ? 1 : 0, code, p.userId),
      );
    }
    await env.DB.batch(stmts);
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'playCards') {
    const plays = Array.isArray(body.plays) ? (body.plays as { cardId: string; target: string }[]) : [];
    if (plays.length === 0) return bad('낼 카드를 선택해주세요');
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');

    // ⚠ 동시 입력 재시도 — 다른 파티원이 같은 순간에 카드를 격파하면 그 처리가 내 행의 version 을
    // 올려서 아래 조건부 UPDATE 가 0행이 된다. 예전엔 그대로 "다시 시도해주세요" 를 띄웠는데,
    // 4명이 동시에 누르는 게 정상인 게임이라 **평범한 플레이 중에도 자주** 떴다. 여기서 몇 번 다시
    // 읽어 조용히 성공시키고, 정말로 카드가 넘어간 경우에만 사람이 읽을 수 있는 이유를 돌려준다.
    for (let attempt = 0; attempt < 4; attempt++) {
      let room = await loadRoomByCode(env, code);
      if (!room) return bad('방을 찾을 수 없습니다');
      room = await expireIfNeeded(env, room);
      if (room.status !== 'active') return bad('진행 중인 던전이 아닙니다');
      const current = room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null;
      if (!current) return bad('공개된 카드가 없습니다');

      const pRow = await loadPlayerRow(env, code, uid);
      if (!pRow) return bad('파티원이 아닙니다');
      const pState = parsePlayer(pRow);

      const contributions: ReqMap = {};
      const playedCards: Card[] = [];
      const seen = new Set<string>();
      let reject: string | null = null;
      for (const play of plays) {
        if (seen.has(play.cardId)) return bad('같은 카드를 두 번 낼 수 없습니다');
        seen.add(play.cardId);
        const card = pState.hand.find((c) => c.id === play.cardId);
        if (!card) {
          reject = '이미 냈거나 손에 없는 카드입니다';
          break;
        }
        if (card.special) return bad('특수카드는 전용 버튼으로만 사용할 수 있습니다');
        const target = play.target as Icon | 'any';
        if (!(target in current.req)) {
          reject = '그 사이 다음 카드로 넘어갔습니다';
          break;
        }
        if (!canContribute(card.icon, target)) return bad('그 카드로는 낼 수 없습니다');
        playedCards.push(card);
        contributions[target] = (contributions[target] ?? 0) + card.value;
      }
      if (reject) return bad(reject);

      const gained = playedCards.reduce((s, c) => s + c.value, 0);
      const playedIds = new Set(playedCards.map((c) => c.id));
      pState.hand = pState.hand.filter((c) => !playedIds.has(c.id));
      pState.discard.push(...playedCards);
      drawUpTo(pState);

      const handUpdate = await env.DB.prepare(
        'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, contributed = contributed + ?, version = version + 1 WHERE room_code = ? AND user_id = ? AND version = ?',
      )
        .bind(
          JSON.stringify(pState.hand),
          JSON.stringify(pState.deck),
          JSON.stringify(pState.discard),
          pState.exhausted ? 1 : 0,
          gained,
          code,
          uid,
          pRow.version,
        )
        .run();
      if (handUpdate.meta.changes === 0) continue; // 경합에 밀림 — 최신 상태로 다시 읽어 재시도

      await applyContribution(env, code, current.key, current.phase, contributions, pRow.name);
      return json(await loadDungeonState(env, uid));
    }
    return bad('동시에 입력이 몰렸습니다. 한 번 더 눌러주세요');
  }

  if (body.action === 'rest') {
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');
    for (let attempt = 0; attempt < 4; attempt++) {
      let room = await loadRoomByCode(env, code);
      if (room) room = await expireIfNeeded(env, room);
      if (!room || room.status !== 'active') return bad('진행 중인 던전이 아닙니다');
      const pRow = await loadPlayerRow(env, code, uid);
      if (!pRow) return bad('파티원이 아닙니다');
      const p = parsePlayer(pRow);
      p.discard.push(...p.hand);
      p.hand = [];
      drawUpTo(p);
      const res = await env.DB.prepare(
        'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, version = version + 1 WHERE room_code = ? AND user_id = ? AND version = ?',
      )
        .bind(JSON.stringify(p.hand), JSON.stringify(p.deck), JSON.stringify(p.discard), p.exhausted ? 1 : 0, code, uid, pRow.version)
        .run();
      if (res.meta.changes === 0) continue; // 위 playCards 와 같은 이유의 재시도
      return json(await loadDungeonState(env, uid));
    }
    return bad('동시에 입력이 몰렸습니다. 한 번 더 눌러주세요');
  }

  if (body.action === 'useSpecial') {
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');
    let room = await loadRoomByCode(env, code);
    if (room) room = await expireIfNeeded(env, room);
    if (!room || room.status !== 'active') return bad('진행 중인 던전이 아닙니다');
    const pRow = await loadPlayerRow(env, code, uid);
    if (!pRow) return bad('파티원이 아닙니다');
    if (pRow.used_special) return bad('이미 사용했습니다');
    const hero = HERO_BY_ID.get(pRow.hero_id);
    if (!hero) return bad('알 수 없는 영웅입니다');

    // ⚠ 요구치에 직접 기여하는 특수(바바리안/음유시인)는 **소모하기 전에** 현재 카드와 타깃을
    // 검증한다 — 검증을 뒤로 미루면 잘못된 타깃 하나에 판당 1회짜리 능력이 그냥 날아간다.
    const current0 = room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null;
    let planned: ReqMap | null = null;
    if (hero.id === 'barbarian' || hero.id === 'bard') {
      if (!current0) return bad('공개된 카드가 없습니다');
      if (hero.id === 'barbarian') {
        const target = String(body.target ?? '');
        if (!(target in current0.req)) return bad('올바른 요구치 항목을 선택해주세요');
        planned = { [target]: 3 };
      } else {
        planned = autoFill(current0.req as Req, current0.progress, 2);
        if (Object.keys(planned).length === 0) return bad('이미 다 채워져 채울 요구치가 없습니다');
      }
    }

    // 특수카드 사용 표시를 원자적으로 확정 — 0행이면 다른 요청이 이미 썼다는 뜻(이중 사용 방지).
    const claim = await env.DB.prepare(
      'UPDATE dungeon_players SET used_special = 1, version = version + 1 WHERE room_code = ? AND user_id = ? AND used_special = 0',
    )
      .bind(code, uid)
      .run();
    if (claim.meta.changes === 0) return bad('이미 사용했습니다');

    const logSpecial = async (msg: string) => {
      for (let i = 0; i < 5; i++) {
        const r = await loadRoomByCode(env, code);
        if (!r || r.status !== 'active') return;
        const ok = await tryRoomUpdate(env, code, r.version, {
          status: r.status,
          hp: r.hp,
          ward: r.ward,
          endsAt: r.ends_at,
          deckJson: r.deck_json,
          currentJson: r.current_json,
          startedAt: r.started_at,
          logJson: JSON.stringify(pushLog(parseLog(r), [{ k: 'special', m: msg, t: Date.now() }])),
        });
        if (ok) return;
      }
    };

    // ⚠ 손패를 쓰는 특수는 전부 **버전 가드**로 쓴다 — 가드 없이 스냅샷을 덮어쓰면 그 사이 카드를
    // 낸 파티원의 손패가 되돌아가 카드가 복사된다(applyContribution 의 followUps 주석 참고).
    const refillGuarded = async (rows: PlayerRow[]) => {
      const stmts = rows.map((row) => {
        const p = parsePlayer(row);
        drawUpTo(p);
        return env.DB.prepare(
          'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, version = version + 1 WHERE room_code = ? AND user_id = ? AND version = ?',
        ).bind(JSON.stringify(p.hand), JSON.stringify(p.deck), JSON.stringify(p.discard), p.exhausted ? 1 : 0, code, p.userId, row.version);
      });
      if (stmts.length) await env.DB.batch(stmts);
    };

    if (hero.id === 'ninja') {
      // 특수 사용 표시(claim)가 이미 version 을 올렸으므로 최신 행을 다시 읽어야 가드가 통과한다.
      const fresh = await loadPlayerRow(env, code, uid);
      if (fresh) await refillGuarded([fresh]);
      await logSpecial(`${pRow.name}: 그림자 밟기 — 손패 보충`);
      return json(await loadDungeonState(env, uid));
    }

    if (hero.id === 'druid') {
      await refillGuarded(await loadPlayerRows(env, code));
      await logSpecial(`${pRow.name}: 자연의 부름 — 파티 전원 손패 보충`);
      return json(await loadDungeonState(env, uid));
    }

    if (hero.id === 'wizard' || hero.id === 'paladin') {
      const heal = hero.id === 'wizard' ? 2 : 0;
      const wardAdd = hero.id === 'paladin' ? 1 : 0;
      for (let i = 0; i < 5; i++) {
        const r = await loadRoomByCode(env, code);
        if (!r || r.status !== 'active') break;
        const ok = await tryRoomUpdate(env, code, r.version, {
          status: r.status,
          hp: Math.min(MAX_HP, r.hp + heal),
          ward: r.ward + wardAdd,
          endsAt: r.ends_at,
          deckJson: r.deck_json,
          currentJson: r.current_json,
          startedAt: r.started_at,
          logJson: JSON.stringify(
            pushLog(parseLog(r), [
              {
                k: 'special',
                m: hero.id === 'wizard' ? `${pRow.name}: 치유의 주문 — 체력 +2` : `${pRow.name}: 수호의 방벽 — 다음 함정 1회 무효`,
                t: Date.now(),
              },
            ]),
          ),
        });
        if (ok) break;
      }
      return json(await loadDungeonState(env, uid));
    }

    if (planned && current0) {
      const amount = Object.values(planned).reduce((s, v) => s + v, 0);
      await env.DB.prepare('UPDATE dungeon_players SET contributed = contributed + ? WHERE room_code = ? AND user_id = ?')
        .bind(amount, code, uid)
        .run();
      await logSpecial(`${pRow.name}: ${hero.special.name} — 요구치 ${amount} 즉시 기여`);
      await applyContribution(env, code, current0.key, current0.phase, planned, pRow.name);
      return json(await loadDungeonState(env, uid));
    }
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'leave') {
    const code = await myRoomCode(env, uid);
    if (!code) return json(await loadDungeonState(env, uid));
    const room = await loadRoomByCode(env, code);
    if (room && room.status === 'active') return bad('진행 중인 던전에서는 나갈 수 없습니다');
    await env.DB.prepare('DELETE FROM dungeon_players WHERE room_code = ? AND user_id = ?').bind(code, uid).run();
    const remaining = await loadPlayerRows(env, code);
    if (remaining.length === 0) {
      await env.DB.prepare('DELETE FROM dungeon_rooms WHERE code = ?').bind(code).run();
    } else if (room && room.host_user_id === uid) {
      await env.DB.prepare('UPDATE dungeon_rooms SET host_user_id = ? WHERE code = ?').bind(remaining[0].user_id, code).run();
    }
    return json(await loadDungeonState(env, uid));
  }

  return bad('알 수 없는 액션');
}
