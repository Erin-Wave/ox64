import { useEffect, useState } from 'react';

/** 실시간 시계(KST, 시:분:초) — 화면 한쪽 구석에 표시. 1초마다 자체 상태만 갱신하는 독립 컴포넌트라
 * 부모(차트 등)의 리렌더를 유발하지 않는다. 브라우저 타임존과 무관하게 항상 KST(Asia/Seoul)로 표기. */
const fmt = () => new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' });

export default function Clock({ className = '' }: { className?: string }) {
  const [now, setNow] = useState(fmt);
  useEffect(() => {
    const t = window.setInterval(() => setNow(fmt()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className={`tabular-nums ${className}`} title="현재 시각 (KST)">
      {now} <span className="opacity-60">KST</span>
    </span>
  );
}
