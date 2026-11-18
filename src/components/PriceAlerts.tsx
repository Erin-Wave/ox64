import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useChartStore } from '@/store/useChartStore';
import { fmtPrice } from '@/format';
import { pairLabel } from '@/symbols';

/**
 * 수평선 가격 알림 — 차트에 그은 수평선(useChartStore.hLines) 중 알림(🔔)을 켠 선을 현재가가 **지나가면** 토스트 + 짧은 소리(폰은 진동)로
 * 한 번 알리고 그 선의 알림을 끈다(트레이딩뷰의 "한 번만" 알림). 선은 그대로 남는다.
 * - 판정은 현재가(useMarketStore.prices — 보고 있는 심볼 + 보유 포지션 심볼)가 직전 값에서 선을 넘었는지. 선 위에 정확히 있다가 떠나는 건
 *   안 울린다(현재가에 선을 그은 직후 바로 울리지 않게).
 * - ⚠ 브라우저 안의 알림이라 **앱을 보고 있을 때만** 울린다(서버 알림 아님 — 탭이 숨으면 시세 폴링이 멈춘다). 시세 갱신 사이(약 1초)에
 *   선을 찍고 되돌아간 건 놓칠 수 있다.
 * - 위치: 폰은 화면 아래(위쪽은 거래 메시지 토스트 자리), PC 는 차트 위. z-[48] = 차트 전체화면(z-45) 위·모달(z-50) 아래.
 */
interface Fired {
  key: number;
  text: string;
  up: boolean;
}
const LIFE_MS = 12_000;
const MAX_SHOWN = 3;

let audioCtx: AudioContext | null = null;
/** 짧은 두 음(소리를 못 내는 환경이면 조용히 넘어간다 — 토스트는 뜬다). 브라우저는 페이지를 한 번이라도 누른 뒤에만 소리를 허락한다. */
function beep(up: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    (up ? [880, 1175] : [1175, 880]).forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = t0 + i * 0.16;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.15);
    });
  } catch {
    /* 소리 없이 */
  }
}

export default function PriceAlerts() {
  const [items, setItems] = useState<Fired[]>([]);

  useEffect(() => {
    let prev = useMarketStore.getState().prices;
    let seq = 0;
    const timers = new Set<number>();
    const unsub = useMarketStore.subscribe((st) => {
      const prices = st.prices;
      if (prices === prev) return;
      const old = prev;
      prev = prices;
      const { hLines, setHLineAlert } = useChartStore.getState();
      for (const [sym, lines] of Object.entries(hLines)) {
        const cur = prices[sym];
        const was = old[sym];
        if (cur == null || was == null || cur === was) continue;
        for (const l of lines) {
          if (!l.alert) continue;
          const up = was < l.price && cur >= l.price;
          const down = was > l.price && cur <= l.price;
          if (!up && !down) continue;
          setHLineAlert(sym, l.id, false); // 한 번만
          const prec = precisionOf(st.precisions, sym);
          const key = ++seq;
          const text = `${pairLabel(sym)} ${fmtPrice(l.price, prec)} ${up ? '상향 돌파 ▲' : '하향 돌파 ▼'} · 현재 ${fmtPrice(cur, prec)}`;
          setItems((xs) => [...xs.slice(-(MAX_SHOWN - 1)), { key, text, up }]);
          const t = window.setTimeout(() => {
            timers.delete(t);
            setItems((xs) => xs.filter((x) => x.key !== key));
          }, LIFE_MS);
          timers.add(t);
          beep(up);
          navigator.vibrate?.([120, 60, 120]);
        }
      }
    });
    return () => {
      unsub();
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  if (items.length === 0) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[48] flex flex-col items-center gap-1.5 px-4 md:bottom-auto md:top-14">
      {items.map((it) => (
        <button
          key={it.key}
          role="alert"
          onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}
          className={`toast-in pointer-events-auto w-full max-w-sm rounded-md border bg-panel px-3 py-2 text-left text-xs font-semibold shadow-lg shadow-black/30 ${
            it.up ? 'border-up/50 text-up' : 'border-down/50 text-down'
          }`}
          title="누르면 닫힙니다"
        >
          🔔 {it.text}
        </button>
      ))}
    </div>,
    document.body,
  );
}
