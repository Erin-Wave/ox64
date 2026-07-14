import { useEffect, useState } from 'react';
import Header from '@/components/Header';
import Chart from '@/components/Chart';
import OrderPanel from '@/components/OrderPanel';
import PositionsPanel from '@/components/PositionsPanel';
import Login from '@/components/Login';
import Leaderboard from '@/components/Leaderboard';
import { useTradingStore } from '@/store/useTradingStore';
import { useMarkPrices } from '@/hooks/useMarkPrices';

export default function App() {
  const init = useTradingStore((s) => s.init);
  const ready = useTradingStore((s) => s.ready);
  const authed = useTradingStore((s) => s.authed);

  const [showRank, setShowRank] = useState(false);

  // 현재 심볼 + 보유 포지션 심볼들의 가격 폴링 (다른 심볼 PnL 갱신)
  useMarkPrices();

  // 앱 시작 시 세션(쿠키) 확인 (1회)
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

  if (!authed) return <Login />;

  return (
    <div className="flex h-screen flex-col bg-bg text-white">
      <Header onOpenRank={() => setShowRank(true)} />

      {/*
        모바일(기본): 세로 스크롤 스택 — 차트(45vh) → 주문 → 포지션.
        데스크톱(md+): 2열 그리드 — 좌(차트 위 / 포지션 아래) · 우(주문, 세로 전체).
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[minmax(0,1fr)_14rem] md:overflow-hidden">
        <div className="h-[45vh] w-full shrink-0 md:col-start-1 md:row-start-1 md:h-auto md:min-h-0 md:shrink">
          <Chart />
        </div>

        <aside className="shrink-0 border-b border-border bg-panel md:col-start-2 md:row-span-2 md:row-start-1 md:min-h-0 md:overflow-y-auto md:border-b-0 md:border-l">
          <OrderPanel />
        </aside>

        <div className="min-h-0 shrink-0 border-t border-border bg-panel md:col-start-1 md:row-start-2 md:overflow-auto">
          <PositionsPanel />
        </div>
      </div>

      {showRank && <Leaderboard onClose={() => setShowRank(false)} />}
    </div>
  );
}
