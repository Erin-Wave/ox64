import { useEffect, useMemo, useRef, useState } from 'react';
import { useCrateStore } from './useCrateStore';
import { fmtG, tierOf } from './data';
import type { CatInfo, MatCat } from './api';

/**
 * 인벤토리 — 클래식 게임 인벤토리처럼 **6×8 고정 그리드 + 페이징**이다.
 *
 * ⚠ 칸 수를 고정한 이유는 **높이가 내용에 따라 변하지 않게** 하기 위해서다. 예전엔 재료 종류마다
 * 섹션을 세로로 쌓아서 상자를 깔수록 페이지가 한없이 길어졌고(제보), 그룹마다 버튼이 붙어 있어
 * 같은 버튼이 화면에 열 개씩 떠 있었다. 지금은 빈 칸도 그려서 격자가 항상 48칸이고, 조작은
 * **아래 액션 바 한 곳**에서만 한다.
 *
 * ⚠ 한 칸 = 재료 **1개**다(스택이 아니다). 머지가 "같은 걸 둘 겹친다"는 조작이라 스택으로 묶으면
 * 끌어다 놓을 상대가 사라진다 — 그래서 개수만큼 칸으로 펼치고, 늘어난 칸은 페이징이 흡수한다.
 * DB 에는 여전히 `{"wood:1": 37}` 처럼 개수만 저장되므로(§6) 칸이 몇 개로 보이든 D1 비용은 같다.
 *
 * 조작은 세 가지이고 전부 같은 포인터 이벤트로 처리한다(모바일엔 우클릭도 hover 도 없다):
 *   · **끌어다 놓기** — 6px 이상 움직이면 드래그. 같은 재료·같은 레벨 칸에 놓으면 합쳐진다.
 *   · **탭** — 선택(액션 바에 상세가 뜬다). 같은 종류의 다른 칸을 탭하면 합쳐진다.
 *   · **마우스를 올리면** 툴팁(PC 전용 — 터치는 탭 선택이 곧 상세 보기다).
 */

const COLS = 6;
const ROWS = 8;
const PAGE_SIZE = COLS * ROWS;

interface Cell {
  /** "wood:1" — 같은 그룹끼리만 합쳐진다 */
  group: string;
  cat: CatInfo;
  level: number;
  /** 그룹 안에서 몇 번째 칸인지(드래그 대상 판정용) */
  idx: number;
  /** 그 재료를 몇 개 갖고 있는지(액션 바·툴팁 표시용) */
  count: number;
}

