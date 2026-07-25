import type { PuzzleGame } from './api';

interface Props {
  game: PuzzleGame;
  onOpen: (x: number, y: number) => void;
  disabled: boolean;
}

/** 보드 격자. 서버가 이미 연 칸만 내려주므로(정답 배치는 절대 안 옴), 안 열린 칸은 전부 빈 버튼이다. */
export default function Board({ game, onOpen, disabled }: Props) {
  const revealedMap = new Map(game.cells.map((c) => [`${c.x},${c.y}`, c]));
  const cellsArr: { x: number; y: number }[] = [];
  for (let y = 0; y < game.size; y++) for (let x = 0; x < game.size; x++) cellsArr.push({ x, y });

  return (
    <div
      className="mx-auto grid w-full max-w-[min(90vw,32rem)] gap-1"
      style={{ gridTemplateColumns: `repeat(${game.size}, minmax(0, 1fr))` }}
    >
      {cellsArr.map(({ x, y }) => {
        const cell = revealedMap.get(`${x},${y}`);
        const isOpen = !!cell;
        const isGem = isOpen && !!cell!.gemId;
        return (
          <button
            key={`${x},${y}`}
            type="button"
            disabled={disabled || isOpen}
            onClick={() => onOpen(x, y)}
            title={isGem ? (cell!.label ?? undefined) : undefined}
            className={
              'flex aspect-square items-center justify-center rounded-md text-[10px] font-bold transition sm:text-xs ' +
              (isOpen
                ? isGem
                  ? 'ring-1 ring-inset ring-black/10'
                  : 'bg-panel2 text-muted/40'
                : 'bg-elevated ring-1 ring-inset ring-border hover:brightness-125 active:scale-95 disabled:cursor-not-allowed')
            }
            style={isGem ? { backgroundColor: `${cell!.color}33`, color: cell!.color ?? undefined } : undefined}
          >
            {isGem ? '◆' : isOpen ? '' : ''}
          </button>
        );
      })}
    </div>
  );
}
