// ── 맵 생성 + 통행 격자 + 전장의 안개 ──────────────────────────────────────────
// 맵은 **180° 회전 대칭**으로 만든다(한쪽에 만든 지형을 반대편에 그대로 뒤집어 복사) —
// 양쪽 시작 자원·지형이 같아야 AI 대전이 공평해진다.
import { MAP_H, MAP_W, TILE, type Entity } from './types';
import { BUILDINGS, UNITS } from './data';

export interface ResourceSeed {
  type: 'mineral' | 'geyser';
  bx: number; // 좌상단 타일
  by: number;
}
export interface BaseSeed {
  bx: number;
  by: number;
}

const IDX = (tx: number, ty: number) => ty * MAP_W + tx;
const inB = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;

/** 좌상단(bx,by)·크기(w,h) 짜리 배치를 맵 중심 기준 180° 회전한 위치 */
function mirror(bx: number, by: number, w: number, h: number) {
  return { bx: MAP_W - w - bx, by: MAP_H - h - by };
}

/** 미네랄 덩이 배치(플레이어 기준 상대 타일) — 커맨드 센터 바로 위쪽에 한 줄로 깔린다. */
const MINERAL_TILES: [number, number][] = [
  [7, 47],
  [8, 47],
  [9, 47],
  [10, 47],
  [11, 47],
  [12, 47],
  [6, 48],
  [13, 48],
];
const PLAYER_BASE: BaseSeed = { bx: 9, by: 50 }; // cc = 4×3
const PLAYER_GEYSER: [number, number] = [15, 50]; // 3×2

export class GameMap {
  terrain: Uint8Array; // 1 = 지나갈 수 없는 바위
  blocked: Uint8Array; // 지형 + 건물 + 자원 (길찾기가 보는 격자)
  explored: Uint8Array; // 플레이어가 한 번이라도 본 타일
  visible: Uint8Array; // 지금 시야에 들어온 타일
  bases: BaseSeed[] = [];
  resources: ResourceSeed[] = [];

  constructor() {
    this.terrain = new Uint8Array(MAP_W * MAP_H);
    this.blocked = new Uint8Array(MAP_W * MAP_H);
    this.explored = new Uint8Array(MAP_W * MAP_H);
    this.visible = new Uint8Array(MAP_W * MAP_H);
    this.generate();
  }

  private generate() {
    const cc = BUILDINGS.cc;
    this.bases = [PLAYER_BASE, mirror(PLAYER_BASE.bx, PLAYER_BASE.by, cc.w, cc.h)];

    this.resources = [];
    for (const [tx, ty] of MINERAL_TILES) {
      this.resources.push({ type: 'mineral', bx: tx, by: ty });
      const m = mirror(tx, ty, 1, 1);
      this.resources.push({ type: 'mineral', bx: m.bx, by: m.by });
    }
    const rf = BUILDINGS.refinery;
    this.resources.push({ type: 'geyser', bx: PLAYER_GEYSER[0], by: PLAYER_GEYSER[1] });
    const gm = mirror(PLAYER_GEYSER[0], PLAYER_GEYSER[1], rf.w, rf.h);
    this.resources.push({ type: 'geyser', bx: gm.bx, by: gm.by });

    // 지형은 몇 번 만들어보고 "두 본진이 서로 걸어갈 수 있는" 맵이 나올 때까지 다시 만든다.
    // 바위가 맵을 반으로 갈라버리면 그 판은 시작부터 성립하지 않는다.
    for (let attempt = 0; attempt < 24; attempt++) {
      this.terrain.fill(0);
      this.scatterRocks();
      this.rebuildBlocked([]);
      if (this.basesConnected()) return;
    }
    this.terrain.fill(0); // 끝내 실패하면 바위 없는 평지로(진행 불가보다는 낫다)
    this.rebuildBlocked([]);
  }

  private scatterRocks() {
    const keepClear = (tx: number, ty: number) => {
      // 본진과 자원 주변은 항상 비워둔다 — 여기 바위가 끼면 일꾼 동선이 막힌다.
      for (const b of this.bases) if (Math.abs(tx - (b.bx + 2)) < 9 && Math.abs(ty - (b.by + 1)) < 9) return true;
      for (const r of this.resources) if (Math.abs(tx - r.bx) < 4 && Math.abs(ty - r.by) < 4) return true;
      return false;
    };
    const blobs = 9;
    for (let i = 0; i < blobs; i++) {
      const cx = 4 + Math.floor(Math.random() * (MAP_W - 8));
      const cy = 4 + Math.floor(Math.random() * (MAP_H - 8));
      const size = 3 + Math.floor(Math.random() * 7);
      let x = cx;
      let y = cy;
      for (let s = 0; s < size; s++) {
        for (const [tx, ty] of [
          [x, y],
          [x + 1, y],
          [x, y + 1],
        ]) {
          if (!inB(tx, ty) || keepClear(tx, ty)) continue;
          this.terrain[IDX(tx, ty)] = 1;
          const m = mirror(tx, ty, 1, 1); // 반대편에 똑같이(대칭 유지)
          if (inB(m.bx, m.by) && !keepClear(m.bx, m.by)) this.terrain[IDX(m.bx, m.by)] = 1;
        }
        x += Math.floor(Math.random() * 3) - 1;
        y += Math.floor(Math.random() * 3) - 1;
      }
    }
    // 맵 가장자리는 벽
    for (let t = 0; t < MAP_W; t++) {
      this.terrain[IDX(t, 0)] = 1;
      this.terrain[IDX(t, MAP_H - 1)] = 1;
      this.terrain[IDX(0, t)] = 1;
      this.terrain[IDX(MAP_W - 1, t)] = 1;
    }
  }

