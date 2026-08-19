import { useSettingsStore, type FontSize, type Theme, type TradingMode } from '@/store/useSettingsStore';
import {
  useChartStore,
  BOOK_ROWS_MIN,
  BOOK_ROWS_MAX,
  type ChartColorScheme,
} from '@/store/useChartStore';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: '다크' },
  { value: 'light', label: '라이트' },
  { value: 'high-contrast', label: '고대비' },
];

const CHART_COLOR_SCHEMES: { value: ChartColorScheme; label: string }[] = [
  { value: 'binance', label: '바이낸스' },
  { value: 'okx', label: 'OKX' },
  { value: 'tradingview', label: '트레이딩뷰' },
];

// 슬라이더를 잘게 끌기 어려운 모바일용 빠른 선택값(BOOK_ROWS_MIN~MAX 범위 안).
const BOOK_ROW_PRESETS = [5, 10, 20, 30, 50];

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
  const colorScheme = useChartStore((s) => s.colorScheme);
  const setColorScheme = useChartStore((s) => s.setColorScheme);
  const bookRows = useChartStore((s) => s.bookRows);
  const setBookRows = useChartStore((s) => s.setBookRows);
  const bookTogether = useChartStore((s) => s.bookTogether);
  const toggleChart = useChartStore((s) => s.toggle);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl"
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
            <h3 className="mb-2 text-xs font-semibold text-muted">차트 색상 (다크 테마일 때 적용)</h3>
            <div className="grid grid-cols-3 gap-2">
              {CHART_COLOR_SCHEMES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setColorScheme(c.value)}
                  className={`rounded-lg px-2 py-2.5 text-xs font-semibold ring-1 transition ${
                    colorScheme === c.value
                      ? 'bg-accent/15 text-accent ring-accent'
                      : 'bg-panel2 text-text ring-border hover:bg-elevated'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted">호가 · 체결 표시 개수</h3>
              <span className="rounded bg-panel2 px-2 py-0.5 text-[11px] font-bold text-accent">{bookRows}개</span>
            </div>
            <input
              type="range"
              min={BOOK_ROWS_MIN}
              max={BOOK_ROWS_MAX}
              value={bookRows}
              onChange={(e) => setBookRows(Number(e.target.value))}
              className="w-full accent-accent"
              aria-label="호가 · 체결 표시 개수"
            />
            <div className="mt-2 grid grid-cols-5 gap-1.5">
              {BOOK_ROW_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setBookRows(n)}
                  className={`rounded-md px-1 py-1.5 text-[11px] font-semibold ring-1 transition ${
                    bookRows === n
                      ? 'bg-accent/15 text-accent ring-accent'
                      : 'bg-panel2 text-text ring-border hover:bg-elevated'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              호가창의 매수·매도 각 열과 체결 목록이 한 화면에 보여줄 행 수({BOOK_ROWS_MIN}~{BOOK_ROWS_MAX}개).
              실제 코인은 거래소 호가 스트림이 최대 20단계까지만 주므로 그보다 많이 설정해도 20줄까지만 채워집니다.
            </p>

            {/* PC 전용 옵션 — 모바일은 폭이 좁아 항상 탭이다(OrderBook 이 화면 폭도 함께 본다). */}
            <button
              onClick={() => toggleChart('bookTogether')}
              className={`mt-2 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left ring-1 transition ${
                bookTogether ? 'bg-accent/15 ring-accent' : 'bg-panel2 ring-border hover:bg-elevated'
              }`}
            >
              <span className="min-w-0">
                <span className={`block text-xs font-bold ${bookTogether ? 'text-accent' : 'text-text'}`}>
                  PC 에서 호가 · 체결 같이 보기
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  탭 전환 없이 호가(위)·체결(아래)을 함께 표시 — 모바일은 폭이 좁아 그대로 탭입니다
                </span>
              </span>
              <span
                className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-bold ${
                  bookTogether ? 'bg-accent/20 text-accent' : 'bg-elevated text-muted'
                }`}
              >
                {bookTogether ? '켬' : '끔'}
              </span>
            </button>
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
