/** 거래 단축키(F8 청산 · F9 롱 · F10 숏)를 지금 받아도 되는가.
 * ⚠ 모달(설정·환전·랭킹·VIP·리필)이 떠 있으면 받지 않는다 — 환전 금액을 치다가 F9 를 누르면 뒤에 가려진 주문 패널로
 * 주문이 나갔다. 조합키(Ctrl/Alt/⌘ + F키)도 무시한다(브라우저·OS 단축키). 주문 패널의 입력칸에 커서가 있는 건 허용한다
 * (수량을 치고 바로 누르는 용도). 모달은 오버레이에 `role="dialog"` 를 달아 둔다 — 새 모달을 만들면 꼭 달 것. */
export function tradeHotkeyAllowed(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return document.querySelector('[role="dialog"]') == null;
}
