import { useState } from 'react';
import { ICON_META, WILD_META, ANY_META } from './data';

/** 아이콘 범례 — 카드에 붙은 이모지가 무슨 속성인지 한 줄로 알려준다. 로비/게임 양쪽에서 쓴다. */
export function IconLegend({ compact }: { compact?: boolean }) {
  const items = [
    ...Object.values(ICON_META),
    { ...WILD_META, label: `${WILD_META.label}(아무 속성으로나)` },
    ...(compact ? [] : [{ ...ANY_META, label: `${ANY_META.label}(아무 카드나)` }]),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      {items.map((m) => (
        <span key={m.label} className="flex items-center gap-1" style={{ color: m.color }}>
          <span>{m.emoji}</span>
          <span className="text-muted">{m.label}</span>
        </span>
      ))}
    </div>
  );
}

/** 게임 규칙 설명 — 처음 들어온 사람이 뭘 해야 하는지 알 수 있게 로비에 펼쳐둔다. */
export default function Rules({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-border bg-panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left text-sm font-bold hover:brightness-110"
      >
        <span>📖 어떻게 하는 게임인가요?</span>
        <span className="text-muted">{open ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 text-xs leading-relaxed text-muted">
          <p>
            <b className="text-text">5분 안에 던전을 끝내는 협동 게임입니다.</b> 턴이 없습니다 — 파티원 모두가 동시에,
            아무 때나 카드를 냅니다. 타이머가 다 되기 전에 마지막 보스까지 잡으면 승리입니다.
          </p>
          <div>
            <p className="mb-1 font-bold text-text">1. 카드를 내서 요구치를 채웁니다</p>
            <p>
              화면 가운데에 몬스터·포션·보스 카드가 한 장씩 공개되고, 각 카드는 <b className="text-text">필요한 속성과 양</b>을
              보여줍니다(예: ⚔️힘 3 · 🔮마법 2). 내 손패에서 맞는 속성의 카드를 눌러 채우면 되고, 파티원 누구의 카드든
              합산됩니다. 다 채우면 즉시 격파되고 다음 카드가 열립니다.
            </p>
          </div>
          <div>
            <p className="mb-1 font-bold text-text">2. 손패가 막히면 휴식하세요</p>
            <p>
              손패는 5장이고, 낸 만큼 자동으로 채워집니다. 쓸 카드가 없으면 <b className="text-text">휴식</b>으로 손패를
              통째로 버리고 새로 뽑을 수 있습니다(횟수 제한 없음). 버린 카드는 덱이 떨어지면 다시 섞여 돌아옵니다.
            </p>
          </div>
          <div>
            <p className="mb-1 font-bold text-text">3. 함정과 포션</p>
            <p>
              🕸️<b className="text-text">함정</b>은 열리는 즉시 자동 발동해 파티 체력을 깎고 손패를 버리게 합니다(막을 수
              있는 건 팔라딘의 특수뿐). 🧪<b className="text-text">포션</b>은 아무 카드로나 채울 수 있고, 채우면 파티 체력을
              회복합니다.
            </p>
          </div>
          <div>
            <p className="mb-1 font-bold text-text">4. 영웅마다 특수 능력이 1회씩</p>
            <p>
              영웅에겐 판당 딱 한 번 쓰는 고유 능력이 있습니다(즉시 요구치 채우기, 체력 회복, 손패 보충, 함정 무효화 등).
              아껴뒀다가 결정적일 때 쓰세요.
            </p>
          </div>
          <div>
            <p className="mb-1 font-bold text-text">패배 조건</p>
            <p>
              5분 타이머 만료 · 파티 체력 0 · 파티 전원이 낼 카드도 뽑을 카드도 없어짐(지침) — 셋 중 하나라도 걸리면
              던전 실패입니다.
            </p>
          </div>
          <div>
            <p className="mb-1 font-bold text-text">속성 보기</p>
            <IconLegend />
          </div>
          <p className="text-[11px] opacity-70">
            ※ 인원이 많을수록 몬스터 요구치가 함께 올라갑니다(1인은 낮게, 4인은 높게). 파티의 영웅들이 낼 수 없는 속성은
            자동으로 «아무거나»로 바뀌어 어떤 조합이든 클리어할 수 있습니다.
          </p>
        </div>
      )}
    </div>
  );
}
