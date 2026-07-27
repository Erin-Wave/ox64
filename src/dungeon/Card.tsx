import type { DungeonCard } from './api';
import { iconMeta } from './data';

interface Props {
  card: DungeonCard;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  dim?: boolean;
}

/** 카드 1장 — 아이콘 이모지 + 기여값. 특수카드는 값 대신 별 표시. */
export default function Card({ card, onClick, selected, disabled, dim }: Props) {
  const meta = iconMeta(card.icon);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      title={card.special ? '고유 특수카드(useSpecial 버튼으로 사용)' : `${meta.label} ${card.value}`}
      className={
        'flex h-14 w-10 flex-shrink-0 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] font-bold ring-1 ring-inset transition sm:h-16 sm:w-12 ' +
        (dim ? 'opacity-40 ' : '') +
        (selected ? 'ring-2 ring-accent brightness-125 ' : 'ring-border ') +
        (onClick && !disabled ? 'cursor-pointer hover:brightness-110 active:scale-95' : 'cursor-default')
      }
      style={{ backgroundColor: `${meta.color}26`, color: meta.color }}
    >
      <span className="text-base sm:text-lg">{card.special ? '✨' : meta.emoji}</span>
      {!card.special && <span>{card.value}</span>}
    </button>
  );
}
