import { useEffect, useState } from 'react';
import { useMarketStore, precisionOf } from '@/store/useMarketStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { fmtPrice, fmtPriceShort, fmtQty, fmtQtyShort, fmtUsd, fmtUsdShort, fmtPct, fmtNumInput, unfmtNum } from '@/format';
import type { ApiOrder } from '@/services/api';

type Tab = 'positions' | 'pending' | 'conditional' | 'history';

const KIND_LABEL: Record<ApiOrder['kind'], string> = { open: '진입', close: '청산', liquidation: '강제청산' };
// sv-SE 로케일은 'YYYY-MM-DD HH:mm:ss' 형식으로 떨어져서 KST 타임존 지정과 함께 편하게 재사용.
const fmtTime = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

/** `continuous` 무한 조건부의 재실행 간격 하한(서버 MIN_CONTINUOUS_COOLDOWN_MS 와 같은 값, CLAUDE.md §6).
 * 하한 도입 전에 만들어진 주문은 DB 에 0 으로 남아 있으므로, 표시할 때도 실효값으로 환산해야 화면과
 * 실제 실행 간격이 어긋나지 않는다. */
const MIN_COOLDOWN_SEC = 5;
const effCooldownSec = (cooldownMs: number) => Math.max(MIN_COOLDOWN_SEC, (cooldownMs || 0) / 1000);

/** 슬라이더가 만든 수량을 입력칸 문자열로. ⚠ 1e21 이상은 String/toFixed 가 지수 표기("1e+21")를 줘서
 * 입력칸이 사람이 못 읽는 값이 된다(OrderPanel trimNum 과 같은 이유) → Intl 로 전체 자릿수를 편다. */
/** 입력칸 문자열 → 슬라이더 위치(%). 비어 있으면 "전량"이라 100% 로 본다. */
const closePctOf = (raw: string | undefined, closable: number): number => {
  const n = Number(raw ?? '');
  if (!raw || !(n > 0) || !(closable > 0)) return 100;
  return Math.max(0, Math.min(100, Math.round((n / closable) * 100)));
};

const qtyInputStr = (n: number): string => {
  if (!(n > 0)) return '';
  if (n >= 1e21) return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
  return String(Number(n.toFixed(8)));
};

/** 보유 포지션 목록 + 실시간 미실현 손익/ROE·청산가 (OKX 스타일).
 * 탭: 포지션 / (Standard) 미체결 지정가 / 주문내역. */
