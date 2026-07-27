// ── 그리드 A* 길찾기 ───────────────────────────────────────────────────────────
// 맵이 64×64(=4096칸)라 매 명령마다 A* 를 새로 돌려도 충분히 빠르다. 유닛끼리는 서로를
// 막지 않고(부드럽게 밀어내는 분리력만 적용) **지형·건물·자원만** 막는다 — 유닛을 장애물로
// 넣으면 한 부대가 서로를 막아 길이 계속 끊긴다.
import { MAP_H, MAP_W, TILE, type Vec } from './types';

const IDX = (tx: number, ty: number) => ty * MAP_W + tx;
const inBounds = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;

/** 최소 힙 — 배열 정렬 대신 써야 큰 맵에서 A* 가 눈에 띄게 빨라진다. */
class MinHeap {
  private a: number[] = []; // node index
  private f: number[] = []; // 우선순위
  push(node: number, prio: number) {
    this.a.push(node);
    this.f.push(prio);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      [this.f[p], this.f[i]] = [this.f[i], this.f[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.a[0];
    const n = this.a.length - 1;
    this.a[0] = this.a[n];
    this.f[0] = this.f[n];
    this.a.pop();
    this.f.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.a.length && this.f[l] < this.f[m]) m = l;
      if (r < this.a.length && this.f[r] < this.f[m]) m = r;
      if (m === i) break;
      [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
      [this.f[m], this.f[i]] = [this.f[i], this.f[m]];
      i = m;
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

// 매번 새 배열을 만들지 않도록 모듈 스코프에 재사용 버퍼를 둔다(탐색마다 stamp 로 무효화).
const gScore = new Float32Array(MAP_W * MAP_H);
const cameFrom = new Int32Array(MAP_W * MAP_H);
const seen = new Int32Array(MAP_W * MAP_H);
let stamp = 0;

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.414],
  [1, -1, 1.414],
  [-1, 1, 1.414],
  [-1, -1, 1.414],
];

/**
 * blocked: 1이면 못 지나가는 타일. goal 타일이 막혀 있으면(건물/자원을 목표로 찍은 경우)
 * 그 근처에서 가장 가까운 통과 가능한 타일로 목표를 옮긴다 — 안 그러면 A* 가 항상 실패한다.
 */
export function findPath(blocked: Uint8Array, sx: number, sy: number, gx: number, gy: number): Vec[] {
  let stx = Math.floor(sx / TILE);
  let sty = Math.floor(sy / TILE);
  let gtx = Math.floor(gx / TILE);
  let gty = Math.floor(gy / TILE);
  if (!inBounds(stx, sty) || !inBounds(gtx, gty)) return [];
  if (blocked[IDX(gtx, gty)]) {
    const near = nearestOpen(blocked, gtx, gty);
    if (!near) return [];
    gtx = near.x;
    gty = near.y;
  }
  // 출발 타일이 막혀 있는 경우(건물에 끼임 등)도 가장 가까운 빈 칸에서 시작한다.
  if (blocked[IDX(stx, sty)]) {
    const near = nearestOpen(blocked, stx, sty);
    if (near) {
      stx = near.x;
      sty = near.y;
    }
  }
  if (stx === gtx && sty === gty) return [{ x: gx, y: gy }];

  stamp++;
  const start = IDX(stx, sty);
  const goal = IDX(gtx, gty);
  const heap = new MinHeap();
  gScore[start] = 0;
  cameFrom[start] = -1;
  seen[start] = stamp;
  heap.push(start, 0);

  let found = false;
  let expanded = 0;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) {
      found = true;
      break;
    }
    // 안전장치 — 도달 불가능한 목표(섬 등)에 프레임을 통째로 쓰지 않게 한다.
    if (++expanded > 6000) break;
    const cx = cur % MAP_W;
    const cy = (cur / MAP_W) | 0;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = IDX(nx, ny);
      if (blocked[ni]) continue;
      // 대각선으로 모서리를 뚫고 지나가지 않게 — 양옆 중 하나라도 막혀 있으면 금지
      if (dx !== 0 && dy !== 0 && (blocked[IDX(cx + dx, cy)] || blocked[IDX(cx, cy + dy)])) continue;
      const ng = gScore[cur] + cost;
      if (seen[ni] === stamp && ng >= gScore[ni]) continue;
      seen[ni] = stamp;
      gScore[ni] = ng;
      cameFrom[ni] = cur;
      const h = Math.hypot(nx - gtx, ny - gty);
      heap.push(ni, ng + h);
    }
  }
  if (!found) return [];

  const rev: Vec[] = [];
  for (let n = goal; n !== -1; n = cameFrom[n]) {
    const tx = n % MAP_W;
    const ty = (n / MAP_W) | 0;
    rev.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
    if (n === start) break;
  }
  rev.reverse();
  rev.shift(); // 현재 서 있는 칸은 빼고
  if (rev.length) rev[rev.length - 1] = { x: gx, y: gy }; // 마지막은 정확한 목표 지점으로
  return smooth(blocked, rev);
}

/** 타일 격자를 그대로 따라가면 계단처럼 꺾이므로, 직선으로 갈 수 있는 구간은 중간점을 버린다. */
function smooth(blocked: Uint8Array, path: Vec[]): Vec[] {
  if (path.length <= 2) return path;
  const out: Vec[] = [];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    if (!lineOpen(blocked, path[anchor], path[i])) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

function lineOpen(blocked: Uint8Array, a: Vec, b: Vec): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (TILE / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const tx = Math.floor((a.x + (b.x - a.x) * t) / TILE);
    const ty = Math.floor((a.y + (b.y - a.y) * t) / TILE);
    if (!inBounds(tx, ty) || blocked[IDX(tx, ty)]) return false;
  }
  return true;
}

/** (tx,ty) 에서 바깥으로 링을 넓혀가며 가장 가까운 통과 가능한 타일을 찾는다. */
export function nearestOpen(blocked: Uint8Array, tx: number, ty: number, maxR = 12): Vec | null {
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (inBounds(nx, ny) && !blocked[IDX(nx, ny)]) return { x: nx, y: ny };
      }
    }
  }
  return null;
}
