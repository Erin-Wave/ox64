import { type Ctx, type Env, type D1PreparedStatement, bad, json, safe, missingEnv, getSession } from '../_shared';
import {
  type EventDef,
  type EventType,
  type Icon,
  type Req,
  HEROES,
  HERO_BY_ID,
  BOSS,
  START_HP,
  MAX_HP,
  MAX_PARTY,
  RUN_MS,
  POTION_HEAL,
} from '../_dungeonData';
import {
  type Card,
  type PlayerState,
  buildHeroDeck,
  buildDungeonDeck,
  drawUpTo,
  allExhausted,
  isReqMet,
  canContribute,
  applyTrap,
} from '../_dungeonEngine';

/**
 * "5분 던전"(ox64.app/5m) — 실시간 협동 카드게임. 트레이딩·퍼즐과 완전히 분리(재화 없음, 승패
 * 통계만 dungeon_stats 에 기록). Durable Objects/WebSocket 대신 기존 OX 마켓메이커와 동일한
 * "D1 + 1초 폴링" 으로 동기화한다(무료 플랜 유지, 새 인프라 없음).
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
}
interface StatsRow {
  user_id: string;
  games_played: number;
  wins: number;
  best_clear_ms: number | null;
}
interface CurrentCard {
  key: string;
  type: EventType;
  name: string;
  req: Req;
  progress: Record<string, number>;
  phase?: number; // 보스 전용(1|2)
}

const HEROES_OUT = HEROES.map((h) => ({ id: h.id, name: h.name, primary: h.primary, secondary: h.secondary, special: h.special }));
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 O/0/I/1 제외

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
  };
}
function publicRoom(room: RoomRow) {
  return {
    code: room.code,
    hostUserId: room.host_user_id,
    status: room.status,
    hp: room.hp,
    endsAt: room.ends_at,
    startedAt: room.started_at,
    current: room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null,
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
  };
}
function toCurrentJson(ev: EventDef, phase: 1 | 2): CurrentCard {
  return {
    key: ev.key,
    type: ev.type,
    name: ev.name,
    req: (phase === 2 ? ev.req2 : ev.req) ?? {},
    progress: {},
    phase: ev.type === 'boss' ? phase : undefined,
  };
}
/** 덱 큐 맨 앞부터 공개하되, 함정은 즉시 자동 발동(파티 체력↓+전원 손패 버림)하고 그 다음 카드를
 * 이어서 공개한다(연쇄 함정도 처리). players 는 그 자리에서 변형(hand/deck/discard/exhausted). */
