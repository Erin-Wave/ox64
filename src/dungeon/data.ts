// 표시 전용 메타(아이콘 라벨/색/이모지) — 실제 덱 구성·판정 로직의 진실원본은 서버
// (functions/_dungeonData.ts) 뿐이다. 여기 값이 바뀌어도 게임 결과엔 영향 없음(화면 표기만).
import type { CardIcon, EventType, Icon } from './api';

export const ICON_META: Record<Icon, { label: string; emoji: string; color: string }> = {
  str: { label: '힘', emoji: '⚔️', color: '#f87171' },
  mag: { label: '마법', emoji: '🔮', color: '#a78bfa' },
  agi: { label: '민첩', emoji: '🗡️', color: '#34d399' },
};
export const WILD_META = { label: '와일드', emoji: '⭐', color: '#fbbf24' };

export function iconMeta(icon: CardIcon) {
  return icon === 'wild' ? WILD_META : ICON_META[icon];
}
export function reqKeyMeta(key: string) {
  if (key === 'any') return { label: '아무거나', emoji: '❔', color: '#94a3b8' };
  return ICON_META[key as Icon] ?? WILD_META;
}

export const EVENT_TYPE_META: Record<EventType, { label: string; color: string }> = {
  monster: { label: '몬스터', color: '#f87171' },
  trap: { label: '함정', color: '#fb923c' },
  potion: { label: '포션', color: '#38bdf8' },
  boss: { label: '보스', color: '#e879f9' },
};

export const HERO_COLORS: Record<string, string> = {
  barbarian: '#f87171',
  wizard: '#a78bfa',
  ninja: '#34d399',
};
