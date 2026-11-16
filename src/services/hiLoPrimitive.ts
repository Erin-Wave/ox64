// 보이는 구간의 최고가·최저가 표시(OKX 식) — Lightweight Charts v4 시리즈 프리미티브. 캔들 시리즈에 한 번 붙여 두면
// 화면에 보이는 봉들 중 고가가 가장 높은 봉의 꼬리 끝과 저가가 가장 낮은 봉의 꼬리 끝에 짧은 가로선 + 가격을 작게 그린다.
// - **계산도 여기서 한다** — LWC 는 팬·줌·새 봉·가격축 드래그 때마다(그리기 직전) updateAllViews 를 부르므로, 거기서 보이는 논리
//   구간을 읽어 봉을 훑으면 따로 구독할 이벤트가 없다(매물대와 달리 지표 설정·레전드와 엮인 상태가 없다). 보이는 봉 수만큼의 선형
//   탐색이라(기본 ~38봉, 최대 수천) 프레임당 비용은 무시할 만하다.
// - 라벨은 봉이 화면 오른쪽 절반이면 왼쪽으로, 왼쪽 절반이면 오른쪽으로 뻗는다(차트 밖·가격축 쪽으로 삐져나가지 않게).
// - zOrder 'top' = 캔들 위(라벨이 캔들에 가려지지 않게). 글자는 차트 배경색 테두리(halo)를 둘러 캔들·지표선 위에서도 읽히게.
// - 왼쪽 위 OHLCV 레전드와 겹치지 않게 하는 건 여기가 아니라 Chart 다 — 레전드 높이만큼 캔들 가격축 위 여백(scaleMargins.top)을
//   늘려 가장 높은 꼬리가 레전드 아래에서 시작하게 한다(모바일처럼 레전드가 여러 줄로 접힐 때 특히).
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  Logical,
  SeriesAttachedParameter,
  SeriesPrimitivePaneViewZOrder,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { Candle } from '@/types';

export interface HiLoSource {
  /** 차트가 들고 있는 봉 배열(시간 오름차순, 논리 인덱스 i = i 번째 봉) — 매번 최신을 읽는다 */
  candles: () => Candle[];
  /** 가격 표기(심볼 정밀도·큰 값 축약은 Chart 가 안다) */
  format: (price: number) => string;
}

type DrawTarget = Parameters<ISeriesPrimitivePaneRenderer['draw']>[0];
interface Mark {
  x: number;
  y: number;
  text: string;
}

const LINE_LEN = 14; // 꼬리 끝에서 뻗는 선 길이(px)
const GAP = 2; // 꼬리 끝 ~ 선 시작, 선 끝 ~ 글자 사이
const FONT = "10px 'Proxima Nova', sans-serif";

class HiLoRenderer implements ISeriesPrimitivePaneRenderer {
  private readonly marks: Mark[];
  private readonly color: string;
  private readonly halo: string;
  constructor(marks: Mark[], color: string, halo: string) {
    this.marks = marks;
    this.color = color;
    this.halo = halo;
  }
  draw(target: DrawTarget) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      const H = mediaSize.height;
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.color;
      ctx.lineJoin = 'round';
      for (const m of this.marks) {
        if (m.y < 0 || m.y > H || m.x < 0 || m.x > W) continue; // 가격축을 끌어 꼬리 끝이 화면 밖이면 안 그린다
        const left = m.x > W / 2; // 오른쪽 절반의 봉은 라벨을 왼쪽으로
        const dir = left ? -1 : 1;
        const x0 = m.x + dir * GAP;
        const x1 = x0 + dir * LINE_LEN;
        // 글자가 위아래로 잘리지 않게 세로 중심만 살짝 안쪽으로(선은 꼬리 끝 그대로)
        const ty = Math.min(H - 6, Math.max(6, m.y));
        const y = Math.round(m.y) + 0.5; // 1px 선이 두 줄로 번지지 않게
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.textAlign = left ? 'right' : 'left';
        const tx = x1 + dir * GAP;
        // 배경색 테두리 먼저 — 글자가 캔들 몸통·격자·지표선을 지나가도 끊겨 보이지 않게
        ctx.strokeStyle = this.halo;
        ctx.lineWidth = 3;
        ctx.strokeText(m.text, tx, ty);
        ctx.fillText(m.text, tx, ty);
      }
      ctx.restore();
    });
  }
}

class HiLoPaneView implements ISeriesPrimitivePaneView {
  marks: Mark[] = [];
  color = '#d1d4dc';
  halo = '#0b0d0f';
  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'top';
  }
  renderer(): ISeriesPrimitivePaneRenderer | null {
    return this.marks.length ? new HiLoRenderer(this.marks, this.color, this.halo) : null;
  }
}

export class HiLoPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private enabled = true;
  private readonly src: HiLoSource;
  private readonly view = new HiLoPaneView();
  // LWC 는 이 배열의 참조로 캐시한다 — 매번 새 배열을 돌려주지 말 것
  private readonly views: readonly ISeriesPrimitivePaneView[] = [this.view];

  constructor(src: HiLoSource) {
    this.src = src;
  }
  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }
  setEnabled(on: boolean) {
    if (this.enabled === on) return;
    this.enabled = on;
    this.requestUpdate?.();
  }
  /** 글자·선 색과 글자 테두리(= 차트 배경) 색 — 테마가 바뀌면 Chart 가 다시 부른다 */
  setColors(color: string, halo: string) {
    if (this.view.color === color && this.view.halo === halo) return;
    this.view.color = color;
    this.view.halo = halo;
    this.requestUpdate?.();
  }
  updateAllViews() {
    this.view.marks = [];
    const chart = this.chart;
    const s = this.series;
    if (!this.enabled || !chart || !s) return;
    const candles = this.src.candles();
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range || candles.length === 0) return;
    // 봉 i 는 논리 좌표 i 가 중심 — 중심이 화면 안에 있는 봉만 센다(반쯤 걸친 끝 봉의 꼬리에 라벨이 매달려 잘리지 않게)
    const from = Math.max(0, Math.ceil(range.from));
    const to = Math.min(candles.length - 1, Math.floor(range.to));
    if (from > to) return;
    let hi = from;
    let lo = from;
    for (let i = from + 1; i <= to; i++) {
      if (candles[i].high > candles[hi].high) hi = i;
      if (candles[i].low < candles[lo].low) lo = i;
    }
    const mark = (i: number, price: number): Mark | null => {
      const x = ts.logicalToCoordinate(i as Logical);
      const y = s.priceToCoordinate(price);
      return x == null || y == null ? null : { x: x as number, y: y as number, text: this.src.format(price) };
    };
    const top = mark(hi, candles[hi].high);
    if (top) this.view.marks.push(top);
    // 보이는 봉이 전부 한 가격이면 두 라벨이 겹친다 — 하나만
    if (candles[lo].low !== candles[hi].high) {
      const bot = mark(lo, candles[lo].low);
      if (bot) this.view.marks.push(bot);
    }
  }
  paneViews() {
    return this.views;
  }
}
