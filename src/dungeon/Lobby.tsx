import { useState } from 'react';
import { useDungeonStore } from './useDungeonStore';
import Rules from './Rules';
import { DIFFICULTY_LABEL, HERO_COLORS, ICON_META, fmtClock } from './data';

/** 방 없음(생성/참가) 또는 방 상태(status='lobby', 던전·영웅 선택 + 시작 대기) 화면. */
export default function Lobby() {
  const room = useDungeonStore((s) => s.room);
  return room ? <PartyScreen /> : <JoinScreen />;
}

function ErrorBar() {
  const error = useDungeonStore((s) => s.error);
  const dismiss = useDungeonStore((s) => s.dismissError);
  if (!error) return null;
  return (
    <p className="flex items-center justify-between gap-3 rounded-lg bg-downDim px-3 py-2 text-xs text-down">
      <span>{error}</span>
      <button onClick={dismiss} className="shrink-0 opacity-70 hover:opacity-100">
        ✕
      </button>
    </p>
  );
}

function JoinScreen() {
  const create = useDungeonStore((s) => s.create);
  const join = useDungeonStore((s) => s.join);
  const busy = useDungeonStore((s) => s.busy);
  const stats = useDungeonStore((s) => s.stats);
  const [code, setCode] = useState('');

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <div className="text-center">
        <h1 className="text-2xl font-extrabold tracking-tight">5분 던전</h1>
        <p className="mt-1 text-xs text-muted">친구들과 함께 5분 안에 던전을 클리어하는 실시간 협동 카드게임</p>
      </div>

      <ErrorBar />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-panel p-5">
          <h2 className="text-sm font-bold">새로 시작하기</h2>
          <p className="mb-3 mt-1 text-[11px] leading-relaxed text-muted">
            방을 만들면 6자리 코드가 나옵니다. 그 코드를 친구에게 알려주면 같이 들어올 수 있어요(최대 4명, 혼자도 가능).
          </p>
          <button
            onClick={() => create()}
            disabled={busy}
            className="w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-40"
          >
            방 만들기
          </button>
        </div>

        <div className="rounded-2xl border border-border bg-panel p-5">
          <h2 className="text-sm font-bold">친구 방에 들어가기</h2>
          <p className="mb-3 mt-1 text-[11px] leading-relaxed text-muted">친구에게 받은 방 코드를 입력하세요.</p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && code.trim().length >= 4 && join(code.trim())}
              maxLength={6}
              placeholder="예: A7K2QX"
              className="w-full rounded-lg bg-panel2 px-3.5 py-2.5 text-center text-sm uppercase tracking-[0.3em] text-text outline-none ring-1 ring-border focus:ring-accent"
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
      </div>

      <Rules defaultOpen />

      <p className="text-center text-[11px] text-muted">
        지금까지 {stats.gamesPlayed}판 · 클리어 {stats.wins}회
        {stats.bestClearMs != null && ` · 최단 기록 ${fmtClock(stats.bestClearMs)}`}
      </p>
    </div>
  );
}

