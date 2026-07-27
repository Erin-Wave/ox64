import { useCallback, useEffect, useRef, useState } from 'react';
import Logo from '@/components/Logo';
import { Game } from './game';
import { AI } from './ai';
import { renderGame, renderMinimap, type Camera, type Ghost } from './render';
import Hud, { type HudSel } from './Hud';
import { BUILDINGS, BUILD_ORDER, UNITS } from './data';
import { PLAYER, TILE, WORLD_H, WORLD_W, type Entity } from './types';

const MINIMAP = 168;
const EDGE = 26; // 화면 가장자리 스크롤 폭(px)
const CAM_SPEED = 900; // px/초

/** 전적은 서버가 아니라 localStorage 에 둔다 — 시뮬레이션이 통째로 클라이언트에 있어서
 * 서버에 기록해봐야 얼마든지 위조할 수 있고, 그러면 트레이딩 잔고 같은 "진짜 서버 권위"
 * 기록 옆에 가짜 권위 기록이 하나 생길 뿐이다. */
const RECORD_KEY = 'ox64_s1_record';
function loadRecord(): { win: number; lose: number } {
  try {
    return { win: 0, lose: 0, ...(JSON.parse(localStorage.getItem(RECORD_KEY) ?? '{}') as object) };
  } catch {
    return { win: 0, lose: 0 };
  }
}

export default function ScApp() {
  const [started, setStarted] = useState(false);
  const [record, setRecord] = useState(loadRecord);
  const [seed, setSeed] = useState(0); // 재시작할 때마다 Match 를 새로 마운트

  if (!started) return <Menu record={record} onStart={() => setStarted(true)} />;
  return (
    <Match
      key={seed}
      onExit={(result) => {
        if (result) {
          const next = { ...loadRecord() };
          if (result === 'won') next.win++;
          else next.lose++;
          localStorage.setItem(RECORD_KEY, JSON.stringify(next));
          setRecord(next);
        }
        setStarted(false);
      }}
      onRestart={() => setSeed((s) => s + 1)}
    />
  );
}

function Menu({ record, onStart }: { record: { win: number; lose: number }; onStart: () => void }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Logo className="h-5 w-auto text-text" />
          <span className="text-sm font-bold">미니 RTS</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <a href="/5m" className="text-muted underline decoration-dotted underline-offset-2 hover:text-text">
            5분 던전
          </a>
          <a href="/b" className="text-muted underline decoration-dotted underline-offset-2 hover:text-text">
            보석찾기
          </a>
          <a href="/" className="text-muted underline decoration-dotted underline-offset-2 hover:text-text">
            트레이딩
          </a>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8">
        <div className="text-center">
          <h1 className="text-3xl font-extrabold tracking-tight">미니 RTS</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            자원을 캐고 기지를 올려 상대를 무너뜨리는 실시간 전략 게임. 컴퓨터와 1:1로 붙습니다.
            <br />
            전부 브라우저에서 돌아가고 로그인도 필요 없습니다.
          </p>
        </div>

        <button
          onClick={onStart}
          className="w-full rounded-lg bg-accent py-3.5 text-sm font-bold text-black transition hover:brightness-110"
        >
          게임 시작
        </button>
        <p className="text-center text-[11px] text-muted">
          전적 {record.win}승 {record.lose}패
        </p>

        <div className="rounded-2xl border border-border bg-panel p-5 text-xs leading-relaxed text-muted">
          <h2 className="mb-2 text-sm font-bold text-text">조작</h2>
          <ul className="flex flex-col gap-1">
            <li>
              <b className="text-text">좌클릭 / 드래그</b> — 선택 (Shift 로 추가, 같은 유닛 더블클릭이면 화면 안 전부)
            </li>
            <li>
              <b className="text-text">우클릭</b> — 상황에 맞는 명령 (빈 땅=이동, 적=공격, 미네랄=채집, 건물 선택 중이면 랠리)
            </li>
            <li>
              <b className="text-text">A</b> 공격 이동 · <b className="text-text">S</b> 정지 · <b className="text-text">H</b> 사수 ·{' '}
              <b className="text-text">B</b> 건설 메뉴 · <b className="text-text">Esc</b> 취소
            </li>
            <li>
              <b className="text-text">방향키 / 화면 가장자리 / 미니맵</b> — 화면 이동 (알파벳은 전부 명령 단축키라 WASD 는 쓰지
              않습니다)
            </li>
            <li>
              <b className="text-text">Ctrl+1~9</b> 부대 지정 · <b className="text-text">1~9</b> 부대 선택
            </li>
          </ul>

          <h2 className="mb-2 mt-4 text-sm font-bold text-text">이기는 법</h2>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            <li>커맨드 센터에서 일꾼을 계속 뽑아 미네랄에 붙입니다(일꾼이 곧 수입입니다).</li>
            <li>인구가 막히기 전에 서플라이 디팟을 짓습니다.</li>
            <li>배럭을 지어 마린을 모으고, 리파이너리로 가스를 캐 파이어뱃·시즈탱크로 넘어갑니다.</li>
            <li>상대 기지의 건물을 전부 부수면 승리입니다.</li>
          </ol>
          <p className="mt-3 text-[11px] opacity-70">
            ※ 블리자드의 원본 리소스는 전혀 쓰지 않았습니다. 그래픽은 전부 코드로 그렸고, 유닛 구성과 수치도 이 프로젝트에서
            새로 잡은 오리지널입니다.
          </p>
        </div>
      </main>
    </div>
  );
}

