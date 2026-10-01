import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

// ── 차트 ↔ 포지션 패널 분할선(데스크톱 2열 그리드의 왼쪽 열) ─────────────────────────────────
// 아래 행(포지션 패널) 높이를 px 로 들고 있다가 그리드의 `grid-template-rows` 로 내려준다. 위 행(차트)은
// `minmax(0,1fr)` 라 나머지를 다 가져가고, 차트는 `autoSize` 라 컨테이너가 바뀌면 스스로 다시 그린다.
// ⚠ 드래그 중엔 React 를 다시 그리지 않는다 — App 이 다시 그려지면 차트·호가창·주문패널·포지션이 통째로 다시
//   렌더돼 끄는 손을 못 따라간다. 그리드 style 만 직접 바꾸고, 손을 뗄 때 한 번 상태·저장소에 넣는다.
// ⚠ 모바일(세로 스택)엔 그리드가 아니라 이 값이 아무 데도 안 걸린다(분할선도 숨김).
const KEY = 'ox64_positions_h';
export const SPLIT_DEFAULT_H = 224; // 예전 고정 높이(14rem) — 더블클릭하면 여기로
const MIN_H = 96; // 탭 바 + 한 줄은 보이게
const CHART_MIN_H = 160; // 차트가 이보다 작아지면 축·레전드만 남는다
const KEY_STEP = 16; // 키보드(↑/↓) 한 번에 움직이는 양

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MIN_H ? v : SPLIT_DEFAULT_H;
  } catch {
    return SPLIT_DEFAULT_H; // 저장소를 못 쓰는 환경(사생활 보호 모드 등) — 기본 높이로
  }
}
function save(h: number) {
  try {
    localStorage.setItem(KEY, String(h));
  } catch {
    /* 저장 못 해도 이번 화면에선 그대로 쓴다 */
  }
}

/** 창이 작아져 저장된 높이가 안 들어가도 차트가 0 으로 찌그러지지 않게 CSS 가 한 번 더 막는다
 * (그리드 높이는 h-screen 에서 내려온 확정값이라 % 가 풀린다). */
const rowsOf = (h: number) => `minmax(0,1fr) max(${MIN_H}px, min(${h}px, calc(100% - ${CHART_MIN_H}px)))`;

export function usePanelSplit() {
  const gridRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(load);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const live = useRef<number | null>(null); // 드래그 중인 높이(리렌더가 끼어들어도 이 값으로 그린다)

  /** 지금 화면에 실제로 그려진 아래 행 높이 — 저장값이 CSS 에서 잘렸을 수 있으므로 그리드에서 읽는다. */
  const shownH = () => {
    const g = gridRef.current;
    const last = g ? parseFloat(getComputedStyle(g).gridTemplateRows.split(' ').pop() ?? '') : NaN;
    return Number.isFinite(last) ? last : height;
  };
  const clampH = (h: number) => {
    const total = gridRef.current?.clientHeight ?? 0;
    const max = total > 0 ? Math.max(MIN_H, total - CHART_MIN_H) : Number.POSITIVE_INFINITY;
    return Math.round(Math.min(max, Math.max(MIN_H, h)));
  };
  const commit = (h: number) => {
    live.current = null;
    setHeight(h);
    save(h);
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (live.current != null) commit(live.current);
  };

  const handleProps = {
    role: 'separator' as const,
    'aria-orientation': 'horizontal' as const,
    'aria-label': '차트와 포지션 패널 높이 조절',
    'aria-valuenow': Math.round(height),
    tabIndex: 0,
    title: '끌어서 높이 조절 · 더블클릭하면 원래 높이',
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault(); // 텍스트 선택·포커스 이동 방지
      e.currentTarget.setPointerCapture(e.pointerId); // 손이 분할선을 벗어나도 계속 받는다
      drag.current = { startY: e.clientY, startH: shownH() };
      setDragging(true);
      // 끄는 동안 커서가 아래 요소(차트 십자선·표)에 따라 바뀌거나 글자가 선택되지 않게
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      const h = clampH(d.startH + (d.startY - e.clientY)); // 위로 끌면(clientY 감소) 포지션 패널이 커진다
      live.current = h;
      if (gridRef.current) gridRef.current.style.gridTemplateRows = rowsOf(h);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onDoubleClick: () => commit(SPLIT_DEFAULT_H),
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      commit(clampH(shownH() + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP)));
    },
  };

  return { gridRef, gridRows: rowsOf(live.current ?? height), dragging, handleProps };
}
