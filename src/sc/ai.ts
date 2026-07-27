// ── 컴퓨터 상대 ────────────────────────────────────────────────────────────────
// 매 틱이 아니라 1초에 두어 번만 판단한다(RTS AI 는 초 단위로 생각해도 충분하고, 매 틱
// 전체 엔티티를 훑으면 그게 곧 프레임 드랍이다). 사람처럼 정해진 순서로 확장한다:
//   일꾼 확보 → 인구 관리 → 배럭 → 가스 → 팩토리 → 병력 모아서 공격
// ⚠ 이 AI 는 안개가 없다(맵 전체를 본다). 미니멀 구현에서 AI 용 시야까지 따로 굴리는 비용에
// 비해 체감 차이가 거의 없어서 의도적으로 생략했다.
import { ENEMY, TILE, type Entity } from './types';
import { BUILDINGS, UNITS } from './data';
import { Game } from './game';
import { footprintOf } from './map';

const WORKER_TARGET = 14;
const GAS_WORKERS = 3;

export class AI {
  private think = 0;
  /** 다음 공격을 나가는 병력 기준선 — 한 번 밀 때마다 조금씩 올라간다 */
  private attackAt = 6;
  private attacking = false;
  /** ⚠ 소유자를 생성자로 받는다 — 실제 게임에선 항상 ENEMY 지만, 이렇게 해두면 헤드리스로
   * AI 대 AI 를 돌려 "게임이 실제로 끝까지 진행되는지"를 검증할 수 있다. */
  private owner: number;
  private foe: number;

  constructor(owner: number = ENEMY) {
    this.owner = owner;
    this.foe = owner === ENEMY ? 0 : ENEMY;
  }

  update(g: Game, dt: number) {
    this.think -= dt;
    if (this.think > 0) return;
    this.think = 0.5;

    const my = this.owner;
    const p = g.players[my];
    const buildings = g.buildingsOf(my);
    const units = g.unitsOf(my);
    const workers = units.filter((u) => UNITS[u.type]?.isWorker);
    const army = units.filter((u) => !UNITS[u.type]?.isWorker);
    const cc = buildings.find((b) => b.type === 'cc' && b.progress >= 1);

    this.manageWorkers(g, workers);

    // 1) 일꾼 — 커맨드 센터가 놀지 않게 채운다
    if (cc && workers.length < WORKER_TARGET && cc.queue.length === 0) g.train(cc, 'scv');

    // 2) 인구 — 막히기 전에 미리 짓는다(막힌 뒤에 지으면 이미 늦다).
    // 생산 시설이 늘수록 인구가 더 빨리 차므로 여유분도 같이 키운다.
    const depotsPending = buildings.filter((b) => b.type === 'depot' && b.progress < 1).length;
    const buildingDepot = this.someoneBuilding(units, 'depot');
    const buffer = 3 + buildings.filter((b) => (BUILDINGS[b.type]?.produces?.length ?? 0) > 0).length * 2;
    if (p.supplyUsed + buffer >= p.supplyMax + depotsPending * 8 && p.supplyMax < 200 && !buildingDepot && p.minerals >= 100) {
      this.build(g, workers, 'depot');
    }

    // 3) 테크 — 배럭 → 리파이너리 → 팩토리 순
    const has = (t: string) => buildings.some((b) => b.type === t);
    if (!has('barracks') && p.minerals >= 150 && !this.someoneBuilding(units, 'barracks')) this.build(g, workers, 'barracks');
    else if (has('barracks') && !has('refinery') && p.minerals >= 100 && !this.someoneBuilding(units, 'refinery'))
      this.build(g, workers, 'refinery');
    else if (has('refinery') && !has('factory') && p.minerals >= 200 && p.gas >= 100 && !this.someoneBuilding(units, 'factory'))
      this.build(g, workers, 'factory');
    // 배럭 추가 증설 — 미네랄이 남아돌면 생산 시설이 부족하다는 뜻이다.
    // ⚠ 예전엔 상한이 3이고 대기열도 1칸이라 AI 가 미네랄을 1000 넘게 쌓아두고도 병력을 못 뽑았다.
    else if (
      has('barracks') &&
      p.minerals >= 350 &&
      buildings.filter((b) => b.type === 'barracks').length < 6 &&
      !this.someoneBuilding(units, 'barracks')
    )
      this.build(g, workers, 'barracks');

    // 4) 병력 생산 — 가스가 있으면 탱크/파이어뱃을 섞는다.
    // 자원이 쌓여 있으면 대기열을 더 깊게 채워 남는 미네랄을 계속 병력으로 바꾼다.
    const maxQueue = p.minerals > 600 ? 3 : p.minerals > 300 ? 2 : 1;
    for (const b of buildings) {
      if (b.progress < 1 || b.queue.length >= maxQueue) continue;
      if (b.type === 'barracks') {
        if (p.gas >= 25 && has('refinery') && Math.random() < 0.35) g.train(b, 'firebat');
        else g.train(b, 'marine');
      } else if (b.type === 'factory') {
        g.train(b, 'tank');
      }
    }

    // 5) 공격 — 기준선을 넘으면 플레이어 본진으로 밀고 들어간다
    if (!this.attacking && army.length >= this.attackAt) {
      this.attacking = true;
      const target = this.playerTarget(g);
      for (const u of army) g.orderMove(u, target.x, target.y, true);
      this.attackAt = Math.min(28, this.attackAt + 4);
    } else if (this.attacking) {
      // 병력이 절반 밑으로 줄면 물러나 다시 모은다
      if (army.length < this.attackAt * 0.4) {
        this.attacking = false;
        const home = g.map.bases[this.owner];
        for (const u of army) g.orderMove(u, (home.bx + 2) * TILE, (home.by + 5) * TILE);
      } else {
        // 놀고 있는 병력은 계속 밀어붙인다
        const target = this.playerTarget(g);
        for (const u of army) if (u.order.kind === 'idle') g.orderMove(u, target.x, target.y, true);
      }
    } else {
      // 대기 중인 병력은 본진 앞에 모아둔다
      const home = g.map.bases[this.owner];
      for (const u of army)
        if (u.order.kind === 'idle') g.orderMove(u, (home.bx + 2) * TILE + (Math.random() - 0.5) * 120, (home.by + 6) * TILE + (Math.random() - 0.5) * 120);
    }
  }

