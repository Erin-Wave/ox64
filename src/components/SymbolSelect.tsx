import { useEffect, useState } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { SYMBOLS } from '@/symbols';

interface Stat {
  price: number;
  changePct: number;
}

// 프리셋 precisions 맵은 현재 보고 있던(차트로 방문한) 심볼만 채워져 있어서
// 드롭다운의 다른 37개 심볼은 값이 없을 수 있다. 그래서 여기선 가격 크기 기반
// 대략적인 자릿수로 표시한다(정밀 표시는 심볼 선택 후 헤더/차트가 담당).
function fmtAdaptive(price: number): string {
  if (!isFinite(price)) return '—';
  if (price >= 100) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(3);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

/** 심볼 선택 드롭다운 — 심볼명 + 현재가 + 24h 변동률 표시(바이낸스 스팟 ticker/24hr, 열려있는 동안 5초 폴링). */
export default function SymbolSelect() {
  const symbol = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Record<string, Stat>>({});

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const q = encodeURIComponent(JSON.stringify(SYMBOLS));
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${q}`);
        if (!res.ok || !alive) return;
        const arr = (await res.json()) as { symbol: string; lastPrice: string; priceChangePercent: string }[];
        const next: Record<string, Stat> = {};
        for (const x of arr) next[x.symbol] = { price: Number(x.lastPrice), changePct: Number(x.priceChangePercent) };
        if (alive) setStats(next);
      } catch {
        /* 네트워크 오류 무시(다음 주기 재시도) */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer rounded-md bg-panel2 px-2.5 py-1.5 text-sm font-semibold text-text outline-none ring-1 ring-border transition hover:ring-elevated"
      >
        {symbol.replace('USDT', '/USDT')} <span className="text-muted">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 overflow-auto rounded-lg border border-border bg-panel shadow-2xl">
            {SYMBOLS.map((s) => {
              const st = stats[s];
              const up = st ? st.changePct >= 0 : true;
              return (
                <button
                  key={s}
                  onClick={() => {
                    setSymbol(s);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-2 text-xs transition hover:bg-panel2 ${
                    s === symbol ? 'bg-panel2' : ''
                  }`}
                >
                  <span className="font-semibold text-text">{s.replace('USDT', '/USDT')}</span>
                  <span className="flex items-center gap-2.5">
                    <span className="text-text">{st ? fmtAdaptive(st.price) : '—'}</span>
                    <span className={`w-14 text-right ${up ? 'text-up' : 'text-down'}`}>
                      {st ? `${up ? '+' : ''}${st.changePct.toFixed(2)}%` : '—'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