export default function Inventory() {
  const inv = useCrateStore((s) => s.inv);
  const cats = useCrateStore((s) => s.cats);
  const flash = useCrateStore((s) => s.flash);
  const busy = useCrateStore((s) => s.busy);
  const mergeMult = useCrateStore((s) => s.mergeMult);
  const merge = useCrateStore((s) => s.merge);
  const sell = useCrateStore((s) => s.sell);
  const mergeAll = useCrateStore((s) => s.mergeAll);

  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string | null>(null); // "wood:1#3"
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number } | null>(null);
  // ⚠ 드래그 중 포인터 좌표는 리렌더에 태우지 않는다 — 48칸이 매 pointermove 마다 다시 그려진다.
  // 고스트는 ref 로 직접 움직이고, 리렌더는 "드롭 대상이 바뀌었을 때"만 일어난다.
  const [drag, setDrag] = useState<{ group: string; emoji: string; over: string | null } | null>(null);
  const [nope, setNope] = useState<string | null>(null);
  const down = useRef<{ x: number; y: number; group: string; idx: number; moved: boolean } | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);

  /** 재료를 칸 단위로 펼친다 — 카테고리 순서 → 레벨 오름차순(합칠 것이 앞 페이지에 모이게). */
  const cells = useMemo(() => {
    const out: Cell[] = [];
    for (const cat of cats)
      for (let level = 1; level <= cat.maxLevel; level++) {
        const count = inv[`${cat.cat}:${level}`] ?? 0;
        for (let i = 0; i < count; i++) out.push({ group: `${cat.cat}:${level}`, cat, level, idx: i, count });
      }
    return out;
  }, [inv, cats]);

  const pages = Math.max(1, Math.ceil(cells.length / PAGE_SIZE));
  // 머지·판매로 칸이 줄어 지금 페이지가 사라지면 마지막 페이지로 당긴다(빈 화면을 보고 있지 않도록).
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);
  const start = Math.min(page, pages - 1) * PAGE_SIZE;
  const pageCells = cells.slice(start, start + PAGE_SIZE);

  // ⚠ 같은 그룹의 아무 칸으로 폴백한다 — "1개 팔기" 로 개수가 줄면 선택했던 인덱스가 사라져서,
  // 정확히 일치하는 칸만 찾으면 아직 재료가 남았는데도 액션 바가 안내 문구로 되돌아간다.
  const selCell = useMemo(() => {
    if (!sel) return null;
    const group = sel.split('#')[0];
    return cells.find((c) => `${c.group}#${c.idx}` === sel) ?? cells.find((c) => c.group === group) ?? null;
  }, [sel, cells]);
  const mergeableAny = useMemo(
    () => cats.some((c) => { for (let lv = 1; lv < c.maxLevel; lv++) if ((inv[`${c.cat}:${lv}`] ?? 0) >= 2) return true; return false; }),
    [inv, cats],
  );

  const doMerge = (group: string, times = 1) => {
    const [cat, lv] = group.split(':');
    merge(cat as MatCat, Number(lv), times);
    setSel(null);
    setHover(null);
  };
  const reject = (slotId: string) => {
    setNope(slotId);
    setTimeout(() => setNope((v) => (v === slotId ? null : v)), 280);
  };

  const onDown = (e: React.PointerEvent, cell: Cell) => {
    if (busy || cell.count < 2) return; // 1개뿐이면 합칠 상대가 없다 — 드래그를 시작하지 않는다
    down.current = { x: e.clientX, y: e.clientY, group: cell.group, idx: cell.idx, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent, cell: Cell) => {
    const d = down.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    const first = !d.moved;
    d.moved = true;
    if (first) setHover(null); // 드래그가 시작되면 툴팁은 방해만 된다
    if (ghost.current) {
      ghost.current.style.left = `${e.clientX}px`;
      ghost.current.style.top = `${e.clientY}px`;
    }
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-slot]') as HTMLElement | null;
    const over = el?.dataset.slot ?? null;
    setDrag((prev) => (!first && prev && prev.over === over ? prev : { group: d.group, emoji: cell.cat.emoji, over }));
  };

  const onUp = (e: React.PointerEvent, cell: Cell) => {
    const d = down.current;
    down.current = null;
    setDrag(null);
    if (!d) return;

    if (d.moved) {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-slot]') as HTMLElement | null;
      const target = el?.dataset.slot ?? '';
      const [tGroup, tIdx] = target.split('#');
      if (tGroup === d.group && Number(tIdx) !== d.idx) doMerge(d.group);
      else if (target) reject(target); // 다른 재료 위에 놓았다 — 흔들어서 안 된다고 알린다
      return;
    }
    // 움직이지 않았으면 탭 — 같은 종류의 다른 칸을 이미 골라뒀으면 합치고, 아니면 선택만 한다
    const id = `${cell.group}#${cell.idx}`;
    if (sel && sel !== id && sel.split('#')[0] === cell.group) doMerge(cell.group);
    else setSel(sel === id ? null : id);
  };

  return (
    <section className="rounded-2xl border border-border bg-panel p-4">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-bold">인벤토리</h2>
          <span className="hidden text-[11px] text-muted sm:inline">
            같은 재료를 끌어다 놓으면 합쳐집니다 (가치 ×{mergeMult})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => mergeAll()}
            disabled={busy || !mergeableAny}
            title="합칠 수 있는 재료를 전부 합칩니다(상자조각 최고 레벨은 제외 — 상자 뽑기는 직접 누르세요)"
            className="rounded-md bg-accent/15 px-2.5 py-1 text-[11px] font-bold text-accent transition hover:bg-accent/25 disabled:opacity-30"
          >
            전부 합치기
          </button>
          {pages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setPage((p) => Math.max(0, p - 1)); setHover(null); }}
                disabled={page <= 0}
                className="rounded bg-panel2 px-2 py-1 text-[11px] font-bold text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
              >
                ‹
              </button>
              <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-muted">
                {Math.min(page, pages - 1) + 1} / {pages}
              </span>
              <button
                onClick={() => { setPage((p) => Math.min(pages - 1, p + 1)); setHover(null); }}
                disabled={page >= pages - 1}
                className="rounded bg-panel2 px-2 py-1 text-[11px] font-bold text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 6×8 고정 격자 — 빈 칸도 그려서 높이가 내용에 따라 흔들리지 않는다 */}
      <div className="grid grid-cols-6 gap-1">
        {Array.from({ length: PAGE_SIZE }, (_, i) => {
          const cell = pageCells[i];
          if (!cell)
            return <div key={`empty-${i}`} className="aspect-square rounded-lg border border-border/40 bg-panel2/40" />;

          const id = `${cell.group}#${cell.idx}`;
          const tier = tierOf(cell.level);
          const isSel = sel === id;
          const isOver = drag?.over === id;
          const canDrop = isOver && drag?.group === cell.group;
          const isSrc = drag?.group === cell.group && down.current?.idx === cell.idx;
          return (
            <button
              key={id}
              data-slot={id}
              onPointerDown={(e) => onDown(e, cell)}
              onPointerMove={(e) => onMove(e, cell)}
              onPointerUp={(e) => onUp(e, cell)}
              onPointerCancel={() => {
                down.current = null;
                setDrag(null);
              }}
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse' && !down.current) setHover({ cell, x: e.clientX, y: e.clientY });
              }}
              onPointerLeave={() => setHover((h) => (h?.cell.group === cell.group && h.cell.idx === cell.idx ? null : h))}
              className={
                'crate-slot relative flex aspect-square items-center justify-center rounded-lg border text-lg transition ' +
                (isSel ? 'ring-2 ring-accent ' : '') +
                (canDrop ? 'crate-droppable ' : isOver && drag ? 'opacity-40 ' : '') +
                (isSrc ? 'crate-dragging ' : '') +
                (nope === id ? 'crate-nope ' : '') +
                (flash === cell.group ? 'crate-merged ' : '') +
                (cell.count >= 2 ? 'cursor-grab active:cursor-grabbing ' : 'cursor-pointer ')
              }
              style={{ borderColor: tier.color + '66', background: tier.color + '14', color: tier.color }}
            >
              <span className="pointer-events-none select-none">{cell.cat.emoji}</span>
              <span
                className="pointer-events-none absolute bottom-0 right-0.5 text-[9px] font-extrabold leading-tight"
                style={{ color: tier.color }}
              >
                {cell.level}
              </span>
            </button>
          );
        })}
      </div>

      <ActionBar cell={selCell} busy={busy} onMerge={doMerge} onSell={sell} onClear={() => setSel(null)} />

      {/* 마우스 호버 툴팁 — 터치엔 안 뜬다(탭 선택이 곧 상세 보기다) */}
      {hover && !drag && <Tooltip cell={hover.cell} x={hover.x} y={hover.y} />}

      {/*
        드래그 고스트 — pointer-events:none 이라 elementFromPoint 가 아래 칸을 찾을 수 있다.
        ⚠ 조건부로 마운트하면 안 된다 — 위치를 ref 로 직접 옮기는데 첫 프레임엔 ref 가 비어 있어
        고스트가 (0,0) 에서 튀어나온다.
      */}
      <div ref={ghost} className="crate-ghost text-2xl" style={{ display: drag ? 'block' : 'none' }}>
        {drag?.emoji}
      </div>
    </section>
  );
}

