import { createPortal } from 'react-dom';
import { useTradingStore } from '@/store/useTradingStore';

/** 모바일 거래 메시지(체결 안내 `notice` · 실패 사유 `error`) — 화면 위쪽(헤더 바로 아래)에 뜨는 토스트.
 * ⚠ 주문 패널 안 롱/숏 버튼 위에 끼워 넣으면 메시지가 뜰 때마다 버튼이 밀려 다음 탭이 엉뚱한 곳에 떨어졌다(제보, 2026-11-10).
 * 토스트는 레이아웃에서 빠져 있어(`fixed`) 아무것도 밀지 않는다. 수명은 스토어가 정한다(8초, showError/showNotice) — 탭하면 바로 닫힌다.
 * z-40 = 모달(z-50) 아래 — 모달이 떠 있으면 PC 의 인라인 메시지처럼 뒤에 가려진다(환전·리필 모달은 자기 안에 사유를 보여준다).
 * PC 는 OrderPanel 이 예전처럼 인라인으로 그린다(버튼이 mt-auto 로 패널 바닥에 붙어 있어 밀리지 않는다). */
export default function TradeToasts({ error, notice }: { error: string | null; notice: string | null }) {
  if (!error && !notice) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-12 z-40 flex flex-col items-center gap-1.5 px-4">
      {error && (
        <button
          key={`e:${error}`}
          role="alert"
          onClick={() => useTradingStore.setState({ error: null })}
          className="toast-in pointer-events-auto w-full max-w-sm rounded-md border border-down/40 bg-panel px-3 py-2 text-left text-xs text-down shadow-lg shadow-black/30"
        >
          {error}
        </button>
      )}
      {notice && (
        <button
          key={`n:${notice}`}
          role="status"
          onClick={() => useTradingStore.setState({ notice: null })}
          className="toast-in pointer-events-auto w-full max-w-sm rounded-md border border-border bg-panel px-3 py-2 text-left text-xs text-text shadow-lg shadow-black/30"
        >
          {notice}
        </button>
      )}
    </div>,
    document.body,
  );
}
