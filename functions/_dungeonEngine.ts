// ── "5분 던전" 순수 게임 로직 (D1 I/O 없음) — _trading.ts 와 같은 "로직은 순수 함수로 분리" 패턴 ──
// functions/api/dungeon.ts 가 D1 읽기/쓰기·동시성 재시도를 담당하고, 이 파일은 셔플/드로우/요구치
// 판정/함정 적용 같은 순수 계산만 한다(테스트·재사용 쉽게).
import {
  type CardIcon,
  type CardSpec,
  type EventDef,
  type HeroDef,
  type Icon,
  type Req,
  HAND_LIMIT,
  HERO_BY_ID,
  MONSTER_POOL,
  TRAP_POOL,
  POTION_POOL,
  BOSS,
  heroDeckSpec,
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
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
 * exhausted = "더 이상 뽑을 수도, 낼 손패도 없는" 완전 소진 상태(승패 판정용). */
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

/** 함정 카드 자동 발동: 파티 체력 차감 + 전원 손패에서 무작위 discardEach 장씩 버림더미로. */
export function applyTrap(ev: EventDef, hp: number, players: PlayerState[]): number {
  if (!ev.trapEffect) return hp;
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
  return newHp;
}

/** 던전 1개 분량 이벤트 덱: 몬스터 10 + 함정 2 + 포션 2 를 섞고, 보스는 항상 마지막(원작 관행). */
export function buildDungeonDeck(): EventDef[] {
  const body = shuffle([...MONSTER_POOL, ...TRAP_POOL, ...POTION_POOL]);
  return [...body, BOSS];
}
