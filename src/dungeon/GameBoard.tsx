import { useEffect, useMemo, useState } from 'react';
import { useDungeonStore } from './useDungeonStore';
import Card from './Card';
import EventLog from './EventLog';
import { IconLegend } from './Rules';
import { EVENT_TYPE_META, HERO_COLORS, canContribute, fmtClock, planAutoPlay, remainingReq, reqKeyMeta } from './data';
import type { DungeonCard } from './api';

/** 진행 중(active)/종료(won·lost) 던전 화면. */
export default function GameBoard() {
  const room = useDungeonStore((s) => s.room)!;
  const players = useDungeonStore((s) => s.players);
  const myUserId = useDungeonStore((s) => s.myUserId);
  const heroes = useDungeonStore((s) => s.heroes);
  const dungeons = useDungeonStore((s) => s.dungeons);
  const handLimit = useDungeonStore((s) => s.handLimit);
  const playCard = useDungeonStore((s) => s.playCard);
  const autoPlay = useDungeonStore((s) => s.autoPlay);
  const rest = useDungeonStore((s) => s.rest);
  const useSpecial = useDungeonStore((s) => s.useSpecial);
  const leave = useDungeonStore((s) => s.leave);
  const busy = useDungeonStore((s) => s.busy);
  const error = useDungeonStore((s) => s.error);
  const dismissError = useDungeonStore((s) => s.dismissError);
  const toast = useDungeonStore((s) => s.toast);
  const dismissToast = useDungeonStore((s) => s.dismissToast);

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [pickingSpecial, setPickingSpecial] = useState(false);
  const [, forceTick] = useState(0);

  // 남은 시간은 서버가 준 endsAt 을 기준으로 로컬에서만 흘려보낸다(폴링과 무관하게 매끄럽게).
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismissToast, 3000);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);
  // 다른 카드로 넘어가면 선택 상태를 비운다(이전 카드 기준으로 고른 타깃이 남지 않게).
  useEffect(() => {
    setSelectedCardId(null);
    setPickingSpecial(false);
  }, [room.current?.key, room.current?.phase]);

  const me = players.find((p) => p.userId === myUserId);
  const myHero = me ? heroes.find((h) => h.id === me.heroId) : undefined;
  const dungeon = dungeons.find((d) => d.id === room.dungeonId);
  const current = room.current;
  const active = room.status === 'active';
  const remainingMs = room.endsAt != null ? Math.max(0, room.endsAt - Date.now()) : 0;
  const timePct = room.runMs ? (remainingMs / room.runMs) * 100 : 0;
  const progressPct = room.totalEvents ? (room.cleared / room.totalEvents) * 100 : 0;

  const validTargetsFor = (card: DungeonCard): string[] => {
    if (!current || !active || card.special) return [];
    return Object.keys(remainingReq(current.req, current.progress)).filter((k) => canContribute(card.icon, k));
  };
  const autoPlan = useMemo(
    () => (current && me && active ? planAutoPlay(me.hand, current.req, current.progress) : []),
    [current, me, active],
  );

  const onCardClick = (card: DungeonCard) => {
    const targets = validTargetsFor(card);
    if (targets.length === 1) {
      playCard(card.id, targets[0]);
      setSelectedCardId(null);
    } else if (targets.length > 1) {
      setSelectedCardId((cur) => (cur === card.id ? null : card.id));
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {error && (
        <p className="flex items-center justify-between gap-3 rounded-lg bg-downDim px-3 py-2 text-xs text-down">
          <span>{error}</span>
          <button onClick={dismissError} className="shrink-0 opacity-70 hover:opacity-100">
            ✕
          </button>
        </p>
      )}

      {/* ── 상단 상태바: 던전 진행도 · 체력 · 타이머 ── */}
      <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-panel px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{dungeon?.name ?? '던전'}</p>
            <p className="text-[11px] text-muted">
              방 {room.code} · 진행 {room.cleared}/{room.totalEvents}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-0.5 text-sm" title={`파티 체력 ${room.hp} / ${room.maxHp}`}>
              {Array.from({ length: Math.max(room.maxHp, room.hp) }).map((_, i) => (
                <span key={i} className={i < room.hp ? 'text-down' : 'text-muted/25'}>
                  {i < room.hp ? '♥' : '♡'}
                </span>
              ))}
            </span>
            {room.ward > 0 && (
              <span className="text-sm text-accent" title="다음 함정을 무효화합니다(팔라딘의 수호의 방벽)">
                🛡️{room.ward > 1 ? `×${room.ward}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* 진행도 막대 */}
        <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progressPct}%` }} />
        </div>

        {active ? (
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2">
              <div
                className={'h-full rounded-full transition-all duration-200 ' + (remainingMs < 30000 ? 'bg-down' : 'bg-up')}
                style={{ width: `${timePct}%` }}
              />
            </div>
            <span className={'font-mono text-lg font-extrabold tabular-nums ' + (remainingMs < 30000 ? 'text-down' : 'text-text')}>
              {fmtClock(remainingMs)}
            </span>
          </div>
        ) : (
          <ResultPanel />
        )}
      </div>

      {/* ── 현재 카드 ── */}
      {current && active && (
        <div className="rounded-2xl border border-border bg-panel p-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-lg">{EVENT_TYPE_META[current.type].emoji}</span>
            <span className="text-base font-extrabold" style={{ color: EVENT_TYPE_META[current.type].color }}>
              {current.name}
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={{ backgroundColor: `${EVENT_TYPE_META[current.type].color}22`, color: EVENT_TYPE_META[current.type].color }}
            >
              {EVENT_TYPE_META[current.type].label}
              {current.type === 'boss' && current.phase ? ` ${current.phase}/2` : ''}
            </span>
            {current.heal != null && <span className="text-[11px] text-up">격파 시 체력 +{current.heal}</span>}
          </div>
          <p className="mb-3 text-[11px] text-muted">{EVENT_TYPE_META[current.type].hint}</p>

          <p className="mb-1.5 text-[11px] font-bold text-muted">이만큼 채우면 격파합니다</p>
          <div className="flex flex-wrap gap-2">
            {Object.keys(current.req).map((k) => {
              const need = current.req[k] ?? 0;
              const have = Math.min(current.progress[k] ?? 0, need);
              const meta = reqKeyMeta(k);
              const done = have >= need;
              return (
                <div
                  key={k}
                  className={'flex min-w-[5.5rem] flex-col gap-1 rounded-lg px-2.5 py-1.5 ring-1 ring-inset ' + (done ? 'ring-up/40' : 'ring-border')}
                  style={{ backgroundColor: `${meta.color}18` }}
                >
                  <span className="flex items-center justify-between text-xs font-bold" style={{ color: meta.color }}>
                    <span>
                      {meta.emoji} {meta.label}
                    </span>
                    <span className="tabular-nums">
                      {have}/{need}
                    </span>
                  </span>
                  <span className="h-1 overflow-hidden rounded-full bg-black/25">
                    <span
                      className="block h-full rounded-full transition-all duration-200"
                      style={{ width: `${need ? (have / need) * 100 : 100}%`, backgroundColor: meta.color }}
                    />
                  </span>
                </div>
              );
            })}
          </div>

          {current.type === 'boss' && current.phase === 1 && current.req2 && (
            <p className="mt-2.5 text-[11px] text-muted">
              ⚠ 2페이즈 예고:{' '}
              {Object.keys(current.req2).map((k) => {
                const meta = reqKeyMeta(k);
                return (
                  <span key={k} className="mr-2" style={{ color: meta.color }}>
                    {meta.emoji} {current.req2![k]}
                  </span>
                );
              })}
            </p>
          )}
        </div>
      )}

      {/* ── 내 손패 + 행동 ── */}
      {me && (
        <div className="rounded-2xl border border-accent/40 bg-panel p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold" style={{ color: myHero ? HERO_COLORS[myHero.id] : undefined }}>
              내 손패 · {myHero?.name}
              {me.exhausted && (
                <span className="ml-2 text-[10px] text-down" title="손패도 덱도 버림더미도 모두 비었습니다">
                  지침
                </span>
              )}
            </span>
            <span className="text-[11px] text-muted" title="남은 덱 / 버림더미 — 덱이 떨어지면 버림더미를 다시 섞어 씁니다">
              손패 {me.hand.length}/{handLimit} · 덱 {me.deckCount} · 버림 {me.discardCount}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {me.hand.length === 0 && <p className="py-3 text-xs text-muted">손패가 없습니다. 휴식으로 다시 뽑으세요.</p>}
            {me.hand.map((card) => {
              const targets = validTargetsFor(card);
              return (
                <Card
                  key={card.id}
                  card={card}
                  selected={selectedCardId === card.id}
                  dim={active && !card.special && targets.length === 0}
                  onClick={active && !busy && targets.length > 0 ? () => onCardClick(card) : undefined}
                />
              );
            })}
          </div>

          {/* 여러 항목에 낼 수 있는 카드는 어디에 낼지 고른다 */}
          {selectedCardId && current && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">어디에 낼까요?</span>
              {validTargetsFor(me.hand.find((c) => c.id === selectedCardId) ?? ({} as DungeonCard)).map((k) => {
                const meta = reqKeyMeta(k);
                return (
                  <button
                    key={k}
                    onClick={() => {
                      playCard(selectedCardId, k);
                      setSelectedCardId(null);
                    }}
                    className="rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset ring-border hover:brightness-125"
                    style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
                  >
                    {meta.emoji} {meta.label}
                  </button>
                );
              })}
            </div>
          )}

          {active && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => autoPlay()}
                disabled={busy || autoPlan.length === 0}
                title="지금 요구치에 쓸 수 있는 카드를 한 번에 다 냅니다"
                className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-black hover:brightness-110 disabled:opacity-40"
              >
                전부 내기{autoPlan.length > 0 ? ` (${autoPlan.length}장)` : ''}
              </button>
              <button
                onClick={() => rest()}
                disabled={busy}
                title="손패를 전부 버리고 상한까지 새로 뽑습니다(횟수 제한 없음)"
                className="rounded-lg bg-panel2 px-4 py-2 text-xs font-bold text-text hover:brightness-110 disabled:opacity-40"
              >
                휴식
              </button>
              {myHero &&
                (me.usedSpecial ? (
                  <span className="text-[11px] text-muted">✨ {myHero.special.name} (사용함)</span>
                ) : (
                  <button
                    onClick={() => {
                      if (myHero.id === 'barbarian') setPickingSpecial((v) => !v);
                      else useSpecial();
                    }}
                    disabled={busy}
                    title={myHero.special.desc}
                    className="rounded-lg bg-panel2 px-4 py-2 text-xs font-bold text-accent ring-1 ring-inset ring-accent/40 hover:brightness-125 disabled:opacity-40"
                  >
                    ✨ {myHero.special.name}
                  </button>
                ))}
              {pickingSpecial && current && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted">어디에 3을 넣을까요?</span>
                  {Object.keys(current.req).map((k) => {
                    const meta = reqKeyMeta(k);
                    return (
                      <button
                        key={k}
                        onClick={() => {
                          useSpecial(k);
                          setPickingSpecial(false);
                        }}
                        className="rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset ring-border hover:brightness-125"
                        style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
                      >
                        {meta.emoji} {meta.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {active && <div className="mt-2.5 border-t border-border pt-2"><IconLegend compact /></div>}
        </div>
      )}

      {/* ── 다른 파티원(손패 공개) ── */}
      {players.filter((p) => p.userId !== myUserId).length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-bold text-muted">파티원 손패 (모두에게 공개됩니다)</p>
          {players
            .filter((p) => p.userId !== myUserId)
            .map((p) => {
              const hero = heroes.find((h) => h.id === p.heroId);
              return (
                <div key={p.userId} className="rounded-xl border border-border bg-panel p-3">
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="font-bold" style={{ color: hero ? HERO_COLORS[hero.id] : undefined }}>
                      {p.name} · {hero?.name}
                      {p.exhausted && <span className="ml-1.5 text-down">지침</span>}
                      {!p.usedSpecial && hero && <span className="ml-1.5 text-accent opacity-70">✨</span>}
                    </span>
                    <span className="text-muted">
                      덱 {p.deckCount} · 버림 {p.discardCount}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {p.hand.map((card) => (
                      <Card key={card.id} card={card} size="sm" />
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      <EventLog log={room.log} />

      {toast && (
        <div
          className={
            'pointer-events-none fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-bold shadow-xl ' +
            (toast.kind === 'win' ? 'bg-up text-black' : toast.kind === 'lose' ? 'bg-down text-white' : 'bg-elevated text-text ring-1 ring-border')
          }
        >
          {toast.text}
        </div>
      )}
    </div>
  );

  /** 승/패 결과 + 파티원별 기여도. */
  function ResultPanel() {
    const won = room.status === 'won';
    const elapsed = room.startedAt ? Date.now() - room.startedAt : 0;
    const sorted = [...players].sort((a, b) => b.contributed - a.contributed);
    const top = sorted[0]?.contributed ?? 0;
    return (
      <div className="flex flex-col gap-3 pt-1">
        <div className="text-center">
          <p className={'text-xl font-extrabold ' + (won ? 'text-up' : 'text-down')}>{won ? '🎉 던전 클리어!' : '💀 던전 실패…'}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {won ? `클리어까지 ${fmtClock(elapsed)} · 진행 ${room.cleared}/${room.totalEvents}` : `진행 ${room.cleared}/${room.totalEvents} 에서 멈췄습니다`}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          {sorted.map((p) => {
            const hero = heroes.find((h) => h.id === p.heroId);
            return (
              <div key={p.userId} className="flex items-center gap-2 text-[11px]">
                <span className="w-24 shrink-0 truncate font-bold" style={{ color: hero ? HERO_COLORS[hero.id] : undefined }}>
                  {p.name}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel2">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${top > 0 ? (p.contributed / top) * 100 : 0}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted">기여 {p.contributed}</span>
              </div>
            );
          })}
        </div>
        <button
          onClick={() => leave()}
          disabled={busy}
          className="mx-auto rounded-lg bg-accent px-5 py-2 text-xs font-bold text-black hover:brightness-110 disabled:opacity-40"
        >
          로비로 돌아가기
        </button>
      </div>
    );
  }
}
