import { useEffect, useRef, useState } from 'react';
import { useMarketStore } from '@/store/useMarketStore';
import {
  SYMBOLS,
  VIRTUAL_SYMBOLS,
  KRW_SYMBOLS,
  KRW_NAMES,
  isVirtualSymbol,
  quoteOf,
  pairLabel,
  categoryOf,
  type SymbolCategory,
} from '@/symbols';
import { api } from '@/services/api';
import { fetchBithumb24h } from '@/services/bithumb';

interface Stat {
  price: number;
  changePct: number;
}

type SortKey = 'symbol' | 'price' | 'change';
type SortDir = 'asc' | 'desc';
type Filter = 'ALL' | SymbolCategory;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'ALL', label: '전체' },
  { key: 'KRW', label: 'KRW' },
  { key: 'USDT', label: 'USDT' },
  { key: 'VIRTUAL', label: '가상' },
];
const ALL_SYMBOLS: string[] = [...VIRTUAL_SYMBOLS, ...SYMBOLS, ...KRW_SYMBOLS];

// 마지막으로 고른 분류 필터는 이 브라우저에만 기억한다(열 때마다 다시 누르지 않게). 실패해도 '전체'.
const FILTER_KEY = 'ox64_symbol_filter_v1';
function loadFilter(): Filter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === 'KRW' || v === 'USDT' || v === 'VIRTUAL' ? v : 'ALL';
  } catch {
    return 'ALL';
  }
}
function saveFilter(f: Filter) {
  try {
    localStorage.setItem(FILTER_KEY, f);
  } catch {
    /* 저장 불가(사생활 보호 모드 등) — 이번 세션만 유지 */
  }
}

// 프리셋 precisions 맵은 현재 보고 있던(차트로 방문한) 심볼만 채워져 있어서
// 드롭다운의 다른 심볼은 값이 없을 수 있다. 그래서 여기선 가격 크기 기반
// 대략적인 자릿수로 표시한다(정밀 표시는 심볼 선택 후 헤더/차트가 담당).
// 원화는 100원 이상이면 정수(115,340,000 에 ".00" 을 붙이지 않는다).
function fmtAdaptive(price: number, krw: boolean): string {
  if (!isFinite(price)) return '—';
  if (krw && price >= 100) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 100) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(3);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

/** 검색어가 이 심볼에 걸리나 — 'btc', 'BTC/KRW', 'btckrw', '비트' 모두. */
function matches(s: string, q: string): boolean {
  if (!q) return true;
  const up = q.toUpperCase().replace(/\s+/g, '');
  return pairLabel(s).includes(up) || s.includes(up.replace('/', '')) || (KRW_NAMES[s]?.includes(q.trim()) ?? false);
}

