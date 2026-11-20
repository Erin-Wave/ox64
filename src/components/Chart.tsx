import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type WhitespaceData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fetchKlines, fetchPricePrecision } from '@/services/binanceRest';
import { klineStream } from '@/services/binanceWs';
import { profileValues, type Series } from '@/services/indicators';
import {
  INDICATOR_DEFS,
  INDICATOR_TYPES_BY_GROUP,
  indicatorTitle,
  type IndicatorFormat,
  type IndicatorLineDef,
  type IndicatorParamDef,
  type IndicatorType,
  type LineStyleName,
  type ProfileDraw,
} from '@/services/indicatorDefs';
import { ProfilePrimitive, type ProfileLayer } from '@/services/profilePrimitive';
import { HiLoPrimitive } from '@/services/hiLoPrimitive';
import { api } from '@/services/api';
import { useMarketStore } from '@/store/useMarketStore';
import { useChartStore, type IndicatorConfig, type ChartColorScheme } from '@/store/useChartStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useTradingStore } from '@/store/useTradingStore';
import { intervalSec, KST_OFFSET, isVirtualSymbol, quoteOf, pairLabel } from '@/symbols';
import { ListingOverlay } from '@/components/Listing';
import { bithumbKlineStream, bithumbSupports, fetchBithumbKlines } from '@/services/bithumb';
import { fmtPrice, fmtPriceShort, fmtQtyShort, virtualPrecision } from '@/format';
import Clock from '@/components/Clock';
import { lockedMargin, positionMargin } from '@/hooks/useEquity';
import IntervalPicker from '@/components/IntervalPicker';
import type { Candle } from '@/types';

const IND_COLORS = ['#f0b90b', '#4a90e2', '#c77dff', '#00c076', '#ff6b6b', '#3bb2d0', '#e08fd6'];

// 차트 캔버스 색(배경/격자/축 텍스트/캔들) — UI 크롬은 index.css 의 CSS 변수로,
// Lightweight Charts 는 캔버스 렌더링이라 여기서 별도로 applyOptions() 해줘야 함.
// 라이트/고대비는 사이트 테마 고정 배색, 다크일 때만 거래소 프리셋(바이낸스/OKX/트레이딩뷰)으로 세분화.
// mark = 차트 위에 얹는 최고·최저가 라벨 글자색 — 축 글자(text)는 회색이라 캔들 사이에선 잘 안 보였다(제보) → 다크는 밝은 흰색, 라이트는 진한 먹색.
type ChartColors = { bg: string; text: string; mark: string; grid: string; border: string; up: string; down: string };
const LIGHT_THEME: ChartColors = { bg: '#ffffff', text: '#6b727a', mark: '#1e2329', grid: '#e7e9ec', border: '#d6dadf', up: '#00875c', down: '#d1293f' };
const HIGH_CONTRAST_THEME: ChartColors = { bg: '#000000', text: '#c8c8c8', mark: '#ffffff', grid: '#333333', border: '#ffffff', up: '#00ff80', down: '#ff1744' };
const DARK_SCHEMES: Record<ChartColorScheme, ChartColors> = {
  binance: { bg: '#0b0d0f', text: '#7c828b', mark: '#d5d8dc', grid: '#191c21', border: '#282c33', up: '#0ecb81', down: '#f6465d' },
  okx: { bg: '#14151a', text: '#76808f', mark: '#d5d8dc', grid: '#1d1f26', border: '#2f333d', up: '#00b897', down: '#ff5b5b' },
  tradingview: { bg: '#131722', text: '#787b86', mark: '#d1d4dc', grid: '#1e222d', border: '#2a2e39', up: '#26a69a', down: '#ef5350' },
};

// 캔들 가격축 위 여백(scaleMargins.top) — 왼쪽 위 OHLCV 레전드 높이만큼 늘려 가장 높은 꼬리(최고가 라벨)가 레전드 아래에서 시작하게 한다.
// 모바일처럼 폭이 좁으면 레전드가 2~3줄로 접혀 6% 여백으로는 최고가 라벨이 레전드 글자와 겹쳤다(제보).
const TOP_MARGIN_MIN = 0.06;
const TOP_MARGIN_MAX = 0.35; // 지표가 많아 레전드가 길게 접혀도 캔들이 납작해지지 않게
const LEGEND_GAP_PX = 10; // 레전드 아래 끝 ~ 가장 높은 꼬리(라벨 글자 반 높이 + 여유)
// 차트 클릭(→ 지정가 입력)은 이만큼 미뤘다가 보낸다 — 더블클릭(전체화면)의 첫 클릭이 지정가를 덮어쓰지 않게.
const CLICK_DEFER_MS = 250;
// 하단(오실레이터 패널 + 거래량)이 차트 높이에서 가져갈 수 있는 최대 몫 — 나머지(위 여백 포함)는 캔들 몫
const BOTTOM_SHARE_MAX = 0.5;
// 패널 맨 위 레전드 한 줄 높이(px) — 그 아래부터 선을 그린다
const PANE_LEGEND_PX = 17;
// 수평선(그리기 도구) 색 — 주문선(녹·적·앰버)과 겹치지 않는 파랑(트레이딩뷰 그리기 기본색)
const HLINE_COLOR = '#2962ff';

/** 수평선 그리기 아이콘 */
function HLineIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 12h18" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </svg>
  );
}

/** 전체화면 들어가기/나오기 아이콘 */
function FullscreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {exit ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}
function chartColors(theme: 'dark' | 'light' | 'high-contrast', colorScheme: ChartColorScheme): ChartColors {
  if (theme === 'light') return LIGHT_THEME;
  if (theme === 'high-contrast') return HIGH_CONTRAST_THEME;
  return DARK_SCHEMES[colorScheme];
}

// ⚠ 거래량 막대 색은 **반드시 캔들 색에서 파생**시킨다. 예전엔 `rgba(0,192,118,0.45)` 처럼 하드코딩해서
// 테마/프리셋을 바꿔도 거래량만 바이낸스 배색으로 남아 캔들과 따로 놀았다(라이트 테마에선 특히 튐).
// 색을 새로 쓰지 말고 항상 이 함수를 거칠 것.
const VOL_ALPHA = 0.45;
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const v = parseInt(n, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}
function volColors(c: ChartColors): { up: string; down: string } {
  return { up: withAlpha(c.up, VOL_ALPHA), down: withAlpha(c.down, VOL_ALPHA) };
}

type IndSeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
/** 인디케이터 인스턴스 하나 = 선 키 → 시리즈 (indicatorDefs 의 lines 와 1:1) */
type IndSeriesMap = Map<string, IndSeries>;
/** 레전드 값: 선 키 → 그 시점 값 */
type IndLegendValue = Record<string, number>;

