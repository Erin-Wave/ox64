import { useTradingStore } from '@/store/useTradingStore';
import { fmtKor, fmtUsd, fmtFeeRate } from '@/format';
import VipBadge from './VipBadge';

/**
 * VIP 등급 진행도 모달 — 헤더의 VIP 뱃지를 눌러 연다.
 *
 * 예전엔 등급/요율/남은 거래대금이 뱃지의 `title`(툴팁)에만 있어서 사실상 아무도 못 봤다. 다음 등급까지
 * 얼마나 남았는지가 핵심 동기부여라 진행 막대로 크게 보여준다.
 *
 * ⚠ 등급 기준표(`vipTiers`)는 **서버가 내려준 값**을 그대로 쓴다 — 클라에 같은 표를 또 적으면 서버 기준이
 * 바뀔 때 조용히 어긋나고, 수수료는 서버가 떼므로 화면만 틀리게 된다.
 */
export default function VipModal({ onClose }: { onClose: () => void }) {
  const tier = useTradingStore((s) => s.vipTier);
  const feeRate = useTradingStore((s) => s.feeRate);
  const nextAt = useTradingStore((s) => s.vipNextAt);
  const totalVolume = useTradingStore((s) => s.totalVolume);
  const totalFees = useTradingStore((s) => s.totalFees);
  const tiers = useTradingStore((s) => s.vipTiers);

  const pct = (r: number) => fmtFeeRate(r) + '%';

  // 현재 등급 구간의 하한 → 그 구간을 얼마나 채웠는지. 최고 등급이면 진행도가 없다(항상 100%).
  const from = tiers.find((t) => t.tier === tier)?.minVolume ?? 0;
  const isMax = nextAt == null;
  const span = isMax ? 0 : nextAt - from;
  const progress = isMax ? 1 : span > 0 ? Math.min(1, Math.max(0, (totalVolume - from) / span)) : 0;
  const remaining = isMax ? 0 : Math.max(0, nextAt - totalVolume);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold text-text">
            VIP 등급
            <VipBadge tier={tier} />
            <span className="text-xs font-medium text-muted">거래 수수료 {pct(feeRate)}</span>
          </h2>
          <button onClick={onClose} aria-label="닫기" className="rounded px-2 py-1 text-muted transition hover:text-text">
            ✕
          </button>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-muted">
          누적 <strong className="text-text">거래대금</strong>이 쌓일수록 등급이 올라 수수료가 내려갑니다. 거래대금은
          증거금이 아니라 <strong className="text-text">명목금액(체결가 × 수량)</strong> 기준이라 레버리지를 크게 쓸수록
          빨리 오르고, 진입·청산이 각각 집계됩니다.
        </p>

        {/* 진행 막대 */}
        <div className="mb-4 rounded-lg bg-panel2 p-3">
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="text-muted">
              {isMax ? '최고 등급 달성' : `VIP${tier + 1} 까지`}
            </span>
            <span className="font-bold text-accent">{(progress * 100).toFixed(1)}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-baseline justify-between text-[11px] text-muted">
            <span>{fmtKor(from)}</span>
            <span>{isMax ? '—' : fmtKor(nextAt)}</span>
          </div>
          {!isMax && (
            <p className="mt-2 text-center text-xs text-text">
              앞으로 <strong className="text-accent">{fmtKor(remaining)} USDT</strong> 더 거래하면 VIP{tier + 1} (
              {pct(tiers.find((t) => t.tier === tier + 1)?.rate ?? 0)})
            </p>
          )}
        </div>

        {/* 내 통계 */}
        <div className="mb-4 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg bg-panel2 p-2.5">
            <div className="text-[10px] text-muted">누적 거래대금</div>
            <div className="mt-0.5 text-sm font-bold text-text">{fmtKor(totalVolume)}</div>
          </div>
          <div className="rounded-lg bg-panel2 p-2.5">
            <div className="text-[10px] text-muted">낸 수수료 합계</div>
            <div className="mt-0.5 text-sm font-bold text-text">{fmtUsd(totalFees)}</div>
          </div>
        </div>

        {/* 등급표 */}
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted">
              <th className="pb-1 text-left font-medium">등급</th>
              <th className="pb-1 text-right font-medium">누적 거래대금</th>
              <th className="pb-1 text-right font-medium">수수료</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => {
              const upper = tiers[i + 1]?.minVolume ?? null;
              const cur = t.tier === tier;
              return (
                <tr key={t.tier} className={cur ? 'bg-accent/10 font-semibold text-text' : 'text-muted'}>
                  <td className="rounded-l py-1 pl-1.5">
                    VIP{t.tier}
                    {cur && <span className="ml-1 text-[10px] text-accent">현재</span>}
                  </td>
                  <td className="py-1 text-right">
                    {t.minVolume === 0 ? `~${fmtKor(upper)}` : upper ? `${fmtKor(t.minVolume)}~${fmtKor(upper)}` : `${fmtKor(t.minVolume)}~`}
                  </td>
                  <td className="rounded-r py-1 pr-1.5 text-right">{pct(t.rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
