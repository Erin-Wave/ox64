import { useState } from 'react';
import { useDungeonStore } from './useDungeonStore';
import { HERO_COLORS } from './data';

/** 방 없음(생성/참가) 또는 방 상태(status='lobby', 영웅 선택+시작 대기) 화면. */
export default function Lobby() {
  const room = useDungeonStore((s) => s.room);
  if (!room) return <JoinScreen />;
  return <PartyScreen />;
}

function JoinScreen() {
  const create = useDungeonStore((s) => s.create);
  const join = useDungeonStore((s) => s.join);
  const busy = useDungeonStore((s) => s.busy);
  const error = useDungeonStore((s) => s.error);
  const stats = useDungeonStore((s) => s.stats);
  const [code, setCode] = useState('');

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {error && <p className="rounded-lg bg-downDim px-3 py-2 text-xs text-down">{error}</p>}

      <div className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="mb-3 text-sm font-bold">새 던전 시작</h2>
        <button
          onClick={() => create()}
          disabled={busy}
          className="w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-40"
        >
          방 만들기
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="mb-3 text-sm font-bold">친구 방 참가</h2>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={6}
            placeholder="방 코드 6자리"
            className="w-full rounded-lg bg-panel2 px-3.5 py-2.5 text-sm uppercase tracking-widest text-text outline-none ring-1 ring-border focus:ring-accent"
          />
          <button
            onClick={() => code.trim() && join(code.trim())}
            disabled={busy || code.trim().length < 4}
            className="shrink-0 rounded-lg bg-panel2 px-4 py-2.5 text-sm font-bold text-text hover:brightness-110 disabled:opacity-40"
          >
            참가
          </button>
        </div>
      </div>

      <p className="text-center text-[11px] text-muted">
        누적 {stats.gamesPlayed}판 · 클리어 {stats.wins}회
        {stats.bestClearMs != null && ` · 최단 ${(stats.bestClearMs / 1000).toFixed(1)}초`}
      </p>
    </div>
  );
}

function PartyScreen() {
  const room = useDungeonStore((s) => s.room)!;
  const players = useDungeonStore((s) => s.players);
  const heroes = useDungeonStore((s) => s.heroes);
  const myUserId = useDungeonStore((s) => s.myUserId);
  const chooseHero = useDungeonStore((s) => s.chooseHero);
  const start = useDungeonStore((s) => s.start);
  const leave = useDungeonStore((s) => s.leave);
  const busy = useDungeonStore((s) => s.busy);
  const error = useDungeonStore((s) => s.error);

  const isHost = room.hostUserId === myUserId;
  const takenHeroIds = new Set(players.filter((p) => p.userId !== myUserId).map((p) => p.heroId));
  const me = players.find((p) => p.userId === myUserId);
  const allReady = players.length > 0 && players.every((p) => p.heroId);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      {error && <p className="rounded-lg bg-downDim px-3 py-2 text-xs text-down">{error}</p>}

      <div className="flex items-center justify-between rounded-2xl border border-border bg-panel px-5 py-4">
        <div>
          <p className="text-[11px] text-muted">방 코드</p>
          <p className="text-2xl font-extrabold tracking-[0.3em]">{room.code}</p>
        </div>
        <button onClick={() => leave()} disabled={busy} className="text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-down">
          나가기
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="mb-3 text-sm font-bold">파티원 ({players.length}/4)</h2>
        <ul className="mb-4 flex flex-col gap-1.5">
          {players.map((p) => (
            <li key={p.userId} className="flex items-center justify-between rounded-lg bg-panel2 px-3 py-2 text-xs">
              <span className="font-bold">
                {p.name}
                {p.userId === room.hostUserId && <span className="ml-1.5 text-[10px] text-accent">방장</span>}
              </span>
              <span className="text-muted">{heroes.find((h) => h.id === p.heroId)?.name ?? '영웅 선택 중…'}</span>
            </li>
          ))}
        </ul>

        <h3 className="mb-2 text-xs font-bold text-muted">영웅 선택</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {heroes.map((h) => {
            const taken = takenHeroIds.has(h.id);
            const mine = me?.heroId === h.id;
            return (
              <button
                key={h.id}
                onClick={() => !taken && chooseHero(h.id)}
                disabled={busy || taken}
                className={
                  'flex flex-col gap-1 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed ' +
                  (mine ? 'border-accent bg-panel2' : taken ? 'border-border opacity-40' : 'border-border bg-panel2 hover:border-accent')
                }
              >
                <span className="text-sm font-extrabold" style={{ color: HERO_COLORS[h.id] }}>
                  {h.name}
                </span>
                <span className="text-[10px] text-muted">
                  주 {h.primary} · 보조 {h.secondary}
                </span>
                <span className="text-[10px] text-accent">{h.special.name}: {h.special.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {isHost && (
        <button
          onClick={() => start()}
          disabled={busy || !allReady}
          className="w-full rounded-lg bg-accent py-3 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-40"
        >
          {allReady ? '던전 시작 (5분 타이머 시작)' : '전원 영웅 선택 대기 중…'}
        </button>
      )}
      {!isHost && <p className="text-center text-xs text-muted">방장이 시작하기를 기다리는 중…</p>}
    </div>
  );
}
