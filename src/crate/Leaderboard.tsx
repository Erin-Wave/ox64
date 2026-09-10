import { useEffect, useMemo, useState } from 'react';
import { crateApi, type BoardEntry } from './api';
import { fmtG } from './data';

const MEDAL = ['🥇', '🥈', '🥉'];
const POLL_MS = 5_000;

type SortKey = 'coins' | 'netWorth';

/**
 * 상자깡 랭킹 — 열려 있는 동안 5초마다 갱신한다(트레이딩 랭킹과 같은 주기).
 *
 * ⚠ 이 폴링은 **읽기 전용**이다(§6). 랭킹은 열어두면 계속 도는 경로라 여기에 쓰기가 한 줄이라도
 * 붙으면 그게 곧 "스스로 반복해서 도는 쓰기 경로"가 된다 — 서버 쪽 `?board=1` 도 SELECT 하나뿐이다.
 * ⚠ **탭이 백그라운드면 멈춘다** — 안 보이는 화면에 요청을 쓰는 건 순수 낭비다(무료 플랜 요청 한도).
 */
export default function Leaderboard({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<BoardEntry[]>([]);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('coins');

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      if (document.hidden) return schedule();
      try {
        const d = await crateApi.board();
        if (!alive) return;
        setEntries(d.entries);
        setUpdatedAt(d.updatedAt);
        setErr(null);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
      schedule();
    };
    const schedule = () => {
      if (alive) timer = setTimeout(load, POLL_MS);
    };

    load();
    // 탭으로 돌아오면 기다리지 않고 바로 한 번 받아온다(멈춰 있던 화면이 낡아 보이지 않게)
    const onVisible = () => {
      if (!document.hidden && alive) {
        if (timer) clearTimeout(timer);
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // 서버는 골드 순으로 주므로 총자산 정렬은 클라에서 다시 세운다(데이터가 이미 다 와 있다).
  const rows = useMemo(() => [...entries].sort((a, b) => b[sort] - a[sort]), [entries, sort]);
  const myRank = rows.findIndex((r) => r.me);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[88dvh] w-full max-w-md flex-col rounded-2xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-extrabold">🏆 상자깡 랭킹</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted transition hover:text-text">
            ✕
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 border-b border-border bg-panel2 px-5 py-2">
          <div className="flex gap-1">
            {(
              [
                ['coins', '소지 골드'],
                ['netWorth', '총자산'],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                title={key === 'coins' ? '지금 손에 쥔 골드' : '골드 + 재료·상자를 전부 판 값'}
                className={
                  'rounded-md px-2.5 py-1 text-[11px] font-bold transition ' +
                  (sort === key ? 'bg-accent text-black' : 'text-muted hover:text-text')
                }
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-muted">
            {myRank >= 0 ? `내 순위 ${myRank + 1}위` : updatedAt ? '5초마다 갱신' : '불러오는 중…'}
          </span>
        </div>

        {err && <p className="border-b border-border bg-downDim px-5 py-2 text-xs text-down">{err}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 && !err ? (
            <p className="px-5 py-8 text-center text-xs text-muted">아직 아무도 상자를 까지 않았습니다.</p>
          ) : (
            rows.map((r, i) => (
              <div
                key={r.name + i}
                className={
                  'flex items-center gap-2.5 border-b border-border/50 px-4 py-2.5 text-xs last:border-0 ' +
                  (r.me ? 'bg-accent/10' : '')
                }
              >
                <span className="w-7 shrink-0 text-center text-sm font-extrabold tabular-nums">
                  {i < 3 ? MEDAL[i] : <span className="text-muted">{i + 1}</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={'truncate font-bold ' + (r.me ? 'text-accent' : '')}>{r.name}</span>
                    {r.jackpots > 0 && (
                      <span
                        className="shrink-0 text-[10px] font-bold text-[#ffcc33]"
                        title={`극한 확률 잭팟 ${r.jackpots}회 적중`}
                      >
                        ★{r.jackpots}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted">
                    개봉 {r.opened.toLocaleString()} · 머지 {r.merged.toLocaleString()} · 최고 {fmtG(r.bestCoins)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className="font-extrabold tabular-nums text-accent"
                    title={`${Math.round(sort === 'coins' ? r.coins : r.netWorth).toLocaleString()} G`}
                  >
                    {fmtG(sort === 'coins' ? r.coins : r.netWorth)} G
                  </div>
                  <div className="text-[10px] text-muted" title={sort === 'coins' ? '총자산' : '소지 골드'}>
                    {sort === 'coins' ? '총 ' : '현금 '}
                    {fmtG(sort === 'coins' ? r.netWorth : r.coins)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="border-t border-border px-5 py-2 text-[10px] leading-snug text-muted">
          <b className="text-text">소지 골드</b>는 지금 손에 쥔 돈, <b className="text-text">총자산</b>은 재료와 안 깐 상자까지
          전부 판 값입니다 — 재료를 쌓아두면 골드 순위는 내려가도 총자산은 그대로입니다.
        </p>
      </div>
    </div>
  );
}
