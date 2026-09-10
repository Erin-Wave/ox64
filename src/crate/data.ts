// 표시 전용 메타 — 실제 확률·가격·재료 가치는 전부 서버(functions/_crateData.ts)가 진실원본이고
// 서버 응답(cats/shop/shardOdds)을 그대로 렌더한다. 여기 있는 건 "몇 레벨이 무슨 색인가" 같은
// 순수 시각 정보뿐이라 서버와 어긋날 여지가 없다.

/**
 * 레벨 등급색 — 게임 관례대로 고정색을 쓴다(테마 변수를 안 탄다). 다크/라이트 양쪽에서 읽히도록
 * 채도를 중간대로 잡고, 배경은 항상 그 색의 낮은 알파라 어느 테마에서도 대비가 유지된다.
 */
export const TIERS = [
  { name: '일반', color: '#8b949e' },
  { name: '고급', color: '#3fb950' },
  { name: '희귀', color: '#4493f8' },
  { name: '영웅', color: '#bc8cff' },
  { name: '전설', color: '#f0883e' },
  { name: '신화', color: '#ffcc33' },
] as const;

export const tierOf = (level: number) => TIERS[Math.min(TIERS.length, Math.max(1, level)) - 1];

/** 골드 표기 — 자릿수가 커져도 칸이 안 밀리게 만/억/조로 줄인다(§ fmtKor 과 같은 사상, 반올림). */
export function fmtG(v: number): string {
  const n = Math.round(v);
  const abs = Math.abs(n);
  if (abs < 1_000_000) return n.toLocaleString();
  const units: [number, string][] = [
    [1e16, '경'],
    [1e12, '조'],
    [1e8, '억'],
    [1e4, '만'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const scaled = n / size;
      return `${scaled >= 100 ? Math.round(scaled).toLocaleString() : scaled.toFixed(1).replace(/\.0$/, '')}${unit}`;
    }
  }
  return n.toLocaleString();
}

/** 확률 표기 — 1/2,000 처럼 극한 확률도 읽히게 0.1% 미만이면 분모로 보여준다. */
export function fmtP(p: number): string {
  if (p >= 0.01) return `${(p * 100).toFixed(p * 100 >= 10 ? 0 : 1)}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(2)}%`;
  return `1/${Math.round(1 / p).toLocaleString()}`;
}

export const JACKPOT_STYLE: Record<string, { label: string; color: string; glow: string }> = {
  lucky: { label: '행운', color: '#ffcc33', glow: 'rgba(255,204,51,0.55)' },
  mega: { label: '초대박', color: '#ff8f3f', glow: 'rgba(255,143,63,0.6)' },
  legend: { label: '전설', color: '#ff5ea8', glow: 'rgba(255,94,168,0.65)' },
};

/** 인벤토리 키를 쪼갠다 — 서버와 형식이 같다("wood:2"). */
export function splitKey(key: string): { cat: string; level: number } {
  const [cat, lv] = key.split(':');
  return { cat, level: Number(lv) };
}

/**
 * 개수 표기 — 네 자리까지는 그대로, 그 위는 한국식 단위로 줄인다(칸이 50px 남짓이라 "12345" 는
 * 아이콘을 통째로 덮는다).
 */
export function fmtCount(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 100_000_000) {
    const v = n / 10_000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}만`;
  }
  const v = n / 100_000_000;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}억`;
}

/**
 * 자릿수가 늘수록 글자를 줄인다 — 칸 크기는 고정인데 숫자만 길어지면 배지가 칸을 넘어간다.
 * ⚠ 픽셀 값을 Tailwind 임의 값(text-[13px])으로 쓰면 **클래스명이 런타임에 조립돼 빌드에서 누락**되므로
 * (Tailwind 는 소스를 정적으로 훑는다) 완성된 클래스 문자열을 그대로 돌려준다.
 */
export function countClass(text: string): string {
  const n = text.length;
  if (n <= 2) return 'text-[13px]';
  if (n === 3) return 'text-[11px]';
  if (n === 4) return 'text-[10px]';
  return 'text-[9px]';
}
