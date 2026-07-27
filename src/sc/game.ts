// ── 시뮬레이션 코어 ────────────────────────────────────────────────────────────
// 고정 틱(TICK_S)으로만 전진한다 — 렌더는 rAF 로 매 프레임 돌지만 시뮬은 누적 시간을 쪼개
// 항상 같은 간격으로 돌려야 프레임레이트에 따라 유닛 속도/공격속도가 달라지지 않는다.
import {
  CARRY_GAS,
  CARRY_MINERAL,
  ENEMY,
  GAS_TIME,
  GEYSER_AMOUNT,
  MAP_H,
  MAP_W,
  MINE_TIME,
  MINERAL_PATCH,
  NEUTRAL,
  PLAYER,
  SUPPLY_MAX,
  TICK_S,
  TILE,
  type Entity,
  type GameStatus,
  type PlayerState,
  type Tracer,
  type Vec,
} from './types';
import { BUILDINGS, UNITS, type BuildingSpec } from './data';
import { GameMap, footprintOf, tileCenter } from './map';
import { findPath } from './pathfind';

let nextId = 1;

export class Game {
  map = new GameMap();
  entities: Entity[] = [];
  byId = new Map<number, Entity>();
  players: PlayerState[] = [
    { minerals: 200, gas: 0, supplyUsed: 0, supplyMax: 0 },
    { minerals: 200, gas: 0, supplyUsed: 0, supplyMax: 0 },
  ];
  selection: number[] = [];
  tracers: Tracer[] = [];
  status: GameStatus = 'playing';
  elapsed = 0;
  /** 마지막으로 "일꾼이 자원을 반납한" 등 UI 로 알릴 만한 사건 */
  notice = '';
  private fogTimer = 0;
  private acc = 0;

