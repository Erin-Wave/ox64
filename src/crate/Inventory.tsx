import { useMemo, useRef, useState } from 'react';
import { useCrateStore } from './useCrateStore';
import { MAX_SLOTS_PER_GROUP, fmtG, tierOf } from './data';
import type { CatInfo, MatCat } from './api';

/**
 * 인벤토리 + 머지.
 *
 * ⚠ 재료는 DB 에 `{"wood:1": 37}` 처럼 **개수만** 저장되고(§6 — 아이템을 행으로 쪼개면 개봉 한 번이
 * 수십 행이 된다) 화면에서만 개수만큼 칸으로 펼친다. 그래서 "칸을 끌어다 놓는" 제스처는 순수 UI 이고
 * 서버에는 `merge(cat, level, times)` 하나만 간다.
 *
 * 두 가지 조작을 같은 포인터 이벤트로 처리한다(모바일에 우클릭도 hover 도 없기 때문):
 *   · **끌어다 놓기** — 6px 이상 움직이면 드래그. 같은 재료·같은 레벨 칸에 놓으면 합쳐진다.
 *   · **탭 두 번** — 움직이지 않고 뗐으면 선택. 같은 그룹의 다른 칸을 탭하면 합쳐진다.
 * ⚠ `setPointerCapture` 를 걸어야 손가락이 칸 밖으로 나가도 이벤트가 끊기지 않는다. 대상 칸은
 * `document.elementFromPoint` 로 찾으므로 드래그 고스트는 반드시 `pointer-events: none` 이어야 한다.
 */
