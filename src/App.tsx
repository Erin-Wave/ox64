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
      <div className="flex flex-1 overflow-hidden">
        {/* 차트 영역 */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1">
            <Chart />
          </div>
          <div className="h-56 border-t border-border bg-panel">
            <PositionsPanel />
          </div>
        </main>
        {/* 우측 주문 패널 */}
        <aside className="w-72 border-l border-border bg-panel">
          <OrderPanel />
        </aside>
      </div>
    </div>
  );
}