function Match({ onExit, onRestart }: { onExit: (r: 'won' | 'lost' | null) => void; onRestart: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // ⚠ 게임 상태는 전부 ref 에 둔다 — 매 프레임 돌아가는 루프가 React state 를 읽으면 클로저가
  // 낡고, state 를 쓰면 초당 60번 리렌더가 난다. React 는 HUD 표시에만 쓰고(아래 8Hz 스냅샷),
  // 시뮬레이션/입력은 전부 ref 로 처리한다.
  const gameRef = useRef<Game | null>(null);
  const aiRef = useRef(new AI());
  const camRef = useRef<Camera>({ x: 0, y: 0 });
  const keysRef = useRef(new Set<string>());
  const mouseRef = useRef({ x: 0, y: 0, inside: false });
  const dragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const placingRef = useRef<string | null>(null);
  const attackModeRef = useRef(false);
  const groupsRef = useRef<Map<string, number[]>>(new Map());
  const minimapDragRef = useRef(false);
  const lastClickRef = useRef({ t: 0, id: -1 });
  const noticeRef = useRef<{ text: string; until: number } | null>(null);

  const [hud, setHud] = useState({
    minerals: 0,
    gas: 0,
    supplyUsed: 0,
    supplyMax: 0,
    elapsed: 0,
    sel: { ids: [], groups: [], primary: null, hasWorker: false, ownUnits: false } as HudSel,
    buildMenu: false,
    placing: null as string | null,
    attackMode: false,
    notice: null as string | null,
    status: 'playing' as 'playing' | 'won' | 'lost',
  });
  const [buildMenu, setBuildMenu] = useState(false);
  const buildMenuRef = useRef(false);
  buildMenuRef.current = buildMenu;

  if (!gameRef.current) {
    const g = new Game();
    gameRef.current = g;
    const b = g.map.bases[PLAYER];
    camRef.current = { x: (b.bx + 2) * TILE - 500, y: (b.by + 1) * TILE - 300 };
  }

  const notify = useCallback((text: string) => {
    noticeRef.current = { text, until: performance.now() + 2200 };
  }, []);

  const clampCam = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const vw = c.clientWidth;
    const vh = c.clientHeight;
    camRef.current.x = Math.max(0, Math.min(camRef.current.x, WORLD_W - vw));
    camRef.current.y = Math.max(0, Math.min(camRef.current.y, WORLD_H - vh));
  }, []);

  const centerOn = useCallback(
    (wx: number, wy: number) => {
      const c = canvasRef.current;
      if (!c) return;
      camRef.current.x = wx - c.clientWidth / 2;
      camRef.current.y = wy - c.clientHeight / 2;
      clampCam();
    },
    [clampCam],
  );

  // ── 메인 루프 ────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let hudAcc = 0;
    let mapAcc = 0;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dtMs = Math.min(now - prev, 200);
      prev = now;
      const g = gameRef.current;
      const canvas = canvasRef.current;
      if (!g || !canvas) return;

      // 캔버스 크기 동기화(레이아웃 변화/DPR 대응)
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 카메라 이동(키 + 화면 가장자리)
      const dt = dtMs / 1000;
      const k = keysRef.current;
      let dx = 0;
      let dy = 0;
      // ⚠ 카메라는 **방향키만** 쓴다(WASD 아님) — A=공격, S=정지/일꾼, D=디팟, B=건설처럼
      // 알파벳은 전부 명령 단축키라서 WASD 를 카메라에 주면 명령을 누를 때마다 화면이 밀린다.
      // 원작도 화면 이동은 방향키·미니맵·화면 가장자리다.
      if (k.has('arrowleft')) dx -= 1;
      if (k.has('arrowright')) dx += 1;
      if (k.has('arrowup')) dy -= 1;
      if (k.has('arrowdown')) dy += 1;
      if (mouseRef.current.inside && !dragRef.current) {
        if (mouseRef.current.x < EDGE) dx -= 1;
        else if (mouseRef.current.x > cw - EDGE) dx += 1;
        if (mouseRef.current.y < EDGE) dy -= 1;
        else if (mouseRef.current.y > ch - EDGE) dy += 1;
      }
      if (dx || dy) {
        camRef.current.x += dx * CAM_SPEED * dt;
        camRef.current.y += dy * CAM_SPEED * dt;
        clampCam();
      }

      if (g.status === 'playing') {
        g.update(dtMs, () => aiRef.current.update(g, 1 / 30));
        if (g.notice) {
          notify(g.notice);
          g.notice = '';
        }
      }

      // 건물 배치 미리보기 위치
      let ghost: Ghost | null = null;
      if (placingRef.current) {
        const s = BUILDINGS[placingRef.current];
        const wx = camRef.current.x + mouseRef.current.x;
        const wy = camRef.current.y + mouseRef.current.y;
        const bx = Math.round(wx / TILE - s.w / 2);
        const by = Math.round(wy / TILE - s.h / 2);
        ghost = { type: placingRef.current, bx, by, ok: g.canPlace(placingRef.current, bx, by, PLAYER) };
      }

      renderGame(ctx, g, { camera: camRef.current, vw: cw, vh: ch, dragBox: dragRef.current, ghost });

      // 미니맵은 매 프레임 그리지 않는다 — 타일 64×64 를 칠하는 작업이라 60fps 로 돌리면
      // 그것만으로 프레임을 깎아먹는다(10Hz 면 체감상 충분히 실시간이다).
      mapAcc += dtMs;
      if (mapAcc >= 100) {
        mapAcc = 0;
        const mm = minimapRef.current;
        const mctx = mm?.getContext('2d');
        if (mm && mctx) {
          mctx.clearRect(0, 0, MINIMAP, MINIMAP);
          renderMinimap(mctx, g, camRef.current, cw, ch, MINIMAP);
        }
      }

      // HUD 는 8Hz 로만 갱신(매 프레임 setState 하면 그것만으로 프레임이 깎인다)
      hudAcc += dtMs;
      if (hudAcc >= 125) {
        hudAcc = 0;
        const p = g.players[PLAYER];
        const n = noticeRef.current;
        setHud({
          minerals: Math.floor(p.minerals),
          gas: Math.floor(p.gas),
          supplyUsed: p.supplyUsed,
          supplyMax: p.supplyMax,
          elapsed: g.elapsed,
          sel: summarize(g),
          buildMenu: buildMenuRef.current,
          placing: placingRef.current,
          attackMode: attackModeRef.current,
          notice: n && n.until > performance.now() ? n.text : null,
          status: g.status,
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clampCam, notify]);

  // ── 키보드 ──────────────────────────────────────────────────
  useEffect(() => {
    const cancelModes = () => {
      placingRef.current = null;
      attackModeRef.current = false;
      setBuildMenu(false);
    };
    const down = (e: KeyboardEvent) => {
      const g = gameRef.current;
      if (!g) return;
      const key = e.key.toLowerCase();
      if (e.target instanceof HTMLInputElement) return;

      // 부대 지정/선택
      if (/^[1-9]$/.test(key)) {
        if (e.ctrlKey || e.metaKey) {
          groupsRef.current.set(key, [...g.selection]);
          notify(`${key}번 부대 지정 (${g.selection.length})`);
        } else {
          const ids = (groupsRef.current.get(key) ?? []).filter((id) => g.byId.has(id));
          if (ids.length) {
            g.selection = ids;
            const first = g.byId.get(ids[0]);
            if (first) centerOn(first.x, first.y);
          }
        }
        e.preventDefault();
        return;
      }

      if (key.startsWith('arrow')) keysRef.current.add(key);
      if (key === 'escape') {
        cancelModes();
        return;
      }
      // 건설 메뉴가 열려 있으면 알파벳은 건물 단축키로 쓴다
      if (buildMenuRef.current) {
        const t = BUILD_ORDER.find((b) => BUILDINGS[b].hotkey.toLowerCase() === key);
        if (t) {
          startPlacing(t);
          e.preventDefault();
          return;
        }
      }
      if (key === 'b' && selectedWorkers(g).length > 0) {
        setBuildMenu(true);
        return;
      }
      // 선택한 건물에서 유닛 뽑기 단축키
      const b = g.selection.map((id) => g.byId.get(id)).find((x) => x?.kind === 'building' && x.owner === PLAYER);
      if (b) {
        const prod = BUILDINGS[b.type]?.produces ?? [];
        const t = prod.find((u) => UNITS[u].hotkey.toLowerCase() === key);
        if (t) {
          const err = g.train(b, t);
          if (err) notify(err);
          return;
        }
      }
      if (key === 'a') attackModeRef.current = true;
      if (key === 's') for (const u of ownSelectedUnits(g)) g.orderStop(u);
      if (key === 'h') for (const u of ownSelectedUnits(g)) g.orderHold(u);
    };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
    const blur = () => keysRef.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerOn, notify]);

  const startPlacing = (type: string) => {
    const g = gameRef.current!;
    if (selectedWorkers(g).length === 0) {
      notify('일꾼을 먼저 선택하세요');
      return;
    }
    const s = BUILDINGS[type];
    if (!g.canAfford(PLAYER, s.costM, s.costG)) {
      notify('자원이 부족합니다');
      return;
    }
    if (s.requires && !g.hasBuilding(PLAYER, s.requires)) {
      notify(`${BUILDINGS[s.requires].name}가 먼저 필요합니다`);
      return;
    }
    placingRef.current = type;
    attackModeRef.current = false;
  };

  // ── 마우스 ──────────────────────────────────────────────────
  const toWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    return { sx, sy, wx: camRef.current.x + sx, wy: camRef.current.y + sy };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gameRef.current;
    if (!g || g.status !== 'playing') return;
    const { sx, sy, wx, wy } = toWorld(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 2) {
      // 우클릭 — 모드 취소가 최우선, 아니면 명령
      if (placingRef.current || attackModeRef.current) {
        placingRef.current = null;
        attackModeRef.current = false;
        setBuildMenu(false);
        return;
      }
      const target = g.entityAt(wx, wy);
      g.commandRight(g.selection, wx, wy, target);
      return;
    }
    if (e.button !== 0) return;

    if (placingRef.current) {
      const type = placingRef.current;
      const s = BUILDINGS[type];
      const bx = Math.round(wx / TILE - s.w / 2);
      const by = Math.round(wy / TILE - s.h / 2);
      if (!g.canPlace(type, bx, by, PLAYER)) {
        notify('그 자리에는 지을 수 없습니다');
        return;
      }
      const workers = selectedWorkers(g);
      if (workers.length === 0) {
        notify('일꾼을 먼저 선택하세요');
        return;
      }
      g.orderBuild(workers[0], type, bx, by);
      if (!e.shiftKey) {
        placingRef.current = null;
        setBuildMenu(false);
      }
      return;
    }

    if (attackModeRef.current) {
      const target = g.entityAt(wx, wy);
      for (const u of ownSelectedUnits(g)) {
        if (target && target.owner !== PLAYER && target.kind !== 'resource') g.orderAttack(u, target);
        else g.orderMove(u, wx, wy, true);
      }
      attackModeRef.current = false;
      return;
    }

    dragRef.current = { x1: sx, y1: sy, x2: sx, y2: sy };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    mouseRef.current.x = e.clientX - r.left;
    mouseRef.current.y = e.clientY - r.top;
    mouseRef.current.inside = true;
    if (dragRef.current) {
      dragRef.current.x2 = mouseRef.current.x;
      dragRef.current.y2 = mouseRef.current.y;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gameRef.current;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!g || !drag || e.button !== 0) return;
    const cam = camRef.current;
    const w = Math.abs(drag.x2 - drag.x1);
    const h = Math.abs(drag.y2 - drag.y1);
    const add = e.shiftKey;

    if (w < 5 && h < 5) {
      // 클릭 한 번 — 더블클릭이면 화면 안의 같은 종류를 전부 잡는다(원작 감각)
      const ent = g.entityAt(cam.x + drag.x1, cam.y + drag.y1);
      if (!ent) {
        if (!add) g.selection = [];
        return;
      }
      const now = performance.now();
      const isDouble = now - lastClickRef.current.t < 320 && lastClickRef.current.id === ent.id;
      lastClickRef.current = { t: now, id: ent.id };
      if (isDouble && ent.owner === PLAYER && ent.kind === 'unit') {
        const c = e.currentTarget;
        g.selection = g.entities
          .filter(
            (x) =>
              x.owner === PLAYER &&
              x.type === ent.type &&
              x.x >= cam.x &&
              x.x <= cam.x + c.clientWidth &&
              x.y >= cam.y &&
              x.y <= cam.y + c.clientHeight,
          )
          .map((x) => x.id);
        return;
      }
      g.selection = add ? [...new Set([...g.selection, ent.id])] : [ent.id];
      return;
    }

    const x1 = cam.x + Math.min(drag.x1, drag.x2);
    const y1 = cam.y + Math.min(drag.y1, drag.y2);
    const x2 = cam.x + Math.max(drag.x1, drag.x2);
    const y2 = cam.y + Math.max(drag.y1, drag.y2);
    // 상자 안에 내 유닛이 하나라도 있으면 유닛만 잡는다(건물이 섞여 잡히면 명령이 꼬인다)
    const inBox = g.entities.filter((x) => x.x >= x1 && x.x <= x2 && x.y >= y1 && x.y <= y2);
    let picked = inBox.filter((x) => x.owner === PLAYER && x.kind === 'unit');
    if (picked.length === 0) picked = inBox.filter((x) => x.owner === PLAYER && x.kind === 'building').slice(0, 1);
    const ids = picked.map((x) => x.id);
    g.selection = add ? [...new Set([...g.selection, ...ids])] : ids;
  };

  // ── 미니맵 ──────────────────────────────────────────────────
  const minimapJump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    centerOn(fx * WORLD_W, fy * WORLD_H);
  };

  const onCommand = (cmd: 'attackMove' | 'stop' | 'hold' | 'buildMenu' | 'cancel') => {
    const g = gameRef.current!;
    if (cmd === 'attackMove') attackModeRef.current = true;
    else if (cmd === 'stop') for (const u of ownSelectedUnits(g)) g.orderStop(u);
    else if (cmd === 'hold') for (const u of ownSelectedUnits(g)) g.orderHold(u);
    else if (cmd === 'buildMenu') setBuildMenu(true);
    else {
      placingRef.current = null;
      attackModeRef.current = false;
      setBuildMenu(false);
    }
  };

  const onTrain = (type: string) => {
    const g = gameRef.current!;
    const b = g.selection.map((id) => g.byId.get(id)).find((x) => x?.kind === 'building' && x.owner === PLAYER);
    if (!b) return;
    const err = g.train(b, type);
    if (err) notify(err);
  };
  const onCancelTrain = (i: number) => {
    const g = gameRef.current!;
    const b = g.selection.map((id) => g.byId.get(id)).find((x) => x?.kind === 'building' && x.owner === PLAYER);
    if (b) g.cancelTrain(b, i);
  };

  const over = hud.status !== 'playing';

  return (
    <div ref={wrapRef} className="flex h-screen select-none flex-col overflow-hidden bg-bg text-text">
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="h-full w-full cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            mouseRef.current.inside = false;
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
        <Hud
          minerals={hud.minerals}
          gas={hud.gas}
          supplyUsed={hud.supplyUsed}
          supplyMax={hud.supplyMax}
          elapsed={hud.elapsed}
          sel={hud.sel}
          buildMenu={buildMenu}
          placing={hud.placing}
          attackMode={hud.attackMode}
          notice={hud.notice}
          minimapRef={minimapRef}
          minimapSize={MINIMAP}
          onMinimapDown={(e) => {
            minimapDragRef.current = true;
            minimapJump(e);
          }}
          onMinimapMove={(e) => {
            if (minimapDragRef.current) minimapJump(e);
          }}
          onMinimapUp={() => {
            minimapDragRef.current = false;
          }}
          onCommand={onCommand}
          onBuild={startPlacing}
          onTrain={onTrain}
          onCancelTrain={onCancelTrain}
        />

        {over && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/70">
            <p className={'text-4xl font-extrabold ' + (hud.status === 'won' ? 'text-up' : 'text-down')}>
              {hud.status === 'won' ? '승리' : '패배'}
            </p>
            <p className="text-xs text-white/70">
              경과 {Math.floor(hud.elapsed / 60)}분 {Math.floor(hud.elapsed % 60)}초
            </p>
            <div className="flex gap-2">
              <button
                onClick={onRestart}
                className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-black hover:brightness-110"
              >
                다시 하기
              </button>
              <button
                onClick={() => onExit(hud.status === 'won' ? 'won' : 'lost')}
                className="rounded-lg bg-panel2 px-5 py-2.5 text-sm font-bold text-text hover:brightness-110"
              >
                메뉴로
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 선택 요약(HUD 용) ─────────────────────────────────────────
function ownSelectedUnits(g: Game): Entity[] {
  return g.selection
    .map((id) => g.byId.get(id))
    .filter((e): e is Entity => !!e && e.kind === 'unit' && e.owner === PLAYER);
}
function selectedWorkers(g: Game): Entity[] {
  return ownSelectedUnits(g).filter((u) => UNITS[u.type]?.isWorker);
}
function summarize(g: Game): HudSel {
  const ents = g.selection.map((id) => g.byId.get(id)).filter((e): e is Entity => !!e);
  const counts = new Map<string, number>();
  for (const e of ents) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const first = ents[0] ?? null;
  return {
    ids: ents.map((e) => e.id),
    groups: [...counts.entries()].map(([type, count]) => ({ type, count })),
    primary: first
      ? {
          id: first.id,
          type: first.type,
          kind: first.kind,
          owner: first.owner,
          hp: first.hp,
          maxHp: first.maxHp,
          queue: first.queue.map((q) => ({ type: q.type, progress: 1 - q.left / q.total })),
          rally: !!first.rally,
        }
      : null,
    hasWorker: ents.some((e) => e.owner === PLAYER && UNITS[e.type]?.isWorker),
    ownUnits: ents.some((e) => e.owner === PLAYER && e.kind === 'unit'),
  };
}