/**
 * 조작이 모이는 유일한 자리 — 칸을 고르면 상세와 버튼이 여기 뜬다.
 * ⚠ 높이를 고정(min-h)해 선택 여부에 따라 격자가 위아래로 밀리지 않게 한다.
 */
function ActionBar({
  cell,
  busy,
  onMerge,
  onSell,
  onClear,
}: {
  cell: Cell | null;
  busy: boolean;
  onMerge: (group: string, times?: number) => void;
  onSell: (cat: MatCat, level: number, count?: number) => void;
  onClear: () => void;
}) {
  if (!cell)
    return (
      <div className="mt-2 flex min-h-[3.25rem] items-center justify-center rounded-xl bg-panel2/50 px-3 text-[11px] text-muted">
        칸을 누르면 정보와 조작이 여기 나옵니다 · 같은 재료끼리 끌어다 놓으면 합쳐집니다
      </div>
    );

  const { cat, level, count } = cell;
  const value = cat.values[level - 1] ?? 0;
  const tier = tierOf(level);
  const isTop = level >= cat.maxLevel;
  const shardCrate = isTop && cat.cat === 'shard';
  const pairs = Math.floor(count / 2);
  const canMerge = pairs > 0 && (!isTop || shardCrate);

  return (
    <div className="mt-2 flex min-h-[3.25rem] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-panel2 px-3 py-2">
      <span className="text-xl leading-none">{cat.emoji}</span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-bold" style={{ color: tier.color }}>
            Lv{level} {cat.name}
          </span>
          <span className="text-[10px] text-muted">{tier.name}</span>
        </div>
        <div className="text-[11px] text-muted">
          개당 {fmtG(value)} G · {count.toLocaleString()}개 · 총 {fmtG(value * count)} G
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {canMerge && (
          <button
            onClick={() => onMerge(cell.group, pairs)}
            disabled={busy}
            title={shardCrate ? `조각 2개마다 랜덤 상자 1개 (${pairs}개)` : `2개씩 ${pairs}번 합쳐 Lv${level + 1} ${cat.name} ${pairs}개로`}
            className={
              'rounded px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-30 ' +
              (shardCrate ? 'bg-accent text-black hover:brightness-110' : 'bg-accent/15 text-accent hover:bg-accent/25')
            }
          >
            {shardCrate ? `상자로 ×${pairs}` : `합치기 ×${pairs}`}
          </button>
        )}
        <button
          onClick={() => onSell(cat.cat, level, 1)}
          disabled={busy}
          title={`1개만 팔아 ${fmtG(value)} G 받기`}
          className="rounded bg-panel px-2.5 py-1 text-[11px] text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
        >
          1개 팔기
        </button>
        <button
          onClick={() => onSell(cat.cat, level)}
          disabled={busy}
          title={`${count.toLocaleString()}개 전부 팔아 ${fmtG(value * count)} G 받기`}
          className="rounded bg-panel px-2.5 py-1 text-[11px] text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
        >
          전부 팔기
        </button>
        <button onClick={onClear} title="선택 해제" className="px-1 text-[11px] text-muted hover:text-text">
          ✕
        </button>
      </div>
    </div>
  );
}