function revealNext(queueIn: EventDef[], hpIn: number, players: PlayerState[]): { current: EventDef | null; hp: number; queue: EventDef[] } {
  let queue = queueIn;
  let hp = hpIn;
  for (;;) {
    if (queue.length === 0) return { current: null, hp, queue };
    const ev = queue[0];
    queue = queue.slice(1);
    if (ev.type === 'trap') {
      hp = applyTrap(ev, hp, players);
      continue;
    }
    return { current: ev, hp, queue };
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
async function ensureStats(env: Env, uid: string): Promise<StatsRow> {
  await env.DB.prepare('INSERT OR IGNORE INTO dungeon_stats (user_id, created_at) VALUES (?, ?)').bind(uid, Date.now()).run();
  return (await env.DB.prepare('SELECT * FROM dungeon_stats WHERE user_id = ?').bind(uid).first<StatsRow>())!;
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
    const res = await env.DB.prepare("UPDATE dungeon_rooms SET status = 'lost', version = version + 1 WHERE code = ? AND version = ?")
      .bind(room.code, room.version)
      .run();
    if (res.meta.changes > 0) {
      const players = await loadPlayerRows(env, room.code);
      await env.DB.batch(statsUpsertStmts(env, players.map((p) => p.user_id), false, null));
      return { ...room, status: 'lost', version: room.version + 1 };
    }
    return (await loadRoomByCode(env, room.code)) ?? room;
  }
  return room;
}

interface RoomPatch {
  status: string;
  hp: number;
  endsAt: number | null;
  deckJson: string | null;
  currentJson: string | null;
  startedAt: number | null;
}
async function tryRoomUpdate(env: Env, code: string, expectedVersion: number, patch: RoomPatch): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE dungeon_rooms SET status = ?, hp = ?, ends_at = ?, deck_json = ?, current_json = ?, started_at = ?, version = version + 1 WHERE code = ? AND version = ?',
  )
    .bind(patch.status, patch.hp, patch.endsAt, patch.deckJson, patch.currentJson, patch.startedAt, code, expectedVersion)
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
  contributions: Record<string, number>,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let room = await loadRoomByCode(env, code);
    if (!room) return;
    room = await expireIfNeeded(env, room);
    if (room.status !== 'active') return;
    const current = room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null;
    if (!current || current.key !== expectedKey || current.phase !== expectedPhase) return;

    const newProgress = { ...current.progress };
    for (const k of Object.keys(contributions)) newProgress[k] = (newProgress[k] ?? 0) + contributions[k];

    if (!isReqMet(current.req, newProgress)) {
      const ok = await tryRoomUpdate(env, code, room.version, {
        status: room.status,
        hp: room.hp,
        endsAt: room.ends_at,
        deckJson: room.deck_json,
        currentJson: JSON.stringify({ ...current, progress: newProgress }),
        startedAt: room.started_at,
      });
      if (ok) return;
      continue;
    }

    // 요구치 충족 — 카드 격파
    if (current.type === 'boss' && current.phase === 1) {
      const ok = await tryRoomUpdate(env, code, room.version, {
        status: room.status,
        hp: room.hp,
        endsAt: room.ends_at,
        deckJson: room.deck_json,
        currentJson: JSON.stringify(toCurrentJson(BOSS, 2)),
        startedAt: room.started_at,
      });
      if (ok) return;
      continue;
    }

    const playerRows = await loadPlayerRows(env, code);
    const playerStates = playerRows.map(parsePlayer);
    let hp = room.hp;
    if (current.type === 'potion') hp = Math.min(MAX_HP, hp + POTION_HEAL);
    const isFinalBoss = current.type === 'boss' && current.phase === 2;
    let deckQueue: EventDef[] = JSON.parse(room.deck_json ?? '[]') as EventDef[];
    let nextCurrentJson: string | null = null;
    let status = room.status;

    if (isFinalBoss) {
      status = 'won';
    } else {
      const revealed = revealNext(deckQueue, hp, playerStates);
      hp = revealed.hp;
      deckQueue = revealed.queue;
      if (revealed.current) {
        nextCurrentJson = JSON.stringify(toCurrentJson(revealed.current, 1));
        if (allExhausted(playerStates) || hp <= 0) status = 'lost';
      } else {
        status = 'won'; // 안전망 — 정상 흐름에선 보스가 항상 마지막이라 여기 도달하지 않음
      }
    }

    const ok = await tryRoomUpdate(env, code, room.version, {
      status,
      hp,
      endsAt: room.ends_at,
      deckJson: JSON.stringify(deckQueue),
      currentJson: nextCurrentJson,
      startedAt: room.started_at,
    });
    if (!ok) continue; // 트랩 효과는 아직 아무데도 안 썼으므로 재시도 안전

    // 여기부턴 이 요청이 전환을 확정지었다 — 다른 파티원 손패(함정 버림) + 통계 반영
    const followUps: D1PreparedStatement[] = playerStates.map((p) =>
      env.DB.prepare(
        'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, version = version + 1 WHERE room_code = ? AND user_id = ?',
      ).bind(JSON.stringify(p.hand), JSON.stringify(p.deck), JSON.stringify(p.discard), p.exhausted ? 1 : 0, code, p.userId),
    );
    if (status === 'won' || status === 'lost') {
      followUps.push(
        ...statsUpsertStmts(env, playerStates.map((p) => p.userId), status === 'won', status === 'won' ? Date.now() - (room.started_at ?? Date.now()) : null),
      );
    }
    if (followUps.length) await env.DB.batch(followUps);
    return;
  }
}

