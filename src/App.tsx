import { useEffect } from 'react';
import Header from '@/components/Header';
import Chart from '@/components/Chart';
import OrderPanel from '@/components/OrderPanel';
import PositionsPanel from '@/components/PositionsPanel';
import { ensureSeed } from '@/db/db';
import { useTradingStore } from '@/store/useTradingStore';

export default function App() {
  const hydrate = useTradingStore((s) => s.hydrate);

  // IndexedDB 시드 + 상태 hydrate (마운트 1회)
  useEffect(() => {
    (async () => {
      await ensureSeed();
      await hydrate();
    })();
  }, [hydrate]);

  return (
    <div className="flex h-screen flex-col bg-bg text-white">
      <Header />

      {/*
        모바일(기본): 세로 스크롤 스택 — 차트(45vh) → 주문 → 포지션.
        데스크톱(md+): 2열 그리드 — 좌(차트 위 / 포지션 아래) · 우(주문, 세로 전체).
      */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[minmax(0,1fr)_14rem] md:overflow-hidden"
      >
        {/* 차트 */}
        <div className="h-[45vh] w-full shrink-0 md:col-start-1 md:row-start-1 md:h-auto md:min-h-0 md:shrink">
          <Chart />
        </div>

        {/* 주문 패널: 모바일=차트 아래, 데스크톱=우측 세로 전체 */}
        <aside className="shrink-0 border-b border-border bg-panel md:col-start-2 md:row-span-2 md:row-start-1 md:min-h-0 md:overflow-y-auto md:border-b-0 md:border-l">
          <OrderPanel />
        </aside>

        {/* 포지션 */}
        <div className="min-h-0 shrink-0 border-t border-border bg-panel md:col-start-1 md:row-start-2 md:overflow-auto">
          <PositionsPanel />
        </div>
      </div>
    </div>
  );
}
