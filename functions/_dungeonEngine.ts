// ── "5분 던전" 순수 게임 로직 (D1 I/O 없음) — _trading.ts 와 같은 "로직은 순수 함수로 분리" 패턴 ──
// functions/api/dungeon.ts 가 D1 읽기/쓰기·동시성 재시도를 담당하고, 이 파일은 셔플/드로우/요구치
// 판정/함정 적용/덱 생성 같은 순수 계산만 한다(테스트·재사용 쉽게).
import {
  type CardIcon,
  type CardSpec,
  type DungeonDef,
  type EventDef,
  type HeroDef,
  type Icon,
  type Req,
  HAND_LIMIT,
  HERO_BY_ID,
  ICONS,
  MONSTER_POOL,
  TRAP_POOL,
  POTION_POOL,
  BOSSES,
  DUNGEON_BY_ID,
  LOG_LIMIT,
  heroDeckSpec,
  partyScale,
} from './_dungeonData';

export interface Card {
  id: string;
  icon: CardIcon;
  value: number;
  special?: boolean;
}
export interface PlayerState {
  userId: string;
  name: string;
  heroId: string;
  hand: Card[];
  deck: Card[];
  discard: Card[];
  exhausted: boolean;
  usedSpecial: boolean;
  contributed: number;
}
export interface LogEntry {
  k: string; // 'defeat' | 'trap' | 'potion' | 'phase' | 'special' | 'win' | 'lose' | 'start' | 'ward'
  m: string;
  t: number;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick<T>(arr: T[], n: number): T[] {
  // n 이 풀보다 크면 풀을 반복해서 채운다(작은 풀에서 큰 던전을 만들 때).
  const out: T[] = [];
  while (out.length < n) out.push(...shuffle(arr).slice(0, Math.min(n - out.length, arr.length)));
  return out;
}

function cardsFromSpec(specs: CardSpec[]): Card[] {
  return specs.map((s, i) => ({
    id: `c${i}_${Math.random().toString(36).slice(2, 9)}`,
    icon: s.icon,
    value: s.value,
    special: s.special,
  }));
}
export function buildHeroDeck(heroId: string): Card[] {
  const hero: HeroDef | undefined = HERO_BY_ID.get(heroId);
  if (!hero) throw new Error('알 수 없는 영웅입니다');
  return shuffle(cardsFromSpec(heroDeckSpec(hero)));
}

/** 손패를 상한까지 채운다. 덱이 비면 버림더미를 셔플해 새 덱으로. 둘 다 비면 거기서 멈춘다.
 * exhausted = "손패도 덱도 버림더미도 전부 빈" 완전 소진 상태(전원 소진 시 던전 실패). */
export function drawUpTo(p: PlayerState, limit = HAND_LIMIT): void {
  while (p.hand.length < limit) {
    if (p.deck.length === 0) {
      if (p.discard.length === 0) break;
      p.deck = shuffle(p.discard);
      p.discard = [];
    }
    p.hand.push(p.deck.shift()!);
  }
  p.exhausted = p.hand.length === 0 && p.deck.length === 0 && p.discard.length === 0;
}

export function allExhausted(players: PlayerState[]): boolean {
  return players.length > 0 && players.every((p) => p.exhausted);
}

export function reqRemaining(req: Req, progress: Record<string, number>): Req {
  const out: Req = {};
  for (const k of Object.keys(req) as (Icon | 'any')[]) {
    const need = (req[k] ?? 0) - (progress[k] ?? 0);
    if (need > 0) out[k] = need;
  }
  return out;
}
export function isReqMet(req: Req, progress: Record<string, number>): boolean {
  return Object.keys(reqRemaining(req, progress)).length === 0;
}
export function canContribute(cardIcon: CardIcon, target: Icon | 'any'): boolean {
  if (target === 'any') return true;
  return cardIcon === target || cardIcon === 'wild';
}

/** 남은 요구치에 총 amount 만큼을 자동 분배한다(음유시인 "영감의 노래", 남은 항목부터 차례로). */
export function autoFill(req: Req, progress: Record<string, number>, amount: number): Record<string, number> {
  const add: Record<string, number> = {};
  let left = amount;
  for (const [k, need] of Object.entries(reqRemaining(req, progress))) {
    if (left <= 0) break;
    const give = Math.min(left, need ?? 0);
    add[k] = give;
    left -= give;
  }
  return add;
}

/** 함정 자동 발동: 파티 체력 차감 + 전원 손패에서 무작위 N장 버림(버린 만큼 다시 뽑음).
 * ward 가 있으면 그 함정을 통째로 무효화하고 ward 를 1 소모한다(팔라딘 "수호의 방벽"). */
export function applyTrap(
  ev: EventDef,
  hp: number,
  players: PlayerState[],
  ward: number,
): { hp: number; ward: number; log: LogEntry } {
  const now = Date.now();
  if (ward > 0) return { hp, ward: ward - 1, log: { k: 'ward', m: `수호의 방벽이 «${ev.name}» 을 막아냈다`, t: now } };
  if (!ev.trapEffect) return { hp, ward, log: { k: 'trap', m: `«${ev.name}» 발동`, t: now } };
  const newHp = Math.max(0, hp - ev.trapEffect.hpLoss);
  for (const p of players) {
    for (let i = 0; i < ev.trapEffect.discardEach; i++) {
      if (p.hand.length === 0) break;
      const idx = Math.floor(Math.random() * p.hand.length);
      const [c] = p.hand.splice(idx, 1);
      p.discard.push(c);
    }
    drawUpTo(p);
  }
  return { hp: newHp, ward, log: { k: 'trap', m: `함정 «${ev.name}» — ${ev.trapEffect.note}`, t: now } };
}

// ── 던전 덱 생성 ──────────────────────────────────────────────────────────
/** 파티가 실제로 낼 수 있는 아이콘(각 영웅의 주/보조). 와일드는 아무거나 되므로 제외. */
export function coveredIcons(heroIds: string[]): Set<Icon> {
  const set = new Set<Icon>();
  for (const id of heroIds) {
    const h = HERO_BY_ID.get(id);
    if (!h) continue;
    set.add(h.primary);
    set.add(h.secondary);
  }
  return set;
}

/** 인원수에 맞춰 요구치를 스케일하고, **파티가 낼 수 없는 아이콘은 'any' 로 완화**한다.
 * ⚠ 후자가 없으면 예컨대 바바리안(힘/민첩) 혼자 들어간 판에서 «밴시»(신성+마법)를 만나면
 * 와일드 2장으로는 절대 못 잡아 타이머가 끝날 때까지 교착된다(솔플·2인에서 실제로 발생). */
export function adaptReq(req: Req, partySize: number, covered: Set<Icon>): Req {
  const scale = partyScale(partySize);
  const out: Req = {};
  for (const [k, v] of Object.entries(req)) {
    const scaled = Math.max(1, Math.round((v ?? 0) * scale));
    const key = k === 'any' || covered.has(k as Icon) ? (k as Icon | 'any') : 'any';
    out[key] = (out[key] ?? 0) + scaled;
  }
  return out;
}

/** 던전 1개 분량의 이벤트 덱. 몬스터/함정/포션을 섞고 보스는 항상 마지막(원작 관행).
 * 몬스터는 파티가 커버하는 아이콘만 쓰는 것을 우선 고르고, 모자라면 나머지에서 채우되
 * adaptReq 가 커버 안 되는 아이콘을 'any' 로 바꿔주므로 어떤 조합이든 항상 클리어 가능하다. */
export function buildDungeonDeck(dungeonId: string, heroIds: string[]): EventDef[] {
  const dungeon: DungeonDef | undefined = DUNGEON_BY_ID.get(dungeonId);
  if (!dungeon) throw new Error('알 수 없는 던전입니다');
  const partySize = heroIds.length;
  const covered = coveredIcons(heroIds);

  const tierSet = new Set(dungeon.tiers);
  const inTier = MONSTER_POOL.filter((m) => m.tier != null && tierSet.has(m.tier));
  const fits = (m: EventDef) => Object.keys(m.req ?? {}).every((k) => k === 'any' || covered.has(k as Icon));
  const preferred = inTier.filter(fits);
  const monsterSource = preferred.length >= Math.min(4, dungeon.monsters) ? preferred : inTier;

  const monsters = pick(monsterSource, dungeon.monsters);
  const traps = pick(TRAP_POOL, dungeon.traps);
  const potions = pick(POTION_POOL, dungeon.potions);
  const boss = BOSSES[dungeon.bossKey];

  const body = shuffle([...monsters, ...traps, ...potions]).map((ev, i) => ({
    ...ev,
    key: `${ev.key}#${i}`, // 같은 카드가 두 번 나와도 진행 중 카드를 구분할 수 있게 유일 키 부여
    req: ev.req ? adaptReq(ev.req, partySize, covered) : undefined,
  }));
  const scaledBoss: EventDef = {
    ...boss,
    req: boss.req ? adaptReq(boss.req, partySize, covered) : undefined,
    req2: boss.req2 ? adaptReq(boss.req2, partySize, covered) : undefined,
  };
  return [...body, scaledBoss];
}

/** 로그에 항목을 덧붙이고 최근 LOG_LIMIT 개만 남긴다(방 행에 JSON 으로 얹혀 폴링으로 전달된다). */
export function pushLog(log: LogEntry[], entries: LogEntry[]): LogEntry[] {
  return [...log, ...entries].slice(-LOG_LIMIT);
}
export const ALL_ICONS = ICONS;
