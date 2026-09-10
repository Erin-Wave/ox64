import { useEffect, useState } from 'react';
import Logo from '@/components/Logo';
import CrateLogin from './CrateLogin';
import OpenStage from './OpenStage';
import Shop, { JackpotBanner } from './Shop';
import Inventory from './Inventory';
import Collection from './Collection';
import Leaderboard from './Leaderboard';
import { useCrateStore } from './useCrateStore';
import { fmtG } from './data';
import './crate.css';

export default function CrateApp() {
  const init = useCrateStore((s) => s.init);
  const ready = useCrateStore((s) => s.ready);
  const authed = useCrateStore((s) => s.authed);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready)
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-sm text-muted">
        <span className="animate-pulse">불러오는 중…</span>
      </div>
    );
  if (!authed) return <CrateLogin />;
  return <CrateGame />;
}

function CrateGame() {
  const coins = useCrateStore((s) => s.coins);
  const netWorth = useCrateStore((s) => s.netWorth);
  const invValue = useCrateStore((s) => s.invValue);
  const stats = useCrateStore((s) => s.stats);
  const broke = useCrateStore((s) => s.broke);
  const refillsLeft = useCrateStore((s) => s.refillsLeft);
  const refillAmount = useCrateStore((s) => s.limits.refillAmount);
  const busy = useCrateStore((s) => s.busy);
  const error = useCrateStore((s) => s.error);
  const toast = useCrateStore((s) => s.toast);
  const refill = useCrateStore((s) => s.refill);
  const logout = useCrateStore((s) => s.logout);
  const dismissToast = useCrateStore((s) => s.dismissToast);
  const clearError = useCrateStore((s) => s.clearError);
  const [board, setBoard] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismissToast, toast.kind === 'jackpot' ? 2600 : 1600);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 3200);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border bg-panel px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Logo className="hidden h-5 w-auto text-text sm:block" />
          <span className="truncate text-sm font-bold">📦 상자깡</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className="shrink-0 rounded-full bg-panel2 px-3 py-1.5 font-bold tabular-nums text-accent"
            title={`골드 ${Math.round(coins).toLocaleString()} G`}
          >
            {fmtG(coins)} G
          </span>
          <span
            className="hidden shrink-0 text-muted sm:inline"
            title={`총자산 = 골드 + 재료 ${Math.round(invValue).toLocaleString()} G + 안 깐 상자`}
          >
            총 {fmtG(netWorth)}
          </span>
          <button
            onClick={() => setBoard(true)}
            title="소지 골드 순위 (5초마다 갱신)"
            className="shrink-0 rounded-md bg-panel2 px-2 py-1 font-bold text-muted ring-1 ring-border transition hover:text-text"
          >
            🏆<span className="ml-1 hidden sm:inline">랭킹</span>
          </button>
          <a href="/" className="shrink-0 text-muted underline decoration-dotted underline-offset-2 hover:text-text">
            트레이딩
          </a>
          <button onClick={() => logout()} className="shrink-0 text-muted hover:text-text">
            로그아웃
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-3 py-4 sm:px-4">
        {broke && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-downDim px-3.5 py-2.5 text-xs text-down">
            <span>가진 걸 다 팔아도 상자를 살 수 없습니다.</span>
            <button
              onClick={() => refill()}
              disabled={busy || refillsLeft <= 0}
              className="rounded-md bg-down/20 px-3 py-1.5 font-bold hover:brightness-110 disabled:opacity-40"
            >
              지원금 +{refillAmount} G ({refillsLeft}회 남음)
            </button>
          </div>
        )}

        <OpenStage />

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Shop />
            <JackpotBanner />
          </div>
          <div className="flex flex-col gap-3">
            <Inventory />
            <Collection />
          </div>
        </div>

        <section className="rounded-2xl border border-border bg-panel p-4 text-[11px] text-muted">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
            <span>개봉 {stats.opened.toLocaleString()}회</span>
            <span>머지 {stats.merged.toLocaleString()}회</span>
            <span>구매에 쓴 골드 {fmtG(stats.spent)}</span>
            <span>벌어들인 골드 {fmtG(stats.earned)}</span>
            <span>최고 보유 {fmtG(stats.bestCoins)}</span>
            <span className={stats.jackpots > 0 ? 'font-bold text-accent' : ''}>잭팟 {stats.jackpots}회</span>
          </div>
          <p className="leading-relaxed">
            <b className="text-text">규칙</b> — 상자를 까면 골드·재료·또 다른 상자가 나옵니다(항목마다 따로 굴리므로 한 번에 여러
            개가 나올 수 있습니다). 같은 재료 2개를 합치면 레벨이 1 오르고 값은 2.35배가 됩니다(종류는 안 바뀝니다).{' '}
            <b className="text-text">상자만 까서 다 팔면 본전이 안 나옵니다</b> — 끝까지 합쳐서 파는 게 이 게임의 유일한 흑자
            경로입니다. 상자조각은 Lv4까지 합친 뒤 2개를 더 합치면 상자가 되고, 운이 좋으면 더 비싼 상자가 나옵니다.
          </p>
        </section>
      </main>

      {board && <Leaderboard onClose={() => setBoard(false)} />}

      {/* 토스트 — 화면 하단 중앙(모바일에서 헤더를 가리지 않게) */}
      {(toast || error) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div
            className={
              'crate-pop rounded-xl px-4 py-2.5 text-xs font-bold shadow-2xl ' +
              (error
                ? 'bg-down text-white'
                : toast?.kind === 'jackpot'
                  ? 'bg-[#ffcc33] text-black'
                  : 'bg-panel2 text-text ring-1 ring-border')
            }
          >
            {error ?? toast?.text}
          </div>
        </div>
      )}
    </div>
  );
}
