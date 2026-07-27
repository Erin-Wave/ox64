// ── Canvas 렌더링 ──────────────────────────────────────────────────────────────
// 스프라이트 없이 전부 도형으로 그린다. 화면에 보이는 영역만 그리고, 안개는 타일을 하나씩
// 칠하는 대신 가로로 이어지는 구간을 합쳐서 fillRect 횟수를 줄인다(64×64 를 매 프레임 개별
// fillRect 하면 그것만으로 프레임을 깎아먹는다).
import { MAP_H, MAP_W, PLAYER, TILE, WORLD_H, WORLD_W, type Entity } from './types';
import { BUILDINGS, TEAM_COLOR, TEAM_DARK, UNITS } from './data';
import type { Game } from './game';

export interface Camera {
  x: number;
  y: number;
}
export interface Ghost {
  type: string;
  bx: number;
  by: number;
  ok: boolean;
}
export interface RenderOpts {
  camera: Camera;
  vw: number;
  vh: number;
  dragBox: { x1: number; y1: number; x2: number; y2: number } | null;
  ghost: Ghost | null;
}

const GROUND = '#2a2f26';
const GROUND2 = '#333a2e';
const ROCK = '#4c4a44';
const ROCK_TOP = '#5d5a52';
const MINERAL = '#4fd8f5';
const GAS = '#3fce7a';

const BUILDING_LETTER: Record<string, string> = { cc: 'C', depot: 'D', barracks: 'B', refinery: 'R', factory: 'F' };