async function loadDungeonState(env: Env, uid: string) {
  const stats = await ensureStats(env, uid);
  const code = await myRoomCode(env, uid);
  if (!code) {
    return {
      stats: { gamesPlayed: stats.games_played, wins: stats.wins, bestClearMs: stats.best_clear_ms },
      room: null,
      players: [] as ReturnType<typeof publicPlayer>[],
      heroes: HEROES_OUT,
      myUserId: uid,
    };
  }
  let room = await loadRoomByCode(env, code);
  if (!room) {
    return {
      stats: { gamesPlayed: stats.games_played, wins: stats.wins, bestClearMs: stats.best_clear_ms },
      room: null,
      players: [] as ReturnType<typeof publicPlayer>[],
      heroes: HEROES_OUT,
      myUserId: uid,
    };
  }
  room = await expireIfNeeded(env, room);
  const players = await loadPlayerRows(env, code);
  const freshStats = await ensureStats(env, uid); // expireIfNeeded 가 방금 통계를 갱신했을 수 있어 재조회
  return {
    stats: { gamesPlayed: freshStats.games_played, wins: freshStats.wins, bestClearMs: freshStats.best_clear_ms },
    room: publicRoom(room),
    players: players.map(publicPlayer),
    heroes: HEROES_OUT,
    myUserId: uid,
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
    await env.DB.prepare("INSERT INTO dungeon_rooms (code, host_user_id, status, hp, created_at) VALUES (?, ?, 'lobby', ?, ?)")
      .bind(code, uid, START_HP, now)
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
    if (players.length >= MAX_PARTY) return bad('파티 정원이 가득 찼습니다');
    await env.DB.prepare('INSERT INTO dungeon_players (room_code, user_id, name, hero_id, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(code, uid, sess.name, '', Date.now())
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

    const players: PlayerState[] = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      heroId: r.hero_id,
      hand: [],
      deck: buildHeroDeck(r.hero_id),
      discard: [],
      exhausted: false,
      usedSpecial: false,
    }));
    for (const p of players) drawUpTo(p);
    const deckQueue = buildDungeonDeck();
    const { current, hp, queue } = revealNext(deckQueue, START_HP, players);
    const now = Date.now();

    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE dungeon_rooms SET status = 'active', hp = ?, ends_at = ?, deck_json = ?, current_json = ?, started_at = ?, version = version + 1 WHERE code = ?",
      ).bind(hp, now + RUN_MS, JSON.stringify(queue), current ? JSON.stringify(toCurrentJson(current, 1)) : null, now, code),
    ];
    for (const p of players) {
      stmts.push(
        env.DB.prepare(
          'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, used_special = 0, version = version + 1 WHERE room_code = ? AND user_id = ?',
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
    let room = await loadRoomByCode(env, code);
    if (!room) return bad('방을 찾을 수 없습니다');
    room = await expireIfNeeded(env, room);
    if (room.status !== 'active') return bad('진행 중인 던전이 아닙니다');
    const current = room.current_json ? (JSON.parse(room.current_json) as CurrentCard) : null;
    if (!current) return bad('공개된 카드가 없습니다');

    const pRow = await loadPlayerRow(env, code, uid);
    if (!pRow) return bad('파티원이 아닙니다');
    const pState = parsePlayer(pRow);

    const contributions: Record<string, number> = {};
    const playedCards: Card[] = [];
    for (const play of plays) {
      const card = pState.hand.find((c) => c.id === play.cardId);
      if (!card) return bad('보유하지 않은 카드입니다');
      const target = play.target as Icon | 'any';
      if (!(target in current.req)) return bad('그 요구치 항목이 없습니다');
      if (!canContribute(card.icon, target)) return bad('그 카드로는 낼 수 없습니다');
      playedCards.push(card);
      contributions[target] = (contributions[target] ?? 0) + card.value;
    }
    const playedIds = new Set(playedCards.map((c) => c.id));
    pState.hand = pState.hand.filter((c) => !playedIds.has(c.id));
    pState.discard.push(...playedCards);
    drawUpTo(pState);

    const handUpdate = await env.DB.prepare(
      'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, version = version + 1 WHERE room_code = ? AND user_id = ? AND version = ?',
    )
      .bind(JSON.stringify(pState.hand), JSON.stringify(pState.deck), JSON.stringify(pState.discard), pState.exhausted ? 1 : 0, code, uid, pRow.version)
      .run();
    if (handUpdate.meta.changes === 0) return bad('다시 시도해주세요');

    await applyContribution(env, code, current.key, current.phase, contributions);
    return json(await loadDungeonState(env, uid));
  }

  if (body.action === 'rest') {
    const code = await myRoomCode(env, uid);
    if (!code) return bad('참가 중인 방이 없습니다');
    let room = await loadRoomByCode(env, code);
    if (room) room = await expireIfNeeded(env, room);
    if (!room || room.status !== 'active') return bad('진행 중인 던전이 아닙니다');
    const pRow = await loadPlayerRow(env, code, uid);
    if (!pRow) return bad('파티원이 아닙니다');
    const p = parsePlayer(pRow);
    p.discard.push(...p.hand);
    p.hand = [];
    drawUpTo(p);
    await env.DB.prepare(
      'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, version = version + 1 WHERE room_code = ? AND user_id = ? AND version = ?',
    )
      .bind(JSON.stringify(p.hand), JSON.stringify(p.deck), JSON.stringify(p.discard), p.exhausted ? 1 : 0, code, uid, pRow.version)
      .run();
    return json(await loadDungeonState(env, uid));
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

    if (hero.id === 'ninja') {
      const p = parsePlayer(pRow);
      drawUpTo(p);
      await env.DB.prepare(
        'UPDATE dungeon_players SET hand_json = ?, deck_json = ?, discard_json = ?, exhausted = ?, used_special = 1, version = version + 1 WHERE room_code = ? AND user_id = ?',
      )
        .bind(JSON.stringify(p.hand), JSON.stringify(p.deck), JSON.stringify(p.discard), p.exhausted ? 1 : 0, code, uid)
        .run();
      return json(await loadDungeonState(env, uid));
    }

    await env.DB.prepare('UPDATE dungeon_players SET used_special = 1, version = version + 1 WHERE room_code = ? AND user_id = ?')
      .bind(code, uid)
      .run();

    if (hero.id === 'wizard') {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await loadRoomByCode(env, code);
        if (!r || r.status !== 'active') break;
        const ok = await tryRoomUpdate(env, code, r.version, {
          status: r.status,
          hp: Math.min(MAX_HP, r.hp + 2),
          endsAt: r.ends_at,
          deckJson: r.deck_json,
          currentJson: r.current_json,
          startedAt: r.started_at,
        });
        if (ok) break;
      }
      return json(await loadDungeonState(env, uid));
    }

    if (hero.id === 'barbarian') {
      const target = String(body.target ?? '');
      const room2 = await loadRoomByCode(env, code);
      const current = room2?.current_json ? (JSON.parse(room2.current_json) as CurrentCard) : null;
      if (!current || !(target in current.req)) return bad('올바른 요구치 항목을 선택해주세요');
      await applyContribution(env, code, current.key, current.phase, { [target]: 3 });
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
      const newHost = remaining[0];
      await env.DB.prepare('UPDATE dungeon_rooms SET host_user_id = ? WHERE code = ?').bind(newHost.user_id, code).run();
    }
    return json(await loadDungeonState(env, uid));
  }

  return bad('알 수 없는 액션');
}
