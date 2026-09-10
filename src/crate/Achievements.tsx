import { useCrateStore } from './useCrateStore';
import { fmtG } from './data';

/**
 * 업적 — "돈 벌 방법이 상자밖에 없다"를 푸는 두 번째 축. 누적 통계가 기준선을 넘으면 서버가 그 자리에서
 * 지급하므로(§ crate.ts grantAchievements) 여기는 **진행도를 보여주기만** 한다.
 * ⚠ 기준표는 서버가 `achievements` 로 내려준 걸 그대로 그린다(클라에 같은 표를 또 적으면 어긋난다).
 */
export default function Achievements({ onClose }: { onClose: () => void }) {
  const list = useCrateStore((s) => s.achievements);
  const stats = useCrateStore((s) => s.stats);
  const seen = useCrateStore((s) => s.seen);
  const cats = useCrateStore((s) => s.cats);
  const shop = useCrateStore((s) => s.shop);

  const totalMats = cats.reduce((n, c) => n + c.maxLevel, 0);
  const current = (stat: string) =>
    stat === 'opened'
      ? stats.opened
      : stat === 'merged'
        ? stats.merged
        : stat === 'jackpots'
          ? stats.jackpots
          : stat === 'seen'
            ? seen.length
            : stat === 'bestCoins'
              ? stats.bestCoins
              : stats.earned;
  const statLabel: Record<string, string> = {
    opened: '개봉',
    merged: '합성',
    jackpots: '잭팟',
    seen: '도감',
    bestCoins: '최고 골드',
    earned: '누적 수입',
  };

  const done = list.filter((a) => a.done).length;
  const totalReward = list.filter((a) => !a.done).reduce((n, a) => n + a.coins, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-2xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-extrabold">
            🏅 업적 <span className="ml-1 text-xs font-normal text-muted">{done}/{list.length}</span>
          </h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted transition hover:text-text">
            ✕
          </button>
        </div>

        <p className="border-b border-border bg-panel2 px-5 py-2 text-[11px] text-muted">
          조건을 채우면 <b className="text-text">자동으로 지급</b>됩니다(따로 받을 필요 없음). 남은 보상{' '}
          <b className="text-accent">{fmtG(totalReward)} G</b> + 상자
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.map((a) => {
            const now = current(a.stat);
            const pct = Math.min(100, (now / a.at) * 100);
            const target = a.stat === 'seen' ? Math.min(a.at, totalMats) : a.at;
            return (
              <div key={a.key} className={'border-b border-border/50 px-4 py-2.5 last:border-0 ' + (a.done ? 'opacity-60' : '')}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className={'truncate text-xs font-bold ' + (a.done ? 'text-accent line-through' : '')}>
                      {a.done && '✓ '}
                      {a.label}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">{a.desc}</span>
                  </span>
                  <span className="shrink-0 text-[11px] font-bold text-accent">
                    +{fmtG(a.coins)} G
                    {a.crates && (
                      <span className="ml-1 text-muted">
                        · {shop.find((c) => c.level === a.crates![0])?.emoji ?? '📦'}×{a.crates[1]}
                      </span>
                    )}
                  </span>
                </div>
                {!a.done && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-panel2">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted">
                      {statLabel[a.stat]} {fmtG(now)}/{fmtG(target)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 업적 달성 팝업 — 여러 개가 한꺼번에 터질 수 있어 큐에서 하나씩 꺼내 보여준다. */
export function AchievementToast() {
  const queue = useCrateStore((s) => s.achieveQueue);
  const pop = useCrateStore((s) => s.popAchievement);
  const shop = useCrateStore((s) => s.shop);
  const a = queue[0];
  if (!a) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center px-4">
      <button
        onClick={pop}
        className="crate-pop pointer-events-auto rounded-xl border border-accent/50 bg-elevated px-4 py-2.5 text-left shadow-2xl"
        title="닫기"
      >
        <div className="text-[11px] font-bold text-accent">🏅 업적 달성{queue.length > 1 && ` (+${queue.length - 1})`}</div>
        <div className="text-sm font-extrabold">{a.label}</div>
        <div className="text-[11px] text-muted">
          {a.desc} · <b className="text-accent">+{fmtG(a.coins)} G</b>
          {a.crates && ` + ${shop.find((c) => c.level === a.crates![0])?.name ?? '상자'} ${a.crates[1]}개`}
        </div>
      </button>
    </div>
  );
}
