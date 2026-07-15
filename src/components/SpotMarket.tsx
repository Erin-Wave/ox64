import { useEffect, useState } from 'react';
import { api, type SpotState } from '@/services/api';

const fmtNum = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** OX/USDT 현물 거래 — 외부 시세 없이 유저 대 유저 지정가 주문이 직접 매칭되는 예시 시장.
 * 레버리지 없음. 매수는 USDT, 매도는 OX(가입 시 정해진 물량 지급)를 그 자리에서 주고받는다. */
export default function SpotMarket({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SpotState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .spotState()
        .then((d) => alive && setState(d))
        .catch((e) => alive && setErr((e as Error).message));
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const submit = async () => {
    const p = Number(price);
    const s = Number(size);
    if (!(p > 0) || !(s > 0) || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setState(await api.spotPlace(side, p, s));
      setSize('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (orderId: string) => {
    setBusy(true);
    try {
      setState(await api.spotCancel(orderId));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bids = state?.book.bids ?? [];
  const asks = state?.book.asks ?? [];
  const maxQty = Math.max(1e-9, ...bids.map((b) => b.size), ...asks.map((a) => a.size));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-extrabold text-text">🪙 OX/USDT 현물 (예시)</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted transition hover:text-text">
            ✕
          </button>
        </div>

        <div className="p-4 text-xs">
          <p className="mb-3 rounded-md bg-panel2 px-3 py-2 text-[11px] leading-relaxed text-muted">
            외부 시세가 없는 가상 코인입니다. 가입 시 지급된 정해진 물량을 유저끼리 지정가 주문으로 직접 사고팔며,
            레버리지·강제청산 없이 현물 그대로 오갑니다.
          </p>

          {!state && err ? (
            <p className="rounded-md bg-downDim px-3 py-2 text-down">{err}</p>
          ) : !state ? (
            <p className="py-8 text-center text-muted">불러오는 중…</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {/* 좌: 호가창 + 잔고 */}
              <div>
                <div className="mb-2 flex items-center justify-between rounded-md bg-panel2 px-3 py-2">
                  <span className="text-muted">보유 OX</span>
                  <span className="font-bold text-text">{fmtNum(state.oxBalance)}</span>
                </div>
                <div className="mb-3 flex items-center justify-between rounded-md bg-panel2 px-3 py-2">
                  <span className="text-muted">보유 USDT</span>
                  <span className="font-bold text-text">{fmtNum(state.usdtBalance)}</span>
                </div>

                <div className="rounded-md border border-border">
                  <div className="space-y-0.5 p-1.5">
                    {[...asks].reverse().map((a) => (
                      <button
                        key={a.price}
                        onClick={() => setPrice(String(a.price))}
                        className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
                      >
                        <span className="absolute inset-y-0 right-0 bg-downDim" style={{ width: `${Math.min(100, (a.size / maxQty) * 100)}%` }} />
                        <span className="relative z-10 font-medium text-down">{fmtNum(a.price)}</span>
                        <span className="relative z-10 text-muted">{fmtNum(a.size)}</span>
                      </button>
                    ))}
                    {asks.length === 0 && <div className="py-2 text-center text-muted">매도 호가 없음</div>}
                  </div>
                  <div className="border-y border-border px-2 py-1 text-center text-muted">호가</div>
                  <div className="space-y-0.5 p-1.5">
                    {bids.map((b) => (
                      <button
                        key={b.price}
                        onClick={() => setPrice(String(b.price))}
                        className="relative flex w-full items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-right transition hover:bg-panel2"
                      >
                        <span className="absolute inset-y-0 right-0 bg-upDim" style={{ width: `${Math.min(100, (b.size / maxQty) * 100)}%` }} />
                        <span className="relative z-10 font-medium text-up">{fmtNum(b.price)}</span>
                        <span className="relative z-10 text-muted">{fmtNum(b.size)}</span>
                      </button>
                    ))}
                    {bids.length === 0 && <div className="py-2 text-center text-muted">매수 호가 없음</div>}
                  </div>
                </div>
              </div>

              {/* 우: 주문 폼 + 내 주문/체결 */}
              <div>
                <div className="mb-2 flex gap-1 rounded-md bg-panel2 p-1">
                  <button
                    onClick={() => setSide('buy')}
                    className={`flex-1 rounded py-1.5 text-center font-semibold transition ${side === 'buy' ? 'bg-up text-white' : 'text-muted hover:text-text'}`}
                  >
                    매수
                  </button>
                  <button
                    onClick={() => setSide('sell')}
                    className={`flex-1 rounded py-1.5 text-center font-semibold transition ${side === 'sell' ? 'bg-down text-white' : 'text-muted hover:text-text'}`}
                  >
                    매도
                  </button>
                </div>
                <div className="mb-2 flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    inputMode="decimal"
                    placeholder="가격 (USDT)"
                    className="w-full bg-transparent px-3 py-2 font-semibold text-text outline-none placeholder:text-muted placeholder:font-normal"
                  />
                </div>
                <div className="mb-2 flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                  <input
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    inputMode="decimal"
                    placeholder="수량 (OX)"
                    className="w-full bg-transparent px-3 py-2 font-semibold text-text outline-none placeholder:text-muted placeholder:font-normal"
                  />
                </div>
                <button
                  onClick={submit}
                  disabled={busy}
                  className={`mb-3 w-full rounded-md py-2 font-bold text-white transition hover:brightness-110 disabled:opacity-40 ${side === 'buy' ? 'bg-up' : 'bg-down'}`}
                >
                  {side === 'buy' ? '매수 주문' : '매도 주문'}
                </button>

                {err && <p className="mb-2 rounded-md bg-downDim px-2.5 py-1.5 text-down">{err}</p>}

                <div className="mb-1 font-semibold text-muted">내 미체결 주문</div>
                <div className="mb-3 max-h-28 space-y-1 overflow-auto">
                  {state.myOrders.length === 0 && <div className="text-muted">없음</div>}
                  {state.myOrders.map((o) => (
                    <div key={o.id} className="flex items-center justify-between rounded bg-panel2 px-2 py-1">
                      <span className={o.side === 'buy' ? 'text-up' : 'text-down'}>
                        {o.side === 'buy' ? '매수' : '매도'} {fmtNum(o.price)} × {fmtNum(o.size)}
                      </span>
                      <button onClick={() => cancel(o.id)} disabled={busy} className="text-muted hover:text-down disabled:opacity-40">
                        취소
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mb-1 font-semibold text-muted">최근 체결</div>
                <div className="max-h-28 space-y-0.5 overflow-auto">
                  {state.trades.length === 0 && <div className="text-muted">없음</div>}
                  {state.trades.map((t) => (
                    <div key={t.id} className={`flex items-center justify-between rounded px-2 py-0.5 ${t.isMe ? 'bg-panel2' : ''}`}>
                      <span className="text-text">{fmtNum(t.price)}</span>
                      <span className="text-muted">{fmtNum(t.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
