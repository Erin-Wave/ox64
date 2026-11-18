import { useState } from 'react';
import { useChartStore } from '@/store/useChartStore';
import { ALL_INTERVALS, INTERVAL_GROUPS } from '@/symbols';

/**
 * 차트 타임프레임 선택 — 트레이딩뷰 방식.
 * - 툴바엔 **즐겨찾기(★)만** 가로로 늘어놓아 한 번에 누른다(짧은 봉부터).
 * - ▾ 를 누르면 전체 목록이 그룹(초/분/시간/일+)별로 나오고, 거기서 고르거나 ★ 로 즐겨찾기를 켜고 끈다.
 * - 즐겨찾기가 아닌 걸 골랐으면 그 칸이 바에 **임시로** 붙는다(점선 테두리) — 지금 뭘 보고 있는지 늘 보이게.
 * `supports` = 이 심볼에서 쓸 수 있는 인터벌만(원화 심볼은 빗썸에 1초봉이 없다) — 바와 목록 양쪽에서 거른다.
 */
export default function IntervalPicker({
  value,
  onChange,
  supports,
}: {
  value: string;
  onChange: (code: string) => void;
  supports: (code: string) => boolean;
}) {
  const favs = useChartStore((s) => s.favIntervals);
  const toggleFav = useChartStore((s) => s.toggleFavInterval);
  const [open, setOpen] = useState(false);

  const bar = ALL_INTERVALS.filter((it) => supports(it.code) && (favs.includes(it.code) || it.code === value));

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {/* 즐겨찾기 바 — 좁으면 가로로 밀어서 본다(스크롤바 숨김). 드롭다운은 이 밖에 둬야 잘리지 않는다. */}
      {/* 폰: 오른쪽 끝을 흐리게 — 잘린 칸이 "밀어서 더 보기"로 읽히게(PC 는 다 들어가 흐림 없음) */}
      <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-14px),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-14px),transparent)] md:[-webkit-mask-image:none] md:[mask-image:none]">
        {bar.map((it) => {
          const active = it.code === value;
          const pinned = favs.includes(it.code);
          return (
            <button
              key={it.code}
              onClick={() => onChange(it.code)}
              title={pinned ? undefined : '즐겨찾기 아님 — ▾ 에서 ★ 로 고정할 수 있습니다'}
              className={`shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-xs font-semibold transition ${
                active ? 'bg-elevated text-accent' : 'text-muted hover:bg-panel2 hover:text-text'
              } ${pinned ? '' : 'outline-dashed outline-1 -outline-offset-1 outline-border'}`}
            >
              {it.label}
            </button>
          );
        })}
      </div>
      {/* ⚠ 폰에선 목록을 버튼이 아니라 차트 툴바(relative) 왼쪽에 맞춰 연다 — 버튼 기준이면 즐겨찾기가 많을 때 화면 오른쪽 밖으로 잘린다 */}
      <div className="shrink-0 md:relative">
        <button
          onClick={() => setOpen((v) => !v)}
          title="전체 타임프레임 · 즐겨찾기 편집"
          aria-expanded={open}
          className={`rounded px-1.5 py-1 text-xs transition hover:bg-panel2 hover:text-text ${open ? 'bg-panel2 text-text' : 'text-muted'}`}
        >
          ▾
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <div className="absolute left-1 top-full z-30 mt-1 max-h-[70vh] w-52 overflow-y-auto overscroll-contain rounded-lg border border-border bg-panel p-1.5 shadow-2xl md:left-0">
              {INTERVAL_GROUPS.map((g) => {
                const items = g.items.filter((it) => supports(it.code));
                if (items.length === 0) return null;
                return (
                  <div key={g.name} className="mb-1 last:mb-0">
                    <div className="px-2 py-0.5 text-[10px] font-semibold uppercase text-muted">{g.name}</div>
                    {items.map((it) => {
                      const pinned = favs.includes(it.code);
                      return (
                        <div
                          key={it.code}
                          className={`flex items-center rounded hover:bg-panel2 ${it.code === value ? 'bg-panel2' : ''}`}
                        >
                          <button
                            onClick={() => {
                              onChange(it.code);
                              setOpen(false);
                            }}
                            className={`flex-1 px-2 py-1 text-left text-xs ${it.code === value ? 'font-semibold text-accent' : 'text-text'}`}
                          >
                            {it.label}
                          </button>
                          <button
                            onClick={() => toggleFav(it.code)}
                            title={pinned ? '즐겨찾기 해제' : '즐겨찾기 — 툴바에 고정'}
                            aria-pressed={pinned}
                            className={`px-2 py-1 text-sm leading-none transition ${pinned ? 'text-[#f0b90b]' : 'text-muted/50 hover:text-muted'}`}
                          >
                            {pinned ? '★' : '☆'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