export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);
  const conditionalOrders = useTradingStore((s) => s.conditionalOrders);
  const orders = useTradingStore((s) => s.orders);
  const balance = useTradingStore((s) => s.balance);
  const closePosition = useTradingStore((s) => s.closePosition);
  const limitClose = useTradingStore((s) => s.limitClose);
  const cancelLimit = useTradingStore((s) => s.cancelLimit);
  const cancelConditional = useTradingStore((s) => s.cancelConditional);
  const editConditional = useTradingStore((s) => s.editConditional);
  const editLimit = useTradingStore((s) => s.editLimit);
  const setSlTp = useTradingStore((s) => s.setSlTp);
  const busy = useTradingStore((s) => s.busy);
  const prices = useMarketStore((s) => s.prices);
  const precisions = useMarketStore((s) => s.precisions);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const symbol = useMarketStore((s) => s.symbol);
  const chartClickPrice = useMarketStore((s) => s.chartClickPrice);
  const chartClickNonce = useMarketStore((s) => s.chartClickNonce);
  const priceTarget = useMarketStore((s) => s.priceTarget);
  const setPriceTarget = useMarketStore((s) => s.setPriceTarget);
  const standard = useSettingsStore((s) => s.tradingMode) === 'standard';

  const [tab, setTab] = useState<Tab>('positions');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');
  const [closeAmt, setCloseAmt] = useState<Record<string, string>>({}); // 포지션별 부분청산 수량(비우면 전량)
  const [closePx, setClosePx] = useState<Record<string, string>>({}); // 포지션별 청산 지정가(비우면 시장가)

  // 지정가가 채워져 있으면 지정가 청산(reduce-only 주문 예약), 아니면 시장가 청산.
  // 수량이 비어 있으면 전량(시장가는 size 생략, 지정가는 보유수량 전체) — 보유량 초과는 서버가 거부.
  // ⚠ 청산 후 입력값(수량·지정가)을 비우지 않는다 — 같은 수량으로 여러 번 나눠 털거나, 같은 가격에
  // 지정가 청산을 다시 걸 때 매번 새로 타이핑해야 했다. 전량 청산되면 행 자체가 사라지므로 남은 값이
  // 화면에 보일 일도 없다(상태는 포지션 id 키라 서로 섞이지 않는다).
  // 지정가 청산은 수량을 비우면 "청산 가능 수량"(보유 − 이미 예약된 지정가 청산)을 기본값으로 — 전량(posSize)을
  // 보내면 이미 예약분이 있을 때 서버가 초과로 거부한다. 시장가 청산(px 없음)은 비우면 전량(서버가 보유량으로 캡).
  const doClose = (id: string, closable: number) => {
    const amt = closeAmt[id] ? Number(closeAmt[id]) : NaN;
    const px = closePx[id] ? Number(closePx[id]) : NaN;
    if (px > 0) limitClose(id, amt > 0 ? amt : closable, px);
    else closePosition(id, amt > 0 ? amt : undefined);
  };

  // 차트/호가창 클릭 → 포커스해뒀던 "청산 지정가" 칸에 그 가격을 채운다(OrderPanel 지정가와 동일한 흐름).
  // ⚠ 클릭 대상은 하나뿐이라(useMarketStore.priceTarget) 주문 지정가와 동시에 바뀌지 않는다.
  // ⚠ 보고 있는 차트의 심볼과 포지션 심볼이 다르면 무시 — BTC 차트를 클릭했는데 OX 포지션의 청산가로
  // 들어가면 엉뚱한 가격에 청산이 예약된다.
  useEffect(() => {
    if (chartClickNonce === 0 || chartClickPrice == null || !priceTarget.startsWith('close:')) return;
    const id = priceTarget.slice('close:'.length);
    const target = positions.find((p) => p.id === id);
    if (!target || target.symbol !== symbol) return;
    setClosePx((s) => ({ ...s, [id]: String(chartClickPrice) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartClickNonce]);

  // 대상 포지션이 사라지면(전량 청산·강제청산) 클릭 타깃을 주문 지정가로 되돌린다 — 안 그러면 청산
  // 직후 첫 차트 클릭이 사라진 칸으로 향해 아무 데도 안 들어가고 삼켜진다.
  useEffect(() => {
    if (!priceTarget.startsWith('close:')) return;
    if (!positions.some((p) => p.id === priceTarget.slice('close:'.length))) setPriceTarget('');
  }, [positions, priceTarget, setPriceTarget]);

  const startEdit = (id: string, sl: number | null, tp: number | null) => {
    setEditingId(id);
    setEditSl(sl != null ? String(sl) : '');
    setEditTp(tp != null ? String(tp) : '');
  };
  const saveEdit = (id: string) => {
    setSlTp(id, {
      stopLoss: editSl ? Number(editSl) : null,
      takeProfit: editTp ? Number(editTp) : null,
    });
    setEditingId(null);
  };

  // 미체결(지정가) 주문 수정 — 지정가/수량 인라인 편집.
  const [editPendId, setEditPendId] = useState<string | null>(null);
  const [editPendPx, setEditPendPx] = useState('');
  const [editPendSize, setEditPendSize] = useState('');
  const startEditPend = (id: string, price: number, size: number) => {
    setEditPendId(id);
    setEditPendPx(String(price));
    setEditPendSize(String(size));
  };
  const saveEditPend = (id: string) => {
    const px = editPendPx ? Number(editPendPx) : NaN;
    const size = editPendSize ? Number(editPendSize) : NaN;
    editLimit(id, { limitPrice: px > 0 ? px : undefined, size: size > 0 ? size : undefined });
    setEditPendId(null);
  };

  // 조건부 주문 수정 — 트리거가/수량/조건(이상·이하) + 반복 설정을 인라인 편집한다(증거금을 잠그지
  // 않는 주문이라 서버도 단순 UPDATE). 편집 중인 행만 입력칸으로 바뀐다.
  const [editCondId, setEditCondId] = useState<string | null>(null);
  const [editCondPx, setEditCondPx] = useState('');
  const [editCondSize, setEditCondSize] = useState('');
  const [editCondDir, setEditCondDir] = useState<'above' | 'below'>('above');
  const [editCondRepeat, setEditCondRepeat] = useState(false);
  const [editCondMode, setEditCondMode] = useState<'continuous' | 'rearm'>('continuous');
  const [editCondCooldown, setEditCondCooldown] = useState('');
  const [editCondRearm, setEditCondRearm] = useState('');
  const [editCondMax, setEditCondMax] = useState('');
  const startEditCond = (c: (typeof conditionalOrders)[number]) => {
    setEditCondId(c.id);
    setEditCondPx(String(c.triggerPrice));
    setEditCondSize(String(c.size));
    setEditCondDir(c.triggerDir);
    setEditCondRepeat(c.repeating);
    setEditCondMode(c.repeatMode);
    setEditCondCooldown(c.cooldownMs > 0 ? String(c.cooldownMs / 1000) : '');
    setEditCondRearm(c.rearmPrice != null ? String(c.rearmPrice) : '');
    setEditCondMax(c.maxFills != null ? String(c.maxFills) : '');
  };
  const saveEditCond = (id: string) => {
    const px = editCondPx ? Number(editCondPx) : NaN;
    const size = editCondSize ? Number(editCondSize) : NaN;
    editConditional(id, {
      triggerPrice: px > 0 ? px : undefined,
      size: size > 0 ? size : undefined,
      triggerDir: editCondDir,
      repeating: editCondRepeat,
      repeatMode: editCondMode,
      // 해당 모드에서 의미 없는 값은 null 로 보내 해제한다(서버가 undefined=유지, null=해제로 구분).
      rearmPrice: editCondRepeat && editCondMode === 'rearm' && editCondRearm ? Number(editCondRearm) : null,
      // ⚠ continuous 는 재실행 간격 하한이 있다(MIN_COOLDOWN_SEC) — 비워서 보내면 서버가 하한으로 올린다.
      cooldownSec:
        editCondRepeat && editCondMode === 'continuous' && editCondCooldown ? Number(editCondCooldown) : MIN_COOLDOWN_SEC,
      maxFills: editCondRepeat && editCondMax ? Number(editCondMax) : null,
    });
    setEditCondId(null);
  };

  // 각 포지션의 미실현 PnL(현재 시세 기준) — 청산가 계산에서 "다른 포지션들"의 몫을 뺄 때 재사용.
  const unrealizedOf = (p: (typeof positions)[number]) => {
    const live = prices[p.symbol];
    if (live == null) return null;
    const dir = p.side === 'long' ? 1 : -1;
    return (live - p.entryPrice) * p.size * dir;
  };
  const totalUnrealizedKnown = positions.every((p) => unrealizedOf(p) != null);
  const totalUnrealized = positions.reduce((a, p) => a + (unrealizedOf(p) ?? 0), 0);
  const totalMargin = positions.reduce((a, p) => a + (p.entryPrice * p.size) / p.leverage, 0);

  // 청산가: 이 포지션의 가격이 얼마가 되면 계좌 평가자산이 0이 되는지.
  // 평가자산 = 여유잔고 + Σ(잠긴 증거금 + 미실현손익) — 서버(functions/_trading.ts)의 강제청산 조건과
  // 동일한 산식(증거금 항 포함). 추정치 표시용(실제 체결은 서버가 함).
  const liqPriceOf = (p: (typeof positions)[number]): number | null => {
    if (!totalUnrealizedKnown) return null;
    const mine = unrealizedOf(p);
    if (mine == null) return null;
    const others = totalUnrealized - mine;
    const dir = p.side === 'long' ? 1 : -1;
    return p.entryPrice - (balance + totalMargin + others) / (p.size * dir);
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      onClick={() => setTab(t)}
      className={`rounded px-2 py-1 text-xs font-semibold transition ${
        tab === t ? 'bg-elevated text-text' : 'text-muted hover:text-text'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 탭 헤더 */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {tabBtn('positions', `포지션 (${positions.length})`)}
        {standard && tabBtn('pending', `미체결 (${pendingOrders.length})`)}
        {standard && tabBtn('conditional', `조건부 (${conditionalOrders.length})`)}
        {tabBtn('history', '주문내역')}
      </div>

      {tab === 'positions' &&
        (positions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">
            보유 중인 포지션이 없습니다
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 text-right font-medium">현재가</th>
                  <th className="px-3 py-2 text-right font-medium">진입가</th>
                  <th className="px-3 py-2 text-right font-medium">청산가</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  {standard && <th className="px-3 py-2 text-right font-medium">SL / TP</th>}
                  <th className="px-3 py-2 text-right font-medium">미실현 PnL (ROE)</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const dir = p.side === 'long' ? 1 : -1;
                  const live = prices[p.symbol] ?? null;
                  const pnl = live != null ? (live - p.entryPrice) * p.size * dir : null;
                  const margin = (p.entryPrice * p.size) / p.leverage;
                  const roe = pnl != null && margin > 0 ? (pnl / margin) * 100 : null;
                  const pos = pnl != null && pnl >= 0;
                  const prec = precisionOf(precisions, p.symbol);
                  const editing = editingId === p.id;
                  const liq = liqPriceOf(p);
                  // 청산 가능 수량 = 보유수량 − 이미 걸어둔 지정가 청산(reduce-only) 합. 초과 예약 방지(서버도 검증).
                  const closeSide = p.side === 'long' ? 'short' : 'long';
                  const reservedClose = pendingOrders
                    .filter((o) => o.reduceOnly && o.symbol === p.symbol && o.side === closeSide)
                    .reduce((a, o) => a + o.size, 0);
                  const closable = Math.max(0, p.size - reservedClose);
                  return (
                    <tr key={p.id} className="border-b border-border/60 transition hover:bg-panel2">
                      <td className="px-3 py-2.5 font-medium text-text">
                        <button
                          onClick={() => setSymbol(p.symbol)}
                          title={`${p.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {p.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            p.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                          }`}
                        >
                          {p.side === 'long' ? '롱' : '숏'} 크로스 {p.leverage}x
                        </span>
                      </td>
                      {/* ⚠ 가격도 축약한다(전체값은 title) — 특히 **청산가**는 숏에서 진입가 + 평가자산/수량
                          이라 1e20 을 예사로 넘고, 그 한 칸이 표 전체를 밀어냈다(§format.fmtPriceShort). */}
                      <td className="px-3 py-2.5 text-right text-text" title={live != null ? `${fmtPrice(live, prec)} USDT` : undefined}>
                        {live != null ? fmtPriceShort(live, prec, 10) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text" title={`${fmtPrice(p.entryPrice, prec)} USDT`}>
                        {fmtPriceShort(p.entryPrice, prec, 10)}
                      </td>
                      <td
                        className="px-3 py-2.5 text-right text-down"
                        title={liq != null && liq > 0 ? `강제청산 예상가 ${fmtPrice(liq, prec)} USDT` : undefined}
                      >
                        {liq != null && liq > 0 ? fmtPriceShort(liq, prec, 10) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {/* 수량·증거금은 1e30 까지 가므로 축약(전체값은 title) — §format.fmtQtyShort */}
                        <div title={`${fmtQty(p.size)} ${p.symbol.replace('USDT', '')}`}>{fmtQtyShort(p.size)}</div>
                        <div className="text-[10px] text-muted" title={`증거금 ${fmtUsd(margin)} USDT`}>
                          ({fmtUsdShort(margin, 9)} USDT)
                        </div>
                      </td>
                      {standard && (
                        <td className="px-3 py-2.5 text-right">
                          {editing ? (
                            <div className="flex items-center justify-end gap-1">
                              <input
                                value={fmtNumInput(editSl)}
                                onChange={(e) => setEditSl(unfmtNum(e.target.value))}
                                placeholder="SL"
                                inputMode="decimal"
                                className="w-16 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                              />
                              <input
                                value={fmtNumInput(editTp)}
                                onChange={(e) => setEditTp(unfmtNum(e.target.value))}
                                placeholder="TP"
                                inputMode="decimal"
                                className="w-16 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                              />
                              <button
                                onClick={() => saveEdit(p.id)}
                                disabled={busy}
                                className="rounded bg-elevated px-1.5 py-0.5 text-[11px] text-accent hover:bg-panel2"
                              >
                                저장
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(p.id, p.stopLoss, p.takeProfit)}
                              className="text-[11px] text-muted hover:text-text"
                            >
                              {p.stopLoss != null || p.takeProfit != null ? (
                                <span className="space-x-1">
                                  <span className="text-down" title={p.stopLoss != null ? fmtPrice(p.stopLoss, prec) : undefined}>
                                    {p.stopLoss != null ? fmtPriceShort(p.stopLoss, prec, 9) : '—'}
                                  </span>
                                  <span>/</span>
                                  <span className="text-up" title={p.takeProfit != null ? fmtPrice(p.takeProfit, prec) : undefined}>
                                    {p.takeProfit != null ? fmtPriceShort(p.takeProfit, prec, 9) : '—'}
                                  </span>
                                </span>
                              ) : (
                                '설정'
                              )}
                            </button>
                          )}
                        </td>
                      )}
                      <td
                        className={`px-3 py-2.5 text-right font-medium ${
                          pnl == null ? 'text-muted' : pos ? 'text-up' : 'text-down'
                        }`}
                      >
                        {pnl == null ? (
                          '—'
                        ) : (
                          <span title={`미실현 ${fmtUsd(pnl)} USDT`}>
                            {pos ? '+' : ''}
                            {fmtUsdShort(pnl)}
                            <span className="ml-1 text-[10px] opacity-80">
                              ({pos ? '+' : ''}
                              {fmtPct(roe)}%)
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex flex-col items-stretch gap-1">
                        <div className="flex items-center justify-end gap-1">
                          {standard && (
                            <>
                              <input
                                value={fmtNumInput(closeAmt[p.id] ?? '')}
                                onChange={(e) => setCloseAmt((s) => ({ ...s, [p.id]: unfmtNum(e.target.value) }))}
                                placeholder={fmtQtyShort(closable)}
                                inputMode="decimal"
                                title={`청산 수량(비우면 전량) · 청산 가능 ${fmtQty(closable)}${reservedClose > 0 ? ` (예약 ${fmtQty(reservedClose)} 제외)` : ''}`}
                                // 보유 수량 텍스트 길이에 맞춰 폭을 잡는다(콤마 포함 자릿수 + 패딩). 너무 짧던 w-14 대체.
                                // ⚠ 상한 20ch — 1e30 개를 들고 있으면 자릿수가 31 이라 입력칸 하나가 패널을 통째로 밀어낸다.
                                style={{ width: `calc(${Math.min(20, Math.max(5, fmtQty(p.size).length))}ch + 1.25rem)` }}
                                className="rounded bg-panel2 px-1.5 py-1 text-right text-[11px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                              />
                              <input
                                value={fmtNumInput(closePx[p.id] ?? '')}
                                onChange={(e) => setClosePx((s) => ({ ...s, [p.id]: unfmtNum(e.target.value) }))}
                                onFocus={() => setPriceTarget(`close:${p.id}`)} // 차트 클릭 가격을 이 칸으로
                                placeholder="시장가"
                                inputMode="decimal"
                                title="청산 지정가(비우면 시장가, 채우면 그 가격에 지정가 청산 예약) — 이 칸을 클릭한 뒤 차트를 클릭하면 그 가격이 들어옵니다"
                                // 차트 클릭을 받는 칸을 accent 링으로 표시(차트를 클릭하면 포커스가 풀려서 어디로 들어갈지 안 보인다)
                                className={`w-16 rounded bg-panel2 px-1.5 py-1 text-right text-[11px] text-text outline-none ring-1 placeholder:text-muted ${
                                  priceTarget === `close:${p.id}` ? 'ring-accent' : 'ring-border'
                                }`}
                              />
                            </>
                          )}
                          <button
                            onClick={() => (standard ? doClose(p.id, closable) : closePosition(p.id))}
                            disabled={busy}
                            title={standard ? '지정가 입력 시 지정가 청산, 비우면 시장가 청산' : '전량 시장가 청산'}
                            className="rounded border border-border px-2.5 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                          >
                            청산
                          </button>
                        </div>
                        {/* 청산 수량 슬라이더 — 숫자를 직접 치지 않고 비중으로 정한다(주문 패널 슬라이더와 같은 감각).
                            ⚠ 값의 진실원본은 위 입력칸 문자열이고 슬라이더 위치는 거기서 **파생**한다(별도 상태를
                            두면 둘이 어긋난다). 입력칸이 비어 있으면 "전량"이므로 100% 로 보여주고, 100 으로
                            끌면 다시 빈칸으로 되돌린다(전량 = 비움 이라는 기존 의미를 유지). */}
                        {standard && closable > 0 && (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="range"
                              min={0}
                              max={100}
                              value={closePctOf(closeAmt[p.id], closable)}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                setCloseAmt((st) => ({
                                  ...st,
                                  [p.id]: v >= 100 ? '' : qtyInputStr((closable * v) / 100),
                                }));
                              }}
                              title="청산 수량 비중 — 청산 가능 수량 기준"
                              className="h-1 w-full min-w-[3rem] accent-down"
                            />
                            <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted">
                              {closePctOf(closeAmt[p.id], closable)}%
                            </span>
                          </div>
                        )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'pending' &&
        (pendingOrders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">
            미체결 지정가 주문이 없습니다
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 text-right font-medium">지정가</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {pendingOrders.map((o) => {
                  const pe = editPendId === o.id;
                  return (
                    <tr key={o.id} className="border-b border-border/60">
                      <td className="px-3 py-2.5 font-medium text-text">
                        <button
                          onClick={() => setSymbol(o.symbol)}
                          title={`${o.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {o.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        {o.reduceOnly ? (
                          // 지정가 청산(reduce-only) — 주문 방향(side)의 반대가 청산 대상 포지션 방향.
                          <span className="rounded bg-elevated px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                            {o.side === 'short' ? '롱' : '숏'} 청산
                          </span>
                        ) : (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                              o.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                            }`}
                          >
                            {o.side === 'long' ? '롱' : '숏'} 크로스 {o.leverage}x
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {pe ? (
                          <input
                            value={fmtNumInput(editPendPx)}
                            onChange={(e) => setEditPendPx(unfmtNum(e.target.value))}
                            placeholder="지정가"
                            inputMode="decimal"
                            className="w-20 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                          />
                        ) : (
                          <span title={`${fmtPrice(o.limitPrice, precisionOf(precisions, o.symbol))} USDT`}>
                            {fmtPriceShort(o.limitPrice, precisionOf(precisions, o.symbol), 10)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {pe ? (
                          <input
                            value={fmtNumInput(editPendSize)}
                            onChange={(e) => setEditPendSize(unfmtNum(e.target.value))}
                            placeholder="수량"
                            inputMode="decimal"
                            className="w-20 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border"
                          />
                        ) : (
                          <span title={fmtQty(o.size)}>{fmtQtyShort(o.size)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {pe ? (
                            <>
                              <button
                                onClick={() => saveEditPend(o.id)}
                                disabled={busy}
                                className="rounded bg-elevated px-2 py-1 text-accent transition hover:bg-panel2 disabled:opacity-40"
                              >
                                저장
                              </button>
                              <button
                                onClick={() => setEditPendId(null)}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:text-text"
                              >
                                취소
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditPend(o.id, o.limitPrice, o.size)}
                                disabled={busy}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:border-accent hover:text-accent disabled:opacity-40"
                              >
                                수정
                              </button>
                              <button
                                onClick={() => cancelLimit(o.id)}
                                disabled={busy}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                              >
                                취소
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'conditional' &&
        (conditionalOrders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">
            조건부(스탑) 주문이 없습니다
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 text-right font-medium">트리거 조건</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2 font-medium">반복</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {conditionalOrders.map((c) => {
                  const editing = editCondId === c.id;
                  const prec = precisionOf(precisions, c.symbol);
                  const inputCls =
                    'w-20 rounded bg-panel2 px-1 py-0.5 text-right text-[11px] text-text outline-none ring-1 ring-border';
                  return (
                    <tr key={c.id} className="border-b border-border/60">
                      <td className="px-3 py-2.5 font-medium text-text">
                        <button
                          onClick={() => setSymbol(c.symbol)}
                          title={`${c.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {c.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            c.side === 'long' ? 'bg-upDim text-up' : 'bg-downDim text-down'
                          }`}
                        >
                          {c.side === 'long' ? '롱' : '숏'} 진입 {c.leverage}x
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {editing ? (
                          <div className="flex items-center justify-end gap-1">
                            {/* 이상/이하 토글 — 클릭하면 반대로 바뀐다 */}
                            <button
                              onClick={() => setEditCondDir(editCondDir === 'above' ? 'below' : 'above')}
                              title="트리거 조건 전환(이상 ↔ 이하)"
                              className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] font-semibold text-accent ring-1 ring-border"
                            >
                              {editCondDir === 'above' ? '≥' : '≤'}
                            </button>
                            <input
                              value={fmtNumInput(editCondPx)}
                              onChange={(e) => setEditCondPx(unfmtNum(e.target.value))}
                              inputMode="decimal"
                              className={inputCls}
                            />
                          </div>
                        ) : (
                          <>
                            <span className="text-muted">{c.triggerDir === 'above' ? '≥ ' : '≤ '}</span>
                            <span title={`${fmtPrice(c.triggerPrice, prec)} USDT`}>{fmtPriceShort(c.triggerPrice, prec, 10)}</span>
                            {/* 재무장 대기 중이면 다시 무장되는 가격을 함께 보여준다 */}
                            {c.repeating && c.repeatMode === 'rearm' && !c.armed && (
                              <div className="text-[10px] text-muted">
                                재무장 {c.triggerDir === 'above' ? '≤ ' : '≥ '}
                                {fmtPriceShort(c.rearmPrice ?? c.triggerPrice, prec, 9)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-text">
                        {editing ? (
                          <input
                            value={fmtNumInput(editCondSize)}
                            onChange={(e) => setEditCondSize(unfmtNum(e.target.value))}
                            inputMode="decimal"
                            className={inputCls}
                          />
                        ) : (
                          <>
                            <span title={fmtQty(c.size)}>{fmtQtyShort(c.size)}</span>
                            {c.repeating && <div className="text-[10px] text-muted">1회당</div>}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {editing ? (
                          <div className="flex flex-col items-start gap-1">
                            <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted">
                              <input
                                type="checkbox"
                                checked={editCondRepeat}
                                onChange={(e) => setEditCondRepeat(e.target.checked)}
                                className="accent-up"
                              />
                              무한 반복
                            </label>
                            {editCondRepeat && (
                              <>
                                <div className="flex gap-1">
                                  <button
                                    onClick={() => setEditCondMode('continuous')}
                                    title="조건을 만족하는 동안 계속 실행"
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                      editCondMode === 'continuous' ? 'bg-elevated text-accent' : 'bg-panel2 text-muted'
                                    }`}
                                  >
                                    계속
                                  </button>
                                  <button
                                    onClick={() => setEditCondMode('rearm')}
                                    title="되돌아왔다 다시 트리거될 때 1회씩"
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                      editCondMode === 'rearm' ? 'bg-elevated text-accent' : 'bg-panel2 text-muted'
                                    }`}
                                  >
                                    되돌아올 때
                                  </button>
                                </div>
                                <div className="flex items-center gap-1">
                                  {editCondMode === 'continuous' ? (
                                    <input
                                      value={fmtNumInput(editCondCooldown)}
                                      onChange={(e) => setEditCondCooldown(unfmtNum(e.target.value))}
                                      inputMode="decimal"
                                      placeholder={`${MIN_COOLDOWN_SEC}s`}
                                      title={`재실행 간격(초). 최소 ${MIN_COOLDOWN_SEC}초 — 비우면 ${MIN_COOLDOWN_SEC}초`}
                                      className="w-14 rounded bg-panel2 px-1 py-0.5 text-right text-[10px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                                    />
                                  ) : (
                                    <input
                                      value={fmtNumInput(editCondRearm)}
                                      onChange={(e) => setEditCondRearm(unfmtNum(e.target.value))}
                                      inputMode="decimal"
                                      placeholder="재무장가"
                                      title="재무장 가격(비움=트리거 가격)"
                                      className="w-16 rounded bg-panel2 px-1 py-0.5 text-right text-[10px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                                    />
                                  )}
                                  <input
                                    value={fmtNumInput(editCondMax)}
                                    onChange={(e) => setEditCondMax(unfmtNum(e.target.value))}
                                    inputMode="numeric"
                                    placeholder="최대"
                                    title="최대 실행 횟수(비움=무제한)"
                                    className="w-14 rounded bg-panel2 px-1 py-0.5 text-right text-[10px] text-text outline-none ring-1 ring-border placeholder:text-muted"
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        ) : c.repeating ? (
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={`w-fit rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                                c.repeatMode === 'continuous'
                                  ? 'bg-downDim text-down'
                                  : c.armed
                                    ? 'bg-accent/15 text-accent'
                                    : 'bg-panel2 text-muted'
                              }`}
                              title={
                                c.repeatMode === 'continuous'
                                  ? `조건을 만족하는 동안 계속 실행 (${effCooldownSec(c.cooldownMs)}초 간격)`
                                  : c.armed
                                    ? '무장 상태 — 트리거되면 실행됩니다'
                                    : '재무장 대기 — 가격이 되돌아와야 다시 실행됩니다'
                              }
                            >
                              {c.repeatMode === 'continuous' ? '계속 ∞' : '되돌아올 때 ∞'}
                            </span>
                            <span className="text-[10px] text-muted">
                              {c.maxFills != null ? `${c.fillCount}/${c.maxFills}회` : `${c.fillCount}회 실행`}
                              {c.repeatMode === 'continuous'
                                ? ` · ${effCooldownSec(c.cooldownMs)}초 간격`
                                : c.armed
                                  ? ' · 대기 중'
                                  : ' · 재무장 대기'}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted">1회</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {editing ? (
                            <>
                              <button
                                onClick={() => saveEditCond(c.id)}
                                disabled={busy}
                                className="rounded bg-elevated px-1.5 py-0.5 text-[11px] text-accent hover:bg-panel2 disabled:opacity-40"
                              >
                                저장
                              </button>
                              <button
                                onClick={() => setEditCondId(null)}
                                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted hover:text-text"
                              >
                                취소
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditCond(c)}
                                disabled={busy}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:border-accent hover:text-accent disabled:opacity-40"
                              >
                                수정
                              </button>
                              <button
                                onClick={() => cancelConditional(c.id)}
                                disabled={busy}
                                className="rounded border border-border px-2 py-1 text-muted transition hover:border-down hover:text-down disabled:opacity-40"
                              >
                                취소
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'history' &&
        (orders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">주문 내역이 없습니다</div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">시각</th>
                  <th className="px-3 py-2 font-medium">심볼</th>
                  <th className="px-3 py-2 font-medium">방향</th>
                  <th className="px-3 py-2 font-medium">종류</th>
                  <th className="px-3 py-2 text-right font-medium">체결가</th>
                  <th className="px-3 py-2 text-right font-medium">수량</th>
                  <th className="px-3 py-2 text-right font-medium">손익</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const prec = precisionOf(precisions, o.symbol);
                  const pos = o.pnl != null && o.pnl >= 0;
                  return (
                    <tr key={o.id} className="border-b border-border/60">
                      <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtTime(o.createdAt)}</td>
                      <td className="px-3 py-2 font-medium text-text">
                        <button
                          onClick={() => setSymbol(o.symbol)}
                          title={`${o.symbol.replace('USDT', '')} 차트로 이동`}
                          className="font-medium text-text underline-offset-2 transition hover:text-accent hover:underline"
                        >
                          {o.symbol.replace('USDT', '')}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span className={o.side === 'long' ? 'text-up' : 'text-down'}>
                          {o.side === 'long' ? '롱' : '숏'} {o.leverage}x
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            o.kind === 'liquidation' ? 'font-semibold text-down' : 'text-muted'
                          }
                        >
                          {KIND_LABEL[o.kind]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-text" title={`${fmtPrice(o.price, prec)} USDT`}>
                        {fmtPriceShort(o.price, prec, 10)}
                      </td>
                      <td className="px-3 py-2 text-right text-text" title={fmtQty(o.size)}>
                        {fmtQtyShort(o.size)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${o.pnl == null ? 'text-muted' : pos ? 'text-up' : 'text-down'}`}
                        title={o.pnl == null ? undefined : `${fmtUsd(o.pnl)} USDT`}
                      >
                        {o.pnl == null ? '—' : `${pos ? '+' : ''}${fmtUsdShort(o.pnl)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
