import { useEffect, useRef } from 'react';
import type { LogEntry } from './api';

const KIND_STYLE: Record<string, { color: string; emoji: string }> = {
  start: { color: '#94a3b8', emoji: '🚪' },
  defeat: { color: '#34d399', emoji: '⚔️' },
  trap: { color: '#fb923c', emoji: '🕸️' },
  ward: { color: '#fbbf24', emoji: '🛡️' },
  potion: { color: '#38bdf8', emoji: '🧪' },
  phase: { color: '#e879f9', emoji: '👑' },
  special: { color: '#a78bfa', emoji: '✨' },
  win: { color: '#34d399', emoji: '🎉' },
  lose: { color: '#f87171', emoji: '💀' },
};

/**
 * 던전에서 방금 무슨 일이 있었는지 보여주는 로그.
 * 폴링 방식이라 내가 다른 걸 보고 있는 사이에 함정이 터지거나 몬스터가 격파될 수 있는데, 그걸
 * 놓치면 화면이 갑자기 바뀐 것처럼 보인다 — 서버가 방에 남기는 이벤트를 그대로 흘려보여 준다.
 */
export default function EventLog({ log }: { log: LogEntry[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  if (log.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-panel p-3">
      <p className="mb-1.5 text-[11px] font-bold text-muted">던전 기록</p>
      <div ref={boxRef} className="flex max-h-24 flex-col gap-1 overflow-y-auto text-[11px] leading-snug">
        {log.map((e, i) => {
          const s = KIND_STYLE[e.k] ?? KIND_STYLE.start;
          return (
            <p key={`${e.t}-${i}`} className="flex gap-1.5">
              <span>{s.emoji}</span>
              <span style={{ color: s.color }}>{e.m}</span>
            </p>
          );
        })}
      </div>
    </div>
  );
}
