import { useEffect } from 'react';
import Logo from '@/components/Logo';
import DungeonLogin from './DungeonLogin';
import Lobby from './Lobby';
import GameBoard from './GameBoard';
import { useDungeonStore } from './useDungeonStore';

export default function DungeonApp() {
  const init = useDungeonStore((s) => s.init);
  const ready = useDungeonStore((s) => s.ready);
  const authed = useDungeonStore((s) => s.authed);
  const startPolling = useDungeonStore((s) => s.startPolling);
  const stopPolling = useDungeonStore((s) => s.stopPolling);

  useEffect(() => {
    init();
  }, [init]);

  // 로그인된 동안엔 항상 1초 폴링 — 방 생성/참가/시작/카드 플레이 전부 이 폴링으로 파티원과 동기화된다
  // (Durable Objects/WebSocket 대신 기존 OX 마켓메이커와 동일한 "D1 + 1초 폴링" 패턴, CLAUDE.md 참고).
  useEffect(() => {
    if (authed) startPolling();
    else stopPolling();
    return () => stopPolling();
  }, [authed, startPolling, stopPolling]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-sm text-muted">
        <span className="animate-pulse">불러오는 중…</span>
      </div>
    );
  }
  if (!authed) return <DungeonLogin />;
  return <DungeonGame />;
}

function DungeonGame() {
  const room = useDungeonStore((s) => s.room);
  const logout = useDungeonStore((s) => s.logout);

  const inParty = room && room.status !== 'lobby';

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Logo className="h-5 w-auto text-text" />
          <span className="text-sm font-bold">5분 던전</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <a href="/" className="text-muted underline decoration-dotted underline-offset-2 hover:text-text">
            트레이딩
          </a>
          <button onClick={() => logout()} className="text-muted hover:text-text">
            로그아웃
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full flex-1 flex-col gap-4 px-4 py-5">{inParty ? <GameBoard /> : <Lobby />}</main>
    </div>
  );
}