export default function Inventory() {
  const inv = useCrateStore((s) => s.inv);
  const cats = useCrateStore((s) => s.cats);
  const flash = useCrateStore((s) => s.flash);
  const busy = useCrateStore((s) => s.busy);
  const mergeMult = useCrateStore((s) => s.mergeMult);
  const merge = useCrateStore((s) => s.merge);
  const sell = useCrateStore((s) => s.sell);
  const mergeAll = useCrateStore((s) => s.mergeAll);
  const sellAll = useCrateStore((s) => s.sellAll);

  const [sel, setSel] = useState<string | null>(null); // "wood:1#3"
  // ⚠ 드래그 중 상태는 **포인터 좌표를 리렌더에 태우지 않는다** — 인벤토리는 칸이 수백 개까지 가므로
  // 매 pointermove 마다 setState 하면 그 전부가 다시 그려진다. 고스트는 ref 로 직접 움직이고,
  // 리렌더는 "드롭 대상이 바뀌었을 때"만 일어난다(그때만 테두리 강조가 달라진다).
  const [drag, setDrag] = useState<{ group: string; emoji: string; over: string | null } | null>(null);
  const [nope, setNope] = useState<string | null>(null);
  const down = useRef<{ x: number; y: number; group: string; idx: number; moved: boolean } | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => {
    const out: { group: string; cat: CatInfo; level: number; count: number }[] = [];
    for (const c of cats)
      for (let lv = 1; lv <= c.maxLevel; lv++) {
        const key = `${c.cat}:${lv}`;
        const count = inv[key] ?? 0;
        if (count > 0) out.push({ group: key, cat: c, level: lv, count });
      }
    return out;
  }, [inv, cats]);

  const mergeable = groups.some((g) => g.count >= 2 && g.level < g.cat.maxLevel);
  const sellableJunk = groups.some((g) => g.cat.cat !== 'shard' && g.level <= 1);

  const doMerge = (group: string, times = 1) => {
    const [cat, lv] = group.split(':');
    merge(cat as MatCat, Number(lv), times);
    setSel(null);
  };
  const reject = (slotId: string) => {
    setNope(slotId);
    setTimeout(() => setNope((v) => (v === slotId ? null : v)), 280);
  };

  const onDown = (e: React.PointerEvent, group: string, idx: number, count: number) => {
    if (busy || count < 2) return; // 1개뿐이면 합칠 상대가 없다 — 드래그 자체를 시작하지 않는다
    down.current = { x: e.clientX, y: e.clientY, group, idx, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent, emoji: string) => {
    const d = down.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    const first = !d.moved;
    d.moved = true;
    // 고스트는 DOM 을 직접 움직인다(리렌더 0). 드롭 대상이 바뀔 때만 state 를 건드려 강조를 갱신한다.
    if (ghost.current) {
      ghost.current.style.left = `${e.clientX}px`;
      ghost.current.style.top = `${e.clientY}px`;
    }
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-slot]') as HTMLElement | null;
    const over = el?.dataset.slot ?? null;
    setDrag((prev) => (!first && prev && prev.over === over ? prev : { group: d.group, emoji, over }));
  };

  const onUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    setDrag(null);
    if (!d) return;

    if (d.moved) {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-slot]') as HTMLElement | null;
      const target = el?.dataset.slot ?? '';
      const [tGroup, tIdx] = target.split('#');
      if (tGroup === d.group && Number(tIdx) !== d.idx) doMerge(d.group);
      else if (target) reject(target);
      setSel(null);
      return;
    }
    // 움직이지 않았으면 탭 — 같은 그룹의 다른 칸을 이미 골라뒀으면 합치고, 아니면 선택만 한다
    const id = `${d.group}#${d.idx}`;
    if (sel && sel !== id && sel.split('#')[0] === d.group) doMerge(d.group);
    else setSel(sel === id ? null : id);
  };

  return (
    <section className="rounded-2xl border border-border bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-bold">인벤토리</h2>
          <span className="text-[11px] text-muted">
            같은 재료 2개를 끌어다 놓으면 합쳐집니다 (가치 ×{mergeMult})
          </span>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => mergeAll()}
            disabled={busy || !mergeable}
            title="합칠 수 있는 재료를 전부 합칩니다(상자조각 최고 레벨은 제외 — 상자 뽑기는 직접 누르세요)"
            className="rounded-md bg-accent/15 px-2.5 py-1.5 text-[11px] font-bold text-accent transition hover:bg-accent/25 disabled:opacity-30"
          >
            전부 합치기
          </button>
          <button
            onClick={() => sellAll(1)}
            disabled={busy || !sellableJunk}
            title="Lv1 재료를 전부 팝니다(상자조각 제외 — 그건 합치는 게 이득입니다)"
            className="rounded-md bg-panel2 px-2.5 py-1.5 text-[11px] font-bold text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
          >
            Lv1 팔기
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted">비어 있습니다. 상자를 열어 재료를 모으세요.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(({ group, cat, level, count }) => {
            const value = cat.values[level - 1] ?? 0;
            const isTop = level >= cat.maxLevel;
            const shardCrate = isTop && cat.cat === 'shard';
            const pairs = Math.floor(count / 2);
            const shown = Math.min(count, MAX_SLOTS_PER_GROUP);
            const tier = tierOf(level);
            return (
              <div key={group} className={'rounded-xl bg-panel2 p-2.5' + (flash === group ? ' crate-merged' : '')}>
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-base leading-none">{cat.emoji}</span>
                  <span className="text-xs font-bold" style={{ color: tier.color }}>
                    Lv{level} {cat.name}
                  </span>
                  <span className="text-[11px] text-muted">×{count.toLocaleString()}</span>
                  <span className="text-[11px] text-muted">· 개당 {fmtG(value)} G</span>
                  <span className="ml-auto flex gap-1">
                    {pairs > 0 && (isTop ? shardCrate : true) && (
                      <button
                        onClick={() => doMerge(group, pairs)}
                        disabled={busy}
                        title={
                          shardCrate
                            ? `상자조각 2개마다 랜덤 상자 1개 (${pairs}개)`
                            : `2개씩 ${pairs}번 합쳐 Lv${level + 1} ${cat.name} ${pairs}개로`
                        }
                        className={
                          'rounded px-2 py-1 text-[11px] font-bold transition disabled:opacity-30 ' +
                          (shardCrate ? 'bg-accent text-black hover:brightness-110' : 'bg-accent/15 text-accent hover:bg-accent/25')
                        }
                      >
                        {shardCrate ? `상자로 ×${pairs}` : `합치기 ×${pairs}`}
                      </button>
                    )}
                    <button
                      onClick={() => sell(cat.cat, level)}
                      disabled={busy}
                      title={`전부 팔아 ${fmtG(value * count)} G 받기`}
                      className="rounded bg-panel px-2 py-1 text-[11px] text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
                    >
                      팔기
                    </button>
                  </span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {Array.from({ length: shown }, (_, i) => {
                    const id = `${group}#${i}`;
                    const isSel = sel === id;
                    const isOver = drag?.over === id && drag.group === group;
                    const isSrc = drag?.group === group && down.current?.idx === i;
                    return (
                      <button
                        key={id}
                        data-slot={id}
                        onPointerDown={(e) => onDown(e, group, i, count)}
                        onPointerMove={(e) => onMove(e, cat.emoji)}
                        onPointerUp={onUp}
                        onPointerCancel={() => {
                          down.current = null;
                          setDrag(null);
                        }}
                        className={
                          'crate-slot relative flex h-11 w-11 items-center justify-center rounded-lg border text-lg transition ' +
                          (isSel ? 'ring-2 ring-accent ' : '') +
                          (isOver ? 'crate-droppable ' : '') +
                          (isSrc ? 'crate-dragging ' : '') +
                          (nope === id ? 'crate-nope ' : '') +
                          (count >= 2 ? 'cursor-grab active:cursor-grabbing ' : 'cursor-default ')
                        }
                        style={{ borderColor: tier.color + '66', background: tier.color + '14', color: tier.color }}
                        title={`${cat.name} Lv${level} · ${fmtG(value)} G`}
                      >
                        <span className="pointer-events-none">{cat.emoji}</span>
                        <span
                          className="pointer-events-none absolute bottom-0 right-0.5 text-[9px] font-extrabold leading-tight"
                          style={{ color: tier.color }}
                        >
                          {level}
                        </span>
                      </button>
                    );
                  })}
                  {count > shown && (
                    <span className="flex h-11 items-center rounded-lg bg-panel px-2 text-[11px] font-bold text-muted">
                      +{(count - shown).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/*
        드래그 고스트 — pointer-events:none 이라 elementFromPoint 가 아래 칸을 찾을 수 있다.
        ⚠ 조건부로 마운트하면 안 된다 — onMove 가 ref 로 위치를 직접 옮기는데, 드래그가 시작되는
        첫 프레임엔 아직 ref 가 비어 있어 고스트가 (0,0) 에서 튀어나온다.
      */}
      <div ref={ghost} className="crate-ghost text-2xl" style={{ display: drag ? 'block' : 'none' }}>
        {drag?.emoji}
      </div>
    </section>
  );
}
