import { useState } from 'react';
import { useCrateStore } from './useCrateStore';
import { fmtG, tierOf } from './data';

/**
 * 도감 — 한 번이라도 얻어본 재료를 종류·레벨별로 기록한다(서버 `seen_json`).
 * 얻은 적 없는 칸은 실루엣으로만 보여줘 "이 위엔 뭐가 더 있나"를 알려준다(수집 동기).
 */
export default function Collection() {
  const cats = useCrateStore((s) => s.cats);
  const seen = useCrateStore((s) => s.seen);
  const inv = useCrateStore((s) => s.inv);
  const shardOdds = useCrateStore((s) => s.shardOdds);
  const shop = useCrateStore((s) => s.shop);
  const [open, setOpen] = useState(false);

  const seenSet = new Set(seen);
  const total = cats.reduce((s, c) => s + c.maxLevel, 0);
  const found = cats.reduce((s, c) => {
    let n = 0;
    for (let lv = 1; lv <= c.maxLevel; lv++) if (seenSet.has(`${c.cat}:${lv}`)) n++;
    return s + n;
  }, 0);

  return (
    <section className="rounded-2xl border border-border bg-panel p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-baseline justify-between text-left">
        <h2 className="text-sm font-bold">
          도감 <span className="ml-1.5 font-normal text-muted">{found}/{total}</span>
        </h2>
        <span className="text-[11px] text-muted">{open ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-2.5">
          {cats.map((c) => (
            <div key={c.cat}>
              <div className="mb-1 flex items-baseline gap-2 text-[11px]">
                <span className="text-sm leading-none">{c.emoji}</span>
                <span className="font-bold">{c.name}</span>
                <span className="text-muted">{c.desc}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: c.maxLevel }, (_, i) => {
                  const lv = i + 1;
                  const key = `${c.cat}:${lv}`;
                  const has = seenSet.has(key);
                  const owned = inv[key] ?? 0;
                  const tier = tierOf(lv);
                  return (
                    <div
                      key={key}
                      title={
                        has
                          ? `${c.name} Lv${lv} · ${fmtG(c.values[i])} G${owned ? ` · 보유 ${owned.toLocaleString()}개` : ''}`
                          : '아직 얻어본 적 없습니다'
                      }
                      className={
                        'flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg border text-sm transition ' +
                        (has ? '' : 'opacity-25 grayscale')
                      }
                      style={{ borderColor: tier.color + '66', background: tier.color + (has ? '18' : '08') }}
                    >
                      <span>{has ? c.emoji : '❔'}</span>
                      <span className="text-[9px] font-extrabold leading-none" style={{ color: tier.color }}>
                        Lv{lv}
                      </span>
                    </div>
                  );
                })}
                {c.cat === 'lotto' && (
                  <div className="ml-1 flex min-w-0 flex-1 items-center rounded-lg bg-panel2 px-2.5 py-1 text-[11px] leading-snug text-muted">
                    레벨도 없고 팔 수도 없습니다 — <b className="mx-1 text-text">긁는 것만</b> 가능(평균 2.6배)
                  </div>
                )}
                {c.cat === 'shard' && (
                  <div className="ml-1 flex min-w-0 flex-1 items-center rounded-lg bg-panel2 px-2.5 py-1 text-[11px] leading-snug text-muted">
                    Lv{c.maxLevel} 2개를 합치면 랜덤 상자 —{' '}
                    {shardOdds
                      .map((o) => `${shop.find((s) => s.level === o.level)?.name ?? `Lv${o.level}`} ${Math.round(o.p * 100)}%`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            </div>
          ))}
          <p className="text-[11px] leading-snug text-muted">
            같은 재료 2개를 합치면 레벨이 하나 오르고 <b className="text-text">가치는 2.25배</b>가 됩니다 — 종류(카테고리)는 절대
            바뀌지 않습니다. 상자만 까서 다 팔면 본전이 안 나오니, 끝까지 합쳐서 파는 게 유일한 흑자 경로입니다.
          </p>
        </div>
      )}
    </section>
  );
}
