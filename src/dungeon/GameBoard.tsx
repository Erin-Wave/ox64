import { useEffect, useState } from 'react';
import { useDungeonStore } from './useDungeonStore';
import Card from './Card';
import { EVENT_TYPE_META, HERO_COLORS, reqKeyMeta } from './data';
import type { DungeonCard } from './api';

const MAX_HP_DISPLAY = 7;

function canContribute(icon: string, target: string): boolean {
  if (target === 'any') return true;
  return icon === target || icon === 'wild';
}

/** 진행 중(active)/종료(won·lost) 던전 화면 — 현재 카드 요구치, 파티 전원 손패(공개), 타이머. */
export default function GameBoard() {
  const room = useDungeonStore((s) => s.room)!;
  const players = useDungeonStore((s) => s.players);
  const myUserId = useDungeonStore((s) => s.myUserId);
  const heroes = useDungeonStore((s) => s.heroes);
  const playCard = useDungeonStore((s) => s.playCard);
  const rest = useDungeonStore((s) => s.rest);
  const useSpecial = useDungeonStore((s) => s.useSpecial);
  const leave = useDungeonStore((s) => s.leave);
  const busy = useDungeonStore((s) => s.busy);
  const error = useDungeonStore((s) => s.error);
  const toast = useDungeonStore((s) => s.toast);
  const dismissToast = useDungeonStore((s) => s.dismissToast);

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [pickingSpecial, setPickingSpecial] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismissToast, 2500);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const me = players.find((p) => p.userId === myUserId);
  const myHero = me ? heroes.find((h) => h.id === me.heroId) : undefined;
  const current = room.current;
  const remainingMs = room.endsAt != null ? Math.max(0, room.endsAt - Date.now()) : 0;
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);

  const validTargetsFor = (card: DungeonCard): string[] => {
    if (!current) return [];
    return Object.keys(current.req).filter((k) => {
      const need = (current.req[k] ?? 0) - (current.progress[k] ?? 0);
      return need > 0 && canContribute(card.icon, k);
    });
  };

  const submit = (cardId: string, targets: string[]) => {
    if (targets.length === 1) playCard(cardId, targets[0]);
    else setSelectedCardId((cur) => (cur === cardId ? null : cardId));
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {error && <p className="rounded-lg bg-downDim px-3 py-2 text-xs text-down">{error}</p>}

      <div className="flex items-center justify-between rounded-2xl border border-border bg-panel px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">방 {room.code}</span>
          <span className="flex gap-0.5" title={`파티 체력 ${room.hp}`}>
            {Array.from({ length: MAX_HP_DISPLAY }).map((_, i) => (
              <span key={i} className={i < room.hp ? 'text-down' : 'text-muted/30'}>
                ♥
              </span>
            ))}
          </span>
        </div>
        {room.status === 'active' ? (
          <span className={'font-mono text-lg font-extrabold tabular-nums ' + (remainingMs < 30000 ? 'text-down' : 'text-text')}>
            {mm}:{String(ss).padStart(2, '0')}
          </span>
        ) : (
          <button onClick={() => leave()} disabled={busy} className="text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-down">
            나가기
          </button>
        )}
      </div>

      {room.status !== 'active' && (
        <div className={'rounded-2xl border p-5 text-center ' + (room.status === 'won' ? 'border-up bg-up/10' : 'border-down bg-down/10')}>
          <p className={'text-xl font-extrabold ' + (room.status === 'won' ? 'text-up' : 'text-down')}>
            {room.status === 'won' ? '던전 클리어!' : '던전 실패…'}
          </p>
          <button onClick={() => leave()} disabled={busy} className="mt-3 rounded-lg bg-panel2 px-4 py-2 text-xs font-bold hover:brightness-110">
            로비로
          </button>
        </div>
      )}

      {current && (
        <div className="rounded-2xl border border-border bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-bold" style={{ color: EVENT_TYPE_META[current.type].color }}>
              [{EVENT_TYPE_META[current.type].label}] {current.name}
              {current.type === 'boss' && current.phase ? ` · 페이즈 ${current.phase}/2` : ''}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.keys(current.req).map((k) => {
              const need = current.req[k] ?? 0;
              const have = Math.min(current.progress[k] ?? 0, need);
              const meta = reqKeyMeta(k);
              return (
                <span key={k} className="flex items-center gap-1 rounded-full bg-panel2 px-2.5 py-1 text-xs font-bold" style={{ color: meta.color }}>
                  {meta.emoji} {have}/{need}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {players.map((p) => {
          const hero = heroes.find((h) => h.id === p.heroId);
          const isMe = p.userId === myUserId;
          return (
            <div key={p.userId} className={'rounded-xl border p-3 ' + (isMe ? 'border-accent bg-panel' : 'border-border bg-panel')}>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-bold" style={{ color: hero ? HERO_COLORS[hero.id] : undefined }}>
                  {p.name} · {hero?.name}
                  {p.exhausted && <span className="ml-1.5 text-[10px] text-down">지침</span>}
                </span>
                <span className="text-muted">
                  덱 {p.deckCount} · 버림 {p.discardCount}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {p.hand.map((card) => {
                  const targets = isMe && room.status === 'active' ? validTargetsFor(card) : [];
                  const clickable = isMe && room.status === 'active' && !busy && targets.length > 0;
                  return (
                    <Card
                      key={card.id}
                      card={card}
                      selected={selectedCardId === card.id}
                      disabled={card.special}
                      dim={isMe && room.status === 'active' && !card.special && targets.length === 0}
                      onClick={clickable ? () => submit(card.id, targets) : undefined}
                    />
                  );
                })}
              </div>
              {isMe && selectedCardId && p.hand.some((c) => c.id === selectedCardId) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {validTargetsFor(p.hand.find((c) => c.id === selectedCardId)!).map((k) => {
                    const meta = reqKeyMeta(k);
                    return (
                      <button
                        key={k}
                        onClick={() => {
                          playCard(selectedCardId, k);
                          setSelectedCardId(null);
                        }}
                        className="rounded-full bg-panel2 px-3 py-1 text-xs font-bold hover:brightness-110"
                        style={{ color: meta.color }}
                      >
                        {meta.emoji} 에 내기
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {me && room.status === 'active' && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => rest()}
            disabled={busy}
            className="rounded-lg bg-panel2 px-4 py-2 text-xs font-bold text-text hover:brightness-110 disabled:opacity-40"
          >
            휴식(손패 전체 교체)
          </button>
          {myHero && !me.usedSpecial && (
            <button
              onClick={() => {
                if (myHero.id === 'barbarian') setPickingSpecial((v) => !v);
                else useSpecial();
              }}
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-black hover:brightness-110 disabled:opacity-40"
              title={myHero.special.desc}
            >
              {myHero.special.name}
            </button>
          )}
          {pickingSpecial && current && (
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(current.req).map((k) => {
                const meta = reqKeyMeta(k);
                return (
                  <button
                    key={k}
                    onClick={() => {
                      useSpecial(k);
                      setPickingSpecial(false);
                    }}
                    className="rounded-full bg-panel2 px-3 py-1 text-xs font-bold hover:brightness-110"
                    style={{ color: meta.color }}
                  >
                    {meta.emoji} 에 3 기여
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div
          className={
            'pointer-events-none fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-bold shadow-xl ' +
            (toast.kind === 'win' ? 'bg-up text-black' : toast.kind === 'lose' ? 'bg-down text-white' : 'bg-elevated text-text ring-1 ring-border')
          }
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