/** 마우스를 올린 칸의 상세 — 화면 밖으로 나가지 않게 좌표를 접는다. */
function Tooltip({ cell, x, y }: { cell: Cell; x: number; y: number }) {
  const { cat, level, count } = cell;
  const value = cat.values[level - 1] ?? 0;
  const tier = tierOf(level);
  const isTop = level >= cat.maxLevel;
  const shardCrate = isTop && cat.cat === 'shard';
  const nextValue = isTop ? 0 : cat.values[level] ?? 0;

  const flipX = typeof window !== 'undefined' && x > window.innerWidth - 220;
  const flipY = typeof window !== 'undefined' && y > window.innerHeight - 170;

  return (
    <div
      className="pointer-events-none fixed z-50 w-52 rounded-lg border border-border bg-elevated p-2.5 text-[11px] shadow-2xl"
      style={{ left: flipX ? x - 216 : x + 14, top: flipY ? y - 160 : y + 14 }}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-base leading-none">{cat.emoji}</span>
        <span className="font-bold" style={{ color: tier.color }}>
          Lv{level} {cat.name}
        </span>
        <span className="ml-auto text-[10px] text-muted">{tier.name}</span>
      </div>
      <p className="mb-1.5 leading-snug text-muted">{cat.desc}</p>
      <div className="flex justify-between">
        <span className="text-muted">판매가</span>
        <span className="font-bold tabular-nums">{fmtG(value)} G</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted">보유</span>
        <span className="font-bold tabular-nums">{count.toLocaleString()}개</span>
      </div>
      <div className="mt-1.5 border-t border-border pt-1.5 leading-snug">
        {shardCrate ? (
          <span className="text-accent">2개를 합치면 랜덤 상자가 나옵니다</span>
        ) : isTop ? (
          <span className="text-muted">최고 레벨입니다 — 더 합칠 수 없습니다</span>
        ) : (
          <span className="text-muted">
            2개 합치면 <b style={{ color: tierOf(level + 1).color }}>Lv{level + 1}</b> 1개 ({fmtG(nextValue)} G) —{' '}
            <b className="text-accent">{fmtG(nextValue - value * 2)} G 이득</b>
          </span>
        )}
      </div>
    </div>
  );
}