export function renderGame(ctx: CanvasRenderingContext2D, g: Game, o: RenderOpts) {
  const { camera: cam, vw, vh } = o;
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // 바닥 — 한 번에 칠하고 그 위에 격자 무늬만 얹는다
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, vw, vh);
  const t0x = Math.max(0, Math.floor(cam.x / TILE));
  const t0y = Math.max(0, Math.floor(cam.y / TILE));
  const t1x = Math.min(MAP_W - 1, Math.ceil((cam.x + vw) / TILE));
  const t1y = Math.min(MAP_H - 1, Math.ceil((cam.y + vh) / TILE));
  ctx.fillStyle = GROUND2;
  for (let ty = t0y; ty <= t1y; ty++)
    for (let tx = t0x; tx <= t1x; tx++)
      if (((tx + ty) & 1) === 0) ctx.fillRect(tx * TILE - cam.x, ty * TILE - cam.y, TILE, TILE);

  // 바위
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      if (!g.map.terrain[ty * MAP_W + tx]) continue;
      const x = tx * TILE - cam.x;
      const y = ty * TILE - cam.y;
      ctx.fillStyle = ROCK;
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = ROCK_TOP;
      ctx.fillRect(x, y, TILE, 4);
    }
  }

  // 자원 → 건물 → 유닛 순으로 겹쳐 그린다
  const inView = (e: Entity, pad = 60) =>
    e.x + pad > cam.x && e.x - pad < cam.x + vw && e.y + pad > cam.y && e.y - pad < cam.y + vh;

  for (const e of g.entities) {
    if (e.kind !== 'resource' || !inView(e)) continue;
    if (!g.map.isExplored(e.x, e.y)) continue;
    drawResource(ctx, e, cam);
  }
  for (const e of g.entities) {
    if (e.kind !== 'building' || !inView(e, 90)) continue;
    // 적 건물은 한 번 본 자리면 계속 보인다(원작처럼 "마지막으로 본 모습"이 남는 감각)
    if (e.owner !== PLAYER && !g.map.isExplored(e.x, e.y)) continue;
    drawBuilding(ctx, g, e, cam);
  }
  for (const e of g.entities) {
    if (e.kind !== 'unit' || !inView(e)) continue;
    if (e.owner !== PLAYER && !g.map.isVisible(e.x, e.y)) continue; // 적 유닛은 시야 안에서만
    drawUnit(ctx, g, e, cam);
  }

  // 사격 궤적
  for (const t of g.tracers) {
    ctx.strokeStyle = t.color;
    ctx.globalAlpha = Math.max(0, t.life / 0.09);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(t.x1 - cam.x, t.y1 - cam.y);
    ctx.lineTo(t.x2 - cam.x, t.y2 - cam.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  drawFog(ctx, g, cam, vw, vh, t0x, t0y, t1x, t1y);

  // 건물 배치 미리보기
  if (o.ghost) {
    const s = BUILDINGS[o.ghost.type];
    const x = o.ghost.bx * TILE - cam.x;
    const y = o.ghost.by * TILE - cam.y;
    ctx.fillStyle = o.ghost.ok ? 'rgba(80,220,120,0.35)' : 'rgba(230,80,80,0.35)';
    ctx.fillRect(x, y, s.w * TILE, s.h * TILE);
    ctx.strokeStyle = o.ghost.ok ? '#5cdc78' : '#e65050';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, s.w * TILE, s.h * TILE);
  }

  // 드래그 선택 상자
  if (o.dragBox) {
    const { x1, y1, x2, y2 } = o.dragBox;
    ctx.strokeStyle = '#7dff9b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawResource(ctx: CanvasRenderingContext2D, e: Entity, cam: Camera) {
  const x = e.x - cam.x;
  const y = e.y - cam.y;
  if (e.type === 'mineral') {
    ctx.fillStyle = MINERAL;
    for (const [dx, dy, r] of [
      [-5, 2, 6],
      [4, 3, 5],
      [0, -4, 7],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dx, y + dy - r);
      ctx.lineTo(x + dx + r * 0.6, y + dy);
      ctx.lineTo(x + dx, y + dy + r);
      ctx.lineTo(x + dx - r * 0.6, y + dy);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    ctx.fillStyle = '#1e3a2a';
    ctx.fillRect(x - 34, y - 22, 68, 44);
    ctx.fillStyle = GAS;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0d1f16';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBuilding(ctx: CanvasRenderingContext2D, g: Game, e: Entity, cam: Camera) {
  const s = BUILDINGS[e.type];
  if (!s) return;
  const w = s.w * TILE;
  const h = s.h * TILE;
  const x = e.x - w / 2 - cam.x;
  const y = e.y - h / 2 - cam.y;
  const building = e.progress < 1;

  ctx.globalAlpha = building ? 0.55 : 1;
  ctx.fillStyle = TEAM_DARK[e.owner] ?? '#444';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = TEAM_COLOR[e.owner] ?? '#888';
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x + 3, y + 3, w - 6, 5);
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#0b1016';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(BUILDING_LETTER[e.type] ?? '?', x + w / 2, y + h / 2);

  if (building) {
    ctx.strokeStyle = '#ffd166';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    bar(ctx, x, y + h + 3, w, 4, e.progress, '#ffd166');
  }
  if (g.selection.includes(e.id)) {
    ctx.strokeStyle = '#7dff9b';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  }
  if (e.hp < e.maxHp) bar(ctx, x, y - 7, w, 4, e.hp / e.maxHp, hpColor(e.hp / e.maxHp));
  // 생산 진행도
  if (e.queue.length > 0) {
    const q = e.queue[0];
    bar(ctx, x, y + h + (building ? 9 : 3), w, 4, 1 - q.left / q.total, '#4aa3ff');
  }
}

function drawUnit(ctx: CanvasRenderingContext2D, g: Game, e: Entity, cam: Camera) {
  const x = e.x - cam.x;
  const y = e.y - cam.y;
  const col = TEAM_COLOR[e.owner] ?? '#aaa';
  const dark = TEAM_DARK[e.owner] ?? '#333';
  const r = e.radius;

  if (g.selection.includes(e.id)) {
    ctx.strokeStyle = '#7dff9b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.5, r + 4, (r + 4) * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.55, r * 0.9, r * 0.45, 0, 0, Math.PI * 2); // 그림자
  ctx.fill();

  ctx.fillStyle = col;
  switch (e.type) {
    case 'scv': {
      ctx.fillRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
      ctx.fillStyle = e.carryType === 'gas' ? GAS : e.carryType === 'mineral' ? MINERAL : dark;
      ctx.fillRect(x - 3, y - r - 3, 6, 5); // 들고 있는 자원 표시
      break;
    }
    case 'marine': {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = dark;
      ctx.fillRect(x - 1.5, y - r, 3, r * 0.9);
      break;
    }
    case 'firebat': {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff9d3d';
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.6, y);
      ctx.lineTo(x - r * 0.6, y);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'tank': {
      ctx.fillRect(x - r, y - r * 0.7, r * 2, r * 1.4);
      ctx.fillStyle = dark;
      ctx.fillRect(x - r * 0.25, y - r * 1.5, r * 0.5, r * 1.1); // 포신
      break;
    }
    default:
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
  }

  if (e.hp < e.maxHp) bar(ctx, x - r, y - r - 8, r * 2, 3, e.hp / e.maxHp, hpColor(e.hp / e.maxHp));
}

function hpColor(f: number) {
  return f > 0.6 ? '#4ade80' : f > 0.3 ? '#facc15' : '#f87171';
}
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, f: number, color: string) {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.max(0, Math.min(1, f)) * w, h);
}

/** 안개 — 한 번도 못 본 곳은 완전히 검게, 봤지만 지금 시야에 없는 곳은 어둡게.
 * 가로로 같은 상태가 이어지는 구간을 묶어 한 번에 칠한다. */
function drawFog(
  ctx: CanvasRenderingContext2D,
  g: Game,
  cam: Camera,
  vw: number,
  vh: number,
  t0x: number,
  t0y: number,
  t1x: number,
  t1y: number,
) {
  for (let ty = t0y; ty <= t1y; ty++) {
    let runStart = -1;
    let runState = -1;
    for (let tx = t0x; tx <= t1x + 1; tx++) {
      const i = ty * MAP_W + tx;
      const state = tx > t1x ? -1 : g.map.visible[i] ? 0 : g.map.explored[i] ? 1 : 2;
      if (state !== runState) {
        if (runState > 0 && runStart >= 0) {
          ctx.fillStyle = runState === 2 ? '#0a0d0b' : 'rgba(6,10,8,0.55)';
          ctx.fillRect(runStart * TILE - cam.x, ty * TILE - cam.y, (tx - runStart) * TILE, TILE);
        }
        runStart = tx;
        runState = state;
      }
    }
  }
  // 맵 바깥은 그냥 검게
  ctx.fillStyle = '#0a0d0b';
  if (cam.x < 0) ctx.fillRect(0, 0, -cam.x, vh);
  if (cam.y < 0) ctx.fillRect(0, 0, vw, -cam.y);
  if (cam.x + vw > WORLD_W) ctx.fillRect(WORLD_W - cam.x, 0, cam.x + vw - WORLD_W, vh);
  if (cam.y + vh > WORLD_H) ctx.fillRect(0, WORLD_H - cam.y, vw, cam.y + vh - WORLD_H);
}

/** 미니맵 — 탐색한 지형 + 유닛 점 + 현재 보고 있는 영역 사각형 */
export function renderMinimap(ctx: CanvasRenderingContext2D, g: Game, cam: Camera, vw: number, vh: number, size: number) {
  const s = size / MAP_W;
  ctx.fillStyle = '#0a0d0b';
  ctx.fillRect(0, 0, size, size);
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = ty * MAP_W + tx;
      if (!g.map.explored[i]) continue;
      ctx.fillStyle = g.map.terrain[i] ? ROCK : g.map.visible[i] ? GROUND2 : GROUND;
      ctx.fillRect(tx * s, ty * s, s + 0.5, s + 0.5);
    }
  }
  for (const e of g.entities) {
    if (e.kind === 'resource') {
      if (!g.map.isExplored(e.x, e.y)) continue;
      ctx.fillStyle = e.type === 'mineral' ? MINERAL : GAS;
      ctx.fillRect((e.x / TILE) * s - 1, (e.y / TILE) * s - 1, 2.5, 2.5);
      continue;
    }
    if (e.owner !== PLAYER && !(e.kind === 'building' ? g.map.isExplored(e.x, e.y) : g.map.isVisible(e.x, e.y))) continue;
    ctx.fillStyle = TEAM_COLOR[e.owner] ?? '#999';
    const d = e.kind === 'building' ? 4 : 2.5;
    ctx.fillRect((e.x / TILE) * s - d / 2, (e.y / TILE) * s - d / 2, d, d);
  }
  ctx.strokeStyle = '#ffffffaa';
  ctx.lineWidth = 1;
  ctx.strokeRect((cam.x / TILE) * s, (cam.y / TILE) * s, (vw / TILE) * s, (vh / TILE) * s);
}

/** 유닛 종류별 대표 색(HUD 아이콘용) */
export function unitTint(type: string): string {
  if (UNITS[type]) return type === 'scv' ? '#ffd166' : type === 'marine' ? '#9fd8ff' : type === 'firebat' ? '#ff9d3d' : '#c7b3ff';
  return '#9fd8ff';
}
