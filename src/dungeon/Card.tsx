import type { DungeonCard } from './api';
import { iconMeta } from './data';

interface Props {
  card: DungeonCard;
  onClick?: () => void;
  selected?: boolean;
  /** 지금 이 카드로는 현재 요구치를 채울 수 없음 — 흐리게 */
  dim?: boolean;
  size?: 'sm' | 'md';
}

/**
 * 카드 1장. 아이콘 이모지 + 기여값 + 아이콘 이름을 함께 보여준다(이모지만 있으면 무슨 속성인지
 * 바로 안 읽힌다). 특수카드는 값 대신 ✨ 로 표시하고 손패에서 직접 낼 수 없다(전용 버튼 전용).
 */
export default function Card({ card, onClick, selected, dim, size = 'md' }: Props) {
  const meta = iconMeta(card.icon);
  const sm = size === 'sm';
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      title={card.special ? '고유 특수카드 — 아래 특수 버튼으로만 사용합니다' : `${meta.label} ${card.value}`}
      className={
        'relative flex flex-shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg font-bold ring-1 ring-inset transition ' +
        (sm ? 'h-11 w-8 text-[9px] ' : 'h-[4.5rem] w-[3.25rem] text-[10px] sm:h-20 sm:w-14 sm:text-[11px] ') +
        (dim ? 'opacity-30 ' : '') +
        (selected ? 'ring-2 ring-accent brightness-125 ' : 'ring-border ') +
        (clickable ? 'cursor-pointer hover:-translate-y-0.5 hover:brightness-110 active:scale-95' : 'cursor-default')
      }
      style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
    >
      <span className={sm ? 'text-sm' : 'text-xl sm:text-2xl'}>{card.special ? '✨' : meta.emoji}</span>
      {card.special ? (
        !sm && <span className="leading-none opacity-80">특수</span>
      ) : (
        <>
          <span className={sm ? 'leading-none' : 'text-sm leading-none sm:text-base'}>{card.value}</span>
          {!sm && <span className="leading-none opacity-70">{meta.label}</span>}
        </>
      )}
    </button>
  );
}
