import { useEffect, useState } from 'react';
import Header from '@/components/Header';
import Chart from '@/components/Chart';
import OrderBook from '@/components/OrderBook';
import OrderPanel from '@/components/OrderPanel';
import PositionsPanel from '@/components/PositionsPanel';
import Login from '@/components/Login';
import Leaderboard from '@/components/Leaderboard';
import Settings from '@/components/Settings';
import VipModal from '@/components/VipModal';
import RefillModal from '@/components/RefillModal';
import { useTradingStore } from '@/store/useTradingStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useChartStore } from '@/store/useChartStore';
import { useMarkPrices } from '@/hooks/useMarkPrices';
import { useTriggerPoll } from '@/hooks/useTriggerPoll';
import { useSpotPoll } from '@/hooks/useSpotPoll';
import { useTradeTape } from '@/hooks/useTradeTape';
import { useEquity } from '@/hooks/useEquity';

export default function App() {
  const init = useTradingStore((s) => s.init);
  const ready = useTradingStore((s) => s.ready);
  const authed = useTradingStore((s) => s.authed);
  const standard = useSettingsStore((s) => s.tradingMode) === 'standard';
  const orderBookOn = useChartStore((s) => s.orderBook);

  const [showRank, setShowRank] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVip, setShowVip] = useState(false);
  // 파산(평가자산 0 이하) 안내 팝업 — 강제청산으로 자산이 0 이 된 사람에게 "하루 3회 무료 리필"을 알린다.
  // ⚠ 한 번 닫으면 **자산이 0 을 벗어날 때까지** 다시 뜨지 않는다(2.5초 폴링마다 다시 뜨면 아무것도 못 한다).
  // 리필을 받으면 평가자산이 0 을 넘으므로 자동으로 초기화되고, 다음에 또 파산하면 다시 뜬다.
  const [refillDismissed, setRefillDismissed] = useState(false);

  // 현재 심볼 + 보유 포지션 심볼들의 가격 폴링 (다른 심볼 PnL 갱신)
  useMarkPrices();
  // 지정가/SL/TP 체결 체크(서버는 cron 이 없어 이 폴링이 체결 트리거 역할을 함)
  useTriggerPoll();
  // OX/USDT(가상 코인) 을 보고 있을 때만 잔고/호가/체결 폴링
  useSpotPoll();
  // 현재 심볼 체결 테이프(OrderBook "체결" 탭 + Header 현재가 색상이 둘 다 구독)
  useTradeTape();

  const { broke } = useEquity();
  useEffect(() => {
    if (!broke) setRefillDismissed(false);
  }, [broke]);

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
    <div className="flex h-screen flex-col bg-bg text-text">
      <Header onOpenRank={() => setShowRank(true)} onOpenSettings={() => setShowSettings(true)} onOpenVip={() => setShowVip(true)} />

      {/*
        모바일(기본): 세로 스크롤 스택 — 차트(45vh) → 주문 → 포지션.
        데스크톱(md+): 2열 그리드 — 좌(차트 위 / 포지션 아래) · 우(주문, 세로 전체).
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[minmax(0,1fr)_14rem] md:overflow-hidden">
        <div className="h-[45vh] w-full shrink-0 md:col-start-1 md:row-start-1 md:h-auto md:min-h-0 md:shrink">
          <Chart />
        </div>

        <aside className="flex shrink-0 flex-col border-b border-border bg-panel md:col-start-2 md:row-span-2 md:row-start-1 md:min-h-0 md:overflow-y-auto md:border-b-0 md:border-l">
          {standard && orderBookOn && <OrderBook />}
          <OrderPanel />
        </aside>

        <div className="min-h-0 shrink-0 border-t border-border bg-panel md:col-start-1 md:row-start-2 md:overflow-auto">
          <PositionsPanel />
        </div>
      </div>

      {showRank && <Leaderboard onClose={() => setShowRank(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showVip && <VipModal onClose={() => setShowVip(false)} />}
      {broke && !refillDismissed && <RefillModal onClose={() => setRefillDismissed(true)} />}
    </div>
  );
}
