/**
 * ox64 워드마크 — 15×3 픽셀 아트를 그대로 옮긴 인라인 SVG.
 *
 * ⚠ 예전엔 `src/resources/images/icon_256.png`(256×256)을 `<img className="h-9 w-9">` 로 그렸는데
 * 세 가지가 겹쳐 흐릿했다:
 *   1. 잉크는 225×45 인데 캔버스가 256×256 이라 위아래 41% 가 투명 여백 → 실제 글자는 약 6px 높이로만 렌더
 *   2. 5:1 워드마크를 정사각형(h-9 w-9)에 넣어 가로세로 비율이 찌그러짐
 *   3. 아트 1픽셀이 CSS 2.1px 같은 비정수 배율로 축소되며 브라우저 보간(=블러)이 걸림
 * SVG 로 옮기면 벡터라 어떤 크기에서도 보간이 없고(`shape-rendering="crispEdges"` 로 경계도 딱 떨어짐),
 * `fill="currentColor"` 라 부모 텍스트 색을 따라간다 — 흰색 PNG 가 라이트 테마에서 배경에 묻히던 문제도
 * 같이 해결된다. 원본 PNG 는 favicon(=public/favicon.png) 용으로 남아있다.
 *
 * 격자(1=칠함):  ███·█·█·█···█·█
 *               █·█··█··███·███
 *               ███·█·█·███···█
 */
const GRID = ['111010101000101', '101001001110111', '111010101110001'] as const;

// 같은 행에서 이어지는 칸을 하나의 rect 로 합친다(엘리먼트 27개 → 15개).
const RECTS: { x: number; y: number; w: number }[] = [];
GRID.forEach((row, y) => {
  let run = 0;
  for (let x = 0; x <= row.length; x++) {
    if (row[x] === '1') {
      run++;
    } else if (run > 0) {
      RECTS.push({ x: x - run, y, w: run });
      run = 0;
    }
  }
});

/** className 으로 크기를 준다(예: "h-5 w-auto"). 색은 부모의 text-* 를 따라간다. */
export default function Logo({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 15 3"
      className={className}
      fill="currentColor"
      shapeRendering="crispEdges"
      role="img"
      aria-label="ox64"
    >
      {RECTS.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}
