import { useEffect, useState } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import { SYMBOLS, VIRTUAL_SYMBOLS, isVirtualSymbol } from '@/symbols';
import { api } from '@/services/api';

interface Stat {
  price: number;
  changePct: number;
}

type SortKey = 'symbol' | 'price' | 'change';
type SortDir = 'asc' | 'desc';

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
  const [oxStat, setOxStat] = useState<Stat | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

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

  // 가상 마켓(OX/USDT)은 바이낸스에 없으므로 서버에서 직접: 최근 체결가(가격) + 1시간봉 24개(≈24h)로
  // 변동률을 계산해 실제 코인과 동일하게 가격·24h 정렬에 참여시킨다(데이터 24h 미만이면 최초 시점 대비).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const [st, cd] = await Promise.all([api.spotState(), api.spotCandles('1h', 24)]);
        if (!alive) return;
        const candles = cd.candles;
        const price = st.trades[0]?.price ?? (candles.length ? candles[candles.length - 1].close : null);
        if (price == null) {
          setOxStat(null);
          return;
        }
        const ref = candles.length ? candles[0].open : price; // 가장 오래된(≈24h 전) 시가
        const changePct = ref > 0 ? ((price - ref) / ref) * 100 : 0;
        setOxStat({ price, changePct });
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

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc'); // 가격/변동률은 큰 값부터 보는 게 기본적으로 유용
    }
  };
  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '');

  // 가상 코인도 실제 코인과 같은 목록·같은 정렬에 참여시킨다(stat 은 심볼 종류에 따라 소스만 다름).
  const statOf = (s: string): Stat | undefined => (isVirtualSymbol(s) ? oxStat ?? undefined : stats[s]);

  const sorted = [...VIRTUAL_SYMBOLS, ...SYMBOLS].sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    if (sortKey === 'symbol') {
      av = a;
      bv = b;
    } else if (sortKey === 'price') {
      av = statOf(a)?.price ?? -Infinity;
      bv = statOf(b)?.price ?? -Infinity;
    } else {
      av = statOf(a)?.changePct ?? -Infinity;
      bv = statOf(b)?.changePct ?? -Infinity;
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer rounded-md bg-panel2 px-2.5 py-1.5 text-sm font-semibold text-text outline-none ring-1 ring-border transition hover:ring-elevated"
      >
        {symbol.replace('USDT', '/USDT')}
        {isVirtualSymbol(symbol) && (
          <span className="ml-1 rounded bg-accent/20 px-1 py-0.5 align-middle text-[9px] font-bold text-accent">가상</span>
        )}{' '}
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 overflow-auto rounded-lg border border-border bg-panel shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-border bg-panel px-3 py-1.5 text-[10px] font-semibold text-muted">
              <button onClick={() => toggleSort('symbol')} className="transition hover:text-text">
                심볼 {sortArrow('symbol')}
              </button>
              <span className="flex items-center gap-2.5">
                <button onClick={() => toggleSort('price')} className="transition hover:text-text">
                  가격 {sortArrow('price')}
                </button>
                <button onClick={() => toggleSort('change')} className="w-14 text-right transition hover:text-text">
                  24h {sortArrow('change')}
                </button>
              </span>
            </div>
            {sorted.map((s) => {
              const st = statOf(s);
              const virtual = isVirtualSymbol(s);
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
                  <span className="flex items-center gap-1.5 font-semibold text-text">
                    {s.replace('USDT', '/USDT')}
                    {virtual && (
                      <span className="rounded bg-accent/20 px-1 py-0.5 text-[9px] font-bold text-accent">가상</span>
                    )}
                  </span>
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