  /** 일꾼이 놀고 있으면 자원에 붙이고, 리파이너리가 완성되면 몇 명을 가스로 돌린다. */
  private manageWorkers(g: Game, workers: Entity[]) {
    const gasBuildings = g.entities.filter((e) => e.type === 'refinery' && e.owner === this.owner && e.progress >= 1);
    let onGas = workers.filter((w) => {
      const t = w.order.target ? g.byId.get(w.order.target) : null;
      return t?.type === 'refinery' || w.carryType === 'gas';
    }).length;
    for (const w of workers) {
      if (w.order.kind === 'build') continue;
      if (w.order.kind === 'idle') {
        const m = g.nearestResource(w, 'mineral');
        if (m) g.orderGather(w, m);
      }
      if (gasBuildings.length > 0 && onGas < GAS_WORKERS && w.order.kind === 'gather' && w.carryType !== 'gas') {
        const t = w.order.target ? g.byId.get(w.order.target) : null;
        if (t?.type === 'mineral') {
          g.orderGather(w, gasBuildings[0]);
          onGas++;
        }
      }
    }
  }

  private someoneBuilding(units: Entity[], type: string): boolean {
    return units.some((u) => u.order.kind === 'build' && u.order.buildType === type);
  }

  /** 채집 중이 아닌(혹은 가장 한가한) 일꾼을 뽑아 건물을 짓게 한다. */
  private build(g: Game, workers: Entity[], type: string) {
    const spec = BUILDINGS[type];
    if (!spec) return;
    const worker = workers.find((w) => w.order.kind === 'gather' && w.carrying === 0) ?? workers.find((w) => w.order.kind !== 'build');
    if (!worker) return;

    if (spec.onGeyser) {
      // 리파이너리는 아직 안 먹은 간헐천 중 본진에서 가장 가까운 곳에
      const home = g.map.bases[this.owner];
      const hx = (home.bx + 2) * TILE;
      const hy = (home.by + 1.5) * TILE;
      let best: Entity | null = null;
      let bd = Infinity;
      for (const e of g.entities) {
        if (e.type !== 'geyser' || e.refinery) continue;
        const d = Math.hypot(e.x - hx, e.y - hy);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      if (!best) return;
      const f = footprintOf(best);
      if (f) g.orderBuild(worker, type, f.bx, f.by);
      return;
    }

    const spot = this.findSpot(g, spec.w, spec.h);
    if (spot) g.orderBuild(worker, type, spot.bx, spot.by);
  }

  /** 본진 주변을 나선형으로 훑어 빈 자리를 찾는다. 자원 근처는 피한다(일꾼 동선을 막으면
   * 채집 효율이 통째로 떨어진다). */
  private findSpot(g: Game, w: number, h: number): { bx: number; by: number } | null {
    const home = g.map.bases[this.owner];
    const cx = home.bx + 2;
    const cy = home.by + 1;
    for (let r = 3; r < 16; r++) {
      const cands: { bx: number; by: number }[] = [];
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          cands.push({ bx: cx + dx, by: cy + dy });
        }
      // 같은 링 안에서는 무작위로 골라 건물이 한 방향으로만 쏠리지 않게
      cands.sort(() => Math.random() - 0.5);
      for (const c of cands) {
        if (!g.canPlace('depot', c.bx, c.by, this.owner)) continue;
        let ok = true;
        for (let ty = c.by; ty < c.by + h && ok; ty++)
          for (let tx = c.bx; tx < c.bx + w && ok; tx++) if (g.map.isBlockedTile(tx, ty)) ok = false;
        if (!ok) continue;
        // 자원과 너무 붙으면 스킵
        const near = g.entities.some(
          (e) => e.kind === 'resource' && Math.abs(e.x / TILE - c.bx) < 3.5 && Math.abs(e.y / TILE - c.by) < 3.5,
        );
        if (near) continue;
        return c;
      }
    }
    return null;
  }

  /** 공격 목표 — 보이는 플레이어 건물 중 가장 앞선 것, 없으면 플레이어 본진 위치 */
  private playerTarget(g: Game): { x: number; y: number } {
    const home = g.map.bases[this.owner];
    const hx = (home.bx + 2) * TILE;
    const hy = (home.by + 1) * TILE;
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of g.entities) {
      if (e.owner !== this.foe) continue;
      const d = Math.hypot(e.x - hx, e.y - hy);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (best) return { x: best.x, y: best.y };
    const pb = g.map.bases[this.foe];
    return { x: (pb.bx + 2) * TILE, y: (pb.by + 1) * TILE };
  }
}
