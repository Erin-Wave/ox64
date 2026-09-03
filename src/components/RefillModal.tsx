import { useState } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtUsd, fmtUsdShort } from '@/format';
import { useEquity } from '@/hooks/useEquity';

/** 서버(`functions/api/refill.ts`)의 지급 조건과 같은 값 — 화면 문구가 실제 지급과 어긋나지 않게 여기 모아둔다. */
const REFILL_AMOUNT = 10_000;
const REFILL_DAILY_LIMIT = 3;

/**
 * 파산(강제청산) 안내 팝업 — 평가자산이 0 이하가 되면 자동으로 뜬다.
 *
 * 리필은 원래 헤더 구석의 작은 버튼뿐이라, 강제청산으로 자산이 0 이 된 사람 입장에선 **게임이 끝난
 * 것처럼** 보였다(하루 3회 무료로 다시 시작할 수 있다는 걸 알 방법이 없었다). 그래서 그 순간 화면
 * 가운데에 띄우고 여기서 바로 리필까지 받게 한다.
 *
 * ⚠ 판정은 `useEquity` 하나만 쓴다(헤더 리필 버튼과 같은 식) — 서버의 지급 조건(평가자산 <= 0)과
 * 어긋나면 "팝업은 떴는데 눌러도 거부되는" 상태가 된다. 최종 판정은 언제나 서버다.
 */
export default function RefillModal({ onClose }: { onClose: () => void }) {
  const refillsLeft = useTradingStore((s) => s.refillsLeft);
  const refill = useTradingStore((s) => s.refill);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);
  const positions = useTradingStore((s) => s.positions);
  const { equity } = useEquity();
  // ⚠ `error` 는 스토어 공용이라 **직전에 실패한 다른 동작**(주문 거부 등)이 그대로 담겨 있을 수 있다 —
  // 리필과 무관한 문구가 리필 팝업에 뜨면 왜 막혔는지 오해한다. 이 팝업에서 실제로 눌러본 뒤에만 보여준다.
  const [tried, setTried] = useState(false);

  const none = refillsLeft <= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-text">자산이 모두 소진되었습니다</h2>
            <p className="mt-0.5 text-xs text-muted">
              {positions.length > 0 ? '평가자산이 0 이하입니다' : '강제청산으로 잔고가 0 이 되었습니다'}
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-muted hover:bg-bg" title="닫기">
            ×
          </button>
        </div>

        <div className="mb-4 rounded-xl border border-border bg-bg p-3">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted">현재 평가자산</span>
            <span className="font-bold tabular-nums text-text" title={`${fmtUsd(equity)} USDT`}>
              {fmtUsdShort(equity, 9)} USDT
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between text-xs">
            <span className="text-muted">오늘 남은 무료 리필</span>
            <span className={`font-bold tabular-nums ${none ? 'text-down' : 'text-up'}`}>
              {refillsLeft} / {REFILL_DAILY_LIMIT}회
            </span>
          </div>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-muted">
          자산이 0 이 되면 <b className="text-text">매일 {REFILL_DAILY_LIMIT}회</b>까지 무료로{' '}
          <b className="text-text">{fmtUsd(REFILL_AMOUNT)} USDT</b> 를 받아 다시 시작할 수 있습니다. 남은 횟수는 매일{' '}
          <b className="text-text">한국시간 자정</b>에 {REFILL_DAILY_LIMIT}회로 초기화됩니다.
        </p>

        {tried && error && <p className="mb-3 rounded-lg bg-down/10 px-3 py-2 text-xs text-down">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={() => {
              setTried(true);
              void refill();
            }}
            disabled={busy || none}
            className="flex-1 rounded-xl bg-accent px-3 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            title={none ? '오늘 리필을 모두 사용했습니다' : `${fmtUsd(REFILL_AMOUNT)} USDT 를 지급받습니다`}
          >
            {busy ? '지급 중…' : none ? '오늘 리필 소진' : `무료 리필 받기 +${fmtUsd(REFILL_AMOUNT)}`}
          </button>
          <button onClick={onClose} className="rounded-xl border border-border px-3 py-2.5 text-sm text-muted hover:bg-bg">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