  constructor() {
    for (const r of this.map.resources) {
      const s = r.type === 'geyser' ? BUILDINGS.refinery : { w: 1, h: 1 };
      const c = tileCenter(r.bx, r.by, s.w, s.h);
      const e = this.blank('resource', r.type, NEUTRAL, c.x, c.y);
      e.amount = r.type === 'geyser' ? GEYSER_AMOUNT : MINERAL_PATCH;
      e.radius = r.type === 'geyser' ? 26 : 12;
      this.add(e);
    }
    for (const owner of [PLAYER, ENEMY]) {
      const b = this.map.bases[owner];
      const cc = this.spawnBuilding('cc', owner, b.bx, b.by, true);
      // 시작 일꾼 — 커맨드 센터 아래쪽에 부채꼴로 배치하고 곧장 가까운 미네랄로 보낸다.
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI * (i + 0.5)) / 6 + (owner === PLAYER ? 0 : Math.PI);
        const u = this.spawnUnit('scv', owner, cc.x + Math.cos(ang) * 70, cc.y + Math.sin(ang) * 70);
        const m = this.nearestResource(u, 'mineral');
        if (m) this.orderGather(u, m);
      }
    }
    this.map.rebuildBlocked(this.entities);
    this.recalcSupply();
    this.map.updateFog(this.entities, PLAYER);
  }

  // ── 엔티티 생성 ──────────────────────────────────────────────
  private blank(kind: Entity['kind'], type: string, owner: number, x: number, y: number): Entity {
    return {
      id: nextId++,
      kind,
      type,
      owner,
      x,
      y,
      hp: 1,
      maxHp: 1,
      radius: 10,
      order: { kind: 'idle' },
      path: [],
      cooldown: 0,
      carrying: 0,
      carryType: null,
      homeResource: null,
      mineTimer: 0,
      stuck: 0,
      lastX: x,
      lastY: y,
      progress: 1,
      buildLeft: 0,
      queue: [],
      rally: null,
      amount: 0,
    };
  }
  private add(e: Entity) {
    this.entities.push(e);
    this.byId.set(e.id, e);
  }

  spawnUnit(type: string, owner: number, x: number, y: number): Entity {
    const s = UNITS[type];
    const e = this.blank('unit', type, owner, x, y);
    e.hp = e.maxHp = s.hp;
    e.radius = s.radius;
    this.add(e);
    return e;
  }

  spawnBuilding(type: string, owner: number, bx: number, by: number, complete: boolean): Entity {
    const s = BUILDINGS[type];
    const c = tileCenter(bx, by, s.w, s.h);
    const e = this.blank('building', type, owner, c.x, c.y);
    e.maxHp = s.hp;
    e.hp = complete ? s.hp : Math.max(1, Math.round(s.hp * 0.1));
    e.progress = complete ? 1 : 0;
    e.buildLeft = complete ? 0 : s.buildTime;
    e.radius = (Math.max(s.w, s.h) * TILE) / 2;
    if (s.onGeyser) {
      const g = this.entities.find((r) => r.type === 'geyser' && Math.hypot(r.x - c.x, r.y - c.y) < TILE);
      if (g) {
        e.geyser = g.id;
        g.refinery = e.id;
      }
    }
    this.add(e);
    this.map.rebuildBlocked(this.entities);
    return e;
  }

  // ── 조회 헬퍼 ────────────────────────────────────────────────
  alive(): Entity[] {
    return this.entities;
  }
  unitsOf(owner: number): Entity[] {
    return this.entities.filter((e) => e.kind === 'unit' && e.owner === owner);
  }
  buildingsOf(owner: number): Entity[] {
    return this.entities.filter((e) => e.kind === 'building' && e.owner === owner);
  }
  countOf(owner: number, type: string): number {
    return this.entities.filter((e) => e.owner === owner && e.type === type).length;
  }
  hasBuilding(owner: number, type: string): boolean {
    return this.entities.some((e) => e.owner === owner && e.type === type && e.progress >= 1);
  }

  nearestResource(u: Entity, kind: 'mineral' | 'gas'): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of this.entities) {
      if (kind === 'mineral') {
        if (e.type !== 'mineral' || e.amount <= 0) continue;
      } else {
        // 가스는 "완성된 내 리파이너리"에서만 캘 수 있다
        if (e.type !== 'refinery' || e.owner !== u.owner || e.progress < 1) continue;
      }
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }
  nearestDropoff(u: Entity): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of this.entities) {
      if (e.kind !== 'building' || e.owner !== u.owner || e.progress < 1) continue;
      if (!BUILDINGS[e.type]?.dropoff) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  // ── 명령 ────────────────────────────────────────────────────
  private repath(u: Entity, tx: number, ty: number) {
    u.path = findPath(this.map.blocked, u.x, u.y, tx, ty);
    u.stuck = 0;
  }
  orderMove(u: Entity, x: number, y: number, attackMove = false) {
    u.order = { kind: attackMove ? 'attackMove' : 'move', x, y };
    u.carryType = u.carrying > 0 ? u.carryType : null;
    this.repath(u, x, y);
  }
  orderAttack(u: Entity, target: Entity) {
    u.order = { kind: 'attack', target: target.id };
    this.repath(u, target.x, target.y);
  }
  orderStop(u: Entity) {
    u.order = { kind: 'idle' };
    u.path = [];
  }
  orderHold(u: Entity) {
    u.order = { kind: 'hold' };
    u.path = [];
  }
  orderGather(u: Entity, res: Entity) {
    if (!UNITS[u.type]?.isWorker) return;
    u.order = { kind: 'gather', target: res.id };
    u.homeResource = res.id;
    this.repath(u, res.x, res.y);
  }
  /** 일꾼에게 "여기에 이 건물을 지어라" — 자리까지 걸어간 뒤 착공한다. */
  orderBuild(u: Entity, type: string, bx: number, by: number): boolean {
    const s = BUILDINGS[type];
    if (!s || !UNITS[u.type]?.isWorker) return false;
    const c = tileCenter(bx, by, s.w, s.h);
    u.order = { kind: 'build', buildType: type, bx, by, x: c.x, y: c.y };
    this.repath(u, c.x, c.y);
    return true;
  }

  /** 건물 배치가 가능한 자리인지 — 지형/다른 건물/자원과 겹치면 안 된다.
   * 리파이너리만은 예외로 **가스 간헐천 위에 정확히 겹쳐야** 놓을 수 있다. */
  canPlace(type: string, bx: number, by: number, owner: number): boolean {
    const s = BUILDINGS[type];
    if (!s) return false;
    if (s.onGeyser) {
      const g = this.entities.find((e) => e.type === 'geyser' && !e.refinery);
      const target = this.entities.find((e) => {
        if (e.type !== 'geyser' || e.refinery) return false;
        const f = footprintOf(e);
        return f && f.bx === bx && f.by === by;
      });
      return !!g && !!target;
    }
    for (let ty = by; ty < by + s.h; ty++) {
      for (let tx = bx; tx < bx + s.w; tx++) {
        if (this.map.isBlockedTile(tx, ty)) return false;
        // 안개 속(한 번도 못 본 곳)에는 지을 수 없다
        if (owner === PLAYER && !this.map.explored[ty * MAP_W + tx]) return false;
      }
    }
    return true;
  }

  canAfford(owner: number, costM: number, costG: number): boolean {
    const p = this.players[owner];
    return p.minerals >= costM && p.gas >= costG;
  }
  pay(owner: number, costM: number, costG: number) {
    this.players[owner].minerals -= costM;
    this.players[owner].gas -= costG;
  }

  /** 건물에 유닛 생산을 예약한다. 자원/인구/선행 건물을 여기서 전부 검사한다. */
  train(b: Entity, type: string): string | null {
    const s = UNITS[type];
    const bs = BUILDINGS[b.type];
    if (!s || !bs?.produces?.includes(type)) return '여기서 뽑을 수 없는 유닛입니다';
    if (b.progress < 1) return '건설이 끝나지 않았습니다';
    if (b.queue.length >= 5) return '생산 대기열이 가득 찼습니다';
    if (s.requires && !this.hasBuilding(b.owner, s.requires)) return `${BUILDINGS[s.requires].name}가 필요합니다`;
    const p = this.players[b.owner];
    if (p.supplyUsed + s.supply > p.supplyMax) return '인구가 부족합니다 (서플라이 디팟을 지으세요)';
    if (!this.canAfford(b.owner, s.costM, s.costG)) return '자원이 부족합니다';
    this.pay(b.owner, s.costM, s.costG);
    b.queue.push({ type, left: s.buildTime, total: s.buildTime });
    return null;
  }
  cancelTrain(b: Entity, index: number) {
    const item = b.queue[index];
    if (!item) return;
    const s = UNITS[item.type];
    this.players[b.owner].minerals += s.costM;
    this.players[b.owner].gas += s.costG;
    b.queue.splice(index, 1);
  }

  // ── 메인 루프 ───────────────────────────────────────────────
  /** 실제 경과 시간을 받아 고정 틱으로 쪼개 돌린다. 탭 전환 등으로 큰 값이 들어와도
   * 한 프레임에 몰아서 수십 틱을 돌지 않도록 상한을 둔다(그래야 갑자기 게임이 순간이동하지 않음). */
  update(dtMs: number, onTick?: (g: Game) => void) {
    if (this.status !== 'playing') return;
    this.acc = Math.min(this.acc + dtMs, 250);
    while (this.acc >= TICK_S * 1000) {
      this.acc -= TICK_S * 1000;
      this.tick();
      onTick?.(this);
      if (this.status !== 'playing') break;
    }
  }

  private tick() {
    this.elapsed += TICK_S;
    for (const e of this.entities) {
      if (e.kind === 'unit') this.tickUnit(e);
      else if (e.kind === 'building') this.tickBuilding(e);
    }
    // 죽은 것 정리
    let removedBuilding = false;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const dead = e.kind === 'resource' ? e.amount <= 0 && e.type === 'mineral' : e.hp <= 0;
      if (!dead) continue;
      if (e.kind === 'building') removedBuilding = true;
      if (e.kind === 'resource') removedBuilding = true;
      if (e.type === 'refinery' && e.geyser) {
        const g = this.byId.get(e.geyser);
        if (g) g.refinery = undefined;
      }
      this.byId.delete(e.id);
      this.entities.splice(i, 1);
    }
    if (removedBuilding) this.map.rebuildBlocked(this.entities);
    this.selection = this.selection.filter((id) => this.byId.has(id));

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      this.tracers[i].life -= TICK_S;
      if (this.tracers[i].life <= 0) this.tracers.splice(i, 1);
    }

    this.recalcSupply();
    this.fogTimer -= TICK_S;
    if (this.fogTimer <= 0) {
      this.fogTimer = 0.2; // 매 틱 돌릴 필요는 없다(0.2초면 체감상 즉각적)
      this.map.updateFog(this.entities, PLAYER);
    }
    this.checkEnd();
  }

  private recalcSupply() {
    for (const owner of [PLAYER, ENEMY]) {
      let used = 0;
      let max = 0;
      for (const e of this.entities) {
        if (e.owner !== owner) continue;
        if (e.kind === 'unit') used += UNITS[e.type]?.supply ?? 0;
        else if (e.kind === 'building' && e.progress >= 1) max += BUILDINGS[e.type]?.supply ?? 0;
      }
      this.players[owner].supplyUsed = used;
      this.players[owner].supplyMax = Math.min(max, SUPPLY_MAX);
    }
  }

  private checkEnd() {
    const pAlive = this.entities.some((e) => e.owner === PLAYER && (e.kind === 'building' || e.kind === 'unit'));
    const eAlive = this.entities.some((e) => e.owner === ENEMY && (e.kind === 'building' || e.kind === 'unit'));
    if (!eAlive) this.status = 'won';
    else if (!pAlive) this.status = 'lost';
  }

  // ── 건물 틱 ────────────────────────────────────────────────
  private tickBuilding(b: Entity) {
    if (b.progress < 1) return; // 건설은 일꾼이 진행시킨다(tickUnit 의 build 처리)
    const item = b.queue[0];
    if (!item) return;
    item.left -= TICK_S;
    if (item.left > 0) return;
    b.queue.shift();
    const s = BUILDINGS[b.type];
    // 건물 아래쪽(랠리 방향)으로 살짝 밀어 내보낸다 — 건물 위에 겹쳐 나오면 끼어 보인다.
    const out = this.freeSpotNear(b.x, b.y + ((s?.h ?? 2) * TILE) / 2 + 18);
    const u = this.spawnUnit(item.type, b.owner, out.x, out.y);
    if (b.rally) {
      // 랠리가 자원이면 바로 채집을 시킨다(원작에서 미네랄에 랠리 찍는 감각)
      const res = this.entities.find(
        (e) => e.kind === 'resource' && Math.hypot(e.x - b.rally!.x, e.y - b.rally!.y) < e.radius + 6,
      );
      if (res && UNITS[u.type]?.isWorker) this.orderGather(u, res);
      else this.orderMove(u, b.rally.x, b.rally.y);
    } else if (UNITS[u.type]?.isWorker) {
      const m = this.nearestResource(u, 'mineral');
      if (m) this.orderGather(u, m);
    }
  }

  private freeSpotNear(x: number, y: number): Vec {
    for (let r = 0; r < 8; r++) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r * TILE;
        const ny = y + Math.sin(ang) * r * TILE;
        if (!this.map.isBlockedTile(Math.floor(nx / TILE), Math.floor(ny / TILE))) return { x: nx, y: ny };
      }
    }
    return { x, y };
  }

  // ── 유닛 틱 ────────────────────────────────────────────────
  private tickUnit(u: Entity) {
    if (u.cooldown > 0) u.cooldown -= TICK_S;
    const spec = UNITS[u.type];
    const o = u.order;

    switch (o.kind) {
      case 'idle':
      case 'hold': {
        const t = this.acquireTarget(u, spec.range + (o.kind === 'hold' ? 8 : spec.sight * 0.55));
        if (t) this.tryShoot(u, t, o.kind === 'hold');
        break;
      }
      case 'move':
        this.stepPath(u, spec.speed);
        if (u.path.length === 0) u.order = { kind: 'idle' };
        break;
      case 'attackMove': {
        const t = this.acquireTarget(u, spec.sight * 0.6);
        if (t) {
          // 사거리 안이면 멈춰서 쏘고, 아니면 접근한다(A-클릭의 기본 동작)
          if (this.dist(u, t) <= spec.range + t.radius) {
            u.path = [];
            this.tryShoot(u, t, true);
          } else this.stepToward(u, t, spec.speed);
          break;
        }
        this.stepPath(u, spec.speed);
        if (u.path.length === 0) u.order = { kind: 'idle' };
        break;
      }
      case 'attack': {
        const t = o.target ? this.byId.get(o.target) : undefined;
        if (!t || t.hp <= 0) {
          u.order = { kind: 'idle' };
          u.path = [];
          break;
        }
        if (this.dist(u, t) <= spec.range + t.radius) {
          u.path = [];
          this.tryShoot(u, t, true);
        } else this.stepToward(u, t, spec.speed);
        break;
      }
      case 'gather':
        this.tickGather(u);
        break;
      case 'return':
        this.tickReturn(u);
        break;
      case 'build':
        this.tickBuild(u);
        break;
    }

    this.separate(u);
    // 이동 명령이 있는데 실제로 거의 안 움직였으면 길을 다시 찾는다(다른 유닛/새 건물에 막힘)
    if (u.path.length > 0) {
      const moved = Math.hypot(u.x - u.lastX, u.y - u.lastY);
      u.stuck = moved < spec.speed * TICK_S * 0.25 ? u.stuck + 1 : 0;
      if (u.stuck > 18) {
        const dest = u.path[u.path.length - 1];
        this.repath(u, dest.x, dest.y);
        u.stuck = 0;
      }
    }
    u.lastX = u.x;
    u.lastY = u.y;
  }

  private dist(a: Entity, b: Entity) {
    return Math.hypot(a.x - b.x, a.y - b.y) - a.radius;
  }

  /** 사거리/시야 안의 가장 가까운 적. 건물보다 유닛을 우선한다(원작의 자동 교전 감각). */
  private acquireTarget(u: Entity, range: number): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of this.entities) {
      if (e.owner === u.owner || e.owner === NEUTRAL || e.hp <= 0) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y) - e.radius;
      if (d > range) continue;
      const score = d + (e.kind === 'building' ? 220 : 0);
      if (score < bd) {
        bd = score;
        best = e;
      }
    }
    return best;
  }

  private tryShoot(u: Entity, t: Entity, alreadyInRange: boolean) {
    const spec = UNITS[u.type];
    if (!alreadyInRange && this.dist(u, t) > spec.range + t.radius) return;
    if (u.cooldown > 0) return;
    u.cooldown = spec.cooldown;
    this.damage(t, spec.dmg, u.owner);
    if (spec.splash) {
      for (const e of this.entities) {
        if (e === t || e.owner === u.owner || e.owner === NEUTRAL || e.hp <= 0) continue;
        if (Math.hypot(e.x - t.x, e.y - t.y) <= spec.splash) this.damage(e, spec.dmg * 0.5, u.owner);
      }
    }
    if (spec.range > TILE) {
      this.tracers.push({ x1: u.x, y1: u.y, x2: t.x, y2: t.y, life: 0.09, color: u.owner === PLAYER ? '#bfe4ff' : '#ffcaca' });
    }
  }

  private damage(t: Entity, amount: number, from: number) {
    if (t.kind === 'resource') return;
    t.hp -= amount;
    // 맞은 유닛이 놀고 있었다면 반격하러 움직인다(가만히 맞고만 있지 않게)
    if (t.kind === 'unit' && t.order.kind === 'idle' && !UNITS[t.type]?.isWorker) {
      const attacker = this.entities.find((e) => e.owner === from && e.kind === 'unit' && Math.hypot(e.x - t.x, e.y - t.y) < UNITS[t.type].sight);
      if (attacker) this.orderAttack(t, attacker);
    }
  }

  // ── 이동 ────────────────────────────────────────────────────
  private stepPath(u: Entity, speed: number) {
    if (u.path.length === 0) return;
    const wp = u.path[0];
    const dx = wp.x - u.x;
    const dy = wp.y - u.y;
    const d = Math.hypot(dx, dy);
    const step = speed * TICK_S;
    if (d <= step) {
      u.x = wp.x;
      u.y = wp.y;
      u.path.shift();
      return;
    }
    u.x += (dx / d) * step;
    u.y += (dy / d) * step;
  }
  private stepToward(u: Entity, t: Entity, speed: number) {
    // 목표가 움직였으면 길을 다시 잡는다(계속 새로 잡으면 비싸므로 거리로 판단)
    const last = u.path[u.path.length - 1];
    if (!last || Math.hypot(last.x - t.x, last.y - t.y) > TILE * 2) this.repath(u, t.x, t.y);
    if (u.path.length === 0) {
      const dx = t.x - u.x;
      const dy = t.y - u.y;
      const d = Math.hypot(dx, dy) || 1;
      u.x += (dx / d) * speed * TICK_S;
      u.y += (dy / d) * speed * TICK_S;
      return;
    }
    this.stepPath(u, speed);
  }

  /** 유닛끼리 겹치지 않게 서로 살짝 밀어낸다. 길찾기에서 유닛을 장애물로 넣지 않는 대신
   * 이 분리력만으로 뭉침을 푼다 — 그래야 부대 이동이 서로를 막고 멈추는 일이 없다. */
  private separate(u: Entity) {
    let px = 0;
    let py = 0;
    for (const e of this.entities) {
      if (e === u || e.kind !== 'unit') continue;
      const dx = u.x - e.x;
      const dy = u.y - e.y;
      const d2 = dx * dx + dy * dy;
      const min = u.radius + e.radius;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2) || 0.01;
      const push = (min - d) / min;
      px += (dx / d) * push;
      py += (dy / d) * push;
    }
    if (px || py) {
      u.x += px * 26 * TICK_S;
      u.y += py * 26 * TICK_S;
    }
    // 건물/지형 안으로 파고들지 않게 되민다
    const tx = Math.floor(u.x / TILE);
    const ty = Math.floor(u.y / TILE);
    if (this.map.isBlockedTile(tx, ty)) {
      const cx = (tx + 0.5) * TILE;
      const cy = (ty + 0.5) * TILE;
      const dx = u.x - cx;
      const dy = u.y - cy;
      if (Math.abs(dx) > Math.abs(dy)) u.x += Math.sign(dx || 1) * 40 * TICK_S * 3;
      else u.y += Math.sign(dy || 1) * 40 * TICK_S * 3;
    }
    u.x = Math.max(TILE, Math.min(u.x, (MAP_W - 1) * TILE));
    u.y = Math.max(TILE, Math.min(u.y, (MAP_H - 1) * TILE));
  }

  // ── 자원 채집 ──────────────────────────────────────────────
  private tickGather(u: Entity) {
    const spec = UNITS[u.type];
    let res = u.order.target ? this.byId.get(u.order.target) : undefined;
    // 캐던 덩이가 사라졌으면 근처 다른 자원으로 알아서 옮겨간다
    if (!res || (res.type === 'mineral' && res.amount <= 0) || (res.type === 'refinery' && res.progress < 1)) {
      const next = this.nearestResource(u, u.carryType === 'gas' ? 'gas' : 'mineral') ?? this.nearestResource(u, 'mineral');
      if (!next) {
        u.order = { kind: 'idle' };
        return;
      }
      u.order = { kind: 'gather', target: next.id };
      u.homeResource = next.id;
      this.repath(u, next.x, next.y);
      res = next;
    }
    const d = Math.hypot(res.x - u.x, res.y - u.y);
    if (d > res.radius + u.radius + 4) {
      if (u.path.length === 0) this.repath(u, res.x, res.y);
      this.stepPath(u, spec.speed);
      return;
    }
    u.path = [];
    const isGas = res.type === 'refinery';
    u.mineTimer += TICK_S;
    if (u.mineTimer < (isGas ? GAS_TIME : MINE_TIME)) return;
    u.mineTimer = 0;
    if (isGas) {
      const geyser = res.geyser ? this.byId.get(res.geyser) : undefined;
      const take = Math.min(CARRY_GAS, geyser?.amount ?? CARRY_GAS);
      if (geyser) geyser.amount -= take;
      u.carrying = take;
      u.carryType = 'gas';
    } else {
      const take = Math.min(CARRY_MINERAL, res.amount);
      res.amount -= take;
      u.carrying = take;
      u.carryType = 'mineral';
    }
    const drop = this.nearestDropoff(u);
    if (!drop) {
      u.order = { kind: 'idle' };
      return;
    }
    u.order = { kind: 'return', target: drop.id };
    this.repath(u, drop.x, drop.y);
  }

  private tickReturn(u: Entity) {
    const spec = UNITS[u.type];
    let drop = u.order.target ? this.byId.get(u.order.target) : undefined;
    if (!drop || drop.hp <= 0) {
      drop = this.nearestDropoff(u) ?? undefined;
      if (!drop) {
        u.order = { kind: 'idle' };
        return;
      }
      u.order = { kind: 'return', target: drop.id };
      this.repath(u, drop.x, drop.y);
    }
    if (Math.hypot(drop.x - u.x, drop.y - u.y) > drop.radius + u.radius + 4) {
      if (u.path.length === 0) this.repath(u, drop.x, drop.y);
      this.stepPath(u, spec.speed);
      return;
    }
    const p = this.players[u.owner];
    if (u.carryType === 'gas') p.gas += u.carrying;
    else p.minerals += u.carrying;
    u.carrying = 0;
    u.carryType = null;
    // 캐던 자리로 자동 복귀 — 이게 없으면 일꾼이 한 번 나르고 멈춰서 계속 재지시해야 한다.
    const back = u.homeResource ? this.byId.get(u.homeResource) : undefined;
    const target = back && (back.type !== 'mineral' || back.amount > 0) ? back : this.nearestResource(u, 'mineral');
    if (!target) {
      u.order = { kind: 'idle' };
      return;
    }
    u.homeResource = target.id;
    u.order = { kind: 'gather', target: target.id };
    this.repath(u, target.x, target.y);
  }

  // ── 건설 ────────────────────────────────────────────────────
  private tickBuild(u: Entity) {
    const o = u.order;
    const spec = UNITS[u.type];
    if (!o.buildType || o.bx == null || o.by == null) {
      u.order = { kind: 'idle' };
      return;
    }
    const s = BUILDINGS[o.buildType];
    const c = tileCenter(o.bx, o.by, s.w, s.h);
    const site = this.entities.find(
      (e) => e.kind === 'building' && e.owner === u.owner && e.progress < 1 && Math.hypot(e.x - c.x, e.y - c.y) < 4,
    );

    if (!site) {
      // 아직 착공 전 — 자리까지 걸어간 뒤 자원을 내고 짓기 시작한다
      if (Math.hypot(c.x - u.x, c.y - u.y) > Math.max(s.w, s.h) * TILE * 0.5 + u.radius + 6) {
        if (u.path.length === 0) this.repath(u, c.x, c.y);
        this.stepPath(u, spec.speed);
        return;
      }
      if (!this.canPlace(o.buildType, o.bx, o.by, u.owner) || !this.canAfford(u.owner, s.costM, s.costG)) {
        u.order = { kind: 'idle' };
        if (u.owner === PLAYER) this.notice = '그 자리에는 지을 수 없습니다';
        return;
      }
      this.pay(u.owner, s.costM, s.costG);
      this.spawnBuilding(o.buildType, u.owner, o.bx, o.by, false);
      return;
    }

    // 착공됨 — 붙어서 건설을 진행시킨다
    if (Math.hypot(site.x - u.x, site.y - u.y) > site.radius + u.radius + 6) {
      if (u.path.length === 0) this.repath(u, site.x, site.y);
      this.stepPath(u, spec.speed);
      return;
    }
    u.path = [];
    site.buildLeft -= TICK_S;
    const total = BUILDINGS[site.type].buildTime;
    site.progress = Math.min(1, 1 - site.buildLeft / total);
    site.hp = Math.max(site.hp, Math.round(site.maxHp * (0.1 + 0.9 * site.progress)));
    if (site.buildLeft <= 0) {
      site.progress = 1;
      site.hp = site.maxHp;
      // 다 지으면 일꾼은 원래 하던 일(채집)로 돌려보낸다 — 안 그러면 멍하니 서 있는다.
      const m = this.nearestResource(u, 'mineral');
      if (m) this.orderGather(u, m);
      else u.order = { kind: 'idle' };
    }
  }

  // ── 플레이어 입력용 상위 명령 ────────────────────────────────
  /** 우클릭 한 번으로 상황에 맞는 명령을 고른다(적→공격, 자원→채집, 그 외→이동). */
  commandRight(ids: number[], wx: number, wy: number, target: Entity | null) {
    for (const id of ids) {
      const u = this.byId.get(id);
      if (!u || u.kind !== 'unit' || u.owner !== PLAYER) continue;
      if (target && target.owner !== PLAYER && target.owner !== NEUTRAL) this.orderAttack(u, target);
      else if (target && target.kind === 'resource' && UNITS[u.type]?.isWorker) this.orderGather(u, target);
      else if (target && target.type === 'refinery' && target.owner === PLAYER && UNITS[u.type]?.isWorker) this.orderGather(u, target);
      else if (target && target.kind === 'building' && target.owner === PLAYER && u.carrying > 0 && BUILDINGS[target.type]?.dropoff) {
        u.order = { kind: 'return', target: target.id };
        this.repath(u, target.x, target.y);
      } else this.orderMove(u, wx, wy);
    }
    // 건물만 선택했다면 우클릭은 랠리 지정
    for (const id of ids) {
      const b = this.byId.get(id);
      if (b && b.kind === 'building' && b.owner === PLAYER) b.rally = { x: wx, y: wy };
    }
  }

  entityAt(wx: number, wy: number): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of this.entities) {
      // 안 보이는 곳의 적은 클릭할 수 없다(안개 뒤를 찍어서 공격 못 하게)
      if (e.owner !== PLAYER && e.kind !== 'resource' && !this.map.isVisible(e.x, e.y)) continue;
      if (e.kind === 'resource' && !this.map.isExplored(e.x, e.y)) continue;
      const r = e.kind === 'building' ? e.radius * 1.15 : e.radius + 4;
      const d = Math.hypot(e.x - wx, e.y - wy);
      if (d <= r && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }
}

export function buildingSpec(type: string): BuildingSpec | undefined {
  return BUILDINGS[type];
}
