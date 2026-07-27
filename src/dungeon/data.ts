// 표시 전용 메타(아이콘 라벨/색/이모지, 카드 배치 계산) — 실제 덱 구성·요구치·판정 로직의
// 진실원본은 서버(functions/_dungeonData.ts) 뿐이다. 여기 값이 바뀌어도 게임 결과엔 영향 없음.
import type { CardIcon, DungeonCard, EventType, Icon } from './api';

export const ICON_META: Record<Icon, { label: string; emoji: string; color: string }> = {
  str: { label: '힘', emoji: '⚔️', color: '#f87171' },
  mag: { label: '마법', emoji: '🔮', color: '#a78bfa' },
  agi: { label: '민첩', emoji: '🗡️', color: '#34d399' },
  hol: { label: '신성', emoji: '✨', color: '#fbbf24' },
  nat: { label: '자연', emoji: '🌿', color: '#4ade80' },
};
export const WILD_META = { label: '와일드', emoji: '🌈', color: '#f472b6' };
export const ANY_META = { label: '아무거나', emoji: '❔', color: '#94a3b8' };

export function iconMeta(icon: CardIcon) {
  return icon === 'wild' ? WILD_META : ICON_META[icon];
}
/** 요구치 키('str'|'any'|…) → 표시 메타 */
export function reqKeyMeta(key: string) {
  if (key === 'any') return ANY_META;
  return ICON_META[key as Icon] ?? WILD_META;
}

export const EVENT_TYPE_META: Record<EventType, { label: string; color: string; emoji: string; hint: string }> = {
  monster: { label: '몬스터', color: '#f87171', emoji: '👹', hint: '요구치를 다 채우면 격파하고 다음 카드로 넘어갑니다.' },
  trap: { label: '함정', color: '#fb923c', emoji: '🕸️', hint: '공개 즉시 자동 발동합니다(팔라딘의 방벽으로만 막을 수 있음).' },
  potion: { label: '포션', color: '#38bdf8', emoji: '🧪', hint: '아무 카드로나 채울 수 있고, 다 채우면 파티 체력을 회복합니다.' },
  boss: { label: '보스', color: '#e879f9', emoji: '👑', hint: '2페이즈입니다. 1페이즈를 끝내면 진행도가 초기화되고 2페이즈가 시작됩니다.' },
};

export const HERO_COLORS: Record<string, string> = {
  barbarian: '#f87171',
  wizard: '#a78bfa',
  ninja: '#34d399',
  paladin: '#fbbf24',
  druid: '#4ade80',
  bard: '#f472b6',
};

export const DIFFICULTY_LABEL: Record<number, string> = { 1: '입문', 2: '보통', 3: '어려움', 4: '최고 난이도' };

/** 이 카드로 그 요구치 항목을 채울 수 있는가(서버 canContribute 와 같은 규칙 — 미리 걸러 보여주기용). */
export function canContribute(icon: CardIcon, target: string): boolean {
  if (target === 'any') return true;
  return icon === target || icon === 'wild';
}

/** 남은 요구치 = 필요량 − 이미 채운 양 (0 이하는 제외) */
export function remainingReq(req: Record<string, number>, progress: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(req)) {
    const need = (req[k] ?? 0) - (progress[k] ?? 0);
    if (need > 0) out[k] = need;
  }
  return out;
}

/**
 * "전부 내기" 계획 — 손패에서 지금 요구치에 쓸 수 있는 카드를 최대한 배치한다.
 * 요구치를 넘겨 낭비하지 않도록 (1)전용 아이콘 카드를 와일드보다 먼저 (2)큰 값부터 넣되 남은
 * 필요량을 초과하지 않게 고르고, 마지막에 남은 필요량이 있으면 초과를 감수하고서라도 채운다
 * (그래야 "3 필요한데 5짜리밖에 없어서 영영 못 깬다"가 안 생긴다).
 */
export function planAutoPlay(
  hand: DungeonCard[],
  req: Record<string, number>,
  progress: Record<string, number>,
): { cardId: string; target: string }[] {
  const need = remainingReq(req, progress);
  const plays: { cardId: string; target: string }[] = [];
  const used = new Set<string>();
  const usable = hand.filter((c) => !c.special);

  const take = (target: string, allowOver: boolean) => {
    // 큰 값 우선, 같은 값이면 전용 아이콘을 와일드보다 먼저 쓴다(와일드는 아껴 두는 게 이득).
    const pool = usable
      .filter((c) => !used.has(c.id) && canContribute(c.icon, target))
      .sort((a, b) => b.value - a.value || (a.icon === 'wild' ? 1 : 0) - (b.icon === 'wild' ? 1 : 0));
    for (const card of pool) {
      if ((need[target] ?? 0) <= 0) return;
      if (!allowOver && card.value > need[target]) continue;
      used.add(card.id);
      plays.push({ cardId: card.id, target });
      need[target] -= card.value;
    }
  };

  for (const target of Object.keys(need)) take(target, false);
  for (const target of Object.keys(need)) if ((need[target] ?? 0) > 0) take(target, true);
  return plays;
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
