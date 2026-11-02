import { useEffect, useState } from 'react';

/** 화면이 PC 폭(Tailwind `md` = 768px)인지. ⚠ App.tsx 의 2열 그리드 분기와 **같은 경계**를 써야 한다 —
 * 어긋나면 사이드바가 아직 안 생긴 좁은 화면에서 호가·체결을 세로로 쌓아 화면을 통째로 밀어내거나(OrderBook),
 * 좁은 화면에 가로로 긴 표를 그려 좌우 스크롤이 생긴다(PositionsPanel — 모바일은 카드). */
export function useIsDesktop(): boolean {
  const query = '(min-width: 768px)';
  const [is, setIs] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIs(mq.matches);
    onChange(); // 마운트 사이에 회전/리사이즈가 있었을 수 있다
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return is;
}
