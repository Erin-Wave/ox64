import { useEffect, useState } from 'react';
import Logo from '@/components/Logo';
import CrateLogin from './CrateLogin';
import OpenStage from './OpenStage';
import Shop, { JackpotBanner } from './Shop';
import Inventory from './Inventory';
import Collection from './Collection';
import Leaderboard from './Leaderboard';
import Achievements, { AchievementToast } from './Achievements';
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
  const dailyReady = useCrateStore((s) => s.dailyReady);
  const rescueLeft = useCrateStore((s) => s.rescueLeft);
  const limits = useCrateStore((s) => s.limits);
  const busy = useCrateStore((s) => s.busy);
  const error = useCrateStore((s) => s.error);
  const toast = useCrateStore((s) => s.toast);
  const refill = useCrateStore((s) => s.refill);
  const logout = useCrateStore((s) => s.logout);
  const dismissToast = useCrateStore((s) => s.dismissToast);
  const clearError = useCrateStore((s) => s.clearError);
  const achieveQueue = useCrateStore((s) => s.achieveQueue);
  const popAchievement = useCrateStore((s) => s.popAchievement);
  const [board, setBoard] = useState(false);
  const [achv, setAchv] = useState(false);
  const event = useCrateStore((s) => s.event);
  const eventWeek = useCrateStore((s) => s.eventWeek);
  const [weekOpen, setWeekOpen] = useState(false);

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

  // 업적 팝업은 큐라 하나씩 자동으로 넘어간다(누르면 즉시 다음으로)
  useEffect(() => {
    if (achieveQueue.length === 0) return;
    const t = setTimeout(popAchievement, 2800);
    return () => clearTimeout(t);
  }, [achieveQueue, popAchievement]);

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
            onClick={() => setAchv(true)}
            title="업적 — 조건을 채우면 자동 지급"
            className="shrink-0 rounded-md bg-panel2 px-2 py-1 font-bold text-muted ring-1 ring-border transition hover:text-text"
          >
            🏅<span className="ml-1 hidden sm:inline">업적</span>
          </button>
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
        {/*
          회생 안내 — 이 게임은 상자만 까면 회수율이 70% 라 **가난할수록 회복이 구조적으로 어렵다**
          (머지하려면 같은 재료 2개가 필요한데 상자를 조금밖에 못 까면 재료가 안 모인다). 그래서
          지원은 골드가 아니라 **상자로** 주고, 파산했을 땐 여러 번 받을 수 있게 한다.
        */}
        {dailyReady && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-accent/10 px-3.5 py-2.5 text-xs ring-1 ring-accent/30">
            <span>
              🎁 <b>오늘의 지원</b>이 도착했습니다 — Lv1 상자 {limits.dailyCrates}개 + {limits.dailyCoins.toLocaleString()} G
              <span className="ml-1.5 text-muted">(매일 한 번, 누구나)</span>
            </span>
            <button
              onClick={() => refill()}
              disabled={busy}
              className="rounded-md bg-accent px-3 py-1.5 font-bold text-black transition hover:brightness-110 disabled:opacity-40"
            >
              받기
            </button>
          </div>
        )}

        {broke && !dailyReady && (
          <div className="rounded-xl bg-downDim px-3.5 py-2.5 text-xs text-down">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span>
                <b>재기 불능 상태입니다</b> — 가진 걸 다 팔아도 상자 {limits.brokeCrates}개를 못 삽니다.
              </span>
              <button
                onClick={() => refill()}
                disabled={busy || rescueLeft <= 0}
                className="rounded-md bg-down/20 px-3 py-1.5 font-bold hover:brightness-110 disabled:opacity-40"
              >
                구제 물자 받기 · 상자 {limits.rescueCrates}개 + {limits.rescueCoins.toLocaleString()} G ({rescueLeft}회 남음)
              </button>
            </div>
            <p className="leading-snug opacity-80">
              {rescueLeft > 0
                ? '골드가 아니라 상자로 드립니다 — 한 번에 여러 개를 까야 같은 재료가 모여 합칠 수 있고, 거기서부터 다시 굴러갑니다.'
                : '오늘 구제를 모두 받았습니다. 내일 다시 받을 수 있고, 지금 가진 상자와 재료로도 이어갈 수 있습니다.'}
            </p>
          </div>
        )}

        {/*
          오늘의 이벤트 — KST 요일에서 파생하므로 저장 상태도 스케줄러도 없다(§10).
          효과는 서버가 드롭·가격에 이미 적용해서 내려주고 여기는 무엇이 걸렸는지만 보여준다.
        */}
        {event && (
          <div className="rounded-xl border border-accent/40 bg-accent/10 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="text-lg leading-none">{event.emoji}</span>
              <b className="text-accent">오늘은 {event.label}</b>
              <span className="text-muted">{event.desc}</span>
              <button
                onClick={() => setWeekOpen(!weekOpen)}
                className="ml-auto shrink-0 text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
              >
                {weekOpen ? '요일표 접기' : '요일표'}
              </button>
            </div>
            {weekOpen && (
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-accent/20 pt-2 text-[11px] sm:grid-cols-4">
                {eventWeek.map((e) => (
                  <span
                    key={e.key}
                    className={'truncate ' + (e.key === event.key ? 'font-bold text-accent' : 'text-muted')}
                    title={e.desc}
                  >
                    {['일', '월', '화', '수', '목', '금', '토'][e.day]} {e.emoji} {e.label}
                  </span>
                ))}
              </div>
            )}
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
          <p className="mt-1.5 leading-relaxed">
            <b className="text-text">보상</b> — 개봉마다 <b className="text-accent">✨보너스</b>(항목 추가)·
            <b className="text-accent">🔥더블</b>·<b className="text-accent">⚡트리플</b>·<b className="text-accent">💥메가</b>가 터질 수
            있고, <b className="text-text">{limits.bulkAt}개 이상 한 번에</b> 까면 {Math.round(limits.bulkChance * 100)}% 확률로 공짜
            상자가 하나 더 나옵니다. 누적 개봉 수가 쌓이면 <b className="text-text">마일스톤 상자</b>를, 조건을 채우면{' '}
            <b className="text-text">업적 보상</b>을 자동으로 받습니다.
          </p>
        </section>
      </main>

      {board && <Leaderboard onClose={() => setBoard(false)} />}
      {achv && <Achievements onClose={() => setAchv(false)} />}
      <AchievementToast />

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