function PartyScreen() {
  const room = useDungeonStore((s) => s.room)!;
  const players = useDungeonStore((s) => s.players);
  const heroes = useDungeonStore((s) => s.heroes);
  const dungeons = useDungeonStore((s) => s.dungeons);
  const myUserId = useDungeonStore((s) => s.myUserId);
  const chooseHero = useDungeonStore((s) => s.chooseHero);
  const chooseDungeon = useDungeonStore((s) => s.chooseDungeon);
  const start = useDungeonStore((s) => s.start);
  const leave = useDungeonStore((s) => s.leave);
  const busy = useDungeonStore((s) => s.busy);
  const [copied, setCopied] = useState(false);

  const isHost = room.hostUserId === myUserId;
  const takenHeroIds = new Set(players.filter((p) => p.userId !== myUserId).map((p) => p.heroId).filter(Boolean));
  const me = players.find((p) => p.userId === myUserId);
  const allReady = players.length > 0 && players.every((p) => p.heroId);
  const dungeon = dungeons.find((d) => d.id === room.dungeonId);

  const copyCode = () => {
    navigator.clipboard?.writeText(room.code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <ErrorBar />

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-panel px-5 py-4">
        <div>
          <p className="text-[11px] text-muted">이 코드를 친구에게 알려주세요</p>
          <div className="flex items-center gap-2">
            <p className="text-2xl font-extrabold tracking-[0.3em]">{room.code}</p>
            <button
              onClick={copyCode}
              className="rounded-md bg-panel2 px-2 py-1 text-[11px] font-bold text-muted hover:text-text"
              title="방 코드 복사"
            >
              {copied ? '복사됨 ✓' : '복사'}
            </button>
          </div>
        </div>
        <button onClick={() => leave()} disabled={busy} className="shrink-0 text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-down">
          나가기
        </button>
      </div>

      {/* ── 던전 선택(방장만) ── */}
      <div className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="text-sm font-bold">던전 고르기</h2>
        <p className="mb-3 mt-1 text-[11px] text-muted">
          {isHost ? '방장이 고릅니다. 난이도가 높을수록 카드가 많고 요구치가 큽니다.' : '방장이 고르는 중입니다.'}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {dungeons.map((d) => {
            const active = d.id === room.dungeonId;
            return (
              <button
                key={d.id}
                onClick={() => isHost && chooseDungeon(d.id)}
                disabled={busy || !isHost}
                className={
                  'flex flex-col gap-1 rounded-xl border p-3.5 text-left transition disabled:cursor-not-allowed ' +
                  (active ? 'border-accent bg-panel2' : 'border-border bg-panel2/50 hover:border-accent disabled:hover:border-border')
                }
              >
                <span className="flex items-center justify-between text-sm font-extrabold">
                  {d.name}
                  <span className="text-[10px] font-bold text-accent">
                    {'★'.repeat(d.difficulty)}
                    <span className="opacity-30">{'★'.repeat(4 - d.difficulty)}</span>
                  </span>
                </span>
                <span className="text-[11px] leading-relaxed text-muted">{d.desc}</span>
                <span className="text-[10px] text-muted opacity-80">
                  {DIFFICULTY_LABEL[d.difficulty]} · 몬스터 {d.monsters} · 함정 {d.traps} · 포션 {d.potions} · 시작 체력 {d.startHp}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 영웅 선택 ── */}
      <div className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="text-sm font-bold">영웅 고르기</h2>
        <p className="mb-3 mt-1 text-[11px] text-muted">
          한 방에 같은 영웅은 한 명만 가능합니다. 파티 속성이 겹치지 않게 나눠 고르면 훨씬 수월합니다.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {heroes.map((h) => {
            const taken = takenHeroIds.has(h.id);
            const mine = me?.heroId === h.id;
            const owner = players.find((p) => p.heroId === h.id);
            return (
              <button
                key={h.id}
                onClick={() => !taken && chooseHero(h.id)}
                disabled={busy || taken}
                className={
                  'flex flex-col gap-1.5 rounded-xl border p-3.5 text-left transition disabled:cursor-not-allowed ' +
                  (mine ? 'border-accent bg-panel2' : taken ? 'border-border opacity-40' : 'border-border bg-panel2/50 hover:border-accent')
                }
              >
                <span className="flex items-center justify-between">
                  <span className="text-sm font-extrabold" style={{ color: HERO_COLORS[h.id] }}>
                    {h.name}
                  </span>
                  {mine && <span className="text-[10px] font-bold text-accent">내 영웅</span>}
                  {taken && <span className="text-[10px] text-muted">{owner?.name} 선택</span>}
                </span>
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span style={{ color: ICON_META[h.primary].color }}>
                    {ICON_META[h.primary].emoji} {ICON_META[h.primary].label}
                  </span>
                  <span className="text-muted opacity-50">+</span>
                  <span className="text-muted">
                    {ICON_META[h.secondary].emoji} {ICON_META[h.secondary].label}
                  </span>
                </span>
                <span className="text-[11px] leading-relaxed text-muted">{h.blurb}</span>
                <span className="text-[10px] leading-relaxed text-accent">
                  ✨ {h.special.name} — {h.special.desc}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 파티원 목록 ── */}
      <div className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="mb-2 text-sm font-bold">파티원 ({players.length}/4)</h2>
        <ul className="flex flex-col gap-1.5">
          {players.map((p) => {
            const hero = heroes.find((h) => h.id === p.heroId);
            return (
              <li key={p.userId} className="flex items-center justify-between rounded-lg bg-panel2 px-3 py-2 text-xs">
                <span className="font-bold">
                  {p.name}
                  {p.userId === room.hostUserId && <span className="ml-1.5 text-[10px] text-accent">방장</span>}
                  {p.userId === myUserId && <span className="ml-1.5 text-[10px] text-muted">(나)</span>}
                </span>
                {hero ? (
                  <span style={{ color: HERO_COLORS[hero.id] }}>{hero.name} ✓</span>
                ) : (
                  <span className="text-muted">영웅 고르는 중…</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {isHost ? (
        <button
          onClick={() => start()}
          disabled={busy || !allReady}
          className="w-full rounded-lg bg-accent py-3.5 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-40"
        >
          {allReady ? `«${dungeon?.name ?? '던전'}» 입장 — 누르면 5분 타이머 시작` : '모든 파티원이 영웅을 골라야 시작할 수 있어요'}
        </button>
      ) : (
        <p className="text-center text-xs text-muted">
          {allReady ? '방장이 시작하기를 기다리는 중…' : '아직 영웅을 안 고른 파티원이 있어요'}
        </p>
      )}

      <Rules />
    </div>
  );
}
