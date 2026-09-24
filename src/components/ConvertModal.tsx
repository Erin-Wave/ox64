import { useEffect, useState } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { useMarketStore } from '@/store/useMarketStore';
import { fmtKrw, fmtMoney, fmtNumInput, unfmtNum } from '@/format';
import { quoteOf, USDT_KRW, type Quote } from '@/symbols';
import { fetchBithumbPrices } from '@/services/bithumb';

/**
 * USDT 지갑 ↔ 원화 지갑 환전(수수료 0, 빗썸 USDT/KRW 현재가).
 *
 * 원화 심볼(BTC/KRW 등)은 원화 지갑으로만 거래되므로 여기서 먼저 옮겨야 한다. 화면의 환율·수령액은
 * **미리보기**다 — 실제 환율은 서버가 요청 시점에 빗썸에서 다시 받는다(functions/api/convert.ts).
 * 환전 가능액 = min(잔고, 잔고 + 그 지갑 미실현손익) — 미실현 이익은 못 옮기고 미실현 손실은 빠진다(서버와 같은 식).
 */
export default function ConvertModal({ onClose }: { onClose: () => void }) {
  const balance = useTradingStore((s) => s.balance);
  const krwBalance = useTradingStore((s) => s.krwBalance);
  const positions = useTradingStore((s) => s.positions);
  const convert = useTradingStore((s) => s.convert);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);
  const prices = useMarketStore((s) => s.prices);
  const setPrice = useMarketStore((s) => s.setPrice);
  const [from, setFrom] = useState<Quote>('USDT');
  const [amount, setAmount] = useState('');
  const [tried, setTried] = useState(false); // 스토어 공용 error 는 이 모달에서 눌러본 뒤에만 보여준다(RefillModal 과 같은 이유)

  // 열려 있는 동안 환율을 직접 받는다(원화 노출이 없으면 시세 폴링이 환율을 안 받고 있을 수 있다). 브라우저 직결.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchBithumbPrices([USDT_KRW])
        .then((m) => {
          if (alive && m[USDT_KRW]) setPrice(USDT_KRW, m[USDT_KRW]);
        })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [setPrice]);

  const rate = prices[USDT_KRW] ?? null;
  const to: Quote = from === 'USDT' ? 'KRW' : 'USDT';
  const bal = from === 'KRW' ? krwBalance : balance;
  let uPnL = 0;
  let known = true;
  for (const p of positions) {
    if (quoteOf(p.symbol) !== from) continue;
    const live = prices[p.symbol];
    if (live == null) {
      known = false;
      continue;
    }
    uPnL += (live - p.entryPrice) * p.size * (p.side === 'long' ? 1 : -1);
  }
  const convertible = Math.max(0, Math.min(bal, bal + uPnL));
  const amt = Number(amount) || 0;
  const received = rate ? (from === 'USDT' ? amt * rate : amt / rate) : 0;
  const over = amt > convertible * (1 + 1e-6) + 1e-6;
  const digits = from === 'KRW' ? 0 : 2;
  // "최대"는 표시 자릿수에서 **내림** — 반올림으로 올리면 서버 한도를 살짝 넘는다(서버는 그 정도는 최대치로 맞춰 준다).
  const setMax = () => {
    const f = Math.pow(10, digits);
    setAmount(String(Math.floor(convertible * f) / f));
  };
  const swap = () => {
    setFrom(to);
    setAmount('');
  };
  const submit = async () => {
    if (!(amt > 0) || over || busy) return;
    setTried(true);
    if (await convert(from, amt)) onClose();
  };

  const walletRow = (q: Quote, v: number) => (
    <div className="flex items-baseline justify-between text-xs">
      <span className="text-muted">{q === 'USDT' ? 'USDT 지갑' : '원화 지갑'}</span>
      <span className="font-semibold tabular-nums text-text">
        {q === 'KRW' ? fmtKrw(v) : fmtMoney(v, 'USDT')} {q}
      </span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-text">환전</h2>
            <p className="mt-0.5 text-xs text-muted">원화 마켓(BTC/KRW 등)은 원화 지갑으로 거래합니다 · 수수료 없음</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-muted hover:bg-bg" title="닫기">
            ×
          </button>
        </div>

        <div className="mb-3 space-y-1 rounded-xl border border-border bg-bg p-3">
          {walletRow('USDT', balance)}
          {walletRow('KRW', krwBalance)}
          <div className="flex items-baseline justify-between border-t border-border pt-1 text-xs">
            <span className="text-muted">환율 (빗썸)</span>
            <span className="tabular-nums text-text">{rate ? `1 USDT = ${fmtKrw(rate)} KRW` : '불러오는 중…'}</span>
          </div>
        </div>

        {/* 보내는 쪽 */}
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>보내는 금액</span>
          <button onClick={setMax} className="text-accent hover:underline" title="환전 가능액 전부">
            최대 {from === 'KRW' ? fmtKrw(convertible) : fmtMoney(convertible, 'USDT')} {from}
          </button>
        </div>
        <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
          <input
            value={fmtNumInput(amount)}
            onChange={(e) => setAmount(unfmtNum(e.target.value))}
            inputMode="decimal"
            placeholder="0"
            className="w-full bg-transparent px-3 py-2 text-sm font-semibold text-text outline-none placeholder:text-muted"
          />
          <span className="px-3 text-xs font-semibold text-muted">{from}</span>
        </div>

        <div className="my-2 flex justify-center">
          <button
            onClick={swap}
            className="rounded-full bg-panel2 px-3 py-1 text-xs font-semibold text-text ring-1 ring-border transition hover:bg-elevated"
            title="방향 바꾸기"
          >
            ⇅ {from} → {to}
          </button>
        </div>

        {/* 받는 쪽(미리보기) */}
        <div className="mb-3 flex items-center justify-between rounded-md bg-panel2 px-3 py-2 ring-1 ring-border">
          <span className="text-xs text-muted">받는 금액(예상)</span>
          <span className="text-sm font-semibold tabular-nums text-text">
            {amt > 0 && rate ? (to === 'KRW' ? fmtKrw(received) : fmtMoney(received, 'USDT')) : '—'} {to}
          </span>
        </div>

        {!known && <p className="mb-2 text-[11px] text-muted">일부 포지션 시세를 불러오는 중이라 환전 가능액이 정확하지 않을 수 있습니다.</p>}
        {uPnL !== 0 && (
          <p className="mb-2 text-[11px] leading-relaxed text-muted">
            {from} 포지션의 미실현 {uPnL > 0 ? '이익은 환전할 수 없습니다' : '손실만큼은 지갑에 남아야 합니다'} (담보 유지).
          </p>
        )}
        {over && <p className="mb-2 rounded-lg bg-down/10 px-3 py-2 text-xs text-down">환전 가능 금액을 초과합니다</p>}
        {tried && error && <p className="mb-2 rounded-lg bg-down/10 px-3 py-2 text-xs text-down">{error}</p>}

        <button
          onClick={submit}
          disabled={busy || !(amt > 0) || over || !rate}
          className="w-full rounded-lg bg-accent py-2 text-sm font-bold text-bg transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? '처리 중…' : `${from} → ${to} 환전`}
        </button>
      </div>
    </div>
  );
}
