import { useSettingsStore, type FontSize, type Theme, type TradingMode } from '@/store/useSettingsStore';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: '다크' },
  { value: 'light', label: '라이트' },
  { value: 'high-contrast', label: '고대비' },
];

const FONT_SIZES: { value: FontSize; label: string }[] = [
  { value: 'sm', label: '작게' },
  { value: 'md', label: '보통' },
  { value: 'lg', label: '크게' },
];

export default function Settings({ onClose }: { onClose: () => void }) {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const tradingMode = useSettingsStore((s) => s.tradingMode);
  const setTradingMode = useSettingsStore((s) => s.setTradingMode);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-extrabold text-text">⚙️ 설정</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted transition hover:text-text">
            ✕
          </button>
        </div>

        <div className="space-y-5 p-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted">테마</h3>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTheme(t.value)}
                  className={`rounded-lg px-2 py-2.5 text-xs font-semibold ring-1 transition ${
                    theme === t.value
                      ? 'bg-accent/15 text-accent ring-accent'
                      : 'bg-panel2 text-text ring-border hover:bg-elevated'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted">거래 모드</h3>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: 'easy' as TradingMode, label: 'Easy', desc: '시장가 주문만' },
                  { value: 'standard' as TradingMode, label: 'Standard', desc: '지정가 · 손절 · 익절' },
                ] as const
              ).map((m) => (
                <button
                  key={m.value}
                  onClick={() => setTradingMode(m.value)}
                  className={`rounded-lg px-3 py-2.5 text-left ring-1 transition ${
                    tradingMode === m.value
                      ? 'bg-accent/15 ring-accent'
                      : 'bg-panel2 ring-border hover:bg-elevated'
                  }`}
                >
                  <div className={`text-sm font-bold ${tradingMode === m.value ? 'text-accent' : 'text-text'}`}>
                    {m.label}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">{m.desc}</div>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted">폰트 크기</h3>
            <div className="grid grid-cols-3 gap-2">
              {FONT_SIZES.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFontSize(f.value)}
                  className={`rounded-lg px-2 py-2.5 text-xs font-semibold ring-1 transition ${
                    fontSize === f.value
                      ? 'bg-accent/15 text-accent ring-accent'
                      : 'bg-panel2 text-text ring-border hover:bg-elevated'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
