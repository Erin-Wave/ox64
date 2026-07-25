import { useEffect } from 'react';
import Logo from '@/components/Logo';
import PuzzleLogin from './PuzzleLogin';
import Board from './Board';
import { usePuzzleStore } from './usePuzzleStore';

export default function PuzzleApp() {
  const init = usePuzzleStore((s) => s.init);
  const ready = usePuzzleStore((s) => s.ready);
  const authed = usePuzzleStore((s) => s.authed);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-sm text-muted">
        <span className="animate-pulse">불러오는 중…</span>
      </div>
    );
  }
  if (!authed) return <PuzzleLogin />;
  return <PuzzleGame />;
}

function PuzzleGame() {
  const currency = usePuzzleStore((s) => s.currency);
  const bestLevel = usePuzzleStore((s) => s.bestLevel);
  const refillsLeft = usePuzzleStore((s) => s.refillsLeft);
  const activeGame = usePuzzleStore((s) => s.activeGame);
  const levels = usePuzzleStore((s) => s.levels);
  const busy = usePuzzleStore((s) => s.busy);
  const error = usePuzzleStore((s) => s.error);
  const toast = usePuzzleStore((s) => s.toast);
  const start = usePuzzleStore((s) => s.start);
  const openCell = usePuzzleStore((s) => s.open);
  const abandon = usePuzzleStore((s) => s.abandon);
  const refill = usePuzzleStore((s) => s.refill);
  const dismissToast = usePuzzleStore((s) => s.dismissToast);
  const backToLevels = usePuzzleStore((s) => s.backToLevels);
  const logout = usePuzzleStore((s) => s.logout);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismissToast, 1800);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);

  const finished = activeGame && activeGame.status !== 'active';

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Logo className="h-5 w-auto text-text" />
          <span className="text-sm font-bold">보석찾기</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="rounded-full bg-panel2 px-3 py-1.5 font-bold text-accent">◆ {currency.toLocaleString()}</span>
          <span className="hidden text-muted sm:inline">최고 레벨 {bestLevel}</span>
          <a href="/" className="text-muted underline decoration-dotted underline-offset-2 hover:text-text">
            트레이딩
          </a>
          <button onClick={() => logout()} className="text-muted hover:text-text">
            로그아웃
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-5">
        {error && <p className="rounded-lg bg-downDim px-3 py-2 text-xs text-down">{error}</p>}

        {currency <= 0 && (
          <div className="flex items-center justify-between rounded-lg bg-downDim px-3.5 py-2.5 text-xs text-down">
            <span>재화가 바닥났습니다.</span>
            <button
              onClick={() => refill()}
              disabled={busy || refillsLeft <= 0}
              className="rounded-md bg-down/20 px-3 py-1.5 font-bold hover:brightness-110 disabled:opacity-40"
            >
              리필 ({refillsLeft}/일 남음)
            </button>
          </div>
        )}

        {!activeGame || finished ? (
          <LevelSelect levels={levels} currency={currency} busy={busy} onStart={start} />
        ) : (
          <div />
        )}

        {activeGame && (
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-panel p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold">레벨 {activeGame.level}</span>
              <span className="text-muted">
                보석 {activeGame.gemsFound}/{activeGame.gemsTotal} · 사용한 재화 {activeGame.spent}
              </span>
            </div>
            <Board game={activeGame} onOpen={openCell} disabled={busy || activeGame.status !== 'active'} />
            <div className="flex items-center justify-between">
              {activeGame.status === 'active' ? (
                <button onClick={() => abandon()} disabled={busy} className="text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-down">
                  포기하기
                </button>
              ) : (
                <span
                  className={
                    'text-xs font-bold ' +
                    (activeGame.status === 'won' ? 'text-up' : activeGame.status === 'lost' ? 'text-down' : 'text-muted')
                  }
                >
                  {activeGame.status === 'won' ? '클리어!' : activeGame.status === 'lost' ? '게임 오버' : '포기함'}
                </span>
              )}
              {finished && (
                <div className="flex gap-2">
                  <button
                    onClick={backToLevels}
                    className="rounded-md bg-panel2 px-3 py-1.5 text-xs font-bold text-text hover:brightness-110"
                  >
                    레벨 선택
                  </button>
                  <button
                    onClick={() => start(activeGame.level)}
                    disabled={busy || currency <= 0}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-bold text-black hover:brightness-110 disabled:opacity-40"
                  >
                    다시 도전
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {toast && (
        <div
          className={
            'pointer-events-none fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-bold shadow-xl ' +
            (toast.kind === 'clear'
              ? 'bg-up text-black'
              : toast.kind === 'over'
                ? 'bg-down text-white'
                : 'bg-elevated text-text ring-1 ring-border')
          }
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function LevelSelect({
  levels,
  currency,
  busy,
  onStart,
}: {
  levels: { level: number; size: number; reward: number; gemsTotal: number; costPerOpen: number }[];
  currency: number;
  busy: boolean;
  onStart: (level: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {levels.map((l) => (
        <button
          key={l.level}
          onClick={() => onStart(l.level)}
          disabled={busy || currency <= 0}
          className="flex flex-col gap-1 rounded-xl border border-border bg-panel p-3.5 text-left transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-sm font-extrabold">레벨 {l.level}</span>
          <span className="text-[11px] text-muted">
            {l.size}×{l.size} 보드 · 보석 {l.gemsTotal}개
          </span>
          <span className="text-[11px] text-accent">클리어 시 +{l.reward}</span>
        </button>
      ))}
    </div>
  );
}
