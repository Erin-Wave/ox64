import { useEffect, useState } from 'react';
import { VIRTUAL_LISTINGS, pairLabel } from '@/symbols';

// ── 가상 코인 상장 카운트다운(OKX 식, 2026-11-20) ─────────────────────────────────────────────────
// 상장 예정 코인(src/symbols.ts VIRTUAL_LISTINGS)은 목록에 미리 뜨고, 고르면 차트 자리에 "상장까지 HH:MM:SS" 를 띄운다.
// 그동안 통합 폴링·체결강도 받기·주문은 전부 쉰다(useSpotPoll·useDayStats·OrderPanel — 서버도 거부한다). 시각이 되면 이 훅이
// pending=false 로 다시 그려 폴링이 저절로 시작되고, 첫 폴링이 서버에서 상장가로 시장을 연다.
// ⚠ 남은 시간은 **이 기기 시계** 기준이다(서버와 몇 초 어긋날 수 있다) — 일찍 보낸 폴링·주문은 서버가 빈 값·거부로 돌려준다.

/** 상장 시각 표기 — 한국 시간 'YYYY-MM-DD HH:mm'. */
export const fmtListingAt = (at: number) => new Date(at + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

/** 남은 초 → 'D일 HH:MM:SS' / 'HH:MM:SS'. */
export function fmtRemain(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const hms = `${p2(Math.floor((s % 86400) / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
  return d > 0 ? `${d}일 ${hms}` : hms;
}

/** 상장 상태 — 상장 전이면 남은 초를 1초마다 갱신한다(상장 예정이 없는 심볼은 타이머를 안 건다). */
export function useListing(symbol: string): { pending: boolean; secLeft: number; at: number; price: number } {
  const l = VIRTUAL_LISTINGS[symbol];
  const calc = () => (l ? Math.ceil((l.at - Date.now()) / 1000) : 0);
  const [secLeft, setSecLeft] = useState(calc);
  useEffect(() => {
    setSecLeft(calc());
    if (!l || Date.now() >= l.at) return;
    // 250ms 로 재되 값(초)이 바뀔 때만 다시 그린다 — 초 경계에 맞춰 넘어가고, 상장 순간을 최대 0.25초 안에 잡는다.
    const t = window.setInterval(() => {
      const v = calc();
      setSecLeft(v);
      if (v <= 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  return { pending: !!l && secLeft > 0, secLeft: Math.max(0, secLeft), at: l?.at ?? 0, price: l?.price ?? 0 };
}

/** 차트 자리를 덮는 큰 카운트다운. 상장 전이 아니면 아무것도 안 그린다. */
export function ListingOverlay({ symbol }: { symbol: string }) {
  const { pending, secLeft, at, price } = useListing(symbol);
  if (!pending) return null;
  const d = Math.floor(secLeft / 86400);
  const parts: [string, number][] = [
    ...(d > 0 ? ([['일', d]] as [string, number][]) : []),
    ['시간', Math.floor((secLeft % 86400) / 3600)],
    ['분', Math.floor((secLeft % 3600) / 60)],
    ['초', secLeft % 60],
  ];
  // z-[15]: 차트 범례(z-10) 위 · 드롭다운(배경 z-20, 패널 z-30) 아래 — 위로 올리면 심볼 목록을 가린다
  return (
    <div className="absolute inset-0 z-[15] flex flex-col items-center justify-center gap-3 bg-panel/95 px-4 text-center">
      <div className="flex items-center gap-2">
        <span className="text-lg font-extrabold text-text md:text-xl">{pairLabel(symbol)}</span>
        <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent">신규 상장</span>
      </div>
      <div className="text-xs text-muted">거래 시작까지</div>
      <div className="flex items-end gap-1.5 md:gap-2" role="timer" aria-live="off" aria-label={`상장까지 ${fmtRemain(secLeft)}`}>
        {parts.map(([unit, v], i) => (
          <div key={unit} className="flex items-end gap-1.5 md:gap-2">
            {i > 0 && <span className="pb-5 text-xl font-bold text-muted md:text-2xl">:</span>}
            <div className="flex flex-col items-center gap-1">
              <span className="min-w-[2.6rem] rounded-md bg-panel2 px-2 py-1.5 text-2xl font-extrabold tabular-nums text-text ring-1 ring-border md:min-w-[3.4rem] md:text-4xl">
                {String(v).padStart(2, '0')}
              </span>
              <span className="text-[10px] text-muted">{unit}</span>
            </div>
          </div>
        ))}
      </div>
      <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-xs">
        <dt className="text-left text-muted">상장 시각</dt>
        <dd className="text-right font-semibold text-text">{fmtListingAt(at)} (한국 시간)</dd>
        <dt className="text-left text-muted">상장가</dt>
        <dd className="text-right font-semibold text-text">{price.toLocaleString('en-US')} USDT</dd>
      </dl>
      <p className="max-w-xs text-[11px] leading-relaxed text-muted">시각이 되면 이 화면에서 바로 거래가 열립니다. 상장 전에는 주문할 수 없습니다.</p>
    </div>
  );
}

/** 좁은 자리(심볼 목록 줄·호가창·주문 패널)용 한 줄 — '상장까지 00:31:12'. */
export function ListingCountdownText({ symbol, className = '' }: { symbol: string; className?: string }) {
  const { pending, secLeft } = useListing(symbol);
  if (!pending) return null;
  return <span className={`tabular-nums ${className}`}>{fmtRemain(secLeft)}</span>;
}
