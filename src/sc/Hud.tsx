import type { RefObject } from 'react';
import { BUILDINGS, BUILD_ORDER, UNITS, nameOf } from './data';
import { unitTint } from './render';

export interface HudSel {
  ids: number[];
  /** 선택한 것들을 종류별로 묶은 요약(마린 ×8 처럼) */
  groups: { type: string; count: number }[];
  primary: {
    id: number;
    type: string;
    kind: string;
    owner: number;
    hp: number;
    maxHp: number;
    queue: { type: string; progress: number }[];
    rally: boolean;
  } | null;
  hasWorker: boolean;
  ownUnits: boolean;
}

export interface HudProps {
  minerals: number;
  gas: number;
  supplyUsed: number;
  supplyMax: number;
  elapsed: number;
  sel: HudSel;
  buildMenu: boolean;
  placing: string | null;
  attackMode: boolean;
  notice: string | null;
  minimapRef: RefObject<HTMLCanvasElement>;
  minimapSize: number;
  onMinimapDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onMinimapMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onMinimapUp: () => void;
  onCommand: (cmd: 'attackMove' | 'stop' | 'hold' | 'buildMenu' | 'cancel') => void;
  onBuild: (type: string) => void;
  onTrain: (type: string) => void;
  onCancelTrain: (index: number) => void;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function Btn({
  label,
  sub,
  hotkey,
  onClick,
  disabled,
  tint,
  active,
  title,
}: {
  label: string;
  sub?: string;
  hotkey?: string;
  onClick: () => void;
  disabled?: boolean;
  tint?: string;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        // 폰에서도 손가락으로 누를 수 있는 크기를 유지한다(터치 타깃 최소 44px 권장)
        'relative flex h-12 w-[4.2rem] flex-col items-center justify-center gap-0.5 rounded-md border text-[10px] font-bold leading-tight transition sm:h-14 sm:w-[4.6rem] sm:text-[11px] ' +
        (active ? 'border-accent bg-panel2 ' : 'border-border bg-panel2/60 hover:border-accent ') +
        'disabled:cursor-not-allowed disabled:opacity-35'
      }
      style={tint ? { color: tint } : undefined}
    >
      <span>{label}</span>
      {sub && <span className="text-[9px] font-normal text-muted">{sub}</span>}
      {hotkey && <span className="absolute right-1 top-0.5 text-[8px] text-muted">{hotkey}</span>}
    </button>
  );
}

