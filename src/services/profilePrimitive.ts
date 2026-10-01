// 매물대(볼륨 프로파일) 그리기 — Lightweight Charts v4 시리즈 프리미티브. 캔들 시리즈에 한 번 붙여 두고, Chart 가 보이는 구간을
// 가격대별로 모은 결과(indicators.volumeProfile)를 setLayers 로 넘기면 차트 **오른쪽 끝에서 왼쪽으로** 자라는 가로 막대로 그린다
// (트레이딩뷰 VPVR 의 오른쪽 배치).
// - zOrder 'bottom' = 배경 바로 위, 격자·캔들 **아래** — 막대가 캔들을 가리지 않는다.
// - 계산은 여기서 하지 않는다(보이는 구간·파라미터는 Chart 가 안다). 여기선 가격 → y 좌표 변환과 그리기만 — 가격축을 위아래로
//   끌거나 자동 스케일이 바뀌어도 updateAllViews 에서 좌표를 다시 잡으므로 막대가 칸에 붙어 따라간다.
import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesPrimitivePaneViewZOrder,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { PriceProfile } from './indicators';

export interface ProfileLayer {
  prof: PriceProfile;
  /** 막대 최대 폭(차트 폭 대비 0~1) — 가장 큰 칸이 이 길이 */
  width: number;
  /** 가치 영역 안(In)·밖(Out)의 매수·매도 막대 색 */
  upIn: string;
  upOut: string;
  downIn: string;
  downOut: string;
  /** POC 선·VA 경계선 색(지표 배정색) */
  line: string;
}

type DrawTarget = Parameters<ISeriesPrimitivePaneRenderer['draw']>[0];
/** 한 장의 화면 좌표(미디어 px) — ys[k] = 칸 경계 lo + k·step 의 y */
interface LayerCoords {
  layer: ProfileLayer;
  ys: (number | null)[];
  poc: number | null;
  vah: number | null;
  val: number | null;
}

class ProfileRenderer implements ISeriesPrimitivePaneRenderer {
  private readonly coords: LayerCoords[];
  constructor(coords: LayerCoords[]) {
    this.coords = coords;
  }
  draw(target: DrawTarget) {
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const W = bitmapSize.width;
      const px = Math.max(1, Math.round(vpr)); // 1 CSS px(선 두께·칸 사이 틈)
      for (const { layer: L, ys, poc, vah, val } of this.coords) {
        const p = L.prof;
        const maxW = W * L.width;
        for (let k = 0; k < p.up.length; k++) {
          const t = p.up[k] + p.down[k];
          const yTop = ys[k + 1];
          const yBot = ys[k];
          if (!(t > 0) || yTop == null || yBot == null) continue;
          const top = Math.round(yTop * vpr);
          let bot = Math.round(yBot * vpr);
          if (bot - top > px * 3) bot -= px; // 칸이 충분히 두꺼우면 사이에 틈을 둬 칸이 구분되게
          const h = Math.max(1, bot - top);
          const len = Math.max(1, Math.round((t / p.max) * maxW));
          const upLen = Math.round((p.up[k] / t) * len);
          const inVa = k >= p.vaLo && k <= p.vaHi;
          // 가격축 쪽(오른쪽 끝)부터 매수, 그 왼쪽으로 매도 — 막대 전체 길이 = 그 가격대의 거래량
          if (upLen > 0) {
            ctx.fillStyle = inVa ? L.upIn : L.upOut;
            ctx.fillRect(W - upLen, top, upLen, h);
          }
          if (len > upLen) {
            ctx.fillStyle = inVa ? L.downIn : L.downOut;
            ctx.fillRect(W - len, top, len - upLen, h);
          }
        }
        // VA 위·아래 끝 — 막대 구역에만 점선
        ctx.save();
        ctx.strokeStyle = L.line;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = px;
        ctx.setLineDash([3 * hpr, 3 * hpr]);
        for (const y of [vah, val]) {
          if (y == null) continue;
          const yy = Math.round(y * vpr) + (px % 2 ? 0.5 : 0);
          ctx.beginPath();
          ctx.moveTo(W - maxW, yy);
          ctx.lineTo(W, yy);
          ctx.stroke();
        }
        ctx.restore();
        // POC — 차트 전체 폭 실선(가장 많이 거래된 가격이 지금 캔들과 어디서 만나는지 보이게)
        if (poc != null) {
          ctx.fillStyle = L.line;
          ctx.fillRect(0, Math.round(poc * vpr - px / 2), W, px);
        }
      }
    });
  }
}

class ProfilePaneView implements ISeriesPrimitivePaneView {
  coords: LayerCoords[] = [];
  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'bottom';
  }
  renderer(): ISeriesPrimitivePaneRenderer | null {
    return this.coords.length ? new ProfileRenderer(this.coords) : null;
  }
}

export class ProfilePrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private layers: ProfileLayer[] = [];
  private readonly view = new ProfilePaneView();
  // LWC 는 이 배열의 참조로 캐시한다 — 매번 새 배열을 돌려주지 말 것
  private readonly views: readonly ISeriesPrimitivePaneView[] = [this.view];

  attached(p: SeriesAttachedParameter<Time>) {
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.series = null;
    this.requestUpdate = null;
  }
  setLayers(layers: ProfileLayer[]) {
    this.layers = layers;
    this.requestUpdate?.();
  }
  updateAllViews() {
    const s = this.series;
    if (!s || this.layers.length === 0) {
      this.view.coords = [];
      return;
    }
    const y = (price: number): number | null => {
      const c = s.priceToCoordinate(price);
      return c == null ? null : (c as number);
    };
    this.view.coords = this.layers.map((layer) => {
      const p = layer.prof;
      const ys: (number | null)[] = [];
      for (let k = 0; k <= p.up.length; k++) ys.push(y(p.lo + k * p.step));
      return { layer, ys, poc: y(p.lo + (p.poc + 0.5) * p.step), vah: y(p.lo + (p.vaHi + 1) * p.step), val: y(p.lo + p.vaLo * p.step) };
    });
  }
  paneViews() {
    return this.views;
  }
}
