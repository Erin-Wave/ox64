import { useState } from 'react';
import { useMarketStore, selectLastPrice, selectLastTakerSide, precisionOf } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice } from '@/format';
import SymbolSelect from '@/components/SymbolSelect';
import logo from '@/resources/images/icon_256.png';

export default function Header({
  onOpenRank,
  onOpenSettings,
}: {
  onOpenRank: () => void;
  onOpenSettings: () => void;
}) {
  const symbol = useMarketStore((s) => s.symbol);
  const lastPrice = useMarketStore(selectLastPrice);
  const lastTakerSide = useMarketStore(selectLastTakerSide);
  const precisions = useMarketStore((s) => s.precisions);
  const connected = useMarketStore((s) => s.connected);
  const balance = useTradingStore((s) => s.balance);
  const positions = useTradingStore((s) => s.positions);
  const refillsLeft = useTradingStore((s) => s.refillsLeft);
  const refill = useTradingStore((s) => s.refill);
  const busy = useTradingStore((s) => s.busy);
  const name = useTradingStore((s) => s.name);
  const logout = useTradingStore((s) => s.logout);
  const prices = useMarketStore((s) => s.prices);
  const [showMenu, setShowMenu] = useState(false);

  // 서버와 동일한 규칙(평가자산<=0 일 때만 리필 허용)을 클라에서도 미리 반영 — 거부당하기 전에 버튼을 비활성화.
  const equityKnown = positions.every((p) => prices[p.symbol] != null);
  const equity =
    balance +
    positions.reduce((a, p) => {
      const live = prices[p.symbol];
      if (live == null) return a;
      const dir = p.side === 'long' ? 1 : -1;
      return a + (live - p.entryPrice) * p.size * dir;
    }, 0);
  const canRefill = equityKnown && equity <= 0;
  // 마지막 체결이 매수 테이커면 매수색, 매도 테이커면 매도색 — 아직 체결이 없으면 기본색.
  const priceColor = lastTakerSide === 'buy' ? 'text-up' : lastTakerSide === 'sell' ? 'text-down' : 'text-text';

  return (
    <header className="flex items-center justify-between gap-2 border-b border-border bg-panel px-2 py-1.5 sm:gap-3 sm:px-4 sm:py-2">
      {/* 좌: (데스크톱) 로고 · 심볼 · 현재가/연결상태 — (모바일) 심볼 + 현재가·연결점만 한 줄 */}
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-4">
        <img src={logo} alt="ox64" className="hidden h-9 w-9 shrink-0 sm:block sm:h-10 sm:w-10" />
        <div className="hidden h-6 w-px bg-border sm:block" />
        <SymbolSelect />
        {/* 연결 상태는 텍스트 없이 점 색으로만(초록=실시간, 회색=끊김) */}
        <span className={`flex min-w-0 items-center gap-1 truncate text-xs font-bold sm:text-[15px] ${priceColor}`}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-up' : 'bg-muted'}`} />
          {lastPrice != null ? fmtPrice(lastPrice, precisionOf(precisions, symbol)) : '—'}
        </span>
      </div>

      {/* 우: 평가자산 · 리필 · (모바일)더보기 / (데스크톱)랭킹·설정·유저·로그아웃 */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
        <div className="flex flex-col items-end leading-none">
          <span className="hidden text-[10px] text-muted sm:block">평가자산</span>
          <span className="mt-0 text-xs font-bold text-text sm:mt-0.5 sm:text-sm">
            {equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        <button
          onClick={() => refill()}
          disabled={busy || refillsLeft <= 0 || !canRefill}
          title={`평가자산이 0일 때만 가능 — 강제청산 등으로 자산이 바닥났을 때를 위한 안전망, 1일 최대 3회 (${refillsLeft}/3)`}
          className="rounded-md bg-panel2 px-2 py-1.5 text-xs font-semibold text-accent ring-1 ring-border transition hover:bg-elevated disabled:opacity-40"
        >
          <span className="sm:hidden">🔄{refillsLeft}</span>
          <span className="hidden sm:inline">+1만 리필 ({refillsLeft}/3)</span>
        </button>

        {/* 모바일: 랭킹/설정/유저/로그아웃을 더보기 메뉴로 묶음 */}
        <div className="relative sm:hidden">
          <button
            onClick={() => setShowMenu((v) => !v)}
            aria-label="더보기"
            className="rounded-md bg-panel2 px-2 py-1.5 text-xs font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
          >
            ⋯
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
                <div className="truncate border-b border-border px-3 py-2 text-xs font-medium text-text">{name}</div>
                <button
                  onClick={() => {
                    onOpenRank();
                    setShowMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text transition hover:bg-panel2"
                >
                  🏆 랭킹
                </button>
                <button
                  onClick={() => {
                    onOpenSettings();
                    setShowMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text transition hover:bg-panel2"
                >
                  ⚙️ 설정
                </button>
                <button
                  onClick={() => logout()}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted transition hover:bg-panel2 hover:text-text"
                >
                  로그아웃
                </button>
              </div>
            </>
          )}
        </div>

        {/* 데스크톱: 기존 개별 버튼 레이아웃 */}
        <div className="hidden items-center gap-2 sm:flex">
          <button
            onClick={onOpenRank}
            className="rounded-md bg-panel2 px-3 py-1.5 text-xs font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
          >
            🏆 랭킹
          </button>
          <button
            onClick={onOpenSettings}
            aria-label="설정"
            className="rounded-md bg-panel2 px-2.5 py-1.5 text-xs font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
          >
            ⚙️
          </button>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-elevated text-xs font-bold text-text">
              {name ? name.slice(0, 1).toUpperCase() : '?'}
            </span>
            <span className="max-w-[80px] truncate text-sm font-medium text-text">{name}</span>
          </div>
          <button
            onClick={() => logout()}
            className="rounded-md px-2 py-1.5 text-xs text-muted transition hover:text-text"
          >
            로그아웃
          </button>
        </div>
      </div>
    </header>
  );
}
