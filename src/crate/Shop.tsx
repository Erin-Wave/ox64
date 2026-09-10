import { useState } from 'react';
import { useCrateStore, oddsLabel } from './useCrateStore';
import { JACKPOT_STYLE, fmtG, fmtP } from './data';

/**
 * 상점 — 상자 3종 구매 + **확률 공시**.
 * ⚠ 확률·가격은 서버가 `shop` 으로 내려준 값을 그대로 그린다(클라에 드롭 테이블을 또 적으면 서버
 * 밸런스를 고칠 때 화면만 조용히 틀려진다 — VIP 등급표와 같은 이유).
 */
export default function Shop() {
  const shop = useCrateStore((s) => s.shop);
  const cats = useCrateStore((s) => s.cats);
  const coins = useCrateStore((s) => s.coins);
  const busy = useCrateStore((s) => s.busy);
  const buy = useCrateStore((s) => s.buy);
  const [odds, setOdds] = useState<number | null>(null);

  return (
    <section className="rounded-2xl border border-border bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-bold">상점</h2>
        <span className="text-[11px] text-muted">한 상자에서 여러 보상이 동시에 나옵니다(각 항목 독립 추첨)</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {shop.map((c) => {
          const affordable = Math.floor(coins / c.price);
          const bulk = Math.min(10, affordable);
          return (
            <div key={c.level} className="flex flex-col rounded-xl border border-border bg-panel2 p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-2xl leading-none">{c.emoji}</span>
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold">{c.name}</div>
                  <div className="flex items-baseline gap-1 text-[11px] font-bold text-accent">
                    {c.price.toLocaleString()} G
                    {c.listPrice > c.price && (
                      <span className="font-normal text-muted line-through" title="오늘 할인 이벤트 중입니다">
                        {c.listPrice.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-muted">{c.desc}</p>

              <div className="mt-auto flex gap-1">
                <button
                  onClick={() => buy(c.level, 1)}
                  disabled={busy || coins < c.price}
                  className="flex-1 rounded-md bg-accent py-1.5 text-[11px] font-bold text-black transition hover:brightness-110 disabled:opacity-30"
                >
                  구매
                </button>
                {bulk > 1 && (
                  <button
                    onClick={() => buy(c.level, bulk)}
                    disabled={busy}
                    title={`${bulk}개 한 번에 구매 (${(c.price * bulk).toLocaleString()} G)`}
                    className="flex-1 rounded-md bg-panel py-1.5 text-[11px] font-bold text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
                  >
                    ×{bulk}
                  </button>
                )}
              </div>
              <button
                onClick={() => setOdds(odds === c.level ? null : c.level)}
                className="mt-1.5 text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
              >
                {odds === c.level ? '확률 닫기' : '확률 보기'}
              </button>
            </div>
          );
        })}
      </div>

      {odds !== null && (
        <div className="mt-3 rounded-xl border border-border bg-panel2 p-3">
          <div className="mb-2 text-xs font-bold">
            {shop.find((c) => c.level === odds)?.name} 드롭 확률
            <span className="ml-2 font-normal text-muted">— 항목마다 따로 굴립니다(여러 개가 같이 나올 수 있음)</span>
          </div>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {shop
              .find((c) => c.level === odds)!
              .odds.map((o, i) => {
                const jp = o.jackpot ? JACKPOT_STYLE[o.jackpot] : null;
                return (
                  <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className={jp ? 'font-bold' : 'text-muted'} style={jp ? { color: jp.color } : undefined}>
                      {jp && <span className="mr-1">★</span>}
                      {oddsLabel(o, cats, shop)}
                    </span>
                    <span className="shrink-0 font-mono font-bold tabular-nums" style={jp ? { color: jp.color } : undefined}>
                      {fmtP(o.p)}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </section>
  );
}

/** 극한 확률 잭팟 안내 — 게임의 도박성을 대놓고 보여주는 자리라 상시 노출한다. */
export function JackpotBanner() {
  const tiers = useCrateStore((s) => s.jackpotTiers);
  const shop = useCrateStore((s) => s.shop);
  const hit = useCrateStore((s) => s.stats.jackpots);
  if (tiers.length === 0) return null;
  const top = shop[shop.length - 1];
  return (
    <section className="rounded-2xl border border-border bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold">⚡ 극한 확률</h2>
        <span className="text-[11px] text-muted">{hit > 0 ? `지금까지 ${hit}번 터졌습니다` : '아직 한 번도 안 터졌습니다'}</span>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-muted">
        모든 상자에 아주 낮은 확률로 대박이 숨어 있습니다. 상자 가격의 배수로 터지므로 비싼 상자일수록 판돈도 큽니다.
      </p>
      <div className="flex flex-col gap-1">
        {tiers.map((t) => {
          const st = JACKPOT_STYLE[t.tier];
          return (
            <div key={t.tier} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-bold" style={{ color: st.color }}>
                ★ {t.label}
              </span>
              <span className="text-muted">
                가격 ×{t.mult.toLocaleString()} {top && <>(최대 {fmtG(top.price * t.mult)} G)</>}
              </span>
              <span className="shrink-0 font-mono font-bold tabular-nums" style={{ color: st.color }}>
                {fmtP(t.p)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
