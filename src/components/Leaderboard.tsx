import { useEffect, useState } from 'react';
import { api, type LeaderRow } from '@/services/api';

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-extrabold">🏆 랭킹</h2>
          <button onClick={onClose} className="text-sm text-muted hover:text-white">
            닫기
          </button>
        </div>

        {err && <p className="mb-2 text-xs text-down">{err}</p>}

        <table className="w-full text-sm">
          <thead className="text-muted">
            <tr className="text-left text-xs">
              <th className="py-1 font-medium">#</th>
              <th className="py-1 font-medium">이름</th>
              <th className="py-1 text-right font-medium">자산(USDT)</th>
              <th className="py-1 text-right font-medium">미실현</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.name}
                className={`border-t border-border ${r.isMe ? 'text-white' : 'text-muted'}`}
              >
                <td className="py-1.5">{i + 1}</td>
                <td className="py-1.5 font-semibold">
                  {r.name}
                  {r.isMe && <span className="ml-1 text-xs text-up">(나)</span>}
                </td>
                <td className="py-1.5 text-right">
                  {r.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
                <td className={`py-1.5 text-right ${r.unrealized >= 0 ? 'text-up' : 'text-down'}`}>
                  {r.unrealized >= 0 ? '+' : ''}
                  {r.unrealized.toFixed(2)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !err && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-xs text-muted">
                  불러오는 중…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
