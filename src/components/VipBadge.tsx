import { fmtBig, fmtFeeRate } from '@/format';

/**
 * VIP 등급 뱃지. 등급은 **누적 거래대금(레버리지가 곱해진 명목금액)** 으로 결정되며 서버가 파생해
 * 내려준다(클라는 표시만 — functions/_shared.ts vipOf 가 진실원본).
 *
 * 등급이 오를수록 뱃지가 진해져서 한눈에 구분된다. title 에 수수료율과 다음 등급까지 남은 거래대금을
 * 넣어 두 번 클릭하지 않고도 확인할 수 있게 했다.
 */
// VIP0~4 는 기존 배색, VIP5~12 는 프레스티지 등급이라 골드→오렌지→퍼플 그라디언트로 점점 화려해진다.
// (arbitrary 색은 정적 문자열이라 Tailwind JIT 가 생성 — 조건부 주문선의 #f0b90b 와 동일 방식)
const TIER_STYLE = [
  'bg-panel2 text-muted ring-border', // VIP0
  'bg-panel2 text-text ring-border', // VIP1
  'bg-elevated text-accent ring-accent/40', // VIP2
  'bg-accent/15 text-accent ring-accent/60', // VIP3
  'bg-accent text-bg ring-accent', // VIP4
  'bg-[#f0b90b]/20 text-[#f0b90b] ring-[#f0b90b]/50', // VIP5
  'bg-[#f0b90b]/35 text-[#f0b90b] ring-[#f0b90b]/80', // VIP6
  'bg-[#f0b90b] text-black ring-[#f0b90b]', // VIP7
  'bg-gradient-to-r from-[#f0b90b] to-[#ff8c00] text-black ring-[#ffa500]', // VIP8
  'bg-gradient-to-r from-[#ff8c00] to-[#ff4d4f] text-white ring-[#ff6b4a]', // VIP9
  'bg-gradient-to-r from-[#ff4d4f] to-[#c026d3] text-white ring-[#e0559a]', // VIP10
  'bg-gradient-to-r from-[#a855f7] to-[#6366f1] text-white ring-[#8b7ff5]', // VIP11
  'bg-gradient-to-r from-[#f0b90b] via-[#ff4d4f] to-[#a855f7] text-white ring-white', // VIP12
];

export default function VipBadge({
  tier,
  feeRate,
  nextAt,
  totalVolume,
  className = '',
  onClick,
}: {
  tier: number;
  feeRate?: number;
  nextAt?: number | null;
  totalVolume?: number;
  className?: string;
  /** 주면 버튼이 되어 클릭 시 VIP 진행도 모달을 연다(랭킹의 "남의 등급"엔 안 준다). */
  onClick?: () => void;
}) {
  const style = TIER_STYLE[Math.max(0, Math.min(TIER_STYLE.length - 1, tier))];
  const parts: string[] = [`VIP${tier}`];
  if (feeRate != null) parts.push(`거래 수수료 ${fmtFeeRate(feeRate)}%`);
  if (totalVolume != null) parts.push(`누적 거래대금 ${fmtBig(totalVolume)} USDT`);
  if (nextAt != null && totalVolume != null) parts.push(`다음 등급까지 ${fmtBig(Math.max(0, nextAt - totalVolume))} USDT`);
  else if (nextAt == null) parts.push('최고 등급');

  const cls = `shrink-0 rounded px-1.5 py-0.5 text-[10px] font-extrabold leading-none ring-1 ${style} ${className}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={`${parts.join(' · ')} — 눌러서 진행도 보기`} className={`${cls} transition hover:brightness-125`}>
        VIP{tier}
      </button>
    );
  }
  return (
    <span title={parts.join(' · ')} className={cls}>
      VIP{tier}
    </span>
  );
}