  /** 두 본진이 실제로 이어져 있는지(플러드 필) */
  private basesConnected(): boolean {
    const seen = new Uint8Array(MAP_W * MAP_H);
    const a = this.bases[0];
    const b = this.bases[1];
    const start = IDX(a.bx + 2, a.by + 4); // 본진 바로 아래 빈 칸에서 출발
    const goal = IDX(b.bx + 2, b.by - 1);
    if (this.blocked[start] || this.blocked[goal]) return false;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === goal) return true;
      const cx = cur % MAP_W;
      const cy = (cur / MAP_W) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inB(nx, ny)) continue;
        const ni = IDX(nx, ny);
        if (seen[ni] || this.blocked[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    return false;
  }

  /** 지형 + 건물/자원 발자국으로 통행 격자를 다시 만든다(건물이 생기거나 부서질 때만 호출). */
  rebuildBlocked(entities: Entity[]) {
    this.blocked.set(this.terrain);
    for (const e of entities) {
      if (e.kind === 'unit') continue; // 유닛은 서로를 막지 않는다(분리력만 적용)
      const f = footprintOf(e);
      if (!f) continue;
      for (let ty = f.by; ty < f.by + f.h; ty++)
        for (let tx = f.bx; tx < f.bx + f.w; tx++) if (inB(tx, ty)) this.blocked[IDX(tx, ty)] = 1;
    }
  }

  // ── 전장의 안개 ────────────────────────────────────────────────
  /** 플레이어 소유 엔티티의 시야로 visible 을 다시 계산하고 explored 에 누적한다.
   * ⚠ 안개는 **플레이어 쪽만** 계산한다 — AI 는 맵 전체를 보는 전지형이다(미니멀 구현에서
   * AI 용 시야까지 돌리면 비용이 두 배인데 체감 차이는 거의 없다). */
  updateFog(entities: Entity[], owner: number) {
    this.visible.fill(0);
    for (const e of entities) {
      if (e.owner !== owner) continue;
      const sight = e.kind === 'building' ? (BUILDINGS[e.type]?.sight ?? 6 * TILE) : (UNITS[e.type]?.sight ?? 7 * TILE);
      const r = Math.ceil(sight / TILE);
      const ctx = Math.floor(e.x / TILE);
      const cty = Math.floor(e.y / TILE);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const tx = ctx + dx;
          const ty = cty + dy;
          if (!inB(tx, ty)) continue;
          const i = IDX(tx, ty);
          this.visible[i] = 1;
          this.explored[i] = 1;
        }
      }
    }
  }

  isVisible(x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return inB(tx, ty) ? this.visible[IDX(tx, ty)] === 1 : false;
  }
  isExplored(x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return inB(tx, ty) ? this.explored[IDX(tx, ty)] === 1 : false;
  }
  isBlockedTile(tx: number, ty: number): boolean {
    return !inB(tx, ty) || this.blocked[IDX(tx, ty)] === 1;
  }
}

/** 건물/자원이 차지하는 타일 영역 */
export function footprintOf(e: Entity): { bx: number; by: number; w: number; h: number } | null {
  if (e.kind === 'building') {
    const s = BUILDINGS[e.type];
    if (!s) return null;
    return { bx: Math.round(e.x / TILE - s.w / 2), by: Math.round(e.y / TILE - s.h / 2), w: s.w, h: s.h };
  }
  if (e.kind === 'resource') {
    if (e.type === 'geyser') {
      const s = BUILDINGS.refinery;
      return { bx: Math.round(e.x / TILE - s.w / 2), by: Math.round(e.y / TILE - s.h / 2), w: s.w, h: s.h };
    }
    return { bx: Math.floor(e.x / TILE), by: Math.floor(e.y / TILE), w: 1, h: 1 };
  }
  return null;
}

/** 타일 좌상단 → 그 발자국의 월드 중심 좌표 */
export function tileCenter(bx: number, by: number, w: number, h: number) {
  return { x: (bx + w / 2) * TILE, y: (by + h / 2) * TILE };
}
