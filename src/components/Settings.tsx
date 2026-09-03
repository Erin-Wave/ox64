import { useState } from 'react';
import { useSettingsStore, type FontSize, type Theme, type TradingMode } from '@/store/useSettingsStore';
import {
  useChartStore,
  BOOK_ROWS_MIN,
  BOOK_ROWS_MAX,
  type ChartColorScheme,
  type TradeFilterBasis,
} from '@/store/useChartStore';
import { fmtNumInput, unfmtNum } from '@/format';

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

const TRADE_BASES: { value: TradeFilterBasis; label: string; desc: string }[] = [
  { value: 'notional', label: '거래대금', desc: '가격 × 수량 (USDT)' },
  { value: 'qty', label: '수량', desc: '코인 개수' },
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
  const colorScheme = useChartStore((s) => s.colorScheme);
  const setColorScheme = useChartStore((s) => s.setColorScheme);
  const bookRows = useChartStore((s) => s.bookRows);
  const setBookRows = useChartStore((s) => s.setBookRows);
  const bookTogether = useChartStore((s) => s.bookTogether);
  const toggleChart = useChartStore((s) => s.toggle);
  const tradeFilterOn = useChartStore((s) => s.tradeFilterOn);
  const tradeFilterBasis = useChartStore((s) => s.tradeFilterBasis);
  const tradeFilterMin = useChartStore((s) => s.tradeFilterMin);
  const tradeFilterMax = useChartStore((s) => s.tradeFilterMax);
  const tradeStrength = useChartStore((s) => s.tradeStrength);
  const setTradeFilter = useChartStore((s) => s.setTradeFilter);
  // 입력칸은 로컬 문자열이 진실원본(OrderPanel 수량칸과 같은 이유) — 스토어는 숫자라 지우는 도중
  // ''→0→'0' 으로 되돌아와 타이핑이 막힌다. 스토어엔 확정값만 밀어넣는다(빈칸=제한 없음=null).
  const [minInput, setMinInput] = useState(tradeFilterMin != null ? String(tradeFilterMin) : '');
  const [maxInput, setMaxInput] = useState(tradeFilterMax != null ? String(tradeFilterMax) : '');
  const unitLabel = tradeFilterBasis === 'qty' ? '개' : 'USDT';

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
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted">체결 목록 필터</h3>
              <button
                onClick={() => toggleChart('tradeFilterOn')}
                className={`rounded px-2 py-0.5 text-[11px] font-bold ring-1 transition ${
                  tradeFilterOn ? 'bg-accent/15 text-accent ring-accent' : 'bg-panel2 text-muted ring-border hover:bg-elevated'
                }`}
              >
                {tradeFilterOn ? '켬' : '끔'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TRADE_BASES.map((b) => (
                <button
                  key={b.value}
                  onClick={() => setTradeFilter({ basis: b.value })}
                  className={`rounded-lg px-3 py-2 text-left ring-1 transition ${
                    tradeFilterBasis === b.value
                      ? 'bg-accent/15 ring-accent'
                      : 'bg-panel2 ring-border hover:bg-elevated'
                  }`}
                >
                  <div className={`text-xs font-bold ${tradeFilterBasis === b.value ? 'text-accent' : 'text-text'}`}>
                    {b.label}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">{b.desc}</div>
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] text-muted">이 값 이상만</label>
                <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                  <input
                    value={fmtNumInput(minInput)}
                    onChange={(e) => {
                      const v = unfmtNum(e.target.value);
                      setMinInput(v);
                      setTradeFilter({ min: v ? Number(v) : null });
                    }}
                    inputMode="decimal"
                    placeholder="제한 없음"
                    className="w-full bg-transparent px-2.5 py-1.5 text-xs font-semibold text-text outline-none placeholder:text-muted"
                  />
                  <span className="shrink-0 px-2 text-[10px] text-muted">{unitLabel}</span>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[10px] text-muted">이 값 이하만</label>
                <div className="flex items-center rounded-md bg-panel2 ring-1 ring-border focus-within:ring-elevated">
                  <input
                    value={fmtNumInput(maxInput)}
                    onChange={(e) => {
                      const v = unfmtNum(e.target.value);
                      setMaxInput(v);
                      setTradeFilter({ max: v ? Number(v) : null });
                    }}
                    inputMode="decimal"
                    placeholder="제한 없음"
                    className="w-full bg-transparent px-2.5 py-1.5 text-xs font-semibold text-text outline-none placeholder:text-muted"
                  />
                  <span className="shrink-0 px-2 text-[10px] text-muted">{unitLabel}</span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              체결 목록에 이 범위의 체결만 보여줍니다(호가·차트·거래엔 영향 없는 <span className="text-text">표시 필터</span>).
              설정은 <span className="text-text">모든 심볼에 똑같이</span> 적용되므로, 심볼을 옮겨 다니며 쓸 거면
              가격대에 상관없는 <span className="text-text">거래대금</span> 기준이 편합니다(수량 기준은 BTC 0.5개와 PEPE
              수십억 개가 같은 잣대를 받습니다). 필터가 걸려 있으면 체결 탭에 뱃지가 뜨고, 뱃지를 누르면 바로 꺼집니다.
            </p>

            <button
              onClick={() => toggleChart('tradeStrength')}
              className={`mt-2 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left ring-1 transition ${
                tradeStrength ? 'bg-accent/15 ring-accent' : 'bg-panel2 ring-border hover:bg-elevated'
              }`}
            >
              <span className="min-w-0">
                <span className={`block text-xs font-bold ${tradeStrength ? 'text-accent' : 'text-text'}`}>
                  강세 · 약세 레벨 배경
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  체결 가격 뒤에 <span className="text-text">그 시점 평균보다 싸게(약세) · 비싸게(강세)</span> 체결됐는지를
                  1~3 레벨 바로 은은하게 깝니다 — 많이 벗어날수록 바가 길어집니다(마우스를 올리면 평균 대비 %)
                </span>
              </span>
              <span
                className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-bold ${
                  tradeStrength ? 'bg-accent/20 text-accent' : 'bg-elevated text-muted'
                }`}
              >
                {tradeStrength ? '켬' : '끔'}
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