/** 심볼 선택 드롭다운 — 검색 + 분류 필터(KRW·USDT·가상) + 현재가·24h 변동률(열려있는 동안 5초 폴링). */
export default function SymbolSelect() {
  const symbol = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [virtualStats, setVirtualStats] = useState<Record<string, Stat>>({});
  const [krwStats, setKrwStats] = useState<Record<string, Stat>>({});
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filter, setFilterState] = useState<Filter>(loadFilter);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const setFilter = (f: Filter) => {
    setFilterState(f);
    saveFilter(f);
  };

  // 열 때마다 검색어를 비우고 검색창에 포커스 — 바로 타이핑해서 찾게.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

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

  // 원화 심볼 — 빗썸 직결(브라우저 → 빗썸, Cloudflare 요청 0). 드롭다운이 열려 있을 때만.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      const next = await fetchBithumb24h([...KRW_SYMBOLS]);
      if (alive) setKrwStats(next);
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open]);

  // 가상 마켓은 바이낸스에 없으므로 서버에서 직접: 최근 체결가(가격) + 1시간봉 24개(≈24h)로
  // 변동률을 계산해 실제 코인과 동일하게 가격·24h 정렬에 참여시킨다(데이터 24h 미만이면 최초 시점 대비).
  // ⚠ 가상 코인마다 따로 받아온다 — 하나로 뭉뚱그리면 목록에서 모든 가상 코인이 같은 가격으로 보인다.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const entries = await Promise.all(
          VIRTUAL_SYMBOLS.map(async (sym) => {
            // ⚠ 현재가는 `spotState`(=/api/spot 호가창)가 아니라 **마지막 1시간봉의 종가**로 구한다
            // (2026-08-14, 무료 플랜 전환 ②). 그 엔드포인트는 캔들 조회와 달리 **봇 틱을 굴린다** —
            // 드롭다운을 열어둔 것만으로 코인 수 × 5초마다 봇이 돌아 쓰기가 나갔다(= cron 과 맞먹는 양).
            // 마지막 1시간봉은 "진행 중인 봉"이라 그 종가가 곧 최근 체결가이므로 값은 동일하고,
            // 요청 수도 코인당 2회 → 1회로 준다. (원래 이 값이 없을 때의 폴백이 바로 이 식이었다.)
            const { candles } = await api.spotCandles(sym, '1h', 24);
            const price = candles.length ? candles[candles.length - 1].close : null;
            if (price == null) return null;
            const ref = candles.length ? candles[0].open : price; // 가장 오래된(≈24h 전) 시가
            return [sym, { price, changePct: ref > 0 ? ((price - ref) / ref) * 100 : 0 }] as const;
          }),
        );
        if (!alive) return;
        setVirtualStats(Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null)));
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

  // 모든 마켓이 같은 목록·같은 정렬에 참여한다(stat 은 심볼 종류에 따라 소스만 다름).
  const statOf = (s: string): Stat | undefined =>
    isVirtualSymbol(s) ? virtualStats[s] : quoteOf(s) === 'KRW' ? krwStats[s] : stats[s];

  const visible = ALL_SYMBOLS.filter((s) => (filter === 'ALL' || categoryOf(s) === filter) && matches(s, query));
  const sorted = visible.sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    if (sortKey === 'symbol') {
      av = pairLabel(a);
      bv = pairLabel(b);
    } else if (sortKey === 'price') {
      // ⚠ 원화와 USDT 가격을 그대로 비교하면 원화가 전부 위로 몰린다 — 가격 정렬은 결제통화가 같은 것끼리만
      // 의미가 있으므로 원화는 원화끼리 뒤에 모은다(필터로 한쪽만 보면 자연스럽게 정렬된다).
      const qa = quoteOf(a) === 'KRW' ? 1 : 0;
      const qb = quoteOf(b) === 'KRW' ? 1 : 0;
      if (qa !== qb) return qa - qb;
      av = statOf(a)?.price ?? -Infinity;
      bv = statOf(b)?.price ?? -Infinity;
    } else {
      av = statOf(a)?.changePct ?? -Infinity;
      bv = statOf(b)?.changePct ?? -Infinity;
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const pick = (s: string) => {
    setSymbol(s);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer rounded-md bg-panel2 px-2.5 py-1.5 text-sm font-semibold text-text outline-none ring-1 ring-border transition hover:ring-elevated"
      >
        {pairLabel(symbol)}
        {isVirtualSymbol(symbol) && (
          <span className="ml-1 rounded bg-accent/20 px-1 py-0.5 align-middle text-[9px] font-bold text-accent">가상</span>
        )}{' '}
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 flex max-h-[26rem] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
            {/* 검색 + 분류 필터 */}
            <div className="space-y-1.5 border-b border-border p-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && sorted[0]) pick(sorted[0]);
                  else if (e.key === 'Escape') setOpen(false);
                }}
                placeholder="심볼 검색 (BTC, 비트코인…)"
                className="w-full rounded-md bg-panel2 px-2.5 py-1.5 text-xs text-text outline-none ring-1 ring-border placeholder:text-muted focus:ring-elevated"
              />
              <div className="flex gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`flex-1 rounded py-1 text-[11px] font-semibold transition ${
                      filter === f.key ? 'bg-elevated text-text' : 'text-muted hover:bg-panel2 hover:text-text'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between border-b border-border bg-panel px-3 py-1.5 text-[10px] font-semibold text-muted">
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
            <div className="overflow-y-auto">
              {sorted.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">검색 결과가 없습니다</div>}
              {sorted.map((s) => {
                const st = statOf(s);
                const virtual = isVirtualSymbol(s);
                const krw = quoteOf(s) === 'KRW';
                const up = st ? st.changePct >= 0 : true;
                return (
                  <button
                    key={s}
                    onClick={() => pick(s)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-xs transition hover:bg-panel2 ${
                      s === symbol ? 'bg-panel2' : ''
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold text-text">
                      {pairLabel(s)}
                      {virtual && <span className="rounded bg-accent/20 px-1 py-0.5 text-[9px] font-bold text-accent">가상</span>}
                      {krw && KRW_NAMES[s] && <span className="truncate text-[10px] font-normal text-muted">{KRW_NAMES[s]}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2.5">
                      <span className="text-text">{st ? fmtAdaptive(st.price, krw) : '—'}</span>
                      <span className={`w-14 text-right ${up ? 'text-up' : 'text-down'}`}>
                        {st ? `${up ? '+' : ''}${st.changePct.toFixed(2)}%` : '—'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
