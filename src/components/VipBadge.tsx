import { fmtBig } from '@/format';

/**
 * VIP 등급 뱃지. 등급은 **누적 거래대금(레버리지가 곱해진 명목금액)** 으로 결정되며 서버가 파생해
 * 내려준다(클라는 표시만 — functions/_shared.ts vipOf 가 진실원본).
 *
 * 등급이 오를수록 뱃지가 진해져서 한눈에 구분된다. title 에 수수료율과 다음 등급까지 남은 거래대금을
 * 넣어 두 번 클릭하지 않고도 확인할 수 있게 했다.
 */
const TIER_STYLE = [
  'bg-panel2 text-muted ring-border', // VIP0
  'bg-panel2 text-text ring-border', // VIP1
  'bg-elevated text-accent ring-accent/40', // VIP2
  'bg-accent/15 text-accent ring-accent/60', // VIP3
  'bg-accent text-bg ring-accent', // VIP4
];

export default function VipBadge({
  tier,
  feeRate,
  nextAt,
  totalVolume,
  className = '',
}: {
  tier: number;
  feeRate?: number;
  nextAt?: number | null;
  totalVolume?: number;
  className?: string;
}) {
  const style = TIER_STYLE[Math.max(0, Math.min(TIER_STYLE.length - 1, tier))];
  const parts: string[] = [`VIP${tier}`];
  if (feeRate != null) parts.push(`거래 수수료 ${(feeRate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`);
  if (totalVolume != null) parts.push(`누적 거래대금 ${fmtBig(totalVolume)} USDT`);
  if (nextAt != null && totalVolume != null) parts.push(`다음 등급까지 ${fmtBig(Math.max(0, nextAt - totalVolume))} USDT`);
  else if (nextAt == null) parts.push('최고 등급');

  return (
    <span
      title={parts.join(' · ')}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-extrabold leading-none ring-1 ${style} ${className}`}
    >
      VIP{tier}
    </span>
  );
}
