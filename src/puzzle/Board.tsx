import type { Connects, PuzzleGame } from './api';

interface Props {
  game: PuzzleGame;
  onOpen: (x: number, y: number) => void;
  disabled: boolean;
}

const NUB = 'absolute rounded-sm';

/** 열린 보석 칸 — 색깔 + 어느 방향으로 더 이어지는지(연결 방향 "부위")를 보여줘서 다음 칸을 유추하게 한다. */
function GemCell({ color, connects }: { color: string; connects?: Connects }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center rounded-md ring-1 ring-inset ring-black/10" style={{ backgroundColor: `${color}3d` }}>
      <span className="text-[13px] sm:text-base" style={{ color }}>
        ◆
      </span>
      {connects?.up && <span className={NUB} style={{ backgroundColor: color, left: '50%', top: -2, width: 10, height: 6, transform: 'translateX(-50%)' }} />}
      {connects?.down && <span className={NUB} style={{ backgroundColor: color, left: '50%', bottom: -2, width: 10, height: 6, transform: 'translateX(-50%)' }} />}
      {connects?.left && <span className={NUB} style={{ backgroundColor: color, top: '50%', left: -2, width: 6, height: 10, transform: 'translateY(-50%)' }} />}
      {connects?.right && <span className={NUB} style={{ backgroundColor: color, top: '50%', right: -2, width: 6, height: 10, transform: 'translateY(-50%)' }} />}
    </div>
  );
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
              'aspect-square overflow-visible rounded-md text-[10px] font-bold transition sm:text-xs ' +
              (isOpen
                ? isGem
                  ? ''
                  : 'bg-panel2 text-muted/40'
                : 'bg-elevated ring-1 ring-inset ring-border hover:brightness-125 active:scale-95 disabled:cursor-not-allowed')
            }
          >
            {isGem && <GemCell color={cell!.color!} connects={cell!.connects} />}
          </button>
        );
      })}
    </div>
  );
}
