import { useState } from 'react';
import { useMarketStore, selectLastPrice, selectLastTakerSide, precisionOf } from '@/store/useMarketStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice } from '@/format';
import SymbolSelect from '@/components/SymbolSelect';
import Logo from './Logo';
import VipBadge from './VipBadge';

export default function Header({
  onOpenRank,
  onOpenSettings,
  onOpenVip,
}: {
  onOpenRank: () => void;
  onOpenSettings: () => void;
  onOpenVip: () => void;
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
  const vipTier = useTradingStore((s) => s.vipTier);
  const feeRate = useTradingStore((s) => s.feeRate);
  const vipNextAt = useTradingStore((s) => s.vipNextAt);
  const totalVolume = useTradingStore((s) => s.totalVolume);
  const vipTiers = useTradingStore((s) => s.vipTiers);
  // 현재 등급 구간을 얼마나 채웠는지(0~1). 최고 등급이면 항상 가득. VipModal 과 같은 식.
  const vipFrom = vipTiers.find((t) => t.tier === vipTier)?.minVolume ?? 0;
  const vipProgress =
    vipNextAt == null ? 1 : Math.min(1, Math.max(0, (totalVolume - vipFrom) / Math.max(1, vipNextAt - vipFrom)));
  const prices = useMarketStore((s) => s.prices);
  const [showMenu, setShowMenu] = useState(false);

  // 평가자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익). 진입 시 잔고에서 빠진 증거금도 담보라
  // 포함해야 포지션을 열자마자 평가자산이 증거금만큼 깎여 보이지 않는다(서버 강제청산/리필 판정과 동일한 정의).
  const equityKnown = positions.every((p) => prices[p.symbol] != null);
  const equity =
    balance +
    positions.reduce((a, p) => {
      const margin = (p.entryPrice * p.size) / p.leverage;
      const live = prices[p.symbol];
      const u = live == null ? 0 : (live - p.entryPrice) * p.size * (p.side === 'long' ? 1 : -1);
      return a + margin + u;
    }, 0);
  const canRefill = equityKnown && equity <= 0;
  // 마지막 체결이 매수 테이커면 매수색, 매도 테이커면 매도색 — 아직 체결이 없으면 기본색.
  const priceColor = lastTakerSide === 'buy' ? 'text-up' : lastTakerSide === 'sell' ? 'text-down' : 'text-text';

  return (
    <header className="flex items-center justify-between gap-2 border-b border-border bg-panel px-2 py-1.5 sm:gap-3 sm:px-4 sm:py-2">
      {/* 좌: (데스크톱) 로고 · 심볼 · 현재가/연결상태 — (모바일) 심볼 + 현재가·연결점만 한 줄 */}
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-4">
        {/* 워드마크는 5:1 비율이라 높이만 주고 폭은 auto — 정사각형에 넣으면 찌그러진다(Logo.tsx 참고) */}
        <Logo className="hidden h-[15px] w-auto shrink-0 text-text sm:block sm:h-[18px]" />
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
            <span className="ml-0.5 text-[10px] font-normal text-muted">USDT</span>
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
                <button
                  onClick={() => {
                    onOpenVip();
                    setShowMenu(false);
                  }}
                  className="w-full border-b border-border px-3 py-2 text-left transition hover:bg-panel2"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                    <span className="truncate">{name}</span>
                    <VipBadge tier={vipTier} />
                  </div>
                  {/* 다음 등급까지 얼마나 왔는지 한눈에 — 자세한 건 눌러서 모달로 */}
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-elevated">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${vipProgress * 100}%` }} />
                  </div>
                </button>
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
            <VipBadge tier={vipTier} feeRate={feeRate} nextAt={vipNextAt} totalVolume={totalVolume} onClick={onOpenVip} />
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
