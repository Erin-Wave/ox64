import { useState } from 'react';
import { useCrateStore } from './useCrateStore';
import { JACKPOT_STYLE, fmtG, tierOf } from './data';
import type { RewardItem } from './api';

/**
 * 개봉 무대 — 보유 상자를 고르고 까는 곳. 애니메이션은 요구사항대로 "아주 살짝만" 이라
 * (상자가 0.42초 흔들림 → 결과 카드가 순서대로 튀어나옴) 결과 확인이 늦어지지 않는다.
 * ⚠ 서버 응답이 그보다 빨리 와도 흔들림은 끝까지 재생한다(`Promise.all` 로 최소 시간 보장) —
 * 안 그러면 로컬에선 애니메이션이 아예 안 보이고 결과만 툭 튀어나온다.
 */
export default function OpenStage() {
  const crates = useCrateStore((s) => s.crates);
  const shop = useCrateStore((s) => s.shop);
  const bonusTiers = useCrateStore((s) => s.bonusTiers);
  const milestones = useCrateStore((s) => s.milestones);
  const cats = useCrateStore((s) => s.cats);
  const session = useCrateStore((s) => s.session);
  const busy = useCrateStore((s) => s.busy);
  const maxOpen = useCrateStore((s) => s.limits.maxOpen);
  const open = useCrateStore((s) => s.open);
  const closeSession = useCrateStore((s) => s.closeSession);

  const [shaking, setShaking] = useState<number | null>(null);

  const doOpen = async (level: number, count: number) => {
    if (busy || shaking !== null) return;
    setShaking(level);
    await Promise.all([open(level, count), new Promise((r) => setTimeout(r, 420))]);
    setShaking(null);
  };

  const owned = shop.map((c) => ({ ...c, count: crates[String(c.level)] ?? 0 }));
  const totalOwned = owned.reduce((s, c) => s + c.count, 0);
  const jp = session?.jackpot ? JACKPOT_STYLE[session.jackpot] : null;

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-panel p-4">
      {/* 잭팟 플래시 — 무대 전체를 한 번 덮는다(1/2,000 이라 대부분 평생 못 본다) */}
      {jp && <div className="crate-flash absolute inset-0 z-10 rounded-2xl" style={{ background: jp.glow }} />}

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-bold">보유 상자</h2>
        <span className="text-xs text-muted">{totalOwned === 0 ? '상점에서 상자를 사세요' : `${totalOwned}개 보유`}</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {owned.map((c) => {
          const has = c.count > 0;
          const bulk = Math.min(c.count, maxOpen);
          return (
            <div
              key={c.level}
              className={
                'flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition ' +
                (has ? 'border-border bg-panel2' : 'border-border/50 bg-panel2/40 opacity-50')
              }
            >
              <button
                onClick={() => has && doOpen(c.level, 1)}
                disabled={!has || busy}
                title={has ? `${c.name} 1개 열기` : '보유한 상자가 없습니다'}
                className={
                  'text-3xl leading-none transition disabled:cursor-not-allowed ' +
                  (has ? 'hover:scale-110 active:scale-95' : '') +
                  (shaking === c.level ? ' crate-shake' : '')
                }
              >
                {c.emoji}
              </button>
              <div className="text-[11px] font-bold">
                Lv{c.level} <span className="text-muted">×{c.count}</span>
              </div>
              <div className="flex w-full gap-1">
                <button
                  onClick={() => doOpen(c.level, 1)}
                  disabled={!has || busy}
                  className="flex-1 rounded-md bg-accent/15 py-1 text-[11px] font-bold text-accent transition hover:bg-accent/25 disabled:opacity-30"
                >
                  열기
                </button>
                {bulk > 1 && (
                  <button
                    onClick={() => doOpen(c.level, bulk)}
                    disabled={busy}
                    title={`${bulk}개를 한 번에 열고 결과를 합쳐서 보여줍니다`}
                    className="flex-1 rounded-md bg-panel py-1 text-[11px] font-bold text-muted ring-1 ring-border transition hover:text-text disabled:opacity-30"
                  >
                    ×{bulk}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 마일스톤 진행도 — 계속 까는 이유를 항상 보이게(누적 개봉 수에서 파생되므로 저장 상태가 없다) */}
      {milestones.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          {milestones.map((m) => {
            const left = m.every - m.progress;
            const pct = (m.progress / m.every) * 100;
            return (
              <span key={m.every} className="flex items-center gap-1.5" title={`${m.every}회 개봉마다 ${shop.find((c) => c.level === m.level)?.name ?? ''} ${m.count}개`}>
                <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-panel2">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                </span>
                <span>
                  Lv{m.level} 상자까지 <b className="text-text">{left}</b>회
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* ── 개봉 결과 ── */}
      {session && (
        <div className="relative z-20 mt-4 rounded-xl border border-border bg-panel2 p-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-bold">
              {shop.find((c) => c.level === session.level)?.name ?? `Lv${session.level} 상자`} ×{session.count} 개봉
              {jp && (
                <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-extrabold" style={{ background: jp.color, color: '#000' }}>
                  {jp.label} 잭팟!
                </span>
              )}
            </span>
            <button onClick={closeSession} className="text-xs text-muted hover:text-text" title="결과 닫기">
              ✕
            </button>
          </div>

          {/* 이번 개봉에서 터진 보너스 — 같은 등급은 묶어서 "✨ 보너스 ×3" 으로 */}
          {(session.bonusCounts.length > 0 || session.bulk > 0) && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {session.bonusCounts.map(({ tier, n }) => {
                const b = bonusTiers.find((x) => x.tier === tier);
                if (!b) return null;
                return (
                  <span
                    key={tier}
                    className="crate-pop rounded-md px-2 py-1 text-[11px] font-extrabold"
                    style={{ background: b.color + '22', color: b.color, border: `1px solid ${b.color}55` }}
                    title={b.mult > 1 ? `보상 ×${b.mult}${b.extra ? ` + 항목 ${b.extra}개 추가` : ''}` : `항목 ${b.extra}개 추가`}
                  >
                    {b.emoji} {b.label}
                    {n > 1 && ` ×${n}`}
                  </span>
                );
              })}
              {session.bulk > 0 && (
                <span className="crate-pop rounded-md bg-accent/20 px-2 py-1 text-[11px] font-extrabold text-accent" title="대량 개봉 보너스">
                  🎉 무료 +{session.bulk}개
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {session.items.map((item, i) => (
              <RewardCard key={i} item={item} index={i} cats={cats} shopNames={shop} />
            ))}
          </div>

          {session.milestones.length > 0 && (
            <p className="mt-2.5 text-[11px] font-bold text-accent">
              🏅 {session.milestones.map((m) => `${m.label} 달성 — ${shop.find((c) => c.level === m.level)?.name ?? `Lv${m.level} 상자`} ${m.count}개`).join(' · ')}
            </p>
          )}

          {session.discovered.length > 0 && (
            <p className="mt-2.5 text-[11px] text-accent">
              🎉 도감에 {session.discovered.length}종이 새로 등록됐습니다
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RewardCard({
  item,
  index,
  cats,
  shopNames,
}: {
  item: RewardItem;
  index: number;
  cats: { cat: string; emoji: string; name: string; values: number[] }[];
  shopNames: { level: number; emoji: string; name: string }[];
}) {
  const jp = item.jackpot ? JACKPOT_STYLE[item.jackpot] : null;
  // stagger — 카드가 한꺼번에 뜨지 않고 순서대로 튀어나온다(단, 40ms 씩이라 10장이 0.4초면 끝난다)
  const style: React.CSSProperties = { animationDelay: `${Math.min(index, 12) * 40}ms` };

  let emoji = '🪙';
  let label = `${fmtG(item.count)} G`;
  let color = '#fbbf24';

  if (item.kind === 'mat') {
    const c = cats.find((x) => x.cat === item.cat);
    emoji = c?.emoji ?? '❓';
    label = `Lv${item.level} ${c?.name ?? ''} ×${item.count}`;
    color = tierOf(item.level).color;
  } else if (item.kind === 'crate') {
    const c = shopNames.find((x) => x.level === item.level);
    emoji = c?.emoji ?? '📦';
    label = `${c?.name ?? `Lv${item.level} 상자`} ×${item.count}`;
    color = '#7ee787';
  }

  return (
    <div
      className={'crate-pop flex items-center gap-2 rounded-lg border px-2.5 py-1.5' + (jp ? ' crate-glow' : '')}
      style={{
        ...style,
        borderColor: jp ? jp.color : color + '66',
        background: (jp ? jp.color : color) + '14',
        ...(jp ? ({ '--glow': jp.glow } as React.CSSProperties) : {}),
      }}
    >
      <span className="text-lg leading-none">{emoji}</span>
      <span className="text-xs font-bold" style={{ color: jp ? jp.color : color }}>
        {label}
      </span>
      {jp && <span className="text-[10px] font-extrabold text-text">{jp.label}</span>}
    </div>
  );
}