const toChart = (t: number) => (t + KST_OFFSET) as UTCTimestamp;
const fmtKst = (realSec: number, withSeconds = false) => {
  const d = new Date((realSec + KST_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(d.getUTCSeconds())}` : base;
};
// ⚠ null 은 건너뛰지 않고 whitespace(`{time}` 만)로 넣는다 — **그 자리에서 선이 끊겨야** 하는 지표가 있다
// (SuperTrend 국면 전환, Ichimoku 후행스팬 끝, 워밍업). 건너뛰면 LWC 가 앞뒤 점을 이어 있지도 않은 선을 그린다.
const line = (arr: Series, times: number[]): (LineData | WhitespaceData)[] =>
  arr.map((v, i) => (v == null ? { time: toChart(times[i]) } : { time: toChart(times[i]), value: v }));
/** 점마다 국면 색을 입힌 선(indicatorDefs 의 colorByState). 판정이 없는 점은 시리즈 기본색.
 * ⚠ LWC 는 선분 (i−1 → i) 을 **시작점 i−1 의 색**으로 긋는다. 그대로 넣으면 국면이 바뀐 봉으로 들어가는 선분이
 * 이전 국면 색이라, OBV 가 기준선을 뚫는 바로 그 선분이 뚫기 전 국면으로 칠해진다("기준선을 뚫었는데 왜 정리?").
 * 그래서 점 i 에는 **다음 봉(i+1)의 국면 색**을 넣는다 → "이 봉으로 들어오는 선분 = 이 봉의 국면"(레전드와 일치). */
const stateLine = (arr: Series, times: number[], state: Series, colors: string[]): (LineData | WhitespaceData)[] =>
  arr.map((v, i) => {
    if (v == null) return { time: toChart(times[i]) };
    const st = state[i + 1] ?? state[i];
    const c = st == null ? undefined : colors[st];
    return c ? { time: toChart(times[i]), value: v, color: c } : { time: toChart(times[i]), value: v };
  });
/** 히스토그램 — 'sign' 은 0 위아래(MACD), 'slope' 는 직전 막대보다 커졌나(AO, 같으면 하락색 — 트레이딩뷰와 같다). */
const histData = (arr: Series, times: number[], up: string, down: string, mode: 'sign' | 'slope' = 'sign'): (HistogramData | WhitespaceData)[] => {
  let prev: number | null = null;
  return arr.map((v, i) => {
    if (v == null) return { time: toChart(times[i]) };
    const rising = mode === 'sign' ? v >= 0 : prev == null || v > prev;
    prev = v;
    return { time: toChart(times[i]), value: v, color: rising ? up : down };
  });
};
/** 시간(초)으로 봉 인덱스를 찾는다(오름차순 이진 탐색, 없으면 −1). */
const barIndexAt = (candles: Candle[], time: number): number => {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = candles[mid].time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
};
/** 선 길이가 봉 수를 넘으면(Ichimoku 선행스팬 = n+kijun) 마지막 봉 뒤로 인터벌만큼 시간을 늘려 붙인다. */
const extendTimes = (times: number[], extra: number, stepSec: number): number[] => {
  const out = times.slice();
  let last = times.length ? times[times.length - 1] : 0;
  for (let i = 0; i < extra; i++) out.push((last += stepSec));
  return out;
};
const LWC_STYLE: Record<LineStyleName, LineStyle> = { solid: LineStyle.Solid, dotted: LineStyle.Dotted, dashed: LineStyle.Dashed };
const fmtIndValue = (fmt: IndicatorFormat, v: number, prec: number): string =>
  fmt === 'price'
    ? fmtPriceShort(v, prec, 9)
    : fmt === 'fixed1'
      ? v.toFixed(1)
      : fmt === 'fixed2'
        ? v.toFixed(2)
        : fmt === 'fixed3'
          ? v.toFixed(3)
          : fmt === 'pct'
            ? `${v.toFixed(0)}%`
            : // 거래량 계열(OBV·거래량 이평)은 유효숫자 5자리 — 이평이 13.005504 처럼 소수 8자리까지 늘어져 레전드가 길어졌다
              fmtQtyShort(Number(v.toPrecision(5)), 9);
/** 레전드 선 약어(파라미터에 따라 바뀌는 것 포함) */
const lineLabel = (ln: IndicatorLineDef, params: Record<string, number>) => (ln.labelOf ? ln.labelOf(params) : ln.label);

/** 이평선 묶음 빠른 추가(국내 거래소·HTS 에서 가장 흔한 조합) */
const MA_SET = [5, 20, 60, 120];

/** 지표 파라미터 입력칸. ⚠ 입력 중인 글자(draft)를 따로 들고 있다 — 예전엔 칸 값이 곧 스토어 값이라 칸을 비우는 순간 최솟값으로
 * 바뀌어(20 을 지우면 1 → 이어 친 50 이 150) 소수("2." 을 치는 순간 0.5 로)를 칠 수 없었다. 범위 안의 값이면 치는 대로 바로 반영하고
 * (차트가 따라 바뀐다), 칸을 떠날 때(포커스 해제·Enter) 범위로 잘라 확정한다. ↑/↓ 키는 step 만큼. */
function ParamInput({ p, value, onCommit }: { p: IndicatorParamDef; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const step = p.step ?? 1;
  const decimals = (String(step).split('.')[1] ?? '').length;
  const finish = () => {
    if (draft == null) return;
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n)) onCommit(n); // 범위 밖이면 스토어가 잘라낸다
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft ?? String(value)}
      onChange={(e) => {
        const s = e.target.value;
        setDraft(s);
        const n = Number(s);
        if (s.trim() !== '' && Number.isFinite(n) && n >= p.min && n <= p.max) onCommit(n);
      }}
      onFocus={(e) => e.target.select()}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const base = Number(draft ?? value);
          const next = Number(((Number.isFinite(base) ? base : value) + (e.key === 'ArrowUp' ? step : -step)).toFixed(decimals));
          const clamped = Math.min(p.max, Math.max(p.min, next));
          setDraft(String(clamped));
          onCommit(clamped);
        }
      }}
      className="w-12 rounded bg-panel2 px-1 py-0.5 text-right text-xs text-text outline-none ring-1 ring-border focus:ring-accent/60"
      // 범위 밖 값은 칸을 떠날 때 잘리므로 범위를 같이 보여준다 — "2 이상 안 올라간다"가 버그로 안 보이게
      title={`${p.label} · ${p.min}~${p.max}`}
      aria-label={p.label}
    />
  );
}

/** 인디케이터 표시/숨김 아이콘(눈 / 빗금 친 눈). 이모지는 폰트에 따라 깨져서 인라인 SVG 로. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

export default function Chart() {
  const symbol = useMarketStore((s) => s.symbol);
  const interval = useMarketStore((s) => s.interval);
  const setIntervalCode = useMarketStore((s) => s.setInterval);
  const setPrecision = useMarketStore((s) => s.setPrecision);
  const setConnected = useMarketStore((s) => s.setConnected);

  const opts = useChartStore();
  const theme = useSettingsStore((s) => s.theme);
  const orders = useTradingStore((s) => s.orders);
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);
  const conditionalOrders = useTradingStore((s) => s.conditionalOrders);
  const cancelLimit = useTradingStore((s) => s.cancelLimit);
  const cancelConditional = useTradingStore((s) => s.cancelConditional);
  const balance = useTradingStore((s) => s.balance);
  const krwBalance = useTradingStore((s) => s.krwBalance);
  const prices = useMarketStore((s) => s.prices);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const indSeriesRef = useRef<Map<string, IndSeriesMap>>(new Map());
  // syncIndicators() 가 candlesRef 와 나란한 인덱스로 채워두는 원본 계산값(선 키별) —
  // 크로스헤어가 벗어났을 때(마지막 값) 또는 hover 시점 조회에 사용.
  const indValuesRef = useRef<Map<string, Record<string, Series>>>(new Map());
  // 매물대(indicatorDefs 의 profile 지표) — 보이는 구간을 다시 셀 때마다(refreshProfiles) 바뀌는 결과와, 그걸 그리는 프리미티브
  const profilesRef = useRef<Map<string, ProfileDraw>>(new Map());
  const profilePrimRef = useRef<ProfilePrimitive | null>(null);
  const profileSigRef = useRef('');
  const refreshProfilesRef = useRef<() => void>(() => {});
  // 보이는 구간 최고·최저가 라벨(OKX 식) — 계산·그리기 전부 프리미티브 안(팬·줌·새 봉마다 LWC 가 다시 부른다)
  const hiLoPrimRef = useRef<HiLoPrimitive | null>(null);
  // 캔들 가격축 여백 — top 은 레전드 높이에서(fitTopMargin), bottom 은 하단 패널 스택에서(syncIndicators) 따로 정해 한 번에 적용
  const legendRef = useRef<HTMLDivElement>(null);
  const marginsRef = useRef({ top: TOP_MARGIN_MIN, bottom: 0.04 });
  const topPendingRef = useRef(false);
  const fitTopMarginRef = useRef<() => void>(() => {});
  // 전체화면(차트 더블클릭) — 차트만 화면 전체에. 브라우저 전체화면은 되는 곳에서만(아이폰 사파리는 CSS 로만 덮는다)
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;
  const browserFsRef = useRef(false);
  const toggleExpandedRef = useRef<() => void>(() => {});
  // 수평선 그리기 — 켜면 다음 차트 클릭이 지정가 대신 그 가격에 수평선을 긋는다(한 번 긋고 꺼진다, Esc 취소)
  const [drawMode, setDrawMode] = useState(false);
  const drawModeRef = useRef(false);
  drawModeRef.current = drawMode;
  const hLineRefs = useRef<IPriceLine[]>([]);
  const syncLineLabelsRef = useRef<() => void>(() => {});
  // 과거로 스크롤해 마지막 봉이 화면 밖이면 "최신으로" 버튼
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const latestQuietUntilRef = useRef(0);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const volMap = useRef<Map<number, number>>(new Map());
  const priceLines = useRef<IPriceLine[]>([]);
  const hovering = useRef(false);
  const lastCalc = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const syncIndicatorsRef = useRef<() => void>(() => {});

  // 하단 패널 배치(syncIndicators 가 정한다) — 패널마다 제 이름·값을 그 패널 왼쪽 위에 붙인다(트레이딩뷰식). top = 그림 영역 높이 대비 0~1.
  // ⚠ 예전엔 오실레이터 값까지 전부 맨 위 레전드 한 덩어리에 넣어서, 폰에서 지표 몇 개만 올려도 레전드가 여러 줄로 불어나 캔들을 덮었고
  //   어느 패널이 어느 지표인지도 화면에 안 보였다(2026-11-18).
  const [paneLayout, setPaneLayout] = useState<{ panes: { id: string; top: number }[]; volTop: number | null }>({ panes: [], volTop: null });
  const paneSigRef = useRef('');
  // 그림 영역(시간축 제외) 높이(px) — 패널 레전드 위치 계산용, 크기가 바뀔 때만(fitTopMargin)
  const [plotH, setPlotH] = useState(0);
  const plotHRef = useRef(0);
  const applyPaneLayoutRef = useRef<() => void>(() => {});
  const [legend, setLegend] = useState<Candle | null>(null);
  const [indLegend, setIndLegend] = useState<Record<string, IndLegendValue>>({});
  const [countdown, setCountdown] = useState('');
  // 불러온 봉 구간(첫 봉|마지막 봉 시각) — 바뀌면 매매 마커를 다시 봉에 맞춘다(§ 매매 마커). 값이 같으면 렌더도 안 일어난다.
  const [barsKey, setBarsKey] = useState('');
  const markBars = (arr: Candle[]) => setBarsKey(arr.length ? `${arr[0].time}|${arr[arr.length - 1].time}` : '');
  // 카운트다운 위치 — 트레이딩뷰처럼 우측 가격축의 현재가 티커(마지막 봉 종가 라벨) 바로 아래에 붙인다.
  // top=현재가 y좌표, width=가격축 너비, up=마지막 봉 방향(색상). 가격/스케일 변화마다 갱신.
  const [countdownPos, setCountdownPos] = useState<{ top: number; width: number; up: boolean } | null>(null);
  const countdownPosRef = useRef<{ top: number; width: number; up: boolean } | null>(null);
  const repositionCountdownRef = useRef<() => void>(() => {});

  // 미체결(지정가)·조건부 주문선 옆의 취소(X) 버튼 위치 — 각 주문 가격의 y좌표에 얹는다(카운트다운과 동일 패턴).
  // conditional=true 면 조건부(스탑) 주문(취소는 cancelConditional 로 라우팅, 앰버색으로 구분).
  type PendBtn = {
    id: string;
    top: number;
    axisW: number;
    sell: boolean;
    reduceOnly: boolean;
    conditional: boolean;
    label: string;
    /** 주문이 아니라 수평선(지우기 · 알림 버튼) */
    hline?: boolean;
    alert?: boolean;
  };
  const [pendBtns, setPendBtns] = useState<PendBtn[]>([]);
  const pendBtnsRef = useRef<PendBtn[]>([]);
  const repositionPendBtnsRef = useRef<() => void>(() => {});
  const [showOpts, setShowOpts] = useState(false);
  const [prec, setPrec] = useState(2); // 현재 심볼 가격 소수 자릿수
  const precRef = useRef(prec);
  precRef.current = prec;

  // 크로스헤어가 벗어나 있을 때(또는 최초) 보여줄 "마지막 봉" 기준 지표값.
  // indValuesRef 는 그냥 ref 라 여기서 최신값을 읽어도 클로저 staleness 문제가 없다.
  const lastIndLegend = (): Record<string, IndLegendValue> => {
    const out: Record<string, IndLegendValue> = {};
    const n = candlesRef.current.length;
    if (n === 0) return out;
    for (const [id, vals] of indValuesRef.current) {
      const rec: IndLegendValue = {};
      let any = false;
      for (const [key, arr] of Object.entries(vals)) {
        // 선행스팬처럼 봉 수보다 긴 선도 "현재 봉" 자리(n-1)의 값을 보여준다
        const v = arr[n - 1];
        if (v != null) {
          rec[key] = v;
          any = true;
        }
      }
      if (any) out[id] = rec;
    }
    // 매물대는 봉마다의 값이 없다 — 보이는 구간 전체의 POC·VAH·VAL
    for (const [id, pr] of profilesRef.current) out[id] = profileValues(pr);
    return out;
  };

  // 카운트다운을 현재가(마지막 봉 종가) 라벨의 y좌표 바로 아래로 옮긴다(우측 가격축 위, 트레이딩뷰식).
  // 가격/스케일이 바뀔 때마다(WS 틱·폴링·팬/줌·1초 틱·크로스헤어) 호출한다 — refs 만 읽어 stale 문제 없음.
  // 미체결 주문선의 취소(X) 버튼을 각 지정가 y좌표에 재배치한다. 카운트다운과 같은 트리거(팬/줌·틱·1초)
  // 에서 함께 불리도록 repositionCountdown 안에서 호출한다. opts.pendingLine 이 꺼져 있으면 안 그린다.
  const repositionPendBtns = () => {
    syncLineLabelsRef.current(); // 화면 밖 가격선의 가격축 라벨 끄기(가격축 폭 — § syncLineLabels)
    const chart = chartRef.current;
    const c = candleRef.current;
    const clear = () => {
      if (pendBtnsRef.current.length) {
        pendBtnsRef.current = [];
        setPendBtns([]);
      }
    };
    if (!chart || !c) return clear();
    const showOrders = optsRef.current.pendingLine;
    const axisW = chart.priceScale('right').width();
    // ⚠ priceToCoordinate 는 화면 밖 가격도 좌표를 **외삽해** 돌려준다 — 그대로 그리면 멀리 걸린 주문(분할 지정가 등)의 X 버튼이
    // 차트 영역 밖으로 삐져나와 아래 주문·포지션 패널 위에 떠 있었다(모바일에서 특히, 2026-11-02). 차트 안(시간축 위)에 보이는 것만.
    const paneH = (containerRef.current?.clientHeight ?? 0) - chart.timeScale().height();
    // 캔들 영역 아래(거래량·오실레이터 패널)에 걸린 선의 버튼은 그 패널 위에 떠서 이름·값을 가린다 — 캔들 영역 안에 보이는 것만
    const candleBottom = paneH * (1 - marginsRef.current.bottom) + 2;
    const visible = (y: number | null): y is number => y != null && y >= 0 && y <= candleBottom;
    const next: PendBtn[] = [];
    for (const o of pendingOrders) {
      if (!showOrders || o.symbol !== symbol) continue;
      const y = c.priceToCoordinate(o.limitPrice);
      if (!visible(y)) continue;
      next.push({
        id: o.id,
        top: y as number,
        axisW,
        sell: o.side === 'short',
        reduceOnly: o.reduceOnly,
        conditional: false,
        label: `${o.reduceOnly ? '청산 ' : ''}${o.side === 'long' ? '매수' : '매도'} ${fmtQtyShort(o.size, 9)}`,
      });
    }
    for (const c2 of conditionalOrders) {
      if (!showOrders || c2.symbol !== symbol) continue;
      const y = c.priceToCoordinate(c2.triggerPrice);
      if (!visible(y)) continue;
      next.push({
        id: c2.id,
        top: y as number,
        axisW,
        sell: c2.side === 'short',
        reduceOnly: false,
        conditional: true,
        label: `조건부${c2.repeating ? '∞' : ''} ${c2.side === 'long' ? '롱' : '숏'} ${
          c2.triggerDir === 'above' ? '≥' : '≤'
        } ${fmtQtyShort(c2.size, 9)}${c2.repeating && c2.repeatMode === 'rearm' && !c2.armed ? ' (재무장 대기)' : ''}`,
      });
    }
    // 수평선 — 지우기(×)·알림(🔔) 버튼(주문선 표시 옵션과 무관)
    for (const l of useChartStore.getState().hLines[symbol] ?? []) {
      const y = c.priceToCoordinate(l.price);
      if (!visible(y)) continue;
      next.push({
        id: l.id,
        top: y as number,
        axisW,
        sell: false,
        reduceOnly: false,
        conditional: false,
        hline: true,
        alert: l.alert,
        label: `수평선 ${fmtPrice(l.price, precRef.current)}`,
      });
    }
    const prev = pendBtnsRef.current;
    // 개수·위치(±1px)·라벨·알림이 그대로면 리렌더 생략
    const same =
      prev.length === next.length &&
      prev.every(
        (p, i) =>
          p.id === next[i].id && Math.abs(p.top - next[i].top) < 1 && p.axisW === next[i].axisW && p.label === next[i].label && p.alert === next[i].alert,
      );
    if (same) return;
    pendBtnsRef.current = next;
    setPendBtns(next);
  };
  repositionPendBtnsRef.current = repositionPendBtns;

  // ⚠⚠ 화면 밖 가격선은 가격축 라벨을 끈다(2026-11-20, "GN 1분봉만 가격축이 빈 공간으로 엄청 넓다" 제보).
  // LWC 는 가격축 폭을 정할 때 **그 축의 모든 가격선 라벨**을 잰다 — 화면 밖이라 그려지지도 않는 라벨까지(lightweight-charts
  // PriceAxisWidget.optimalWidth → _backLabels, 위치를 보지 않는다). 잔고가 큰 계정의 숏 청산가는 진입가 + 평가자산/수량이라
  // 8×10⁴⁹ 같은 값이 되고(실제 GN 숏 3,650억 개·잔고 2.9e61), 그 50자리 라벨 폭만큼 가격축이 빈 칸으로 넓어졌다. 멀리 걸린
  // 지정가·조건부·SL/TP·수평선도 같다. 그래서 선은 그대로 두고 **라벨만** 화면 안(가격축 높이 ±8px)에 있을 때 켠다 — 화면 밖
  // 라벨은 원래 안 보이므로 잃는 것이 없다. 카운트다운·버튼 재배치와 같은 때(팬·줌·새 봉·1초 틱·크로스헤어) 다시 맞춘다.
  // 끄고 켤 때만 applyOptions(값이 같으면 손대지 않는다 — 라벨을 바꾸면 축 폭이 바뀌어 다시 그려진다).
  const syncLineLabels = () => {
    const chart = chartRef.current;
    const c = candleRef.current;
    if (!chart || !c) return;
    const paneH = (containerRef.current?.clientHeight ?? 0) - chart.timeScale().height();
    for (const pl of [...priceLines.current, ...hLineRefs.current]) {
      const o = pl.options();
      const y = c.priceToCoordinate(o.price);
      const on = y != null && y >= -8 && y <= paneH + 8;
      if (on !== o.axisLabelVisible) pl.applyOptions({ axisLabelVisible: on });
    }
  };
  syncLineLabelsRef.current = syncLineLabels;

  const repositionCountdown = () => {
    repositionPendBtnsRef.current(); // 미체결 취소버튼도 같은 트리거에서 함께 재배치
    const chart = chartRef.current;
    const c = candleRef.current;
    const last = candlesRef.current.at(-1);
    const clear = () => {
      if (countdownPosRef.current) {
        countdownPosRef.current = null;
        setCountdownPos(null);
      }
    };
    if (!chart || !c || !last) return clear();
    const y = c.priceToCoordinate(last.close);
    if (y == null) return clear();
    const next = { top: y as number, width: chart.priceScale('right').width(), up: last.close >= last.open };
    const prev = countdownPosRef.current;
    // 1px 미만 이동·같은 너비/색이면 리렌더 생략(WS 틱이 초당 여러 번 와도 낭비 방지)
    if (prev && Math.abs(prev.top - next.top) < 1 && prev.width === next.width && prev.up === next.up) return;
    countdownPosRef.current = next;
    setCountdownPos(next);
  };
  repositionCountdownRef.current = repositionCountdown;

  // 캔들 가격축 여백 적용 — top 과 bottom 이 합쳐 1 을 넘으면 LWC 가 거부하므로 top 을 깎는다(하단 패널이 많을 때)
  const applyRightMargins = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const { top, bottom } = marginsRef.current;
    chart.priceScale('right').applyOptions({ scaleMargins: { top: Math.min(top, 0.9 - bottom), bottom } });
    requestAnimationFrame(() => repositionCountdownRef.current()); // 축이 다시 잡힌 뒤 카운트다운·X 버튼 위치
  };
  // 레전드 높이 → 위 여백. ⚠ 크로스헤어로 봉을 훑는 동안엔 바꾸지 않는다 — 레전드 값 길이에 따라 줄 수가 오가면
  // 마우스를 움직일 때마다 캔들이 위아래로 튄다. 미뤄 뒀다가 크로스헤어가 빠질 때 반영.
  const fitTopMargin = () => {
    const chart = chartRef.current;
    const box = containerRef.current;
    if (!chart || !box) return;
    const paneH = box.clientHeight - chart.timeScale().height();
    // 패널 레전드 위치는 크로스헤어와 무관하게 늘 맞춘다(패널 위 레전드 자리는 px 라 높이가 바뀌면 배치도 다시)
    if (paneH > 0 && Math.abs(paneH - plotHRef.current) >= 1) {
      plotHRef.current = paneH;
      setPlotH(paneH);
      applyPaneLayoutRef.current();
    }
    if (hovering.current) {
      topPendingRef.current = true;
      return;
    }
    topPendingRef.current = false;
    if (paneH <= 0) return;
    const lg = legendRef.current;
    const legendBottom = lg && lg.offsetHeight > 0 ? lg.offsetTop + lg.offsetHeight : 0;
    const top = Math.min(TOP_MARGIN_MAX, Math.max(TOP_MARGIN_MIN, (legendBottom + LEGEND_GAP_PX) / paneH));
    if (Math.abs(top - marginsRef.current.top) < 0.002) return;
    marginsRef.current.top = top;
    applyRightMargins();
  };
  fitTopMarginRef.current = fitTopMargin;

  // 전체화면 토글 — ⚠ requestFullscreen 은 사용자 입력 처리 중에만 허용되므로 이펙트가 아니라 여기(더블클릭·버튼 핸들러)서 부른다.
  // 문서 전체를 브라우저 전체화면으로 올리고 차트는 CSS 로 화면을 덮는다 — 차트 엘리먼트만 올리면 그 위에 뜨는 모달(리필 등)이 안 보인다.
  const toggleExpanded = () => {
    if (!expandedRef.current) {
      setExpanded(true);
      expandedRef.current = true; // fullscreenchange 가 리렌더보다 먼저 와도 맞게
      const el = document.documentElement;
      if (!document.fullscreenElement && typeof el.requestFullscreen === 'function') {
        el.requestFullscreen().catch(() => {}); // 막히면 CSS 로 덮은 것만으로 충분
      }
    } else {
      setExpanded(false);
      expandedRef.current = false;
      if (browserFsRef.current && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      browserFsRef.current = false;
    }
  };
  toggleExpandedRef.current = toggleExpanded;

  // ── 차트 생성 (1회) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const initTheme = chartColors(useSettingsStore.getState().theme, useChartStore.getState().colorScheme);
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: initTheme.bg },
        textColor: initTheme.text,
        fontFamily: 'Proxima Nova, sans-serif',
      },
      grid: { vertLines: { color: initTheme.grid }, horzLines: { color: initTheme.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: initTheme.border },
      timeScale: { borderColor: initTheme.border, timeVisible: true, secondsVisible: false },
      // 하단 크로스헤어 시간 라벨 = yyyy-MM-dd HH:mm:ss (KST, 이미 오프셋된 값이라 UTC 로 포맷)
      localization: {
        timeFormatter: (t: unknown) => {
          const d = new Date((t as number) * 1000);
          const p = (n: number) => String(n).padStart(2, '0');
          return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
        },
      },
      autoSize: true,
    });
    const candle = chart.addCandlestickSeries({
      upColor: initTheme.up,
      downColor: initTheme.down,
      borderVisible: false,
      wickUpColor: initTheme.up,
      wickDownColor: initTheme.down,
    });
    chartRef.current = chart;
    candleRef.current = candle;
    // 매물대 막대는 캔들 시리즈에 붙인 프리미티브 하나가 전부 그린다(지표가 없으면 아무것도 안 그린다)
    const profilePrim = new ProfilePrimitive();
    candle.attachPrimitive(profilePrim);
    profilePrimRef.current = profilePrim;
    const hiLoPrim = new HiLoPrimitive({
      candles: () => candlesRef.current,
      format: (v) => fmtPriceShort(v, precRef.current, 9),
    });
    hiLoPrim.setColors(initTheme.mark, initTheme.bg);
    hiLoPrim.setEnabled(useChartStore.getState().hiLoMarks);
    candle.attachPrimitive(hiLoPrim);
    hiLoPrimRef.current = hiLoPrim;
    // 팬·줌으로 보이는 구간이 바뀌면 매물대를 다시 센다 — 이벤트가 한 프레임에 여러 번 와도 한 번만
    let profileRaf = 0;
    const onProfileRange = () => {
      if (profileRaf) return;
      profileRaf = requestAnimationFrame(() => {
        profileRaf = 0;
        refreshProfilesRef.current();
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onProfileRange);
    // 마지막 봉이 화면 오른쪽 밖이면(과거를 보는 중) "최신으로" 버튼을 띄운다 — 폰에서 끌어서 되돌아오기가 번거롭다.
    // ⚠ LWC 의 애니메이션(최신으로 이동·관성 스크롤)은 **마지막 위치를 구독에 알리지 않는다**(실측: 끝 직전 프레임 to=497.3, 마지막 봉 499 에서
    //   멈춘 채 이벤트가 끊겼다) — 이벤트가 멎고 300ms 뒤 실제 구간을 한 번 더 읽는다. "최신으로"를 누른 뒤 이동하는 동안엔 띄우지 않는다.
    let latestTimer = 0;
    const checkLatest = () => {
      const r = chart.timeScale().getVisibleLogicalRange();
      const last = candlesRef.current.length - 1;
      setAwayFromLatest(r != null && last > 0 && r.to < last - 1 && performance.now() > latestQuietUntilRef.current);
    };
    const onLatestRange = () => {
      checkLatest();
      window.clearTimeout(latestTimer);
      latestTimer = window.setTimeout(checkLatest, 300);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onLatestRange);

    chart.subscribeCrosshairMove((param) => {
      repositionCountdownRef.current(); // 마우스 이동(팬/줌 포함) 시 축 라벨 따라 위치 갱신
      const c = candleRef.current;
      if (!c || param.time == null) {
        hovering.current = false;
        const l = candlesRef.current.at(-1);
        if (l) setLegend(l);
        setIndLegend(lastIndLegend());
        // 훑는 동안 미뤄 둔 위 여백 — 레전드가 마지막 봉 값으로 다시 그려진 뒤에 잰다
        if (topPendingRef.current) requestAnimationFrame(() => fitTopMarginRef.current());
        return;
      }
      const d = param.seriesData.get(c) as CandlestickData | undefined;
      if (!d) return;
      hovering.current = true;
      const real = (param.time as number) - KST_OFFSET;
      setLegend({ time: real, open: d.open, high: d.high, low: d.low, close: d.close, volume: volMap.current.get(real) });

      // 인디케이터 값 — 각 시리즈에 그 시점 데이터가 있으면 param.seriesData 에서 바로 조회.
      // whitespace 점(값 없음 = 선이 끊긴 자리)은 건너뛴다.
      const nextInd: Record<string, IndLegendValue> = {};
      let barIdx: number | undefined; // 필요할 때 한 번만 찾는다
      for (const [id, m] of indSeriesRef.current) {
        const rec: IndLegendValue = {};
        let any = false;
        for (const [key, s] of m) {
          const v = param.seriesData.get(s) as { value?: number } | undefined;
          if (v && typeof v.value === 'number') {
            rec[key] = v.value;
            any = true;
          }
        }
        // 선으로 안 그리는 값(국면 판정 등, indicatorDefs 의 states)은 시리즈가 없어 seriesData 로 못 찾는다 —
        // 계산 결과에서 그 봉의 인덱스로 직접 읽는다.
        const vals = any ? indValuesRef.current.get(id) : undefined;
        if (vals) {
          for (const key in vals) {
            if (m.has(key)) continue;
            if (barIdx === undefined) barIdx = barIndexAt(candlesRef.current, real);
            const v = barIdx < 0 ? null : vals[key][barIdx];
            if (v != null) rec[key] = v;
          }
        }
        if (any) nextInd[id] = rec;
      }
      // 매물대 — 구간 전체 값(POC 등) + 커서가 가리키는 가격대의 거래량·매수 비중
      if (profilesRef.current.size) {
        const cursor = param.point ? c.coordinateToPrice(param.point.y) : null;
        for (const [id, pr] of profilesRef.current) nextInd[id] = profileValues(pr, cursor);
      }
      setIndLegend(nextInd);
    });

    // 차트 클릭 → 클릭한 y좌표의 가격을 지정가 주문 입력에 흘려보낸다(OrderPanel 이 구독).
    // ⚠ 잠깐(CLICK_DEFER_MS) 미뤘다가 보낸다 — 더블클릭(전체화면)이면 LWC 가 첫 번째만 클릭으로 주므로, 바로 보내면
    // 전체화면으로 들어가는 것만으로 지정가 탭의 가격이 덮어써졌다. 더블클릭이 오면 대기 중인 클릭을 버린다.
    let clickTimer = 0;
    chart.subscribeClick((param) => {
      const c = candleRef.current;
      if (!c || !param.point) return;
      // 캔들 영역 아래(거래량·오실레이터 패널)를 누른 건 가격 클릭이 아니다 — 예전엔 거기서도 캔들 축으로 외삽한 엉뚱한 가격이 지정가에 들어갔다
      const ph = plotHRef.current;
      if (ph > 0 && param.point.y > ph * (1 - marginsRef.current.bottom) + 2) return;
      const raw = c.coordinateToPrice(param.point.y);
      if (raw == null) return;
      const price = Number(raw.toFixed(precRef.current));
      if (drawModeRef.current) {
        // 수평선 그리기 — 이 클릭은 지정가로 보내지 않는다
        window.clearTimeout(clickTimer);
        clickTimer = 0;
        useChartStore.getState().addHLine(useMarketStore.getState().symbol, price);
        setDrawMode(false);
        return;
      }
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        clickTimer = 0;
        useMarketStore.getState().setChartClickPrice(price);
      }, CLICK_DEFER_MS);
    });
    // 더블클릭(모바일은 더블탭) → 전체화면 토글. 가격축·시간축 더블클릭은 LWC 의 축 리셋이고 여기로 안 온다.
    chart.subscribeDblClick(() => {
      window.clearTimeout(clickTimer);
      clickTimer = 0;
      toggleExpandedRef.current();
    });

    return () => {
      window.clearTimeout(clickTimer);
      if (profileRaf) cancelAnimationFrame(profileRaf);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onProfileRange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onLatestRange);
      window.clearTimeout(latestTimer);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      profilePrimRef.current = null;
      hiLoPrimRef.current = null;
      profilesRef.current.clear();
      profileSigRef.current = '';
      indSeriesRef.current.clear();
      volRef.current = null;
    };
  }, []);

  // ── 테마/차트 색상 프리셋 변경 시 차트 캔버스(배경/격자/축/캔들) 재도색 ──────────
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;
    const c = chartColors(theme, opts.colorScheme);
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    candle.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    hiLoPrimRef.current?.setColors(c.mark, c.bg);
    // ⚠ 거래량 막대는 색이 각 데이터 포인트에 박혀 있어서 applyOptions 로는 안 바뀐다 — 테마가 바뀌면
    // 전체를 새 색으로 다시 그려야 캔들과 싱크가 유지된다(안 하면 테마 전환 직후 거래량만 옛 색).
    syncIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, opts.colorScheme]);

  // ── 초봉(1s) 등 1분 미만 타임프레임에서는 축/레전드에 초 단위까지 표시 ──
  const subMinute = intervalSec(interval) < 60;
  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: subMinute } });
  }, [subMinute]);

  useEffect(() => {
    hiLoPrimRef.current?.setEnabled(opts.hiLoMarks);
  }, [opts.hiLoMarks]);

  // 레전드가 접히거나(폭·지표 수) 차트 높이가 바뀌면(분할선·전체화면·회전) 위 여백을 다시 잰다
  useEffect(() => {
    const ro = new ResizeObserver(() => fitTopMarginRef.current());
    if (legendRef.current) ro.observe(legendRef.current);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // 전체화면: 브라우저 전체화면을 Esc 등으로 빠져나오면 차트도 원래 자리로. CSS 로만 덮은 경우(아이폰)는 Esc 로 닫는다.
  useEffect(() => {
    const onFs = () => {
      if (document.fullscreenElement) {
        // 들어가는 사이에 다시 더블클릭해 이미 나왔으면 브라우저 전체화면도 되돌린다(차트는 제자리인데 화면만 꽉 찬 상태 방지)
        if (!expandedRef.current) document.exitFullscreen().catch(() => {});
        else browserFsRef.current = true;
      } else if (browserFsRef.current) {
        browserFsRef.current = false;
        setExpanded(false);
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawMode]);
  // 심볼을 바꾸면 그리기 모드는 끈다(엉뚱한 코인에 선이 생기지 않게)
  useEffect(() => setDrawMode(false), [symbol]);

  // ── 수평선(그리기 도구) — 이 심볼의 선을 캔들 가격선으로 ──
  const hLinesHere = opts.hLines[symbol];
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    for (const pl of hLineRefs.current) c.removePriceLine(pl);
    hLineRefs.current = [];
    for (const l of hLinesHere ?? []) {
      hLineRefs.current.push(
        // 제목은 비운다 — 선 오른쪽 끝(제목 자리)에 지우기·알림 버튼이 얹혀 가려진다. 알림 상태는 🔔 버튼 색으로 보인다
        c.createPriceLine({ price: l.price, color: HLINE_COLOR, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' }),
      );
    }
    repositionPendBtnsRef.current(); // 지우기·알림 버튼 위치
  }, [hLinesHere, symbol]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement && !document.querySelector('[role="dialog"]')) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // ── 매물대(가격대별 거래량) — 보이는 봉 구간을 다시 세어 프리미티브에 넘긴다 ──────────
  // indicatorDefs 에 profile 이 있는 지표만(타입 분기 없음). 새 봉·지표 설정(syncIndicators 끝)과 팬·줌(보이는 구간 변화)에서 부른다.
  const refreshProfiles = () => {
    const chart = chartRef.current;
    const prim = profilePrimRef.current;
    if (!chart || !prim) return;
    const o = optsRef.current;
    const candles = candlesRef.current;
    const range = chart.timeScale().getVisibleLogicalRange();
    const next = new Map<string, ProfileDraw>();
    const layers: ProfileLayer[] = [];
    if (range && candles.length) {
      const th = chartColors(useSettingsStore.getState().theme, o.colorScheme);
      // 반쯤 걸친 양 끝 봉까지(봉 i 는 논리 좌표 i−0.5 ~ i+0.5 를 차지한다). 범위 밖은 volumeProfile 이 잘라낸다
      const from = Math.round(range.from);
      const to = Math.round(range.to);
      o.indicators.forEach((ind, idx) => {
        const def = INDICATOR_DEFS[ind.type];
        if (!def.profile || !ind.visible) return;
        const prof = def.profile(candles, from, to, ind.params);
        if (!prof) return;
        next.set(ind.id, prof);
        layers.push({
          prof,
          width: prof.width,
          upIn: withAlpha(th.up, 0.42),
          upOut: withAlpha(th.up, 0.16),
          downIn: withAlpha(th.down, 0.42),
          downOut: withAlpha(th.down, 0.16),
          line: IND_COLORS[idx % IND_COLORS.length],
        });
      });
    }
    const had = profilesRef.current.size > 0;
    profilesRef.current = next;
    if (!had && next.size === 0) return; // 매물대를 안 쓰면 아무것도 안 한다(다른 지표만 쓸 때 비용 0)
    prim.setLayers(layers);
    // 레전드(POC·VAH·VAL)는 값이 바뀌었을 때만 갱신 — 팬하는 동안 프레임마다 Chart 를 다시 렌더하지 않게
    const sig = [...next].map(([id, p]) => `${id}:${p.lo}:${p.step}:${p.poc}:${p.vaLo}:${p.vaHi}`).join('|');
    if (sig !== profileSigRef.current) {
      profileSigRef.current = sig;
      if (!hovering.current) setIndLegend(lastIndLegend());
    }
  };
  refreshProfilesRef.current = refreshProfiles;

  // ── 인디케이터 동기화 (candlesRef 기준 재계산) ────────────────
  // opts 를 직접 클로징하지 않고 optsRef 로 항상 최신 값을 읽는다.
  // (WS 구독 이펙트처럼 symbol/interval 변경시에만 재생성되는 이펙트 안에서
  //  옵션 토글 직후 옛 클로저가 다시 실행되며 방금 켠 지표를 지워버리는 버그 방지)
  const syncIndicators = () => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || candles.length === 0) return;
    const o = optsRef.current;
    const times = candles.map((c) => c.time);

    // 더 이상 존재하지 않는 인디케이터 인스턴스의 시리즈 제거
    const activeIds = new Set(o.indicators.map((i) => i.id));
    for (const [id, m] of indSeriesRef.current) {
      if (activeIds.has(id)) continue;
      for (const s of m.values()) chart.removeSeries(s);
      indSeriesRef.current.delete(id);
      indValuesRef.current.delete(id);
    }

    // 거래량 히스토그램 — 최하단. ⚠ 지표 시리즈보다 **먼저** 만든다: LWC 는 나중에 만든 시리즈를 위에 그려서, 거래량 이평(pane
    // 'volume')이 먼저 만들어지면 막대 뒤로 숨는다. 거래량을 껐다 다시 켜 막대가 새로 생기면 그 위의 지표 시리즈도 다시 만든다.
    if (o.volume) {
      if (!volRef.current) {
        // lastValueVisible=true → 우측 축에 최신 거래량 티커(1.23M 형식) 표시
        volRef.current = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: true });
        for (const ind of o.indicators) {
          if (INDICATOR_DEFS[ind.type].pane !== 'volume') continue;
          const m = indSeriesRef.current.get(ind.id);
          if (!m) continue;
          for (const s of m.values()) chart.removeSeries(s);
          indSeriesRef.current.delete(ind.id);
        }
      }
      const vc = volColors(chartColors(useSettingsStore.getState().theme, o.colorScheme));
      volRef.current.setData(
        candles.map((c) => ({
          time: toChart(c.time),
          value: c.volume ?? 0,
          color: c.close >= c.open ? vc.up : vc.down,
        })) as HistogramData[],
      );
    } else if (volRef.current) {
      chart.removeSeries(volRef.current);
      volRef.current = null;
    }

    // 레지스트리(indicatorDefs) 기반 — 여기엔 지표 타입 분기가 없다. 선 하나 = 시리즈 하나,
    // own 패널 지표는 priceScaleId = 지표 id 로 자기 축을 갖는다(아래 스택 배치).
    const themeColors = chartColors(useSettingsStore.getState().theme, o.colorScheme);
    const histUp = withAlpha(themeColors.up, 0.6);
    const histDown = withAlpha(themeColors.down, 0.6);
    const stepSec = intervalSec(interval);
    o.indicators.forEach((ind: IndicatorConfig, idx: number) => {
      const def = INDICATOR_DEFS[ind.type];
      const base = IND_COLORS[idx % IND_COLORS.length];
      let found = indSeriesRef.current.get(ind.id);
      if (!found) {
        found = new Map<string, IndSeries>();
        indSeriesRef.current.set(ind.id, found);
      }
      const series = found;
      // own = 자기 패널(축 id = 지표 id), volume = 거래량 막대의 축('vol'), 그 외 = 캔들 축
      const scaleId = def.pane === 'own' ? ind.id : def.pane === 'volume' ? 'vol' : 'right';
      // 거래량 위에 얹는 지표는 거래량을 끄면 같이 숨긴다 — 'vol' 축은 거래량이 켜져 있을 때만 맨 아래 15% 로 잡혀 있어서,
      // 그대로 두면 축 여백이 없는 채로 캔들 영역 전체에 그려진다
      const shown = ind.visible && (def.pane !== 'volume' || o.volume);
      const vals = def.compute(candles, ind.params);
      indValuesRef.current.set(ind.id, vals);
      def.lines.forEach((ln, li) => {
        if (ln.kind === 'value') return; // 레전드 값만 찍는 칸(매물대 POC 등) — 선을 만들지 않는다
        const color = ln.color ?? base;
        let s = series.get(ln.key);
        if (!s) {
          if (ln.kind === 'hist') {
            s = chart.addHistogramSeries({ priceScaleId: scaleId, base: 0, priceLineVisible: false, lastValueVisible: false });
          } else {
            s = chart.addLineSeries({
              color,
              lineWidth: ln.width ?? 1,
              lineStyle: LWC_STYLE[ln.style ?? 'solid'],
              priceScaleId: scaleId,
              priceLineVisible: false,
              lastValueVisible: false,
              // 점 표시(Parabolic SAR): 선은 숨기고 점만 찍는다
              ...(ln.kind === 'dots' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, crosshairMarkerVisible: false } : {}),
              // 가격축 범위에서 빼는 선(엔벨로프 ±%) — null = 이 시리즈는 축 맞춤에 안 들어간다
              ...(ln.autoscale === false ? { autoscaleInfoProvider: () => null } : {}),
            });
          }
          if (li === 0 && def.levels) {
            for (const lv of def.levels) {
              s.createPriceLine({ price: lv.value, color: lv.color ?? '#88888855', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
            }
          }
          series.set(ln.key, s);
        }
        const arr = vals[ln.key] ?? [];
        const t = arr.length > times.length ? extendTimes(times, arr.length - times.length, stepSec) : times;
        if (ln.kind === 'hist') {
          (s as ISeriesApi<'Histogram'>).setData(histData(arr, t, histUp, histDown, ln.histColor));
        } else if (ln.colorByState && def.states) {
          const colors = def.states.labels.map((l) => l.color);
          (s as ISeriesApi<'Line'>).setData(stateLine(arr, t, vals[def.states.key] ?? [], colors));
          (s as ISeriesApi<'Line'>).applyOptions({ color });
        } else {
          (s as ISeriesApi<'Line'>).setData(line(arr, t));
          // 앞의 지표가 지워지면 배정색(idx)이 바뀌므로 매번 맞춘다 — 레전드 점 색과 어긋나지 않게
          (s as ISeriesApi<'Line'>).applyOptions({ color });
        }
        // 숨김 ≠ 삭제. 시리즈·설정은 그대로 두고 visible 만 끈다(다시 켤 때 재생성 비용 0).
        s.applyOptions({ visible: shown });
      });
    });

    applyPaneLayout();
    refreshProfiles(); // 봉·설정·색이 바뀌었다 — 매물대도 다시 센다
  };
  syncIndicatorsRef.current = syncIndicators;

  // 하단 영역 스택 배치: [캔들] / [own 패널 지표들 — 보이는 것만] / [거래량]. 패널이 늘면 높이를 나눠 쓴다(숨긴 지표는 자리를 차지하지 않는다).
  // ⚠ 하단(패널+거래량) 몫은 BOTTOM_SHARE_MAX 까지 — 예전 상한(패널만 55% + 거래량 15%)이면 오실레이터 셋에 캔들이 30% 남짓이었고, 폰에서
  //   레전드 여백까지 빼면 캔들이 한 줄로 납작해졌다(2026-11-18). 패널이 셋 이상이면 거래량 몫도 15→10% 로 줄인다.
  // 패널 맨 위 한 줄(≈15px)은 그 패널의 이름·값 자리라 선을 그 아래부터 그린다(px 로 잡으므로 높이가 바뀌면 다시 — fitTopMargin).
  const applyPaneLayout = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const o = optsRef.current;
    // 시리즈가 아직 없는 패널(막 추가돼 syncIndicators 전)은 축도 없다 — 빼고 잡는다(곧 syncIndicators 가 다시 부른다)
    const panes = o.indicators.filter((i) => i.visible && INDICATOR_DEFS[i.type].pane === 'own' && indSeriesRef.current.has(i.id));
    const vol = o.volume && volRef.current != null;
    const volH = vol ? (panes.length >= 3 ? 0.1 : 0.15) : 0;
    const paneH = panes.length ? Math.min(0.16, (BOTTOM_SHARE_MAX - volH) / panes.length) : 0;
    const total = volH + paneH * panes.length;
    // 위 여백은 레전드 높이에서(fitTopMargin) — 여기선 아래만 바꾸고 함께 적용
    marginsRef.current.bottom = Math.max(0.04, total + 0.02);
    applyRightMargins();
    const ph = plotHRef.current;
    const padTop = (h: number) => (ph > 0 ? Math.min(h * 0.4, PANE_LEGEND_PX / ph) : h * 0.2);
    const padBot = (h: number) => (ph > 0 ? Math.min(h * 0.1, 3 / ph) : 0);
    const layout = { panes: [] as { id: string; top: number }[], volTop: vol ? 1 - volH : null };
    panes.forEach((ind, i) => {
      const top = 1 - volH - (panes.length - i) * paneH;
      const bottom = volH + (panes.length - i - 1) * paneH;
      chart.priceScale(ind.id).applyOptions({ scaleMargins: { top: top + padTop(paneH), bottom: bottom + padBot(paneH) } });
      layout.panes.push({ id: ind.id, top });
    });
    if (vol) {
      // 거래량 이평이 있으면 그 레전드 자리만큼 막대를 내린다
      const volLegend = o.indicators.some((i) => i.visible && INDICATOR_DEFS[i.type].pane === 'volume');
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 1 - volH + (volLegend ? padTop(volH) : 0), bottom: 0 } });
    }
    const sig = JSON.stringify(layout);
    if (sig !== paneSigRef.current) {
      paneSigRef.current = sig;
      setPaneLayout(layout);
    }
  };
  applyPaneLayoutRef.current = applyPaneLayout;

  // ── 데이터 로드 + WS 구독 (symbol/interval 변경 시) ───────────
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    let cancelled = false;
    candlesRef.current = [];
    volMap.current.clear();

    // ── 가상 코인(OX/USDT): 바이낸스 REST/WS 대신 spot_trades 기반 캔들을 짧은 폴링으로 ──
    if (isVirtualSymbol(symbol)) {
      // ⚠ 가상 코인은 소수 자릿수가 고정이 아니다 — 호가 단위가 **유효숫자 4자리**라 가격대에 따라
      // 10배씩 바뀐다(1.057→3자리, 0.002434→6자리, 123.4→1자리). 캔들이 올 때마다 최신가 기준으로
      // 다시 적용한다(예전엔 4자리 하드코딩이라 가격대가 바뀌면 축·크로스헤어가 실제 틱과 어긋났다).
      let curPrec = -1;
      const applyPrec = (price: number) => {
        const p = virtualPrecision(price);
        if (p === curPrec) return;
        curPrec = p;
        setPrec(p);
        setPrecision(symbol, p);
        candle.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: Math.pow(10, -p) } });
      };

      let isFirstLoad = true;
      let loadingMore = false;
      let noMore = false;
      // ⚠ **캔들은 이 컴포넌트가 직접 폴링하지 않는다**(2026-08-14, 무료 플랜 전환). 예전엔 1초마다
      // 500봉을 통째로 다시 받았고(하루 1,050만 행 읽기), 그걸 증분으로 줄인 뒤에도 호가 폴링과 **따로**
      // 요청을 보내 OX 화면 1인이 시간당 8,640요청이었다 — 무료 플랜(하루 10만 요청)의 실질 천장이
      // 그것이었다. 지금은 통합 폴링(useSpotPoll → useTradingStore.spotTick)이 호가·체결·캔들을 한
      // 요청으로 받아 스토어에 넣고, 여기선 **그 변화를 구독만** 한다. 몇 봉을 받을지도 스토어가 정한다.
      // 과거봉 추가 로드(loadOlder)만은 사용자가 스크롤할 때만 도는 별개 요청이라 그대로 둔다.
      const FULL_BARS = 500;
      // 이보다 오래 새 봉이 안 들어오면 "끊김"으로 본다(통합 폴링 1초 주기 기준 넉넉하게).
      const STALE_MS = 8000;

      const draw = (arr: Candle[]) => {
        candle.setData(
          arr.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
        );
        syncIndicatorsRef.current();
      };

      /** 통합 폴링이 새로 받아온 봉들을 화면에 반영한다(예전 load() 의 응답 처리 부분 그대로). */
      const onCandles = (fresh: Candle[]) => {
        if (cancelled || fresh.length === 0) return;
        // ⚠ 받아온 걸로 배열을 통째로 갈아끼우면 왼쪽 스크롤로 붙여둔 과거봉이 매번 날아간다
        // (매 폴링마다 리셋되니 사실상 과거 조회 불가) → 최신 구간만 교체하고 그보다 앞선 구간은 보존.
        // ⚠ 단 받아온 폭이 상한(FULL_BARS)에 닿았다는 건 그만큼 오래 쉬었거나 처음이라는 뜻이라,
        // 기존 구간과 사이에 구멍이 있을 수 있다 → 그땐 이어붙이지 말고 통째로 갈아끼운다.
        const prev = fresh.length >= FULL_BARS ? [] : candlesRef.current;
        const cut = fresh[0].time;
        const merged = prev.length ? [...prev.filter((c) => c.time < cut), ...fresh] : fresh;
        candlesRef.current = merged;
        markBars(merged);
        for (const c of fresh) volMap.current.set(c.time, c.volume ?? 0);
        draw(merged);
        // 최초 1회만 표시 범위를 잡는다 — 매 폴링마다 다시 잡으면 사용자가 확대/축소한 뷰가 계속
        // 리셋되는 버그가 있었음(실제 심볼은 초기 로드 1번 + WS 업데이트뿐이라 이 문제가 없음).
        if (isFirstLoad) {
          isFirstLoad = false;
          const len = merged.length;
          const initBars = optsRef.current.visibleBars;
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - initBars), to: len + 2 });
        }
        const l = merged.at(-1);
        setConnected(true);
        if (l) {
          applyPrec(l.close);
          // ⚠ 현재가는 여기서 넣지 않는다(2026-09-23) — 가상 코인의 봉 종가는 마지막 체결가라 매수면
          // 매도호가·매도면 매수호가에 찍혀 공정가(서버 mark)와 반 스프레드쯤 다르다. 헤더·청산가는 통합
          // 폴링이 받은 mark 를 쓴다(useTradingStore.spotTick) — 둘 다 넣으면 숫자가 번갈아 깜빡인다.
          if (!hovering.current) setLegend(l);
        }
        if (!hovering.current) setIndLegend(lastIndLegend());
        repositionCountdownRef.current();
      };

      // ── 과거봉 추가 로드 (왼쪽 스크롤) ── 실제 심볼과 동일한 동작. 예전엔 이 분기가 여기서
      // 곧장 return 해버려서 OX 만 과거 조회가 통째로 없었다(맨 왼쪽까지 가도 아무 일도 안 일어남).
      const loadOlder = async () => {
        if (loadingMore || noMore || cancelled) return;
        if (candlesRef.current.length === 0) return;
        loadingMore = true;
        try {
          const oldest = candlesRef.current[0].time; // sec
          const { candles: older, more } = await api.spotCandles(symbol, interval, 500, oldest * 1000);
          if (cancelled) return;
          // await 사이에 폴링이 배열을 갱신했을 수 있으므로 최신 상태를 다시 읽는다.
          const cur = candlesRef.current;
          const fresh = older.filter((c) => c.time < cur[0].time);
          if (fresh.length === 0) {
            noMore = true;
            return;
          }
          const ts = chartRef.current?.timeScale();
          const before = ts?.getVisibleLogicalRange();
          candlesRef.current = [...fresh, ...cur];
          markBars(candlesRef.current);
          for (const c of fresh) volMap.current.set(c.time, c.volume ?? 0);
          draw(candlesRef.current);
          // 프리펜드로 인덱스가 fresh.length 만큼 밀리므로 보이던 구간 그대로 유지
          if (before && ts) ts.setVisibleLogicalRange({ from: before.from + fresh.length, to: before.to + fresh.length });
          // 과거 데이터 끝 — 서버가 알려 주면 그걸 따른다(롤업 인터벌은 원본 행 상한 때문에 페이지가 500봉보다 작다, § api.spotCandles)
          if (more === false || (more === undefined && fresh.length < 450)) noMore = true;
        } catch {
          /* 다음 스크롤 때 재시도 */
        } finally {
          loadingMore = false;
        }
      };

      let lastBarsSaveV = 0;
      const onRangeV = (range: { from: number; to: number } | null) => {
        repositionCountdownRef.current();
        requestAnimationFrame(() => repositionCountdownRef.current()); // 가격축은 다음 프레임에 다시 맞춰진다(위 onRange 와 같은 이유)
        if (range && range.from < 10) loadOlder();
        if (range) {
          const now = Date.now();
          if (now - lastBarsSaveV > 500) {
            lastBarsSaveV = now;
            const bars = Math.round(range.to - range.from) - 2; // 초기 범위의 +2 여유분 제외
            if (bars > 1) useChartStore.getState().setVisibleBars(bars);
          }
        }
      };
      const tsApiV = chartRef.current?.timeScale();
      tsApiV?.subscribeVisibleLogicalRangeChange(onRangeV);

      // 통합 폴링(useSpotPoll)이 스토어에 새 봉을 넣을 때마다 반영한다. 폴링 주기·탭 숨김 정지·요청
      // 폭은 전부 그쪽이 관리하므로 여기엔 타이머가 없다. 마운트 시점에 이미 값이 있으면 즉시 한 번 그린다.
      let lastAt = 0;
      const myKey = `${symbol}|${interval}`;
      const pump = (candles: Candle[], at: number, key: string) => {
        // ⚠ 키 대조 필수 — 이게 없으면 인터벌을 바꾼 직후 **이전 인터벌의 봉**이 한 번 그려진다.
        if (at === 0 || at === lastAt || key !== myKey) return;
        lastAt = at;
        onCandles(candles);
      };
      const s0 = useTradingStore.getState();
      pump(s0.spotCandles, s0.spotCandlesAt, s0.spotCandlesKey);
      const unsub = useTradingStore.subscribe((st) => pump(st.spotCandles, st.spotCandlesAt, st.spotCandlesKey));
      // ⚠ 연결 표시는 **신선도로** 판정한다 — 예전엔 이 컴포넌트가 직접 fetch 해서 그 catch 로 껐는데,
      // 지금은 통합 폴링이 스토어에서 조용히 재시도하므로 실패가 여기까지 안 온다. 그대로 두면 서버가
      // 죽어도 초록불이 켜져 있다. 요청을 새로 만들지 않고 "마지막 갱신이 얼마나 됐나"만 본다.
      const staleTimer = window.setInterval(() => {
        const at = useTradingStore.getState().spotCandlesAt;
        if (at > 0 && Date.now() - at > STALE_MS) setConnected(false);
      }, 2000);
      return () => {
        cancelled = true;
        window.clearInterval(staleTimer);
        unsub();
        tsApiV?.unsubscribeVisibleLogicalRangeChange(onRangeV);
        setConnected(false);
      };
    }

    // ── 원화 심볼(빗썸): 바이낸스와 같은 흐름(REST 과거봉 + 실시간), 데이터 소스만 빗썸(브라우저 직결) ──
    const krw = quoteOf(symbol) === 'KRW';
    // 빗썸엔 1초봉이 없다 — 1초봉을 보다가 원화 심볼로 오면 1분봉으로 옮긴다(인터벌 목록에서도 뺀다).
    if (krw && !bithumbSupports(interval)) {
      setIntervalCode('1m');
      return;
    }
    const loadKlines = (limit: number, endTimeMs?: number) =>
      krw ? fetchBithumbKlines(symbol, interval, limit, endTimeMs) : fetchKlines(symbol, interval, limit, endTimeMs);

    // 심볼별 가격 정밀도 적용(우측 축·크로스헤어·레전드) — 소수점 2자리 고정 버그 수정.
    // 원화 심볼은 받아올 tickSize 가 없어 가격에서 파생한다(유효숫자 4자리 = 빗썸 호가 단위, § useMarketStore.setPrice).
    const applyPrecision = (precision: number, minMove = Math.pow(10, -precision)) => {
      setPrec(precision);
      setPrecision(symbol, precision);
      candle.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
    };
    if (!krw) {
      fetchPricePrecision(symbol)
        .then(({ precision, minMove }) => {
          if (!cancelled) applyPrecision(precision, minMove);
        })
        .catch(() => {});
    }

    // ⚠⚠ 실시간 구독은 **과거봉을 그린 뒤에** 시작한다(2026-10-01). 예전엔 바로 구독해서, 과거봉 요청(빗썸은 3~10번 연속)이 끝나기
    // 전에 체결이 오면 그 한 건으로 현재 봉을 만들었고, 과거봉이 같은 시각으로 도착해도 스트림 쪽 봉이 이겨서 **그 기간 내내 현재
    // 봉이 틀렸다**(1d 면 하루 종일 — 시가 = 차트를 연 뒤 첫 체결, 고저·거래량 = 연 뒤의 체결뿐). 실패해도 구독은 한다.
    let sub: { unsubscribe: () => void } | undefined;
    (async () => {
      try {
        const candles = await loadKlines(500);
        if (cancelled) return;
        if (krw && candles.length) applyPrecision(virtualPrecision(candles[candles.length - 1].close));
        candlesRef.current = candles;
        markBars(candles);
        for (const c of candles) volMap.current.set(c.time, c.volume ?? 0);
        candle.setData(
          candles.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
        );
        // 기본 표시 봉수 = 사용자가 마지막으로 확대/축소한 값(localStorage, 없으면 ~38봉).
        // 이후 왼쪽으로 당기면 과거봉 추가 로드.
        const len = candles.length;
        const initBars = optsRef.current.visibleBars;
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - initBars), to: len + 2 });
        syncIndicatorsRef.current();
        const l = candles.at(-1);
        if (l && !hovering.current) setLegend(l);
        if (!hovering.current) setIndLegend(lastIndLegend());
        repositionCountdownRef.current();
      } catch (e) {
        console.error('[chart] load failed', e);
      }
      if (!cancelled) sub = subscribeLive();
    })();

    // ── 과거봉 추가 로드 (왼쪽 스크롤) ──────────────────────────
    let loadingMore = false;
    let noMore = false;
    const loadOlder = async () => {
      const chart = chartRef.current;
      const arr = candlesRef.current;
      if (loadingMore || noMore || !chart || arr.length === 0) return;
      loadingMore = true;
      try {
        const oldest = arr[0].time; // sec
        // 빗썸 `to` 는 그 시각 미만(배타), 바이낸스 endTime 은 이하(포함)라 1ms 를 빼 둔다 — 어느 쪽이든 아래 filter 가 거른다.
        const older = await loadKlines(500, krw ? oldest * 1000 : oldest * 1000 - 1);
        if (cancelled) return;
        const fresh = older.filter((c) => c.time < oldest);
        if (fresh.length === 0) {
          noMore = true;
          return;
        }
        const ts = chart.timeScale();
        const before = ts.getVisibleLogicalRange();
        candlesRef.current = [...fresh, ...arr];
        markBars(candlesRef.current);
        for (const c of fresh) volMap.current.set(c.time, c.volume ?? 0);
        candle.setData(
          candlesRef.current.map((c) => ({ time: toChart(c.time), open: c.open, high: c.high, low: c.low, close: c.close })) as CandlestickData[],
        );
        syncIndicatorsRef.current();
        // 프리펜드로 인덱스가 fresh.length 만큼 밀리므로 보이던 구간 그대로 유지
        if (before) ts.setVisibleLogicalRange({ from: before.from + fresh.length, to: before.to + fresh.length });
        // 더 받을 게 거의 없음(과거 데이터 끝 근처). ⚠ 빗썸 롤업 인터벌(6h 등)은 한 번에 500봉을 못 채우므로
        // 개수로 판단하지 않는다(빈 응답일 때만 끝 — 위 fresh.length === 0).
        if (!krw && fresh.length < 450) noMore = true;
      } catch {
        /* 다음 시도 때 재시도 */
      } finally {
        loadingMore = false;
      }
    };
    let lastBarsSave = 0;
    const onRange = (range: { from: number; to: number } | null) => {
      repositionCountdownRef.current(); // 가로 팬/줌으로 가격축 스케일이 바뀌면 카운트다운 위치도 갱신
      // ⚠ 가격축은 LWC 가 다음 프레임에 다시 맞춘다 — 그 뒤에 한 번 더(안 하면 1초 틱까지 주문 X·수평선 버튼이 옛 자리에 떠 있다)
      requestAnimationFrame(() => repositionCountdownRef.current());
      if (range && range.from < 10) loadOlder();
      // 사용자가 확대/축소한 봉 개수를 기억해뒀다가 다음 접속 때 기본값으로 사용(과도한 쓰기 방지로 스로틀).
      if (range) {
        const now = Date.now();
        if (now - lastBarsSave > 500) {
          lastBarsSave = now;
          // 초기 로드가 {from: len-N, to: len+2} 로 2봉만큼 여유를 두고 범위를 잡으므로
          // (아래 참고) 저장할 땐 그 여유분을 빼야 다음 로드 때 N 그대로 복원된다.
          // 이걸 안 빼면 로드→저장→로드 때마다 매번 +2씩 불어나는 버그가 있었음.
          const bars = Math.round(range.to - range.from) - 2;
          if (bars > 1) useChartStore.getState().setVisibleBars(bars);
        }
      }
    };
    const tsApi = chartRef.current?.timeScale();
    tsApi?.subscribeVisibleLogicalRangeChange(onRange);

    // 함수 선언이라 위의 비동기 로드가 끝난 뒤 호출해도 된다(호이스팅).
    function subscribeLive(): { unsubscribe: () => void } | undefined {
    if (!candle) return undefined; // (함수 선언 안에선 바깥의 null 검사가 좁혀지지 않는다)
    const live$ = krw ? bithumbKlineStream(symbol, interval, () => candlesRef.current.at(-1)) : klineStream(symbol, interval);
    return live$.subscribe({
      next: (tick) => {
        setConnected(true);
        // ⚠ 실제 코인의 mark(현재가/PnL 기준)는 바이낸스 WS 가 아니라 OKX(useMarkPrices)로 온다 —
        // 서버 체결가가 OKX 라 여기서 바이낸스 close 로 덮어쓰면 진입 즉시 손익/평단이 튄다(§ useMarkPrices).
        // 캔들 자체는 바이낸스 그대로 그린다(아래). setPrice 는 하지 않는다.
        const bar = tick.candle;
        candle.update({ time: toChart(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        const vc = volColors(chartColors(useSettingsStore.getState().theme, optsRef.current.colorScheme));
        volRef.current?.update({
          time: toChart(bar.time),
          value: bar.volume ?? 0,
          color: bar.close >= bar.open ? vc.up : vc.down,
        } as HistogramData);
        volMap.current.set(bar.time, bar.volume ?? 0);
        const arr = candlesRef.current;
        if (arr.length && arr[arr.length - 1].time === bar.time) arr[arr.length - 1] = bar;
        else {
          arr.push(bar);
          markBars(arr); // 새 봉이 열렸다 — 그 봉 안의 체결 마커가 제자리를 찾게
        }
        if (!hovering.current) setLegend(bar);
        repositionCountdownRef.current(); // 현재가 이동 → 카운트다운도 축 티커 따라 이동
        const now = Date.now();
        if (now - lastCalc.current > 700) {
          lastCalc.current = now;
          syncIndicatorsRef.current();
          if (!hovering.current) setIndLegend(lastIndLegend());
        }
      },
      error: () => setConnected(false),
    });
    }

    return () => {
      cancelled = true;
      sub?.unsubscribe();
      tsApi?.unsubscribeVisibleLogicalRangeChange(onRange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  // 지표 추가 직후 그 지표의 줄이 패널 아래쪽에 생긴다 — 모바일처럼 패널이 스크롤되면 화면 밖이라 "추가가 안 됐다"로 보였다
  const optsListRef = useRef<HTMLDivElement>(null);
  const indCountRef = useRef(opts.indicators.length);
  useEffect(() => {
    const grew = opts.indicators.length > indCountRef.current;
    indCountRef.current = opts.indicators.length;
    if (!grew || !showOpts) return;
    const el = optsListRef.current;
    if (el) requestAnimationFrame(() => el.lastElementChild?.scrollIntoView({ block: 'nearest' }));
  }, [opts.indicators.length, showOpts]);

  // 인디케이터 추가/삭제/설정 변경, 거래량 토글 시 즉시 반영
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    syncIndicators();
    if (!hovering.current) setIndLegend(lastIndLegend());
  }, [opts.indicators, opts.volume]);

  // ── 매매 마커 (B/S) ──────────────────────────────────────────
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    if (!opts.tradeMarkers) { c.setMarkers([]); return; }
    // ⚠ 마커 시각을 **그 체결이 속한 봉의 시작**으로 맞춘다(2026-10-01) — LWC 는 마커를 "그 시각 이후의 첫 봉"에 붙여서 13:44:30
    // 체결이 13:45 봉(1d 면 다음 날 봉)에 찍혔다. 불러온 구간보다 오래된 주문은 첫 봉에 몰려 쌓이므로 뺀다.
    const bars = candlesRef.current;
    const barOf = (t: number): number | null => {
      if (bars.length === 0 || t < bars[0].time) return null;
      let lo = 0;
      let hi = bars.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bars[mid].time <= t) lo = mid;
        else hi = mid - 1;
      }
      return bars[lo].time;
    };
    const markers: SeriesMarker<Time>[] = [];
    for (const o of orders) {
      if (o.symbol !== symbol) continue;
      const bt = barOf(Math.floor(o.createdAt / 1000));
      if (bt == null) continue;
      // 체결 방향 = 진입은 포지션 방향, 청산·강제청산은 그 반대(롱 청산 = 매도). 예전엔 롱 청산이 매수처럼 초록 ▲ 로 찍혔다.
      const buy = o.kind === 'open' ? o.side === 'long' : o.side === 'short';
      const liquidation = o.kind === 'liquidation';
      markers.push({
        time: toChart(bt) as Time,
        position: (buy ? 'belowBar' : 'aboveBar') as SeriesMarker<Time>['position'],
        color: liquidation ? '#ff9800' : buy ? '#00c076' : '#f6465d',
        shape: (buy ? 'arrowUp' : 'arrowDown') as SeriesMarker<Time>['shape'],
        text: liquidation ? 'L' : o.kind === 'close' ? 'C' : buy ? 'B' : 'S',
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    c.setMarkers(markers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, symbol, opts.tradeMarkers, barsKey]);

  // ── 포지션 평단 / SL·TP 수평선 ───────────────────────────────
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    for (const pl of priceLines.current) c.removePriceLine(pl);
    priceLines.current = [];
    const mine = positions.filter((p) => p.symbol === symbol);

    if (opts.positionLine && mine.length > 0) {
      // ⚠ 방향별로 따로 그린다(2026-10-01) — 롱·숏을 같이 들고 있으면(서버는 방향별 포지션) 예전엔 두 진입가를 섞은 평균 한 줄을
      // 첫 포지션 색으로 그려 어느 쪽 평단도 아니었다.
      for (const side of ['long', 'short'] as const) {
        const ps = mine.filter((p) => p.side === side);
        if (ps.length === 0) continue;
        const totSize = ps.reduce((a, p) => a + p.size, 0);
        const avg = ps.reduce((a, p) => a + p.entryPrice * p.size, 0) / totSize;
        priceLines.current.push(
          c.createPriceLine({
            price: avg,
            color: side === 'long' ? '#00c076' : '#f6465d',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: mine.some((p) => p.side !== side) ? (side === 'long' ? '롱 평단' : '숏 평단') : '평단',
          }),
        );
      }

      // 청산가(추정) 수평선 — PositionsPanel 과 동일 산식(평가자산=잔고+전 포지션 미실현손익 이 0 되는 가격).
      // 다른 포지션들의 미실현손익이 필요하므로 전 심볼 가격이 있어야 계산 가능(없으면 생략).
      const unrealizedOf = (p: (typeof positions)[number]) => {
        const lv = prices[p.symbol];
        if (lv == null) return null;
        const d = p.side === 'long' ? 1 : -1;
        return (lv - p.entryPrice) * p.size * d;
      };
      // ⚠ 크로스 담보는 **지갑(결제통화)별**이다 — 이 심볼과 같은 통화의 포지션·잔고만 본다(서버 강제청산과 같은 식).
      const q = quoteOf(symbol);
      const walletPos = positions.filter((p) => quoteOf(p.symbol) === q);
      const walletBal = q === 'KRW' ? krwBalance : balance;
      if (walletPos.every((p) => unrealizedOf(p) != null)) {
        const totalU = walletPos.reduce((a, p) => a + (unrealizedOf(p) ?? 0), 0);
        // 평가자산 = 여유잔고 + Σ(잠긴 증거금 + 미실현손익). PositionsPanel/서버와 동일한 산식(증거금 항 포함).
        const totalMargin = walletPos.reduce((a, p) => a + positionMargin(p), 0) + lockedMargin(pendingOrders, q);
        for (const p of mine) {
          const others = totalU - (unrealizedOf(p) ?? 0);
          const d = p.side === 'long' ? 1 : -1;
          const liq = p.entryPrice - (walletBal + totalMargin + others) / (p.size * d);
          if (liq > 0) {
            priceLines.current.push(
              c.createPriceLine({
                price: liq,
                color: '#ff9800',
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: '청산',
              }),
            );
          }
        }
      }
    }

    if (opts.slTpLines) {
      // 포지션이 여러 개면 각각의 SL/TP 를 전부 그린다(중복 값이면 겹쳐 보임).
      for (const p of mine) {
        if (p.stopLoss != null) {
          priceLines.current.push(
            c.createPriceLine({
              price: p.stopLoss,
              color: '#f6465d',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: 'SL',
            }),
          );
        }
        if (p.takeProfit != null) {
          priceLines.current.push(
            c.createPriceLine({
              price: p.takeProfit,
              color: '#00c076',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: 'TP',
            }),
          );
        }
      }
    }

    // ── 걸어둔 지정가(미체결) 수평선 + 수량 ──
    if (opts.pendingLine) {
      for (const p of pendingOrders.filter((o) => o.symbol === symbol)) {
        priceLines.current.push(
          c.createPriceLine({
            price: p.limitPrice,
            color: p.side === 'long' ? '#00c076' : '#f6465d',
            lineWidth: 1,
            lineStyle: LineStyle.LargeDashed,
            axisLabelVisible: true,
            title: `${p.reduceOnly ? '청산 ' : ''}${p.side === 'long' ? '매수' : '매도'} ${fmtQtyShort(p.size, 9)}`,
          }),
        );
      }
      // ── 조건부(스탑) 주문 수평선 — 트리거 가격에. 지정가/SL·TP(녹/적)와 구분되게 앰버색·점선. ──
      for (const cd of conditionalOrders.filter((o) => o.symbol === symbol)) {
        priceLines.current.push(
          c.createPriceLine({
            price: cd.triggerPrice,
            color: '#f0b90b',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `조건부${cd.repeating ? '∞' : ''} ${cd.side === 'long' ? '롱' : '숏'} ${
              cd.triggerDir === 'above' ? '≥' : '≤'
            } ${fmtQtyShort(cd.size, 9)}`,
          }),
        );
        // 재무장 대기 중이면 "여기까지 돌아오면 다시 무장" 지점도 흐린 점선으로 보여준다
        // (트리거선만 있으면 왜 지금은 안 걸리는지 화면에서 알 수 없다). 재무장가=트리거가면 생략.
        if (cd.repeating && cd.repeatMode === 'rearm' && !cd.armed && cd.rearmPrice != null && cd.rearmPrice !== cd.triggerPrice) {
          priceLines.current.push(
            c.createPriceLine({
              price: cd.rearmPrice,
              color: '#f0b90b80',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: `재무장 ${cd.triggerDir === 'above' ? '≤' : '≥'}`,
            }),
          );
        }
      }
    }
    repositionPendBtnsRef.current(); // 주문선이 바뀌면 취소(X) 버튼 위치도 즉시 갱신
  }, [positions, pendingOrders, conditionalOrders, prices, balance, krwBalance, symbol, opts.positionLine, opts.slTpLines, opts.pendingLine]);

  // ── 다음 봉 카운트다운 ───────────────────────────────────────
  useEffect(() => {
    if (!opts.showCountdown) { setCountdown(''); return; }
    const sec = intervalSec(interval);
    // ⚠ 남은 시간은 **마지막 봉의 시작 시각** 기준으로 센다(2026-10-01) — `now % sec` 는 봉이 유닉스 시각 경계에서 시작한다고 가정해서
    // 바이낸스 1w(월요일 시작)·1M(달력 월)과 빗썸 2h~1M(한국 시각 정렬)에서 틀렸다(20시 KST 의 BTC/KRW 1d 가 4시간 대신 13시간).
    const kstAligned = quoteOf(symbol) === 'KRW';
    const nextMonth = (startSec: number) => {
      const off = kstAligned ? 9 * 3600 : 0;
      const d = new Date((startSec + off) * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 - off;
    };
    const tick = () => {
      const now = Date.now() / 1000;
      const last = candlesRef.current.at(-1)?.time;
      let remain: number;
      if (last == null) remain = sec - (now % sec);
      else if (interval === '1M') {
        let next = nextMonth(last);
        while (next <= now) next = nextMonth(next);
        remain = next - now;
      } else remain = sec - ((((now - last) % sec) + sec) % sec);
      remain = Math.max(0, Math.ceil(remain));
      const h = Math.floor(remain / 3600);
      const m = Math.floor((remain % 3600) / 60);
      const s = Math.floor(remain % 60);
      const p = (n: number) => String(n).padStart(2, '0');
      setCountdown(h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`);
      repositionCountdownRef.current(); // 축 드래그/리사이즈 등 이벤트 없는 변화도 1초마다 보정
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, symbol, opts.showCountdown]);

  /** 지표 하나의 레전드 — `RSI(14) 52.3`. withTitle 이면 값이 아직 없어도(워밍업) 제목은 보인다(패널 이름표 역할). */
  const indLegendNode = (ind: IndicatorConfig, idx: number, withTitle: boolean) => {
    const def = INDICATOR_DEFS[ind.type];
    const val = indLegend[ind.id];
    const parts: string[] = [];
    if (val) {
      for (const ln of def.lines) {
        if (ln.legend === false) continue;
        const v = val[ln.key];
        if (v == null) continue;
        const txt = fmtIndValue(ln.format ?? def.format, v, prec);
        const lab = lineLabel(ln, ind.params);
        parts.push(lab ? `${lab} ${txt}` : txt);
      }
    }
    if (parts.length === 0 && !withTitle) return null;
    const st = val && def.states ? val[def.states.key] : undefined;
    const stLabel = st != null ? def.states?.labels[st] : undefined;
    return (
      <span key={ind.id} style={{ color: IND_COLORS[idx % IND_COLORS.length] }}>
        {indicatorTitle(ind.type, ind.params)} {parts.join(' ')}
        {stLabel && <span className="font-semibold" style={{ color: stLabel.color }}> · {stLabel.text}</span>}
      </span>
    );
  };

  const up = legend ? legend.close >= legend.open : true;
  // 종가 옆 변동률 = 그 봉의 (종가-시가)/시가 (레전드 상하 색과 동일 기준). hover 시 그 봉, 아니면 마지막 봉.
  const chgPct = legend && legend.open ? ((legend.close - legend.open) / legend.open) * 100 : null;

  return (
    // 전체화면이면 화면 전체를 덮는다(z-[45] = 토스트(z-40) 위·모달(z-50) 아래 — 리필 팝업 등은 그대로 위에 뜬다).
    // 컴포넌트를 다른 곳으로 옮기지 않고 CSS 만 바꾼다 — 포털로 옮기면 다시 마운트되어 차트를 새로 만든다.
    <div className={expanded ? 'fixed inset-0 z-[45] flex flex-col overscroll-contain bg-bg' : 'flex h-full flex-col'}>
      {/* 툴바 — ⚠ relative: 모바일에선 드롭다운(지표·옵션, 타임프레임 목록)을 버튼이 아니라 이 툴바 폭에 맞춰 연다(버튼 기준 w-80 은
          폰 화면 오른쪽 밖으로 잘려 체크박스가 아예 안 보였다, 2026-11-18). PC(md+)는 버튼 아래. */}
      <div className="relative flex items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5 sm:gap-2">
        {/* 타임프레임 — 즐겨찾기(★)만 가로로, 나머지는 ▾ 목록(트레이딩뷰식). 원화 심볼(빗썸)은 1초봉이 없어 뺀다 */}
        <IntervalPicker
          value={interval}
          onChange={setIntervalCode}
          supports={(code) => quoteOf(symbol) !== 'KRW' || bithumbSupports(code)}
        />

        <div className="shrink-0 md:relative">
          {/* ⚠ 줄바꿈 금지 — 폰에서 "지표 · 옵션 ▾" 가 두 줄로 접혀 툴바가 두꺼워졌다. 좁은 화면은 "지표" 만 */}
          <button
            onClick={() => setShowOpts((v) => !v)}
            aria-expanded={showOpts}
            className={`flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs ring-1 ring-border transition hover:bg-elevated ${
              showOpts ? 'bg-elevated text-text' : 'bg-panel2 text-text'
            }`}
          >
            <span className="sm:hidden">지표</span>
            <span className="hidden sm:inline">지표 · 옵션</span>
            {opts.indicators.length > 0 && (
              <span className="rounded bg-panel px-1 text-[10px] font-semibold tabular-nums text-accent">{opts.indicators.length}</span>
            )}
            <span className="text-muted">▾</span>
          </button>
          {showOpts && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowOpts(false)} />
              <div className="absolute inset-x-1 top-full z-30 mt-1 max-h-[min(75vh,36rem)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-panel p-1.5 shadow-2xl md:inset-x-auto md:left-0 md:w-[24rem]">
                {/* 표시 옵션 — 폰은 두 칸으로(세로 길이 절반) */}
                <div className="grid grid-cols-2 gap-x-1 md:grid-cols-1">
                  {(
                    [
                      ['volume', '거래량'],
                      ['showCountdown', '다음 봉 카운트다운'],
                      ['tradeMarkers', '내 매매 표시 (B/S)'],
                      ['positionLine', '포지션 평단선'],
                      ['slTpLines', 'SL/TP 수평선'],
                      ['pendingLine', '지정가 주문선 (수량)'],
                      ['hiLoMarks', '최고·최저가 표시'],
                      ['orderBook', '호가창'],
                    ] as const
                  ).map(([k, label]) => (
                    <label
                      key={k}
                      className="flex cursor-pointer items-center justify-between gap-1 rounded px-2 py-1.5 text-xs text-text hover:bg-panel2"
                    >
                      <span className="min-w-0 truncate">{label}</span>
                      <input type="checkbox" checked={opts[k]} onChange={() => opts.toggle(k)} className="shrink-0 accent-up" />
                    </label>
                  ))}
                </div>

                <div className="my-1 border-t border-border" />
                <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted">인디케이터</div>

                {opts.indicators.length === 0 && (
                  <div className="px-2 py-1.5 text-[11px] text-muted">추가된 인디케이터 없음</div>
                )}
                <div ref={optsListRef}>
                {opts.indicators.map((ind, idx) => {
                  const def = INDICATOR_DEFS[ind.type];
                  return (
                    <div key={ind.id} className={`rounded hover:bg-panel2 ${ind.visible ? '' : 'opacity-50'}`}>
                      <div className="flex items-center gap-1 px-2 py-1 text-xs text-text">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: IND_COLORS[idx % IND_COLORS.length] }} />
                        <span
                          className="w-[4.6rem] shrink-0 truncate"
                          title={`${def.name}${def.pane === 'own' ? ' · 아래 패널' : def.pane === 'volume' ? ' · 거래량 막대 위(거래량을 켜야 보입니다)' : ''}`}
                        >
                          {def.label}
                        </span>
                        {/* 파라미터가 많으면(StochRSI 4개) 줄을 넘긴다 — 한 줄에 우겨 넣으면 패널이 가로로 밀린다 */}
                        <span className="flex flex-1 flex-wrap items-center justify-end gap-1">
                          {def.params.map((p) => (
                            <ParamInput
                              key={p.key}
                              p={p}
                              value={ind.params[p.key] ?? p.def}
                              onCommit={(v) => opts.updateIndicator(ind.id, { [p.key]: v })}
                            />
                          ))}
                        </span>
                        {/* 숨김/표시 — 삭제와 별개. 설정을 지우지 않고 잠시 끈다(시리즈 visible 만 토글) */}
                        <button
                          onClick={() => opts.toggleIndicator(ind.id)}
                          className={`shrink-0 rounded p-0.5 hover:bg-elevated ${ind.visible ? 'text-text' : 'text-muted'}`}
                          title={ind.visible ? '숨기기' : '보이기'}
                          aria-pressed={ind.visible}
                        >
                          <EyeIcon off={!ind.visible} />
                        </button>
                        <button
                          onClick={() => opts.removeIndicator(ind.id)}
                          className="shrink-0 rounded px-1 text-muted hover:bg-elevated hover:text-down"
                          title="삭제"
                        >
                          ✕
                        </button>
                      </div>
                      {/* 국면 판정이 있는 지표(OBV)는 선 색이 무슨 뜻인지 바로 아래에 — 칩에 올리면 설명 */}
                      {def.states && (
                        <div className="flex flex-wrap gap-x-2 gap-y-0.5 px-2 pb-1 pl-5 text-[10px] text-muted">
                          {def.states.labels.map((l) => (
                            <span key={l.text} className="inline-flex cursor-help items-center gap-1" title={l.hint}>
                              <span className="h-1.5 w-3 rounded-sm" style={{ backgroundColor: l.color }} />
                              {l.text}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>

                {/* 추가 — 분류(이동평균·밴드·추세·오실레이터·거래량·변동성)별 묶음. 값은 항상 '' 로 되돌려 같은 지표를 또 고를 수 있게 */}
                <select
                  value=""
                  onChange={(e) => {
                    const t = e.target.value as IndicatorType | '';
                    if (t) opts.addIndicator(t);
                  }}
                  className="mt-1 w-full cursor-pointer rounded bg-panel2 px-2 py-1.5 text-xs font-semibold text-text outline-none ring-1 ring-border"
                >
                  <option value="">+ 인디케이터 추가…</option>
                  {INDICATOR_TYPES_BY_GROUP.map((g) => (
                    <optgroup key={g.key} label={g.label}>
                      {g.types.map((t) => (
                        <option key={t} value={t}>
                          {INDICATOR_DEFS[t].label} — {INDICATOR_DEFS[t].name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {/* 이평선 묶음 — 이평을 네 번 추가하고 기간을 하나씩 고치지 않게(국내 거래소·HTS 기본 5·20·60·120) */}
                <button
                  onClick={() => MA_SET.forEach((n) => opts.addIndicator('sma', { period: n }))}
                  className="mt-1 w-full rounded px-2 py-1 text-left text-[11px] text-muted transition hover:bg-panel2 hover:text-text"
                  title="단순이동평균 5 · 20 · 60 · 120 을 한 번에 추가합니다"
                >
                  + 이평선 묶음 추가 (SMA {MA_SET.join(' · ')})
                </button>

                {/* 수평선 — 차트 위 버튼(×·🔔)은 작아서 폰에서 누르기 어렵다 — 여기서도 지우고 알림을 켠다 */}
                <div className="my-1 border-t border-border" />
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[10px] font-semibold uppercase text-muted">수평선 · {pairLabel(symbol)}</span>
                  {(hLinesHere?.length ?? 0) > 0 && (
                    <button onClick={() => opts.clearHLines(symbol)} className="rounded px-1 text-[10px] text-muted hover:bg-panel2 hover:text-down">
                      모두 지우기
                    </button>
                  )}
                </div>
                {(hLinesHere?.length ?? 0) === 0 ? (
                  <div className="px-2 pb-1.5 text-[11px] leading-snug text-muted">
                    툴바의 <span className="text-text">수평선</span> 버튼을 누른 뒤 차트에서 가격을 누르면 선을 긋습니다. 🔔 를 켜 두면 현재가가 그 선을
                    지나갈 때 한 번 알려 줍니다(이 앱을 보고 있을 때만).
                  </div>
                ) : (
                  [...(hLinesHere ?? [])]
                    .sort((a, b) => b.price - a.price)
                    .map((l) => (
                      <div key={l.id} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text hover:bg-panel2">
                        <span className="h-0.5 w-3 shrink-0 rounded" style={{ backgroundColor: HLINE_COLOR }} />
                        <span className="flex-1 tabular-nums">{fmtPrice(l.price, prec)}</span>
                        <button
                          onClick={() => opts.setHLineAlert(symbol, l.id)}
                          aria-pressed={l.alert}
                          title={l.alert ? '알림 끄기' : '현재가가 이 선을 지나가면 알림(한 번)'}
                          className={`rounded px-1.5 py-0.5 text-[11px] transition ${l.alert ? 'bg-[#2962ff] text-white' : 'text-muted hover:bg-elevated'}`}
                        >
                          🔔 {l.alert ? '켬' : '끔'}
                        </button>
                        <button onClick={() => opts.removeHLine(symbol, l.id)} title="지우기" className="shrink-0 rounded px-1 text-muted hover:bg-elevated hover:text-down">
                          ✕
                        </button>
                      </div>
                    ))
                )}
              </div>
            </>
          )}
        </div>

        {/* 수평선 그리기 — 누른 뒤 차트를 누르면 그 가격에 선(지지·저항 표시, 🔔 로 가격 알림) */}
        <button
          onClick={() => setDrawMode((v) => !v)}
          aria-pressed={drawMode}
          title={drawMode ? '수평선 그리기 취소 (Esc)' : '수평선 그리기 — 누른 뒤 차트에서 가격을 누르세요'}
          aria-label="수평선 그리기"
          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs ring-1 transition ${
            drawMode ? 'bg-[#2962ff] text-white ring-[#2962ff]' : 'bg-panel2 text-muted ring-border hover:bg-elevated hover:text-text'
          }`}
        >
          <HLineIcon />
          <span className="hidden lg:inline">수평선</span>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 실시간 시계(KST) — 폰은 툴바가 좁아(타임프레임이 잘렸다) 숨긴다 */}
          <Clock className="hidden text-xs font-semibold text-muted sm:inline" />
          {/* 전체화면 — 차트 더블클릭(모바일 더블탭)과 같다. 아이폰처럼 Esc 가 없는 곳은 이 버튼으로 나온다 */}
          <button
            onClick={toggleExpanded}
            className="shrink-0 rounded p-1 text-muted transition hover:bg-panel2 hover:text-text"
            title={expanded ? '전체화면 종료 (Esc · 차트 더블클릭)' : '전체화면 (차트 더블클릭)'}
            aria-label={expanded ? '전체화면 종료' : '전체화면'}
            aria-pressed={expanded}
          >
            <FullscreenIcon exit={expanded} />
          </button>
        </div>
      </div>

      {/* 차트 영역 */}
      <div className="relative flex-1">
        {/* OHLCV 레전드 — 틀은 늘 두고(높이를 재서 캔들 위 여백을 맞춘다, fitTopMargin) 내용만 조건부 */}
        <div ref={legendRef} className="pointer-events-none absolute left-2 top-1.5 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          {legend && (
            <>
              <span className="font-semibold text-text">{pairLabel(symbol)}</span>
              <span className="text-muted">{fmtKst(legend.time, subMinute)}</span>
              {/* 레전드도 축약 — 좁은 한 줄에 OHLCV + 인디케이터가 다 들어가서 한 값만 길어도 줄이 깨진다 */}
              <span className="text-muted">시 <span className={up ? 'text-up' : 'text-down'}>{fmtPriceShort(legend.open, prec, 9)}</span></span>
              <span className="text-muted">고 <span className={up ? 'text-up' : 'text-down'}>{fmtPriceShort(legend.high, prec, 9)}</span></span>
              <span className="text-muted">저 <span className={up ? 'text-up' : 'text-down'}>{fmtPriceShort(legend.low, prec, 9)}</span></span>
              <span className="text-muted">
                종{' '}
                <span className={up ? 'text-up' : 'text-down'}>
                  {fmtPrice(legend.close, prec)}
                  {chgPct != null && ` (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)`}
                </span>
              </span>
              <span className="text-muted">거래량 <span className="text-text">{fmtQtyShort(legend.volume, 9)}</span></span>
              {/* 캔들 위에 겹치는 지표만 — 아래 패널·거래량 위 지표는 그 패널 왼쪽 위에(아래) */}
              {opts.indicators.map((ind, idx) =>
                ind.visible && INDICATOR_DEFS[ind.type].pane === 'overlay' ? indLegendNode(ind, idx, false) : null,
              )}
            </>
          )}
        </div>
        {/* 하단 패널마다 제 이름·값(트레이딩뷰식) + 패널 경계선 — 위치는 applyPaneLayout 이 정한 비율 × 그림 영역 높이 */}
        {plotH > 0 &&
          paneLayout.panes.map(({ id, top }, i) => {
            const idx = opts.indicators.findIndex((x) => x.id === id);
            if (idx < 0) return null;
            const y = Math.round(top * plotH);
            // 패널이 글자 한 줄보다 낮으면(패널을 열 개 넘게 올린 경우) 이름표끼리 겹친다 — 경계선만
            const h = ((paneLayout.panes[i + 1]?.top ?? paneLayout.volTop ?? 1) - top) * plotH;
            return (
              <div key={id} className="pointer-events-none absolute inset-x-0 z-10" style={{ top: y }}>
                <div className="h-px w-full bg-border/70" />
                {/* 한 줄로 — 길면 가격축 앞에서 말줄임(패널 높이가 한 줄 몫뿐이라 접으면 선을 덮는다) */}
                {h >= PANE_LEGEND_PX && (
                  <div className="ml-2 mr-20 mt-0.5 truncate text-[11px] leading-[13px]">{indLegendNode(opts.indicators[idx], idx, true)}</div>
                )}
              </div>
            );
          })}
        {plotH > 0 && paneLayout.volTop != null && opts.indicators.some((i) => i.visible && INDICATOR_DEFS[i.type].pane === 'volume') && (
          <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top: Math.round(paneLayout.volTop * plotH) }}>
            <div className="ml-2 mr-20 mt-0.5 flex gap-x-3 overflow-hidden whitespace-nowrap text-[11px] leading-[13px]">
              {opts.indicators.map((ind, idx) =>
                ind.visible && INDICATOR_DEFS[ind.type].pane === 'volume' ? indLegendNode(ind, idx, true) : null,
              )}
            </div>
          </div>
        )}
        {/* 다음 봉 카운트다운 — 트레이딩뷰처럼 우측 가격축의 현재가 티커(마지막 봉 종가 라벨) 바로 아래 */}
        {opts.showCountdown && countdown && countdownPos && (
          <div
            className="pointer-events-none absolute z-10 flex justify-center"
            style={{ top: countdownPos.top + 9, right: 0, width: countdownPos.width }}
          >
            <span
              className={`rounded-sm bg-elevated px-1 py-px text-[10px] font-semibold tabular-nums ring-1 ring-border ${
                countdownPos.up ? 'text-up' : 'text-down'
              }`}
            >
              {countdown}
            </span>
          </div>
        )}
        {/* 미체결 지정가·조건부 주문선 옆 취소(X) 버튼 — 각 주문 가격의 y좌표, 우측 가격축 바로 왼쪽에 얹는다. */}
        {/* 수평선 — 가격축 바로 왼쪽에 지우기(×)와 알림(🔔) 버튼. 주문선(X)과 같은 자리 규칙(화면 안에 보이는 선만, repositionPendBtns) */}
        {pendBtns.map((b) =>
          b.hline ? (
            <div key={b.id} className="absolute z-20 flex items-center gap-0.5" style={{ top: b.top - 8, right: b.axisW + 3 }}>
              <button
                onClick={() => opts.setHLineAlert(symbol, b.id)}
                title={b.alert ? `${b.label} — 알림 끄기` : `${b.label} — 현재가가 이 선을 지나가면 알림(한 번)`}
                aria-pressed={!!b.alert}
                className={`pointer-events-auto flex h-4 w-4 items-center justify-center rounded-sm text-[9px] leading-none ring-1 transition ${
                  b.alert ? 'bg-[#2962ff] text-white ring-[#2962ff]' : 'bg-[#2962ff]/15 text-[#5b8def] ring-[#2962ff]/40 hover:bg-[#2962ff]/40'
                }`}
              >
                🔔
              </button>
              <button
                onClick={() => opts.removeHLine(symbol, b.id)}
                title={`${b.label} — 클릭하면 지움`}
                className="pointer-events-auto flex h-4 w-4 items-center justify-center rounded-sm bg-[#2962ff]/15 text-[11px] font-bold leading-none text-[#5b8def] ring-1 ring-[#2962ff]/40 transition hover:bg-[#2962ff] hover:text-white"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              key={b.id}
              onClick={() => (b.conditional ? cancelConditional(b.id) : cancelLimit(b.id))}
              title={`${b.label} — 클릭하면 취소`}
              style={{ top: b.top - 8, right: b.axisW + 3 }}
              className={`pointer-events-auto absolute z-20 flex h-4 w-4 items-center justify-center rounded-sm text-[11px] font-bold leading-none ring-1 transition ${
                b.conditional
                  ? 'bg-[#f0b90b]/15 text-[#f0b90b] ring-[#f0b90b]/40 hover:bg-[#f0b90b] hover:text-black'
                  : b.sell
                    ? 'bg-downDim text-down ring-down/40 hover:bg-down hover:text-white'
                    : 'bg-upDim text-up ring-up/40 hover:bg-up hover:text-white'
              }`}
            >
              ×
            </button>
          ),
        )}
        {/* 수평선 그리기 중 안내 */}
        {drawMode && (
          <div className="pointer-events-none absolute inset-x-0 bottom-9 z-20 flex justify-center px-2">
            <span className="rounded-md bg-[#2962ff] px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg">
              차트를 누르면 그 가격에 수평선을 긋습니다 · <span className="hidden sm:inline">Esc</span>
              <span className="sm:hidden">버튼 다시 누르면</span> 취소
            </span>
          </div>
        )}
        {/* 최신으로 — 과거를 보다가 마지막 봉으로(트레이딩뷰의 실시간으로 이동) */}
        {awayFromLatest && !drawMode && (
          <button
            onClick={() => {
              // 이동 애니메이션(약 1초) 동안은 중간 위치 때문에 다시 뜨지 않게(§ checkLatest)
              latestQuietUntilRef.current = performance.now() + 1100;
              chartRef.current?.timeScale().scrollToRealTime();
              setAwayFromLatest(false);
            }}
            title="최신 봉으로 이동"
            style={{ right: (countdownPos?.width ?? 60) + 8 }}
            className="absolute bottom-9 z-20 flex h-7 items-center gap-1 rounded-full bg-elevated/90 px-2.5 text-[11px] font-semibold text-text shadow-lg ring-1 ring-border transition hover:bg-elevated"
          >
            최신 <span aria-hidden>»</span>
          </button>
        )}
        <div ref={containerRef} className="absolute inset-0" />
        {/* 상장 예정 코인 — 차트 자리에 카운트다운(§ components/Listing.tsx). 상장 전엔 봉이 없다. */}
        <ListingOverlay symbol={symbol} />
      </div>
    </div>
  );
}