export default function Hud(p: HudProps) {
  const { sel } = p;
  const supplyBlocked = p.supplyUsed >= p.supplyMax;
  const prim = sel.primary;
  const primIsOwnBuilding = prim && prim.kind === 'building' && prim.owner === 0;
  const produces = primIsOwnBuilding ? (BUILDINGS[prim.type]?.produces ?? []) : [];

  return (
    <>
      {/* 상단 자원 표시 */}
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-3 rounded-lg bg-black/60 px-3 py-1.5 font-mono text-sm tabular-nums text-white shadow-lg">
        <span className="text-[#4fd8f5]">◆ {p.minerals}</span>
        <span className="text-[#3fce7a]">▲ {p.gas}</span>
        <span className={supplyBlocked ? 'text-[#ff7676]' : 'text-white'}>
          ⛨ {p.supplyUsed}/{p.supplyMax}
        </span>
        <span className="text-white/50">{fmtTime(p.elapsed)}</span>
      </div>

      {p.placing && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-xs font-bold text-white">
          {nameOf(p.placing)} 지을 곳을 클릭하세요 · 우클릭/Esc 로 취소
        </div>
      )}
      {p.attackMode && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-[#e6503f]/80 px-4 py-1.5 text-xs font-bold text-white">
          공격 이동 — 목표 지점을 클릭하세요
        </div>
      )}
      {p.notice && (
        <div className="pointer-events-none absolute left-1/2 top-14 -translate-x-1/2 rounded-md bg-[#c9433a] px-3 py-1.5 text-xs font-bold text-white shadow-lg">
          {p.notice}
        </div>
      )}

      {/* 하단 콘솔: 미니맵 / 선택 정보 / 커맨드 카드.
          좁은 화면에선 미니맵을 줄이고 선택 정보를 숨겨 커맨드 카드가 밀려나지 않게 한다. */}
      <div className="flex shrink-0 items-stretch gap-1.5 border-t border-border bg-panel p-1.5 sm:gap-2 sm:p-2">
        <canvas
          ref={p.minimapRef}
          width={p.minimapSize}
          height={p.minimapSize}
          onPointerDown={p.onMinimapDown}
          onPointerMove={p.onMinimapMove}
          onPointerUp={p.onMinimapUp}
          onPointerLeave={p.onMinimapUp}
          onContextMenu={(e) => e.preventDefault()}
          className="aspect-square h-[104px] w-[104px] shrink-0 cursor-pointer rounded border border-border sm:h-[168px] sm:w-[168px]"
          style={{ touchAction: 'none' }}
        />

        <div className="hidden min-w-0 flex-1 rounded border border-border bg-panel2/40 p-2 md:block">
          {sel.ids.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted">
              좌클릭·드래그로 선택하고 우클릭으로 이동/공격/채집합니다. 일꾼을 고른 뒤 <b className="text-text">건설(B)</b>로 건물을
              짓고, 커맨드 센터를 골라 일꾼을 뽑으세요.
            </p>
          ) : (
            <div className="flex h-full flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {sel.groups.map((g) => (
                  <span key={g.type} style={{ color: unitTint(g.type) }} className="font-bold">
                    {nameOf(g.type)}
                    {g.count > 1 && <span className="ml-1 text-muted">×{g.count}</span>}
                  </span>
                ))}
              </div>
              {prim && (
                <>
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-black/40">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(prim.hp / prim.maxHp) * 100}%`,
                          background: prim.hp / prim.maxHp > 0.6 ? '#4ade80' : prim.hp / prim.maxHp > 0.3 ? '#facc15' : '#f87171',
                        }}
                      />
                    </span>
                    <span className="tabular-nums">
                      {Math.ceil(prim.hp)}/{prim.maxHp}
                    </span>
                    {prim.rally && <span className="text-accent">랠리 지정됨</span>}
                  </div>
                  <p className="text-[10px] leading-snug text-muted">
                    {UNITS[prim.type]?.desc ?? BUILDINGS[prim.type]?.desc ?? ''}
                  </p>
                  {prim.queue.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      {prim.queue.map((q, i) => (
                        <button
                          key={i}
                          onClick={() => p.onCancelTrain(i)}
                          title="클릭해서 취소(자원 환불)"
                          className="relative h-8 w-8 overflow-hidden rounded border border-border bg-panel2 text-[9px] font-bold hover:border-down"
                          style={{ color: unitTint(q.type) }}
                        >
                          {nameOf(q.type).slice(0, 2)}
                          <span className="absolute bottom-0 left-0 h-1 bg-accent" style={{ width: `${q.progress * 100}%` }} />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto sm:gap-1.5 md:flex-none md:overflow-visible" style={{ maxWidth: '100%' }}>
          {p.buildMenu
            ? BUILD_ORDER.map((t) => {
                const b = BUILDINGS[t];
                const lack = p.minerals < b.costM || p.gas < b.costG;
                return (
                  <Btn
                    key={t}
                    label={b.name.replace('서플라이 ', '')}
                    sub={`${b.costM}${b.costG ? `/${b.costG}` : ''}`}
                    hotkey={b.hotkey}
                    disabled={lack}
                    active={p.placing === t}
                    title={`${b.desc}${lack ? ' — 자원이 부족합니다' : ''}`}
                    onClick={() => p.onBuild(t)}
                  />
                );
              }).concat(
                <Btn key="__cancel" label="취소" hotkey="Esc" onClick={() => p.onCommand('cancel')} />,
              )
            : [
                ...produces.map((t) => {
                  const u = UNITS[t];
                  const lack = p.minerals < u.costM || p.gas < u.costG;
                  return (
                    <Btn
                      key={t}
                      label={u.name}
                      sub={`${u.costM}${u.costG ? `/${u.costG}` : ''}`}
                      hotkey={u.hotkey}
                      tint={unitTint(t)}
                      disabled={lack}
                      title={`${u.desc}${lack ? ' — 자원이 부족합니다' : ''}`}
                      onClick={() => p.onTrain(t)}
                    />
                  );
                }),
                ...(sel.ownUnits
                  ? [
                      <Btn key="am" label="공격 이동" hotkey="A" active={p.attackMode} onClick={() => p.onCommand('attackMove')} />,
                      <Btn key="st" label="정지" hotkey="S" onClick={() => p.onCommand('stop')} />,
                      <Btn key="hd" label="사수" hotkey="H" onClick={() => p.onCommand('hold')} />,
                    ]
                  : []),
                ...(sel.hasWorker ? [<Btn key="bd" label="건설" hotkey="B" onClick={() => p.onCommand('buildMenu')} />] : []),
              ]}
        </div>
      </div>
    </>
  );
}
