import { useEffect, useState } from 'react';
import { api, type LeaderRow } from '@/services/api';
import { fmtUsd } from '@/format';
import VipBadge from './VipBadge';

const MEDAL = ['🥇', '🥈', '🥉'];

/** 친구들 자산(equity) 순위. 열려 있는 동안 5초마다 갱신. */
export default function Leaderboard({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .leaderboard()
        .then((d) => alive && setRows(d.leaderboard))
        .catch((e) => alive && setErr((e as Error).message));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-extrabold">🏆 랭킹</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted transition hover:text-text"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-auto p-2">
          {err && <p className="px-3 py-2 text-xs text-down">{err}</p>}

          {rows.length === 0 && !err && (
            <p className="py-8 text-center text-xs text-muted">불러오는 중…</p>
          )}

          <ul className="space-y-1">
            {rows.map((r, i) => (
              <li
                key={r.name}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                  r.isMe ? 'bg-panel2 ring-1 ring-accent/40' : 'hover:bg-panel2'
                }`}
              >
                <span className="w-6 text-center text-sm font-bold text-muted">
                  {MEDAL[i] ?? i + 1}
                </span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-elevated text-sm font-bold">
                  {r.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-sm font-semibold text-text">
                    {r.name}
                    <VipBadge tier={r.vipTier ?? 0} />
                    {r.isMe && <span className="text-[10px] font-normal text-accent">(나)</span>}
                  </div>
                  <div className="text-[11px] text-muted">
                    포지션 {r.openCount}개
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-text">{fmtUsd(r.equity)}</div>
                  <div className={`text-[11px] ${r.unrealized >= 0 ? 'text-up' : 'text-down'}`}>
                    {r.unrealized >= 0 ? '+' : ''}
                    {fmtUsd(r.unrealized)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
