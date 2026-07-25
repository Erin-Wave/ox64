/** 보석 모양을 작은 격자 아이콘으로 그린다(원작 회전/반전은 서버가 배치 시점에만 적용하고, 여기선
 * 정규화된 대표 모양만 보여준다 — "이런 생김새를 찾으세요" 정도의 정보). */
export function ShapeIcon({ shape, color, cell = 6 }: { shape: readonly (readonly [number, number])[]; color: string; cell?: number }) {
  const maxX = Math.max(...shape.map((c) => c[0]));
  const maxY = Math.max(...shape.map((c) => c[1]));
  const on = new Set(shape.map(([x, y]) => `${x},${y}`));
  const rows: { x: number; y: number; on: boolean }[] = [];
  for (let y = 0; y <= maxY; y++) for (let x = 0; x <= maxX; x++) rows.push({ x, y, on: on.has(`${x},${y}`) });
  return (
    <div className="grid shrink-0 gap-px" style={{ gridTemplateColumns: `repeat(${maxX + 1}, ${cell}px)` }}>
      {rows.map((c) => (
        <div
          key={`${c.x},${c.y}`}
          style={{ width: cell, height: cell, backgroundColor: c.on ? color : 'transparent' }}
          className="rounded-[1px]"
        />
      ))}
    </div>
  );
}

interface LegendEntry {
  typeKey: string;
  label: string;
  color: string;
  shape: readonly (readonly [number, number])[];
  total: number;
  found: number;
}

/** "찾아야 할 보석" 목록 — 색/모양/개수를 미리 보여주고, 다 찾은 종류는 지운 것처럼(취소선+흐리게) 표시. */
export default function Legend({ items }: { items: LegendEntry[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => {
        const done = it.found >= it.total;
        return (
          <div
            key={it.typeKey}
            className={
              'flex items-center gap-2 rounded-lg border border-border bg-panel2 px-2.5 py-1.5 text-[11px] transition ' +
              (done ? 'opacity-40' : '')
            }
          >
            <ShapeIcon shape={it.shape} color={it.color} />
            <span className={'font-bold ' + (done ? 'text-muted line-through' : 'text-text')}>{it.label}</span>
            <span className="text-muted">
              {it.found}/{it.total}
            </span>
          </div>
        );
      })}
    </div>
  );
}
