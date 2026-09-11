# ox64 — Mock Trading Platform

> 지인들끼리 수익률을 겨루는 모의 선물 트레이딩 플랫폼. 실시간 시세(바이낸스) 기반 롱/숏 진입·청산 연습 + **친구 랭킹**.
> **서버 권위 구조**: 잔고·포지션·주문·손익은 전부 서버(Cloudflare D1)가 계산·보관하고, 체결가는 서버가 외부
> 거래소(OKX→Coinbase 폴백, §3)에서 직접 받아 쓴다 → 클라이언트가 가격/잔고를 조작해도 무의미.
> 프론트(정적 SPA) + 백엔드(Cloudflare Pages Functions) 를 **한 레포·한 배포**로 운영.

> **이 문서 읽는 법** — §1~§3 = 구조 · §4 = 체결·정산 규칙(돈이 걸린 부분) · §5 = 배포·마이그레이션 ·
> **§6 = D1 예산과 함정(새 기능을 얹기 전에 반드시 볼 것)** · §7~§10 = 트레이딩과 분리된 독립 게임 셋 · §11 = 백로그.
> **⚠ 표시는 "여기서 실제로 사고가 났다"는 뜻**이다 — 그 규칙을 되돌리기 전에 문단을 끝까지 읽을 것.
> 완료된 작업의 이력·실측치는 [docs/HISTORY.md](docs/HISTORY.md) 에 있다(§11). `AGENTS.md` 는 이 파일을 가리키는
> 포인터이므로 내용은 **여기에만** 쓴다.

## 1. 기술 스택 (선정 이유 = 성능 + 무결성)

| 역할 | 기술 | 이유 |
| --- | --- | --- |
| 프레임워크 | **Vite + React (TS)** | 순수 SPA, Pages 배포 최적화 |
| 차트 | **TradingView Lightweight Charts v4** | Canvas 초경량, 실시간 60fps |
| 실시간 시세 | **RxJS + Native WebSocket** | 초당 수십 틱 스트림(표시 전용) |
| 상태/UI | **Zustand + Tailwind CSS** | selector 구독으로 리렌더 차단 |
| **백엔드** | **Cloudflare Pages Functions** (`functions/`) | 프론트와 같은 레포·배포. `/api/*` 라우트 |
| **DB** | **Cloudflare D1 (SQLite)** | 서버 권위 저장소 |
| **인증** | HMAC 서명 세션 쿠키 + PBKDF2 패스코드 | 세션테이블 불필요. 쿠키 30일. 클라 `init/refresh` 는 **401 일 때만** 로그아웃(일시적 네트워크/5xx 엔 세션 유지, `api.ts ApiError`) |

> **왜 서버 권위인가**: 클라 값은 콘솔로 100% 변조 가능 → 랭킹이 무의미. 진실원본을 서버로 옮김.

## 2. 폴더 구조 (역할 한 줄)

```
ox64/
├── index.html              SPA 진입(다크). favicon + Proxima Nova + 구글 애드센스 로더(ca-pub-6831535776648677, 광고 단위 없음)
├── wrangler.toml           Pages+Functions 설정. D1 바인딩(DB) 코드 관리 → Git 배포가 읽음
├── schema.sql              D1 스키마(users/positions/orders/pending_orders/conditional_orders/spot_orders(폐기)/spot_trades/spot_candles/spot_bot_state/usage_meter/puzzle_*/dungeon_*/crate_stats). wrangler d1 execute 로 적용
├── docs/HISTORY.md         완료된 작업의 배경·수정·검증 기록(규칙의 진실원본은 이 문서 본문)
├── scripts/                d1-budget.mjs(D1 예산 점검, §6) · sim-crate.ts(`npm run sim:crate` — 드롭 확률·가격·가치를 바꿨으면 반드시, §10) · sim-bot.ts(`npm run sim:bot` — 봇 심리 파라미터를 바꿨으면 반드시. 기본 7일=한 주여야 세션 활성도 평균 1. 편향은 **로그드리프트/틱**(|값| 2e-6 이하)으로 본다)
├── vite.config.ts          @ alias(src), charts/rx 청크 분리
├── tailwind.config.js       색상 토큰이 CSS 변수 참조 — 실제 값은 src/index.css 테마 블록
├── cron/                   ── 접속자 없이도 돌아야 하는 백그라운드 전용 Cron Worker(메인 Pages 와 별도 배포) ──
│   ├── wrangler.toml       name="ox64-liquidation-cron", 같은 D1 바인딩, crons=["* * * * *"]
│   └── index.ts            매 1분 "페어별 봇 버스트(runMarketMakerBurst) → sweepTriggers **1회**". ⚠ 4라운드 반복은 invocation당 쿼리 한도(50)를 넘겼다 → 버스트의 **기준가 경로**(rangeOfPath) 최저/최고로 한 번에 판정. fetch() 는 CRON_SECRET 수동 트리거
├── functions/              ── 백엔드 (Cloudflare Pages Functions, /api/*) ──
│   ├── _middleware.ts      Host 가 ox64.app/localhost 가 아니면(*.pages.dev 포함) ox64.app 으로 301
│   ├── _shared.ts          인증(HMAC/PBKDF2)·서버측 시세·D1 타입·loadState
│   ├── _budget.ts          **D1 쓰기 예산 계량기 + 서킷 브레이커**(§6) — 스스로 반복 도는 경로(봇 틱·repeating 조건부·큰 지정가 재체결)만 `usage_meter` 에 누적, 선을 넘으면 그 경로만 물러남. 계량 문장은 **이미 도는 batch 에 얹고**, 조회는 **오늘 한 행만**(PK)
│   ├── _trading.ts         runTriggers = 강제청산→지정가→SL/TP→조건부 평가 본체 / checkTriggers(env,uid) = 접속 폴링 1인분 / sweepTriggers(env) = cron 전 유저(**같은 본체 공유** — "접속 중에만 되는 기능"이 갈라지지 않게)
│   ├── _crateData.ts       상자깡(§10) 콘텐츠 + 순수 로직(D1 없음). **밸런스 진실원본, 고쳤으면 `npm run sim:crate`**
│   ├── _dungeonData.ts     5분 던전(§8) 콘텐츠 — 아이콘 5/영웅 6/몬스터 24/함정 6/포션 4/보스 4/던전 4, partyScale
│   ├── _dungeonEngine.ts   5분 던전 순수 게임 로직(D1 없음) — 셔플/덱빌드/드로우/요구치/함정/adaptReq
│   └── api/
│       ├── login.ts        POST (없는 이름=가입, 있으면 패스코드 검증 → 쿠키 30일) · logout.ts POST
│       ├── state.ts        GET (checkTriggers 후 계정 상태). **`?tick=<pair>` 통합 폴링** — 호가·체결·캔들(+`&state=1` 계정)을 한 요청으로(§6). ⚠ 이 파일이 `api/spot.ts` 를 import 하는 방향이어야 한다(반대면 순환)
│       ├── order.ts        POST (open/close/limitClose/limitOpen/cancelLimit/editLimit/setSlTp/conditionalOpen/cancelConditional). 응답은 `loadState(…, body.ordersSince)` 로 **주문내역 증분**(§6)
│       ├── refill.ts       POST (파산 안전망 — 1일 3회, +10,000 USDT)
│       ├── spot.ts         GET (OX 호가창·체결 표시용, ?candles=1) + runMarketMaker() — 봇 심리 모델(nextMarketState)이 기준가를 옮기고 사다리를 깐다. **틱은 순수 계산(simulateTick), N틱 메모리 → 커밋 1회 = 1행**(runBotTicks) — 사다리(`book_json`)·테이프(`tape_json`)·진행 중 캔들(`live_json`)이 그 한 행. 봇 호가는 에스크로 없음, 체결 뒤 정산은 `botFillStmts`
│       ├── leaderboard.ts  GET (자산=잔고+미실현PnL 순위)
│       ├── puzzle.ts       GET/POST — 퍼즐게임(§7). 별도 재화, 보드 정답은 서버만
│       ├── crate.ts        GET/POST — 상자깡(§10). ⚠ **한 요청 = 읽기 1행 + 쓰기 1행**(유저 상태 전부가 한 행의 JSON) — 아이템을 행으로 쪼개지 말 것
│       └── dungeon.ts      GET/POST — 5분 던전(§8). GET 폴링이 곧 동기화 — ⚠ **GET 은 D1 왕복 2회·쓰기 0회** 유지
├── public/
│   ├── favicon.png · fonts/  아이콘(원본 src/resources/images/icon2_256.png) · ProximaNova ttf 4종
│   ├── _redirects          `/* /index.html 200` — SPA 폴백(/api/* 는 Functions 가 먼저). /b,/5m,/s1,/c 직접 진입용
│   └── ads.txt             애드센스 판매자 선언(없으면 경고). 정적 파일이 `_redirects` 보다 먼저 매칭
└── src/                    ── 프론트 ──
    ├── App.tsx             세션확인 → Login 또는 트레이딩 UI(반응형) + 랭킹/설정 모달
    ├── main.tsx            pathname 으로 트레이딩·퍼즐(/b)·던전(/5m)·RTS(/s1)·상자깡(/c) 분기(라우터 없음, 동적 import). useSettingsStore 먼저 import(FOUC 방지). ⚠ /s1 만 StrictMode 안 씌움(이펙트 2회 실행이 rAF 루프를 두 벌 만든다)
    ├── index.css           Tailwind + 테마 CSS 변수 + @font-face + tabular-nums
    ├── types.ts            도메인 타입(Candle/Order/Position/PendingOrder/Side)
    ├── symbols.ts          심볼 38종(바이낸스∩OKX) + VIRTUAL_SYMBOLS/isVirtualSymbol + INTERVAL_GROUPS + KST_OFFSET(+9h)
    ├── format.ts           fmtPrice/fmtVol/precisionFromTick + 축약 헬퍼(§6)
    ├── services/
    │   ├── binanceRest.ts  초기 과거봉(스팟 REST)
    │   ├── binanceWs.ts    kline + orderbookStream(`@depth<N>@100ms` 를 `BOOK_THROTTLE_MS`=200ms 로 솎음) + aggTradeStream. ⚠ **브라우저↔바이낸스 직결**이라 요청·D1 을 안 쓴다 — 갱신 주기를 예산과 무관하게 당길 수 있다(가상 코인은 반대, §6)
    │   ├── okxRest.ts      OKX 시세(실제 코인 mark — 서버 체결가와 같은 소스)
    │   ├── indicators.ts   차트 보조지표 순수 계산 15종(EMA/SMA/BB/RSI/VWAP(롤링)/MACD/Stochastic/ATR/ADX(+DI/−DI)/CCI/OBV/Williams %R/Ichimoku/Parabolic SAR/SuperTrend). 입력=Candle[] 시간 오름차순, 출력=같은 인덱스 정렬(워밍업 null). Ichimoku 선행스팬은 길이가 n+kijun 이라 Chart 가 시간을 연장해 그린다
    │   ├── indicatorDefs.ts 인디케이터 레지스트리(`INDICATOR_DEFS`): 타입별 라벨·패널(overlay=캔들 위 / own=하단 별도 패널)·파라미터 정의(key/label/기본값/범위)·선 스펙(kind line/hist/dots, 스타일, 고정색)·기준선(RSI 70/30 등)·값 포맷·compute. **Chart 는 이 표만 보고 그리므로 지표 추가 = 여기 한 항목 + indicators.ts 계산 함수**(Chart/스토어에 타입 분기를 새로 넣지 말 것)
    │   └── api.ts          백엔드 클라이언트(/api/*, credentials 포함)
    ├── hooks/
    │   ├── useMarkPrices.ts   현재+포지션 심볼 가격 1.2초 폴링. **소스=OKX**(서버 체결가와 동일), 실패 시 바이낸스 폴백. 가상 심볼 제외. 보유·미체결·현재 심볼의 precision 도 없으면 1회 조회(가상 심볼은 가격에서 파생)
    │   ├── useTriggerPoll.ts  로그인 시 **항상 2.5초** /api/state 재조회 = 서버 checkTriggers 클럭. in-flight 가드
    │   ├── useTradeTape.ts    체결 테이프 → recentTrades. ⚠ 가상 코인은 교체 아닌 **`mergeTrades`**(서버가 최근 50건만 주므로 통째로 갈아끼우면 버퍼가 영영 50건). `MAX_TRADES`=400 은 클라 메모리(비용 0)
    │   ├── useEquity.ts       평가자산(= 여유잔고 + Σ(증거금 + 미실현)) + 파산 여부 — 서버와 **같은 식**을 클라 한 곳에만(Header·RefillModal 공유)
    │   └── useSpotPoll.ts     현재 심볼이 가상일 때만 1초 **통합 폴링**(`?tick=`, 3틱에 한 번 `&state=1`). 이 폴링이 곧 봇 클럭. **탭 백그라운드면 정지**(§6)
    ├── store/
    │   ├── useMarketStore.ts   symbol/interval/prices/precisions/connected/chartClickPrice+Nonce+priceTarget(클릭 가격을 받을 칸: ''=주문패널, 'close:<positionId>')
    │   ├── useChartStore.ts    차트 옵션(localStorage) — visibleBars, 토글류, bookRows(5~50/기본 10, `clampRows`), bookTogether, 체결 필터(`cleanLimit` 이 0/음수/NaN→null), tradeStrength. `indicators: IndicatorConfig[]`(`{id,type,params:Record<string,number>,visible}`) — 예전 `{period,mult}` 저장값은 load 시 params 로 마이그레이션. `addIndicator/removeIndicator/updateIndicator(id, params 패치)/toggleIndicator(id)`(visibility on/off — 삭제와 별개)
    │   ├── useSettingsStore.ts 테마+거래모드(easy/standard), setTheme 이 `dataset.theme` 도 갱신
    │   └── useTradingStore.ts  서버 상태 캐시 + 액션 + spotBook/spotTrades(표시용). **체결 목록은 `dripTrades` 가 0.1~0.25초 간격으로 한 건씩** 흘려보낸다(§6, 비용 0). ⚠ 새 체결 식별은 **`createdAt`**(테이프 `id` 는 폴링마다 바뀜). 코인 전환 시 `spotClear` 가 타이머를 지울 것
    └── components/
        ├── RefillModal.tsx      파산 팝업 — 평가자산 ≤0 이면 자동. 판정은 `useEquity` 하나만. 닫으면 **0 을 벗어날 때까지** 다시 안 뜸
        ├── VipModal.tsx · VipBadge.tsx  VIP 진행도·뱃지 — 기준표는 서버(loadState.vipTiers)
        ├── Logo.tsx            워드마크 — 15×3 픽셀아트 인라인 SVG(currentColor). 높이 3의 배수, 폭 w-auto(§6)
        ├── Login.tsx           이름+패스코드 로그인/가입
        ├── Header.tsx          심볼/현재가/평가자산/리필(평가자산≤0 일 때만)/랭킹/설정/로그아웃. 모바일은 "⋯" 더보기
        ├── SymbolSelect.tsx    실제 38종 + 가상 코인을 **같은 목록·같은 정렬**로. OX 가격=`/api/spot`, 24h변동=`?candles=1&interval=1h&limit=24`. `statOf(sym)` 이 소스만 분기
        ├── OrderBook.tsx       호가(매수 좌·매도 우)/체결 탭. 내 미체결 가격대 강조(서버 `mine`). 체결 행은 가격·수량 모두 테이커 방향 색. Standard+옵션(orderBook) 둘 다 켜야 표시. PC(md≥768)에서 `bookTogether` 면 호가·체결 상하 함께 — `useIsDesktop` 은 App.tsx 2열 분기와 **같은 경계**. ⚠ 훅을 `옵션 && useIsDesktop()` 처럼 단축 평가 뒤에 두면 훅 개수가 바뀌어 터진다. 높이=`bookRows × ROW_PX(16)` — ⚠ **maxHeight 가 아니라 height 고정**(체결이 흘러들 때 패널이 오르내림; 행 높이를 바꾸면 ROW_PX 도 같이). 강세/약세 레벨(tradeStrength): ⚠ 틱 방향이 아니라 **"이 가격이 싼가/비싼가"** — `strengthAt` 이 그 체결 **직전 120건의 중앙값/MAD(robust)** 대비 z(평균은 스윕 프린트가 잣대를 부풀림), z→레벨은 **꺾은선**(z=2.5 까지 선형 30, 위는 로그 압축으로 z=600 에서 50), 가격 칸 배경에 **왼쪽에서 자라는** 바. 기준은 **trailing**(행마다 자기 시점), **표시할 행에 대해서만**, 창은 **필터 이전 원본 테이프**에서
        ├── Settings.tsx        테마·차트 색·호가/체결 행 수·PC 함께 보기·체결 필터·강세/약세·거래모드·폰트 모달(`max-h-[90dvh] overflow-y-auto`)
        ├── Clock.tsx           KST 시계(자체 상태만 갱신). Chart 툴바 우측
        ├── Chart.tsx           **⚠ 캔들을 직접 폴링하지 않는다** — 통합 폴링이 스토어에 넣은 봉을 구독만(과거봉 lazy 로드만 자기 요청). 연결 표시는 **신선도**(8초). LWC v4: KST+9·OHLCV 레전드·카운트다운(우측 가격축 현재가 라벨 아래, `priceToCoordinate`+`priceScale('right').width()`)·B/S/L 마커·평단선+청산가선·SL/TP선·지정가/조건부 주문선(X 버튼)·차트 클릭→지정가·테마 재도색. 인디케이터는 레지스트리(indicatorDefs) 기반 — 선마다 시리즈 1개(`Map<id, Map<lineKey, series>>`), own 패널 지표는 `priceScaleId=ind.id` 로 하단에 자동 스택([캔들]/[패널들]/[거래량], 높이는 개수로 나눔), 숨김은 `series.applyOptions({visible:false})`(삭제 아님, 레전드·패널 배치에서도 제외). null 은 whitespace 로 넣어 선이 끊긴다(SuperTrend 국면 전환·워밍업). 옵션 패널: 지표 행마다 👁 토글·파라미터 입력(def.params 자동 생성)·삭제, 추가는 오버레이/오실레이터 optgroup 셀렉트. 가상 심볼 표시범위는 최초 로드 때만(매 폴링 재설정하면 줌 리셋)
        ├── OrderPanel.tsx      Easy=슬라이더+롱/숏 / Standard=시장가·지정가·조건부 탭+SL/TP+수량(코인/USDT). **⚠ 수량 진실원본은 입력칸 문자열(`amtInput`)이고 코인 수량은 `sizeCoin` 파생**(반대로 두면 왕복 정밀도가 깨져 USDT 입력이 튄다). OXUSDT 도 같은 컴포넌트
        ├── PositionsPanel.tsx  포지션(청산가 `fmtPriceShort`·부분청산 입력+비중 슬라이더(진실원본은 입력칸, 슬라이더는 `closePctOf` 파생; 빈칸=전량)·지정가 청산 입력(비우면 시장가, 포커스 시 차트 클릭 가격 수신)·SL/TP 편집) / 미체결(reduce-only 뱃지) / 조건부 / 주문내역
        └── Leaderboard.tsx     자산 순위 모달(5초 폴링) + 거래소 수수료 수익(유저분/봇분)
    └── puzzle/                 ── 퍼즐게임(/b, §7) ── api.ts(별도 번들) · usePuzzleStore.ts(open() 은 로컬 보드에 결과만 이어붙임 — 끝난 판이 안 사라지게) · PuzzleLogin · Board(연 칸만 그림) · PuzzleApp
    └── sc/                     ── 미니 RTS(/s1, §9) — **서버·로그인 없이 전부 클라이언트** ── types(타일 24px·맵 64×64·틱 30Hz) · data(유닛 4·건물 5, 밸런스는 여기만) · map(180° 대칭·연결성 보장·안개) · pathfind(A*, 유닛은 장애물 아님) · game · ai(0.5초 판단, owner 인자로 AI 대 AI) · render(전부 도형) · Hud · ScApp(rAF 루프, HUD 8Hz)
    └── dungeon/                ── 5분 던전(/5m, §8) ── api(playCards 여러 장 한 요청) · data(표시 메타 + planAutoPlay — 덱·판정은 서버) · useDungeonStore(**적응형 폴링** 진행 0.5s/로비 1s/종료 2s/방 없음 4s, 같은 응답이면 setState 스킵) · Login · Rules(+IconLegend) · EventLog · Lobby · GameBoard · Card · DungeonApp
    └── crate/                  ── 상자깡(/c, §10) ── api(⚠ 확률·가격·가치는 **서버 응답 그대로**) · data(등급색·fmtG·fmtP) · crate.css(0.2~0.7초) · useCrateStore(개봉 결과는 같은 보상끼리 **합산**) · Login · OpenStage · Shop(확률 공시) · Inventory(드래그 머지, ⚠ 포인터 좌표를 리렌더에 안 태움) · Collection
```

## 3. 데이터 흐름

```
시세(표시 전용):
  바이낸스 스팟 REST ─(초기 500봉)─► Chart.setData()
  바이낸스 스팟 WS   ─(RxJS kline$)─► Chart.update()
  OKX REST(1.2s)     ─(useMarkPrices)─► useMarketStore.prices (현재가/PnL mark)

거래(서버 권위):
  Login ──POST /api/login──► [세션쿠키]
  OrderPanel ──POST /api/order {symbol,side,size,leverage}──► functions/api/order.ts
                                                                │ 서버가 OKX 서 체결가 fetch
                                                                │ 증거금/손익 계산·검증
                                                                ▼
                                                            D1 (users/positions/orders) 원자 갱신
                                                                │
  useTradingStore ◄──(갱신된 state 응답)────────────────────────┘
  Leaderboard ──GET /api/leaderboard──► 전 유저 equity(잔고+미실현) 순위
```

- **차트 시세 = 바이낸스 스팟**(REST `api.binance.com/api/v3/klines`, WS `stream.binance.com:9443`; 선물 WS 는 지역에 따라 막힘). **클라 시세는 표시 전용** — 체결가는 서버(`_shared.fetchPrice`)가 따로 받는다.
- **⚠ 서버 시세 = OKX → Coinbase → 바이낸스미러 폴백**(바이낸스는 Worker egress IP 를 403 차단). OKX(`BASE-USDT`) 우선, Coinbase(`BASE-USD`, USD≈USDT) — 새 심볼 추가 시 두 매핑 확인. `timedFetch`(2.5s) 로 느린 소스는 즉시 다음 폴백.
- **⚠ 실제 코인 mark(현재가/PnL) = OKX, 차트 캔들만 바이낸스**: 서버 체결가가 OKX 인데 클라 mark 가 바이낸스면 코인별 0.005~0.3% 어긋나 고배율에서 진입 즉시 손익이 튄다(200배면 0.05% 도 10% ROE). `useMarkPrices` 가 OKX 로 채우고 open 응답의 `markPrices[symbol]=체결가` 로 시드. **차트 WS(klineStream)는 캔들만 그리고 `setPrice` 하지 않는다**(OX 스폿캔들 경로의 setPrice 는 ref=체결소스라 유지). 캔들은 바이낸스 유지(전 인터벌 — OKX 는 8h 미지원).
- **가격 정밀도(심볼별)**: `binanceRest.fetchPricePrecision`(`PRICE_FILTER.tickSize`) → 차트 `priceFormat` + `useMarketStore.precisions[symbol]` → 모든 가격 표기는 `fmtPrice(v, precisionOf(...))`. ⚠ 차트가 "현재 심볼"만 채우면 다른 심볼 포지션이 소수 2자리 폴백 → `useMarkPrices` 가 보유·미체결·현재 심볼 전부 채운다(**가상 심볼은 가격에서 파생** — 유효숫자 4자리라 `setPrice` 가 매 갱신 계산, §4).
- **⚠ 거래량 히스토그램 색은 캔들 색에서 파생**(`volColors`/`withAlpha`, alpha 0.45) — 하드코딩하면 테마를 바꿔도 거래량만 옛 배색. **⚠ 색이 데이터 포인트에 박혀 `applyOptions` 로 안 바뀐다** — 테마 변경 이펙트가 `syncIndicators()` 를 다시 불러 전체를 새로 그린다.
- **⚠ 과거봉 lazy 로드는 실제 심볼·OX 양쪽 모두**. OX 는 `api.spotCandles(interval, 500, oldest*1000)`(서버 `loadSpotCandles` 가 `endTime` 으로 `bucket < ?` 페이지네이션). **<60s 는 영속 캔들이 없어 `endTime` 이 오면 빈 배열**(최신 구간을 다시 주면 무한히 덧붙인다). **⚠ 폴링이 과거봉을 덮어쓰지 않게 병합**(최신 구간만 교체). 초기 로드 후 `setVisibleLogicalRange` 로 **최근 ~38봉**(visibleBars), `from<10` 이면 과거 500봉 prepend + 오프셋으로 뷰 보존, `loadingMore`/`noMore`(fresh<450=끝) 가드.
- **차트 시간축은 KST(+9h) 고정** — 모든 시간값에 `KST_OFFSET` 을 더한다(LWC v4 는 UTC 라벨). 매매마커=orders(long=B arrowUp, short=S arrowDown, close=C, liquidation=L). 평단선=심볼 포지션 가중평균 `createPriceLine`. **바이낸스는 1년봉 미지원 → 최대 1개월봉**.

## 4. 모의 체결 로직 (서버 = `functions/api/order.ts`)

- **진입(open)**: 서버가 `fetchPrice(env, symbol)` → 증거금 `price*size/leverage` 를 잔고에서 **조건부 UPDATE**(`balance >= margin`)로 원자 차감, 부족하면 거부. 포지션+주문 INSERT 는 `DB.batch`. `fetchPrice` 는 `isVirtualSymbol(symbol)` 이면 OKX/Coinbase 대신 봇 내부가격(`spot_bot_state.ref_price`) — **OX 도 이 코드 그대로 거래되고 체결가 소스만 다르다.**
  **⚠ 같은 심볼·같은 방향 물타기 = 포지션 병합**(원웨이 모드): 새 행을 만들지 않고 그 포지션에 합쳐 평단가 재계산. 레버리지는 **최초 진입 값으로 고정**(한 포지션에 레버리지가 섞이면 증거금 계산 불가) — 클라 값은 기존 포지션이 있으면 무시하고 `existing.leverage`. `limitOpen` 체결(`_trading.ts`)도 같은 병합(`posBySymbolSide` 맵으로 같은 라운드 안의 연속 체결까지).
- **미실현 PnL** `(mark-entry)*size*dir` — 저장 안 하고 랭킹/표시에서 계산.
- **마진 모드 = 크로스 고정**: 전 포지션이 계좌 전체(여유잔고+전 증거금)를 공유 담보로 쓰고, 강제청산은 **평가자산 ≤ 0 일 때 전 포지션 동시**로만. 아이솔레이티드 옵션 없음(OrderPanel 레버리지 뱃지·PositionsPanel 뱃지에 "크로스" 명시).
- **⚠ 크로스 가용 증거금 = 여유잔고 + 전 포지션 미실현손익**(`_shared.unrealizedTotal`, = 평가자산 − 사용중 증거금): 신규 주문(open/limitOpen)은 보유 포지션의 미실현이익까지 담보로 쓴다(여유 현금만 보면 이익 중 포지션이 새 주문에 안 잡혀 사실상 아이솔레이티드). 그래서 `users.balance` 는 **음수까지 허용**되고 가드는 `balance − margin >= −uPnL`(⟺ `가용 >= margin`) 원자 UPDATE. 클라(OrderPanel 슬라이더·"가용(크로스)")도 서버 `markPrices` 로 같은 식. OX 시장가도 `matchMarketOxOrder(…, floorPnL)`.
- **⚠ 평가자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익)** — 증거금은 진입 때 잔고에서 빠지지만 청산 때 `balance += margin + pnl` 로 돌아오는 **순자산의 일부**다. 강제청산(`_trading.ts liquidateIfBankrupt`)·리필(`refill.ts`)·랭킹(`leaderboard.ts`)·클라 표시(Header/PositionsPanel/Chart 청산가, `useEquity`)가 전부 이 식(증거금 항을 빠뜨리면 슬라이더 100% 진입이 즉시 강제청산되고 랭킹 자산이 증거금만큼 깎여 보인다).
- **청산(close)**: 실제 코인 38종은 청산가 fetch → `pnl` → 잔고에 `margin+pnl` 반환, 포지션 DELETE, close 주문 기록(pnl 포함, 전부 batch). `size` 지정 시 **부분 청산**(증거금·수량을 비율만큼 축소), 생략/전량이면 DELETE(외부시세 mark 정산이 표준).
  - **⚠ OX 시장가 매칭 = 스냅샷 기반**: 봇 호가를 **1회 읽어 메모리에서 walking**(실사다리 소진 후 합성 흡수까지) → 결과를 **단일 batch** 로. 왕복이 주문 크기와 무관하게 상수(수 read + charge + batch 1회), claim 경합 스핀 없음(소비한 실호가는 best-effort UPDATE — 리쿼트가 이미 지웠어도 봇은 무한 유동성이라 체결 성립). 합성 흡수는 `SYNTH_STEPS`=24 균등 분할 + `SYNTH_MAX_IMPACT`=3% 상한. 지정가(reduce-only 청산·marketable limitOpen)는 합성 안 함 — 크로스 호가 없으면 잔량 대기. ⚠ 청크마다 D1 을 왕복하던 예전 방식(대량 주문이 느리고·조금씩·급락·멈춤)으로 돌아가지 말 것.
  - **⚠⚠ 유저 체결은 "한 줄"이 아니라 walking 한 가격대별로 여러 줄**(`splitPrints`/`userTradeStmts`): 같은 가격은 한 줄(사다리 한 단계 = 한 체결), 줄 수는 `USER_PRINT_MAX`(20)로 묶되 **인덱스를 정확히 max 칸으로 균등 분할**한다(`per=ceil(n/max)` 로 크기를 먼저 정하면 줄 수가 `ceil(n/per)` 로 떨어져 상한의 절반쯤만 나온다), 연속 구간은 가중평균가로 순서 유지. 시각은 1ms 씩 벌려 마지막이 정확히 `now`(같은 ms 면 정렬 불안정 + 클라 `dripTrades` 가 시각으로 새 체결을 식별해 한 건만 흘린다). 봇처럼 `tape_json` 에 얹지 않는 이유: 봇이 매 틱 덮어써 유저 체결이 사라진다. **계량은 flat 단가가 아니라 실제 줄 수**(`feeAccrualStmts(…, prints.length)` → `_budget.rowsForFill`) — flat 을 20줄 기준으로 올리면 1~3줄짜리 평범한 체결까지 3배 과대 계상된다. ⚠ 새 체결 경로가 여러 줄을 찍으면 반드시 줄 수를 넘길 것(누락=과소계상=다음 청구서). 적용: 시장가 진입/청산·지정가 체결. `recordVirtualFill`(SL/TP 등 mark 정산)은 1건 그대로.
    **⚠⚠ 프린트 한 줄 = INSERT 한 문장이면 안 된다(`TRADE_INSERT_ROWS`=12)** — 무료 플랜은 invocation당 D1 쿼리 50 이고 `DB.batch` 문장 하나가 1쿼리다(§6). 20줄이면 시장가 한 방이 47~51 쿼리라 주문 크기·보유 심볼 수에 따라 "가끔" 넘고, 넘기면 batch 가 통째로 던져지는데 **잔고 차감(charge)은 그 앞에서 이미 확정**돼 증거금만 빠지고 포지션이 안 생긴다. 그래서 다중행 INSERT(`VALUES (…),(…)`)로 12줄당 1문장(20줄 = 2문장, ~30쿼리). 12 는 **D1 바운드 파라미터 상한 100 ÷ 8컬럼** — 컬럼을 늘리면 같이 내릴 것.
  - **⚠ 합성 흡수(synth) 램프의 기준은 "사다리를 다 먹은 지점"**(`synthBase = planned[마지막].price ?? est`) — `est`(주문 전 기준가)에서 다시 시작하면 사다리 위쪽까지 먹고도 합성 첫 스텝이 아래로 되돌아간다. 진입·청산 모두 단조(매수 오름/매도 내림), 대량 슬리피지는 "책을 다 먹은 자리 + 최대 3%".
  - **⚠ 유저 체결이 적정가(anchor)를 끌어당긴다(`ANCHOR_TRADE_PULL`=0.5)**: `matchMarketOxOrder`/`closePositionAgainstBook` 이 체결 후 `newAnchor = anchor + (newRef−anchor)×0.5`. 안 하면 다음 봇 틱의 평균회귀가 움직임을 통째로 되돌려 "매수했는데 급락"이 된다(대량 주문은 정보/수요라 적정가 자체를 옮긴다). 봇↔봇 합성체결·봇 전용 sim 에는 적용 안 함(장기 안정성 불변).
  - **⚠ 시장가 진입은 목표 수량을 감당 가능한 만큼 먼저 클램프**: `affordableUnits = (balance + floorPnL) × 0.999 / (est/lev + est×feeRate)` 로 줄인 뒤 walking(안 하면 부풀린 평단→즉시 강제청산). ⚠ 메모리 정산 시 감당분은 `avail×(1−1e-6)`(budget)로 잘라야 한다 — 정확히 avail 이면 charge 의 원자 가드가 부동소수로 실패해 체결이 통째로 0. 청산(`closePositionAgainstBook`)은 환급이라 클램프 없음.
  - **⚠ OX 시장가 청산 = 봇 호가창 walking**(`spot.ts closePositionAgainstBook`, 진입과 대칭): 있는 물량만 실제 호가 가격에, 부족하면 **그만큼만 부분 청산하고 나머지는 포지션에 남긴다**(호가가 없으면 "청산할 수 있는 호가 물량이 없습니다"). PnL·환급은 가중평균 체결가 기준. `order.ts close` 가 OX 면 `marketCloseOxPosition`. ⚠ 호가창을 무시하고 `fetchPrice` 한 값에 전량 정산하던 예전 방식 금지.
- **⚠ 미체결 주문 수정(editLimit)**: 지정가·수량을 취소 없이 수정. 진입 지정가는 새 증거금 델타만큼 잔고 조정 — **잔고 차감을 먼저 원자 가드(`balance − delta >= −uPnL`)로 확정하고 성공했을 때만 pending UPDATE**. **⚠⚠ D1 batch 는 조건부 UPDATE 가 0행이어도 실패로 안 본다** — 잔고 가드와 후속 쓰기를 한 batch 에 넣으면 "증거금 없이 주문만 커지는/포지션만 생기는" 상태가 된다(conditionalOpen 실제코인 경로·던전 §8 도 같은 규칙). reduce-only 는 증거금이 없어 값만 갱신. OX 는 수정 후 즉시 재매칭. UI: `PositionsPanel` 미체결 탭 "수정" + 차트 주문선 옆 취소(X).
- **⚠ 지정가 청산(limitClose, reduce-only)**: `pending_orders.reduce_only=1`, **증거금은 안 잠근다(margin=0)**, side 는 포지션 반대(롱 청산=`short`). 체결 시 새 포지션을 열지 않고 대상 포지션(반대 side)을 그 수량만큼 줄인다. **OX** 는 제출 즉시 + 재호가 sweep + `checkTriggers` 가 `matchReduceOnlyOxPending`(`closePositionAgainstBook` 을 limitPrice 로 walking)으로 매칭, **실제 코인**은 `_trading.ts settleReduceOnlyClose` 가 mark 크로스(매도청산 `mark>=limit`/매수청산 `mark<=limit`) 시 지정가에 정산. 대상 포지션이 없으면 고아 pending 자동 삭제. `cancelLimit` 환불 0. **⚠ 청산 예약 수량 ≤ 보유 − 이미 걸어둔 reduce-only 합**(원웨이라 symbol+closeSide 의 reduce_only 는 전부 이 포지션 대상; `limitClose`·`editLimit` 둘 다 검증. 클라 placeholder 도 "청산 가능"=보유−예약, 지정가 청산 시 비우면 그 값을 보낸다). **⚠ SL/TP 루프는 포지션을 스냅샷이 아니라 최신 상태로 다시 읽는다**(같은 폴링의 reduce-only 청산이 줄인 포지션을 이중 청산하지 않게).
- **입력 검증**: USDT 페어 형식·side∈long/short·레버리지 1~250(⚠ 서버 `order.ts` 4곳과 클라 `OrderPanel.MAX_LEVERAGE` 가 **같은 값**이어야 한다)·`badSize(size)`(=`size>0 && isFinite` — **상한은 여기서 안 본다**).
  - **⚠⚠ 수량 상한 초과는 "거부"가 아니라 "클램프"(`_shared.clampOrderSize`, 캡 `1e60`)** — 상한은 부동소수 폭주만 막는 안전장치고 실제 한도는 `증거금+수수료 <= 가용` 가드다. 캡을 숫자로 거부하면 유저가 자릿수를 더 넣는 순간 같은 버그가 재발한다(1e6→1e15→1e30 으로 세 번 터졌다 — "수량 오류"라 주문 자체가 안 되는 것처럼 보였다). 파싱 지점(`open`/`limitOpen`/`editLimit`/`conditionalOpen`/`editConditional`) 전부 `clampOrderSize` 를 거치고, 그 뒤는 증거금 가드가 판정: 실제 코인은 `noMarginMsg`("증거금이 부족합니다 (최대 약 N 개)", 식은 클라 슬라이더와 동일), OX/EW 는 감당 가능 수량으로 클램프해 부분 체결. `1e999`(Infinity)도 `> MAX` 로 흡수, `NaN`/0/음수만 "수량 오류". 캡 1e60 은 잘리는 일 자체가 없게 하는 값(BTC 최고가를 곱해도 double 한참 아래). ⚠ 새 주문 경로에서 `Number(body.size)` 를 그냥 쓰지 말 것(1e300 이 명목금액 곱셈에서 Infinity→NaN 이 되어 잔고 오염). 청산 수량(`close`/`limitClose`)은 상한이 보유·청산 가능 수량이라 "보유 수량보다 많습니다" 그대로.
  - **⚠ 잔여/전량 판정 오차 = `_shared.sizeEps(size)=max(1e-9, size*1e-12)`** — double 유효자리가 ~16자리라 1e15 개를 여러 청크로 체결하면 합산 오차가 0.1~1 이고, 고정 1e-9 로 비교하면 그 먼지가 "미체결 잔량"으로 남아 전량 청산해도 포지션이 안 지워진다. 적용: `spot.ts` 청산 `fullyClosed`·pending 소진, `_trading.ts` reduce-only `fullyClosed`·조건부 잔량, `order.ts` 보유수량/부분청산/청산가능 검증. **전량이면 증거금은 비율이 아니라 잠긴 전액(`pos.margin`) 환급**(반올림 손실이 잔고에 남지 않게).
- **⚠ 진입 지연 감소**: 실제 코인 `open` 은 `checkTriggers`(보유 심볼 시세)와 `fetchPrice(symbol)` 를 `Promise.all` **병렬**(둘 다 끝난 뒤 잔고/포지션을 읽으므로 원자성 안전). 시세 소스 fetch 는 `timedFetch`(2.5s AbortController)로 느린 소스를 즉시 다음 폴백으로.
- **지정가(limitOpen)**: `pending_orders` 에 `limit_price` 기준 증거금 즉시 잠금(조건부 UPDATE). 실제 코인은 `checkTriggers` 가 mark 크로스 시 `limit_price` 그대로 체결(델타 정산 없음). **OX 는 봇 호가창을 walking 매칭**(`spot.ts matchLimitPendingAgainstBook`, 있는 물량만 실제 호가 가격에·잔량 대기). `cancelLimit` 은 잔량분 증거금 환불.
- **SL/TP(setSlTp)**: `positions.stop_loss`/`take_profit` 포지션당 각 1개, 항상 포지션 방향 기준 검증(`validSlTp()`: 롱 `stopLoss<entry<takeProfit`, 숏 반대).
- **⚠ 조건부(스탑) 주문(conditionalOpen/cancelConditional)**: 지정가와 별개 타입. `conditional_orders`(`trigger_price`+`trigger_dir` 'above'/'below'+side+size+leverage), **증거금은 미리 안 잠근다**(스탑 관행). `settleConditionalOrder`(`_trading.ts`) 가 매 평가에서 above=`mark>=trigger`/below=`mark<=trigger` 면 **그 자리에서 시장가로 남은 수량만큼 진입**: OX 는 `matchMarketOxOrder`(있는 물량만, 잔량은 조건 유지), 실제 코인은 mark 에 **가용 증거금(크로스)만큼만** 체결하고 못 채운 잔량은 조건을 살려둔다(부분 체결마다 `size` 차감, 0 이면 삭제 = "다 안 채워지면 계속 살아있음"). ⚠ 실제 코인 경로도 **잔고 차감을 먼저 원자 가드로 확정한 뒤에만** 포지션/원장 batch(위 editLimit 함정). 물타기는 기존 레버리지 고정·평단 재계산. SL/TP 미지원(진입만). INSERT 직후 `checkTriggers` 1회로 **이미 트리거된 스탑은 즉시 체결**. 취소 환불 0. UI: `OrderPanel` 세 번째 탭 "조건부"(이상/이하 토글+트리거가) + `PositionsPanel` "조건부" 탭.
- **⚠ 무한(반복) 조건부(`repeating=1`)**: 체결돼도 주문이 남는다. `size` 는 **1회 실행 수량(차감 안 함)**, 체결 후 `fill_count+1`·`last_fill_at`. `repeat_mode` 두 가지:
  - **`continuous`(기본)** — 조건이 참인 **동안 계속**(체결 후 `armed=1` 유지 → 다음 폴링에서 또 진입, DCA 용도). **⚠⚠ 재실행 간격 하한 5초**(`_shared.ts MIN_CONTINUOUS_COOLDOWN_MS`) — `cooldown_ms=0`(≈1초)이면 주문 하나가 하루 8.6만 체결 × ~18행 = 월 4,650만 행으로 D1 포함분을 혼자 먹는다(실제 7월 $47 청구의 원인 중 하나, §6). 5초면 월 930만 행. **⚠ 판정은 저장값이 아니라 `effectiveCooldownMs(c.cooldown_ms)`** (하한 도입 전에 만들어진 `cooldown_ms=0` 행 방어) 이고 `order.ts` 는 저장값도 하한으로 올린다(UI 표시와 실제 동작 일치). **⚠ 스스로 멈추지 않는다** — 브레이크는 `cooldown_ms`(≥5초)와 `max_fills` 뿐이고, 트리거가 현재가에서 아주 멀면(OX 1.0 에 "1.8 이하 매수") 조건이 영구 참이라 잔고가 바닥날 때까지 진입한다(선택된 동작, UI 경고 문구). **이 사이트에서 유일하게 스스로 무한히 D1 쓰기를 만드는 유저 경로**라 `settleConditionalOrder` 는 체결 전 `autoWritesBlocked(env)`(§6 `_budget.ts`)를 확인하고 예산 초과면 조용히 물러난다(1회성은 막지 않는다 — 걸어둔 스탑이 안 걸리는 게 더 큰 사고).
  - **`rearm`** — 한 번 실행되면 `armed=0`, 가격이 **트리거 반대편**(`rearm_price`, 미설정이면 `trigger_price`)으로 돌아왔을 때만(below `mark >= rearm`/above `mark <= rearm`) `armed=1`("내려갈 때마다 한 번씩"). 재무장 대기 중엔 **재무장 판정만 하고 즉시 return**(그 폴링엔 절대 체결 없음). `rearm_price` 는 방향 검증(below 는 `rearm >= trigger`, above 는 `rearm <= trigger`).
  - `max_fills`(1~100,000, NULL=무제한) 도달 시 그 체결 batch 에서 삭제. 체결 후 행 처리는 OX/실제 양쪽이 `conditionalAfterFillStmt()` 하나를 공유(1회성=차감/삭제, 무한=횟수+1, continuous 무장 유지·rearm armed=0·상한 도달 삭제). OX 는 `filled > EPS` 일 때만 호출(0 체결이면 다음 폴링 재시도).
  - **⚠ `useTriggerPoll` 은 항상 2.5초**(하한 5초를 충분히 따라잡아 옛 1초 적응형은 폐기 — 더 당기려면 §6 예산 먼저). **⚠ 반복은 앱을 닫아둬도 계속된다**(cron `sweepTriggers`, 접속 중 ~2.5초 / 미접속 1분 주기) — `cooldown_ms`/`max_fills` 를 안 걸면 **자는 동안에도 잔고가 나간다**.
  - **⚠ 신규 컬럼은 마이그레이션 전 DB 에서 `undefined`** — 읽기는 전부 `?? 기본값`(`repeatModeOf()` 포함)으로 방어하지만 `conditionalOpen` 의 INSERT 는 실패하므로 **코드 배포 전에 ALTER 먼저**(§5).
  - UI: `OrderPanel` 조건부 탭 "무한 반복" 체크(반복 방식 토글 + continuous 는 간격(초) / rearm 은 재무장 가격 + 최대 실행 횟수 + 모드별 위험 설명), `PositionsPanel` 조건부 탭 "반복" 컬럼(`계속 ∞`/`되돌아올 때 ∞`, 횟수·간격·무장 상태), `Chart` 주문선 `조건부∞`(재무장 대기면 재무장 가격에 흐린 점선을 하나 더).
- **⚠ 조건부 주문 수정(`editConditional`)**: 트리거가·수량·조건·레버리지 + 반복 설정을 취소 없이 변경. **`editLimit` 과 달리 잔고 정산이 전혀 없다**(증거금을 안 잠그므로 UPDATE 한 방, 순서 함정 없음). 안 보낸 필드는 유지, `null`/`''` 는 해제(`parseRepeatOpts(body, …, prev)` 가 `undefined`=유지 / `null`=해제 구분). 검증은 `conditionalOpen` 과 공유, `max_fills` 는 **이미 실행한 횟수보다 커야** 한다(작으면 저장 즉시 사라진다). 수정 후 **`armed=1` 로 되살리고** `checkTriggers` 1회(재무장 대기 중 고쳤는데 계속 잠들어 있으면 "수정했는데 안 걸린다"). UI: `PositionsPanel` 조건부 탭 "수정"(인라인 편집).
- **강제청산(계좌 파산)**: `checkTriggers` 맨 앞에서 평가자산 < 0 이면 **전 포지션 강제청산 + 미체결 지정가 전부 취소 + 잔고 0 리셋**, 각 포지션은 `kind='liquidation'` 주문(청산가=그 시점 서버 시세). 심볼 가격을 하나라도 못 받은 라운드는 건너뜀(불완전 데이터로 오청산 방지). 트리거되면 그 라운드의 지정가/SL·TP 평가는 스킵.
- **청산가 표시(추정치)**: `PositionsPanel`/`Chart` 가 클라에서 `entry - (balance + Σ전체margin + 다른 포지션들 미실현손익) / (size*dir)` — 강제청산 조건과 같은 식(증거금 항 포함)이지만 클라 추정(실제 판단은 서버 다음 폴링).
- **⚠ markPrices(청산가 즉시·일관 표시)**: `checkTriggers` 가 자기가 fetch 한 시세 맵을 반환 → `loadState(env,uid,marks)` 가 `markPrices` 로 응답에 싣고 → 클라 `useTradingStore.apply` 가 `useMarketStore.prices` 에 시드. 서버 강제청산과 **똑같은 시세**로 폴링을 기다리지 않고 즉시 계산(OX 미열람·진입 직후 포함 — 클라 폴링만으로는 OX 포지션 현재가가 안 들어와 전 포지션 청산가가 비었다). `open` 은 체결가, `close` 는 청산가를 marks 에 추가.
- **리필(`functions/api/refill.ts`)**: **평가자산 ≤ 0 일 때만 지급** — 포지션이 있으면 서버가 시세 fetch 로 판정(하나라도 못 받으면 거부). `users.refill_count`/`refill_date`(KST) 로 **1일 최대 3회, 1회 +10,000 USDT**, 날짜가 바뀌면 `refill_date !== 오늘` 이라 카운트 0 취급(리셋 cron 불필요 — "폴링 시점에 계산" 패턴). `loadState` 가 `refillsLeft` 포함, `Header.tsx` 도 같은 식으로 버튼을 미리 비활성화. **⚠ 자산이 0 이면 팝업이 자동으로 뜬다(`RefillModal.tsx`)** — 헤더 구석 버튼만으로는 강제청산당한 사람에게 게임이 끝난 것처럼 보였다. 판정은 `useEquity` 하나만(헤더 버튼과 어긋나지 않게), 닫으면 **평가자산이 0 을 벗어날 때까지** 다시 안 뜬다(리필 성공 시 자동 초기화), 스토어 공용 `error` 는 **이 팝업에서 눌러본 뒤에만** 표시.
- **체결 체크 = 접속 폴링(빠른 경로) + cron sweep(접속 무관, 느린 경로)**: Pages Functions 는 정기 실행이 없어 `functions/_trading.ts checkTriggers(env,uid)` 를 `state.ts`(GET, `useTriggerPoll` 2.5초)와 `order.ts`(POST 액션 직후, 수동 조작과 레이스 방지)에서 호출해 **그 유저의 요청 시점에** 강제청산/지정가/SL·TP/조건부를 평가·체결한다(체결가는 지정가/SL/TP 값 그대로, 슬리피지 모델링 없음). 아무도 접속하지 않아도 `cron/` 워커(Pages 는 Cron 미지원이라 별도 배포, 같은 D1 바인딩)가 매 1분 `sweepTriggers(env)` 로 **포지션·미체결·조건부가 있는 전 유저**를 훑는다 — **주기만 다르고 기능 차이는 없다**. 배포·시크릿은 §5(⚠ cron 워커는 수동 재배포).
  - 평가 본체는 `runTriggers(env,uid,pendings,positions,conditionals,prices)` 하나를 `checkTriggers`(1인분)와 `sweepTriggers`(전 유저)가 **공유** — 새 트리거 기능을 추가해도 자동으로 양쪽에서 돈다(sweep 이 강제청산만이던 시절엔 앱을 닫으면 조건부가 멈췼다 — 유저 요청이 유일한 클럭이었기 때문).
  - **⚠ 마켓메이커 틱 예산은 총량 고정, 코인들이 나눠 쓴다**(`cron/index.ts` `MM_TICK_BUDGET`=24, `MM_BUDGET_PER_PAIR = MM_TICK_BUDGET / VIRTUAL_PAIRS.length`, 현재 2코인 × 12틱). 틱은 순수 계산이고 커밋이 페어당 1회라 틱 수가 쿼리·쓰기를 거의 안 늘린다 — 상한을 정하는 건 **CPU(무료 10ms/invocation, 실측 24틱 ≈ 3.5ms)**. 코인을 늘려도 총량은 그대로(코인당 틱만 줄어 움직임이 성겨진다).
  - **⚠ 유저가 보고 있으면 cron 은 물러난다**(`marketMakerTickBudget`, `POLL_ACTIVE_MS`=20s, `BURST_MIN_TICKS`=4): `/api/spot` 폴링이 이미 초당 재호가를 돌리는데 cron 이 12틱을 더 얹는 건 쓰기만 배로 나가는 중복. `last_run` 이 방금이면 폴링이 클럭이라 최소치만(cron 이 찍은 `last_run` 은 다음 실행 때 60초 전이라 안 섞인다). **⚠⚠ 이 판정은 라운드 루프 밖에서 실행당 한 번만** — 안에서 라운드마다 하면 직전 라운드의 자기 `last_run` 을 보고 "누가 폴링 중"이라 오판해 물러난다.
  - **⚠ 트리거는 "현재가 한 점"이 아니라 "지나온 가격 범위"로 판정**(`_trading.ts` `PriceRanges`/`rangeOfPath`): OX 가격은 봇 틱이 돌 때만 움직이고 cron 은 1분치 틱을 몰아 돌리므로, 끝난 뒤 한 점만 보면 그 사이 딥/스파이크를 놓친다. 버스트가 돌려준 경로의 **최저/최고**로 조건부(발동·재무장)·SL/TP·지정가 크로스를 한 번에 판정(거래소의 구간 고저 스탑 판정과 같고 점 샘플링보다 정확). **강제청산만은 현재가**(스쳐간 저가로 파산시키면 되돌릴 수 없다). ⚠ 예전의 "sweep 4라운드 반복"은 sweep 1회가 D1 ~18쿼리라 무료 한도(50)를 넘겼다 — 되돌리지 말 것.
  - **⚠ `MAX_SWEEP_USERS`(8)**: 한 invocation 이 훑는 유저 수 상한. 유저가 늘어도 쿼리 수가 늘지 않게 분 단위로 회전(접속 유저는 자기 폴링이 즉시 처리하므로 늦어지는 건 앱을 닫아둔 유저만).
  - 실제 코인 시세는 한 cron 안에서 재사용(`sweepTriggers(env, cachedPrices?)` → 반환 `prices` 를 다음 라운드에), OX 는 매 라운드 새로 읽는다(`spot_bot_state.ref_price` 가 라운드마다 실제로 바뀐다).
  - 체감 주기: 접속 중 폴링 2.5초 / 미접속 1분 1회. `continuous` 는 하한 5초라 접속 중 분당 최대 12회, 미접속 분당 1회. cron 1분이 Cloudflare 최소 — 더 촘촘히 하려면 §6 예산 먼저.
  - 한 유저의 평가가 예외로 터져도 나머지는 계속(try/catch + `console.error`). 로컬 검증: `cd cron && npx wrangler dev` → `curl .../cdn-cgi/handler/scheduled`(유저 요청 0회로 조건부 반복·cooldown·1회성 삭제·지정가·SL 체결까지 확인 가능).
- **⚠ 거래 수수료 + VIP 등급**: 모든 체결에 `수수료 = 명목금액(체결가×수량) × VIP 요율`.
  - **등급 = 누적 거래대금(`users.total_volume`)**, 증거금이 아니라 **명목금액(레버리지 포함)** 을 진입·청산 각각 누적. **등급은 컬럼으로 저장하지 않는다** — `_shared.ts vipOf(totalVolume)` 가 항상 파생(총거래량 하나가 진실원본).
  - **⚠⚠ 등급은 표가 아니라 공식이고 상한이 없다**(무한 레벨, `_shared.ts`):
    ```
    등급 t 진입 거래대금 = VIP_BASE_VOLUME(1만) × VIP_VOLUME_GROWTH(4)^(t-1)   (t>=1, VIP0=0)
    등급 t 수수료율      = max(VIP_MIN_RATE(1e-9), VIP_BASE_RATE(0.0003) × VIP_RATE_DECAY(0.79)^t)
    ```
    | 등급 | 누적 거래대금(USDT) | 요율 |
    | --- | --- | --- |
    | VIP0 | 0 | 0.03% |
    | VIP5 | 256만 | 0.00923% |
    | VIP10 | 26억 | 0.00284% |
    | VIP20 | 2.7경 | 0.000269% |
    | VIP54+ | 8.1e35 | 0.0000001%(하한) |
    근거: ①거래대금 **×4/등급** — 첫 등급 1만이라 초반 보상이 빠르고, 거래대금이 명목금액이라 고배율 유저는 한 판에 몇 등급씩 뛰므로 촘촘해야 레벨업이 자주 보인다. ②요율 **×0.79/등급** — 옛 13행 표(VIP0~12, 100배/단계)를 근사한 값이라 **등급 숫자만 촘촘해지고 실제 경제는 그대로**(5등급 ≈ 반토막). ③하한 0.0000001% — 0 이면 상위 등급 거래가 수수료 수익에 안 잡혀 랭킹 표시가 멈춘다.
    - ⚠ `format.ts fmtFeeRate`(소수 8자리)는 이 하한에 맞춰져 있다 — 하한을 내리면 같이 늘릴 것.
    - ⚠ 로그로 구한 등급은 기준선에 정확히 걸친 값에서 한 칸 어긋난다(지수가 k−1e-16) — `vipOf` 는 실제 기준선(`vipMinVolume`)과 대조해 양방향 보정.
    - ⚠ **등급표를 통째로 클라에 내려보낼 수 없다**(무한). `loadState` 는 `vipTierWindow(tier)`(현재 −2 ~ +6)만 보내고, 진행률용 현재 구간 하한은 **`vipFrom` 으로 따로**(클라가 표에서 `find` 하면 창을 벗어나는 순간 0 이 되어 진행률이 100% 로 굳는다), 곡선 파라미터 `vipCurve` 도 함께(모달 문구 하드코딩 금지). 응답: `vipTier/feeRate/vipNextAt/vipFrom/vipTiers/vipCurve/totalVolume/totalFees`.
    - ⚠ `VipBadge` 배색은 13단계라 **`STYLE_SPAN`(3)등급마다 한 칸**씩 올라가고 끝에서 고정(새 3등급 ≈ 옛 1등급).
  - **⚠ 진입은 증거금과 "함께" 차감**: 가드 `balance - (margin + fee) >= -uPnL` 하나로(따로 빼면 증거금은 통과하고 수수료만 실패하는 틈). 청산은 환급액에서 차감(`margin + pnl - fee`). 지정가는 주문 시점이 아니라 **체결 시점**에 뗀다.
  - **⚠ 강제청산은 수수료를 걷지 않는다** — 직후 잔고 0 리셋이라 걷을 수 없는 돈. 거래대금은 누적하고 `fee=0` 인 `kind='liquidation'` 원장 행을 남긴다.
  - **⚠ OX 호가창 walking 경로는 부기(카운터+원장)를 합계로 1번만**(청크마다 부르면 원장이 청크 수만큼 불어난다), 요율은 주문당 1회 확정(청크마다 읽으면 도중 등급 상승으로 요율이 갈린다). 감당 역산은 **1코인당 비용에 수수료 포함**(`price/leverage + price*rate`) — 빼먹으면 딱 가용만큼 사려다 가드에 걸린다.
  - **수익 원장 = `fee_ledger`**(체결 1건당 1행: user/symbol/kind/notional/rate/fee/created_at) — 심볼별·기간별·종류별 분해의 진실원본. **⚠ 거래소 수수료 수익 총액은 `users.total_fees` 를 SUM 한다**(`GET /api/leaderboard` 의 `revenue{total,fromUsers,fromBots,volume}`, 랭킹 모달 상단) — 원장은 봇 때문에 수백만 행이라 5초 폴링으로 스캔 불가. `feeAccrualStmts` 가 원장과 카운터를 같은 batch 에서 갱신하므로 둘은 항상 일치. 봇이 물량 대부분을 만들므로 유저분/봇분을 분리 표시.
  - **⚠ 클라 슬라이더도 수수료를 넣고 역산**: 서버 가드가 `증거금+수수료 <= 가용` 이므로 `명목가 = 가용 / (1/leverage + feeRate)`(250배에선 수수료가 증거금의 ~7.5% 라 빼먹으면 슬라이더 100% 가 거부된다).
  - UI: `VipBadge.tsx`(헤더 이름 옆·모바일 더보기·랭킹 행) + `VipModal.tsx`(진행 막대·%·남은 거래대금·누적/낸 수수료·주변 등급표 + "계속 이어집니다(상한 없음)" 행), `OrderPanel` 정보란 예상 수수료+등급/요율. **⚠ 등급 기준은 서버 `loadState`(vipTiers/vipFrom/vipCurve) 값을 그대로 쓴다** — 클라에 공식을 또 적으면 서버 기준이 바뀔 때 화면만 틀려진다. 진행률 = `(누적 − vipFrom) / (vipNextAt − vipFrom)`.
  - **⚠ 큰 금액 표시는 `fmtKor`(만/억/조), 반올림이 아니라 내림** — 999,999 를 "100만"으로 올려 보이면 기준선을 넘은 것처럼 읽힌다.
- **아직 없음**: 펀딩비.

### 가상 코인 — OX/USDT · EW/USDT (서버 = `functions/api/order.ts` + `functions/api/spot.ts`) — 실제 코인과 동일한 레버리지, 체결가만 봇이 생성

> **상세는 [docs/VIRTUAL_COIN.md](docs/VIRTUAL_COIN.md)** — 봇 심리 모델(국면/탐욕·공포/세션/코일/저항·지지), 체결 미세구조(호가 바운스·flurry·스톱헌팅·아이스버그), 호가창 지속/취소(`prevBook`), 수량 계층 분포(`SIZE_TIERS`), `book_json`/`tape_json`/`live_json` 링 버퍼, 캔들 영속(`PERSIST_INTERVALS`/`open_at`·`close_at`), 벽 존중, 봇 수수료·재고 정산, 매칭 엔진(시장가/지정가/sweep/`Aggressor`), 유효숫자 4자리 틱. **그 파일이 규칙의 진실원본**이고 여기엔 손댈 때 반드시 지킬 것만 적는다.

- 가상 코인은 2종이고 전부 **페어 파라미터**로 흐른다. 새 코인 추가 시 손댈 곳은 딱 셋 — `functions/api/spot.ts VIRTUAL_PAIRS`, `src/symbols.ts VIRTUAL_SYMBOLS`, D1 `spot_bot_state` 시작가 행. 그 외 심볼 하드코딩 금지. cron 틱 예산(`MM_TICK_BUDGET`=24)은 코인 수로 **나눠** 쓴다(곱하지 말 것).
- OX 는 다른 38종과 **완전히 동일한 코드**(order.ts/OrderPanel/PositionsPanel 에 가상 분기 없음)로 거래되고, 유일한 차이는 체결가 소스(`fetchPrice` 의 `isVirtualSymbol` 분기 → 봇 기준가 `spot_bot_state.ref_price`).
- **봇은 무한 유동성 공급자** — 호가 에스크로·잔고 가드를 절대 붙이지 않는다(음수 재고 정상). 체결 뒤 재고/현금 정산만 `botFillStmts` 로 합계 batch 1회. 봇은 `fee_ledger` 에 행을 남기지 않는다(카운터만).
- **봇 경로에 "행을 남기는" 설계 금지** — 매 틱 교체되는 스냅샷(사다리·테이프·진행 중 캔들)은 상태 행의 JSON 칸(`book_json`/`tape_json`/`live_json`)에 담는다(쓰기 비용 0). 새 INSERT 를 넣을 땐 "누가 언제 지우나"를 반드시 같이 정할 것. 봇이 만든 것은 테이프에, 유저 것은 `spot_trades` 테이블에.
- 틱은 순수 계산(`simulateTick`), N틱 메모리 → 커밋 1회 = 1행(`runBotTicks`). 커밋은 `last_run` 가드가 선점을 겸하고, 진 쪽은 가격 경로를 빈 배열로 반환한다. 닫힌 캔들 flush 도 같은 가드.
- **심리 파라미터를 바꿨으면 `npm run sim:bot`** — 합격선: 5~20일 가격 0.5~2배, 수익률 acf1≈0.55, |수익률| acf1≈0.45, 1분봉 폭 ~2.9%, 추세효율 ≥0.55, 되돌려주는 몫 <55%, 평균 공포 ~0.3, 국면 점유율 calm 39/rally 24/pullback 23/panic 9/euphoria 5/capitulation 0.3%. 로그드리프트 편향 판정은 `SIM_RUNS=24` 이상. `bias` 와 국면 수명은 같이 재조정. `BOT_BASE_PULL` 은 prod 현재 가격에 그대로 꽂히므로 sim 만 보고 정하지 말 것. 되돌림을 풀면 `GAUGE_FULL` 을 같이 넓힐 것. `MOOD_PERSIST+HERD_GAIN<1` 유지.
- 크기 분포·호가 물량을 바꿨으면 sim 이 아니라 **상태 고정 A/B**(`simulateTick` 20만 회)로 "평균 보존"을 잰다(`SIZE_TIER_MEAN`/`FLOW_CORR_NORM`/`FLURRY_MEAN` 정규화). 쪼개기(`SLICE_CHANCE`)는 뽑힌 수량과 무관하게 결정.
- 체결 라벨은 **누가 호가를 때렸나**(원인)에서 나온다 — 가격과 독립적으로 뽑지 말 것. 유저 주문은 `Aggressor`(resting 지정가가 봇에 채워지면 라벨만 반전, buyer/seller·잔고는 `userSide`).
- 호가 사다리는 이전 틱을 물려받는다(`prevBook`) — 체결(테이프)을 먼저 찍고 그 고저로 사다리를 만든다. 슬롯 귀속은 지터 뺀 `LEVEL_STEP` 격자 중심, 생존 주문을 먼저 다 앉히지 말고 슬롯마다 배정, 배정은 새 호가보다 먼저. 사다리 기하(`SPREAD_BASE`/`LEVEL_STEP`/`LEVEL_JITTER`)는 한 곳에만. 라운드 가격 벽은 `priceHash` 로 고정.
- 격자 스냅은 반드시 1e-9 오차 흡수와 함께(`humanQuotePrice`/`OrderBook.snapToGrid`). 가격 관련 상수는 절대값이 아니라 "틱 몇 개"로(`roundVirtual`/`virtualTick`, 유효숫자 4자리). 기준가 클램프는 `VIRTUAL_PRICE_MIN/MAX`(1e-12~1e12) 안전장치일 뿐 — 시세 하한을 거기 적지 말 것.
- 캔들 upsert 에 넘기는 `now` 는 그 체결이 실제로 일어난 시각(과거 시각이면 마감된 봉이 변조된다). 저장 인터벌은 1m/1h/1d 뿐, 나머지는 조회 시 롤업 — 새 인터벌은 그 셋의 정수배여야 한다.
- 벽은 현재가 너머의 비-marketable 주문만(`price>=ref` 매도 / `<=ref` 매수). `sweepRestingOxPendings` 는 요청당 `MAX_SWEEP_FILLS`(2) 체결까지.
- `spot_orders` 테이블은 아무도 읽지도 쓰지도 않는다(롤백 여지로 정의만) — 새 코드에서 참조 금지.

## 5. 빌드 / 실행 / 배포

```bash
npm install
npm run dev          # 프론트 개발 서버 (Vite) — /api 는 안 뜸(아래 pages dev 사용)
npm run build        # tsc -b && vite build → dist/
npm run lint         # 타입체크

# 백엔드까지 로컬 구동 (D1 + functions):
npm run build
npx wrangler pages dev dist        # wrangler.toml 의 D1 바인딩·.dev.vars 사용
```

### Cloudflare 설정 (완료 상태, 2026-07-14) — **바인딩=wrangler.toml / 시크릿=CLI**
- **D1**: `ox64` (database_id `f32f600e-49ad-4026-843f-84f34a62df3c`), 스키마 적용 완료(현재 테이블 목록은 §2 의 `schema.sql` 항목 — **신규 테이블/컬럼은 코드 배포 전에 아래 마이그레이션을 먼저 적용**할 것). 바인딩은 `wrangler.toml` 의 `[[d1_databases]] binding="DB"` 로 코드 관리 → Git 배포가 자동 적용(대시보드 바인딩 UI 는 "managed through wrangler.toml" 로 잠기며, 이게 정상 — 코드가 진실원본).
- **⚠ 컬럼 마이그레이션(최초 1회, 수동)**: `CREATE TABLE IF NOT EXISTS` 는 이미 존재하는 prod 테이블에 새 컬럼을 추가해주지 않는다. 새 컬럼이 생길 때마다 `schema.sql` 맨 아래에 주석 처리된 `ALTER TABLE` 블록을 추가해두니, 배포 후 해당 줄들을 **한 번만** 직접 실행할 것:
  - `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE positions ADD COLUMN stop_loss REAL"` / 동일하게 `take_profit REAL` (지정가/SL/TP)
  - `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE users ADD COLUMN refill_count INTEGER NOT NULL DEFAULT 0"` / 동일하게 `refill_date TEXT` (강제청산 리필)
  - `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE users ADD COLUMN ox_balance REAL NOT NULL DEFAULT 100"` (OX 현물 거래) — `spot_orders`/`spot_trades`/`spot_bot_state` 는 신규 테이블, 봇 유저 2행은 `INSERT OR IGNORE` 라 `--file=./schema.sql` 재적용만으로 자동 생성/시딩됨(ALTER 불필요)
  이미 실행했다면 재실행 시 "duplicate column name" 에러 발생(무시 가능, 이미 적용됐다는 뜻).
  - **⚠ `spot_candles`(OX 영속 캔들, 2026-07-19)**: 신규 테이블이라 `CREATE TABLE IF NOT EXISTS` 라 `--file=./schema.sql` 재적용만으로 생성된다(ALTER 불필요). **코드가 이 테이블을 참조하므로 코드 배포 전에 먼저 생성돼 있어야 한다**(없으면 봇/유저 체결 batch 가 통째로 실패) — prod 엔 이미 적용 완료(`num_tables` 8). 로컬은 `--local --file=./schema.sql`.
  - **⚠ `spot_bot_state` 봇 심리 컬럼(2026-07-20)**: `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE spot_bot_state ADD COLUMN drift REAL NOT NULL DEFAULT 0"` 및 동일 형식으로 `vol REAL NOT NULL DEFAULT 1` / `sentiment REAL NOT NULL DEFAULT 0` / `anchor REAL NOT NULL DEFAULT 0` / `regime TEXT NOT NULL DEFAULT 'calm'` / `regime_ticks INTEGER NOT NULL DEFAULT 0`. **코드(`nextMarketState` 상태 로드/저장)가 참조하므로 코드 배포 전에 먼저 적용돼 있어야 한다** — prod 엔 이미 적용 완료. 전부 DEFAULT 가 있어 기존 행도 그대로 동작(anchor=0 은 "미초기화"라 첫 틱에 현재가로 자동 세팅).
  - **⚠ `spot_bot_state` 고점/저점 기억 컬럼(2026-08-12, 탐욕/공포 심화)**: `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE spot_bot_state ADD COLUMN peak REAL NOT NULL DEFAULT 0"` 및 동일 형식으로 `trough REAL NOT NULL DEFAULT 0`. **코드(`nextMarketState` 가 읽고 `marketMakerTick` 이 UPDATE)가 참조하므로 코드 배포 전에 먼저 적용돼 있어야 한다** — 없으면 봇 틱 batch 가 통째로 실패해 시장이 멈춘다. prod·로컬 적용 완료. DEFAULT 0 = 미초기화라 기존 행도 첫 틱에 현재가로 자동 세팅. 컬럼이 늘어도 UPDATE 는 여전히 1행이라 **D1 쓰기 비용은 그대로**다(§6).
  - **⚠ `pending_orders.reduce_only`(지정가 청산, 2026-07-19)**: `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE pending_orders ADD COLUMN reduce_only INTEGER NOT NULL DEFAULT 0"`. **코드(limitClose INSERT)가 이 컬럼을 참조하므로 코드 배포 전에 먼저 적용돼 있어야 한다** — prod 엔 이미 적용 완료. 재실행 시 "duplicate column name"(무시 가능).
  - **⚠ `conditional_orders`(조건부/스탑 주문, 2026-07-24)**: 신규 테이블이라 `CREATE TABLE IF NOT EXISTS` — `npx wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용(멱등) 또는 `npx wrangler d1 execute ox64 --remote --command "CREATE TABLE IF NOT EXISTS conditional_orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, leverage INTEGER NOT NULL, trigger_price REAL NOT NULL, trigger_dir TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_conditional_user ON conditional_orders(user_id);"` 로 생성. **코드(loadState/checkTriggers)가 이 테이블을 SELECT 하므로 코드 배포 전에 먼저 생성돼 있어야 한다** — 단, loadState/checkTriggers 는 이 조회를 try/catch 로 감싸 미생성 시에도 앱 전체가 500 이 되진 않게 방어함(조건부 기능만 비활성). conditionalOpen(INSERT)만 테이블 없으면 500.
  - **⚠ `conditional_orders` 무한 반복 컬럼(2026-07-28)**: `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE conditional_orders ADD COLUMN repeating INTEGER NOT NULL DEFAULT 0"` 및 동일 형식으로 `armed INTEGER NOT NULL DEFAULT 1` / `rearm_price REAL` / `fill_count INTEGER NOT NULL DEFAULT 0` / `max_fills INTEGER` / `repeat_mode TEXT NOT NULL DEFAULT 'continuous'` / `cooldown_ms INTEGER NOT NULL DEFAULT 0` / `last_fill_at INTEGER`. **코드 배포 전에 먼저 적용돼 있어야 한다**(읽기 경로는 기본값으로 방어하지만 `conditionalOpen` INSERT 가 컬럼을 참조) — prod 엔 이미 적용 완료. 전부 DEFAULT 가 있거나 NULL 허용이라 기존 행도 그대로 1회성 주문으로 동작.
  - **⚠ `usage_meter`(D1 쓰기 예산 계량기, §6, 2026-08-01)**: 신규 테이블이라 `--file=./schema.sql` 재적용 또는 `npx wrangler d1 execute ox64 --remote --command "CREATE TABLE IF NOT EXISTS usage_meter (day TEXT PRIMARY KEY, rows_est INTEGER NOT NULL DEFAULT 0)"`. **코드(`_budget.ts` 가 SELECT/UPSERT)가 참조하므로 코드 배포 전에 먼저 생성돼 있어야 한다** — 조회는 try/catch 로 0 을 반환해 방어하지만(계량기 고장이 봇을 멈추면 안 됨) `meterStmt` 는 봇 틱 batch 안에 있어서 테이블이 없으면 **봇 틱이 통째로 롤백된다**(시장 정지). prod 적용 완료.
  - **⚠ `puzzle_stats`/`puzzle_games`(퍼즐게임, §7, 2026-07-25)**: 신규 테이블이라 `CREATE TABLE IF NOT EXISTS` — `npx wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용만으로 자동 생성된다(ALTER 불필요). **`/api/puzzle` 코드가 이 테이블들을 참조하므로 코드 배포 전에 먼저 생성돼 있어야 한다** — 트레이딩(`/api/state` 등) 과는 완전히 분리된 라우트라 이 테이블이 없어도 트레이딩 쪽은 영향 없고, `/api/puzzle` 만 500 이 된다(방어적 try/catch 없음 — 격리돼 있어 불필요 판단).
  - **⚠⚠ 무료 플랜 전환 마이그레이션(2026-08-14)** — 아래 5줄. **전부 코드 배포 전에 먼저 적용해야 한다**(봇 상태 UPDATE·sweep 이 이 컬럼들을 참조하므로, 없으면 봇 틱 batch 가 통째로 롤백돼 시장이 멈춘다). prod·로컬 적용 완료:
    `ALTER TABLE spot_bot_state ADD COLUMN live_json TEXT` / `pend_notional REAL NOT NULL DEFAULT 0` / `pend_rows INTEGER NOT NULL DEFAULT 0` / `pend_ticks INTEGER NOT NULL DEFAULT 0` / `ALTER TABLE pending_orders ADD COLUMN last_fill_at INTEGER`
    그리고 **인덱스 교체**(쓰기 비용 증가 0, 읽기 96% 감소): `CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at)` + `DROP INDEX IF EXISTS idx_orders_user` + `DROP INDEX IF EXISTS idx_fee_ledger_time`(읽는 코드가 없는데 체결마다 1행씩 비용만 냈다).
    **⚠ `usage_meter` 의 오늘 행은 전환 시 한 번 리셋해야 한다** — 예전 단가(틱당 7행)로 쌓인 값이라 새 임계값(§6, 일 8만)에서 즉시 차단이 걸린다. `DELETE FROM usage_meter WHERE day = <오늘 KST>`.
  - **⚠ `spot_candles.open_at`/`close_at`(캔들 시가 오염 수정, 2026-09-02)**: `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE spot_candles ADD COLUMN open_at INTEGER NOT NULL DEFAULT 0"` 및 동일 형식으로 `close_at INTEGER NOT NULL DEFAULT 0`. **코드 배포 전에 먼저 적용돼야 한다** — 모든 체결의 캔들 upsert 와 봇의 캔들 flush 가 이 컬럼을 쓰므로 없으면 체결 batch 가 통째로 롤백된다(= 거래가 멈춘다). prod·로컬 적용 완료. 기존 행은 0(=가장 이른 시각)이라 시가가 예전 값 그대로 유지되고, 배포 시점에 진행 중이던 버킷 하나만 해당된다.
  - **⚠ `crate_stats`(상자깡, §10, 2026-09-10)**: 신규 테이블이라 `CREATE TABLE IF NOT EXISTS` — `npx wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용으로 만들 수 있다(ALTER 불필요). **단 이 테이블만은 `loadRow` 가 "없으면 그 자리에서 만든다"** — prod 적용 당시 wrangler OAuth 토큰에 `d1` 스코프가 없어 CLI 로 마이그레이션을 돌릴 수 없었고(`code: 7403`), 완전히 격리된 신규 테이블이라 자동 생성이 안전했다. 정상 경로에선 catch 가 안 타므로 쿼리·비용 증가 0. ⚠ **컬럼을 더할 땐 이 자동 생성에 기대지 말 것** — `IF NOT EXISTS` 는 컬럼을 추가해주지 않고, 그때는 평소대로 ALTER 를 코드 배포보다 먼저 돌려야 한다. 그리고 `crate.ts` 의 `CREATE_TABLE_SQL` 과 `schema.sql` 의 정의는 **항상 같아야 한다**.
  - **⚠ `dungeon_stats`/`dungeon_rooms`/`dungeon_players`(5분 던전, §8, 2026-07-27)**: 신규 테이블이라 `CREATE TABLE IF NOT EXISTS` — `npx wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용만으로 자동 생성된다(ALTER 불필요). **`/api/dungeon` 코드가 이 테이블들을 참조하므로 코드 배포 전에 먼저 생성돼 있어야 한다** — 트레이딩·퍼즐 라우트와 완전히 분리돼 있어 없어도 그쪽엔 영향 없고 `/api/dungeon` 만 500 이 된다(방어적 try/catch 없음 — 격리돼 있어 불필요 판단).
- **Secret**: `SESSION_SECRET` = `wrangler pages secret put SESSION_SECRET --project-name ox64` 로 production 에 설정됨(랜덤 32B hex). wrangler.toml 엔 두지 않음.
- 재적용 명령: 스키마 `npx wrangler d1 execute ox64 --remote --file=./schema.sql` / 시크릿 `echo <값> | npx wrangler pages secret put SESSION_SECRET --project-name ox64`.
- **Pages 빌드 설정**(Git 연동): Build command=`npm run build`, Output dir=`dist`(wrangler.toml `pages_build_output_dir`). Functions 는 `functions/` 자동 번들. 바인딩/시크릿은 **새 배포부터** 적용.
- 상태 점검(데이터 안 건드림): `curl https://ox64.app/api/state` → `{"error":"unauthorized"}`(401)면 정상(함수+D1+시크릿 OK). 500 + missingEnv 메시지면 바인딩/시크릿 누락.

### 백그라운드 Cron Worker (`cron/`) — 메인 Pages 배포와 별개, **배포 완료·운영 중** (`ox64-liquidation-cron`)
- Cloudflare Pages 프로젝트는 Cron Trigger 를 지원하지 않는다(Durable Objects 도 Pages 안에서 새로 정의 불가 — 둘 다 별도 Worker 배포가 필요). 그래서 `cron/` 를 **완전히 별개의 Workers 프로젝트**로 배포했다(Git 연동 Pages 배포로는 자동 적용되지 않음 — Pages 를 재배포해도 이 Worker 는 그대로 유지됨).
- 배포 URL: `https://ox64-liquidation-cron.erinwaveofficial.workers.dev` (스케줄만 쓰고 fetch 는 수동 트리거 용도라 사람이 직접 방문할 일은 없음).
- 코드/스케줄 변경 시 재배포: `cd cron && npx wrangler deploy` (Pages 처럼 Git 연동 자동배포 아님 — 수동, `CRON_SECRET` 시크릿은 최초 1회만 설정하면 재배포해도 유지됨).
- 수동 재실행/점검: `curl -X POST https://ox64-liquidation-cron.erinwaveofficial.workers.dev/ -H "x-cron-secret: <값>"` → `{"sweep":{"rounds":4,"checked":N,"liquidated":M}}` (`checked`=이번에 훑은 유저 수, 마켓메이커는 결과를 반환하지 않고 그냥 실행만 됨). 이름은 `ox64-liquidation-cron` 이지만 하는 일은 강제청산만이 아니다(트리거 전체 sweep + 마켓메이커).
- 주기는 `cron/wrangler.toml` 의 `[triggers] crons`(현재 매 1분) — 트리거 sweep(강제청산·지정가·SL/TP·조건부)·OX 마켓메이커 봇(버스트) 둘 다 이 한 스케줄로 처리(§3 "봇 거래량", §4 "접속 여부와 무관하게 매 1분 자동 실행" 참고). ⚠ 스케줄/코드를 바꾸면 `cd cron && npx wrangler deploy` 로 수동 재배포해야 반영된다(Git 자동배포 아님). 로컬 검증은 `cd cron && npx wrangler dev` 뒤 `curl http://127.0.0.1:8787/cdn-cgi/handler/scheduled`(스케줄은 로컬에서 자동 발화 안 됨, 수동 트리거만) — 로컬 D1 은 `wrangler dev` 와 `wrangler d1 execute --local` 이 별도 프로세스로 뜬 채 겹치면 데이터가 안 보일 수 있으니(포트 점유), 테스트 전 `netstat`/`tasklist` 로 이전 `wrangler dev` 잔여 프로세스가 없는지 확인할 것.

## 6. 주의 / 함정

- **서버 권위 원칙**: 잔고/체결/손익/랭킹은 **절대 클라 값을 신뢰하지 않는다**. 새 거래 기능은 반드시 `functions/api/*` 에서 검증·계산. 프론트는 요청·표시만.
- **체결가는 서버가 fetch**: OrderPanel 은 가격을 안 보냄. 클라 price 를 받아 쓰면 조작 구멍이 됨(금지).
- **Lightweight Charts v4**: `addCandlestickSeries`. v5 는 `addSeries(...)`. 현재 v4 고정.
- **time = UTC seconds**: 바이낸스 ms → `/1000`.
- **바이낸스 지역차단**: 선물 WS 막힘 → 스팟 사용. 스팟마저 막히면 `data-api.binance.vision` 미러/프록시로 `services/` + `_shared.fetchPrice` 교체.
- **functions/ 타입**: 앱 `tsc -b`(src 전용)엔 안 잡힘. Cloudflare 도 타입체크 안 함. 수동 확인:
  `npx tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom functions/_shared.ts functions/_trading.ts functions/_middleware.ts functions/api/*.ts cron/index.ts`. WebCrypto 바이트 인자는 `bs()`(BufferSource 캐스팅)로 TS lib 마찰 회피.
- **로컬 검증(선택)**: `npm run build && npx wrangler d1 execute ox64 --local --file=./schema.sql && npx wrangler pages dev dist` 로 로컬 D1(miniflare)까지 띄워 실제 `/api/order` 호출로 지정가/SL/TP 라이프사이클을 curl 로 검증 가능(`.dev.vars` 에 `SESSION_SECRET` 아무 값이나 채우면 됨, `--local` 이라 prod DB 안 건드림). 매번 세션 시작 시 `--local` D1 은 비어있으니 참고.
- **favicon**: `public/favicon.png` 교체(원본 `src/resources/images/icon2_256.png`). Vite public/ 은 해시 없이 dist 루트로 복사.
- **⚠ 워드마크 로고 = 인라인 SVG(`src/components/Logo.tsx`)**: 화면의 "ox64" 워드마크는 **15×3 픽셀 아트를 그대로 옮긴 SVG 컴포넌트**다. 예전엔 `src/resources/images/icon_256.png` 를 `import` 해 `<img className="h-9 w-9">` 로 그렸는데 세 가지가 겹쳐 흐릿했다: (1) 잉크는 225×45 인데 캔버스가 256×256 이라 **위아래 41% 가 투명 여백** → 실제 글자가 ~6px 높이로만 렌더, (2) **5:1 워드마크를 정사각형에 넣어** 비율이 찌그러짐, (3) 아트 1픽셀이 CSS 2.1px 같은 **비정수 배율**로 축소되며 브라우저 보간(블러). SVG 는 보간이 없고(`shape-rendering="crispEdges"`) `fill="currentColor"` 라 부모 `text-*` 색을 따라간다 — **흰색 PNG 가 라이트 테마에서 배경에 묻히던 문제도 함께 해결**. 크기는 `className` 으로 주되 **높이를 3의 배수**로(아트 1픽셀이 정수 px: 헤더 18px→6px/칸, 로그인 36px→12px/칸) 하고 **폭은 `w-auto`**(정사각형 금지). 로고 모양을 바꾸려면 `Logo.tsx` 의 `GRID` 문자열을 수정. 원본 PNG 는 favicon 용으로 남아있다(`public/favicon.png`). (index.html `<title>` 의 "ox64" 는 탭 제목이라 유지.)
- **API 500 진단**: `functions/_shared.safe()`(핸들러 예외→500+메시지) + `missingEnv()`(D1/SECRET 미설정을 한국어로 안내)로 감쌈. 클라(`api.ts req`)가 `error` 필드를 그대로 throw→Login 화면에 표시. "HTTP 500"만 뜨고 원인 불명이면 이 래핑이 빠진 것.
- **폰트 = Proxima Nova(전체)**: `public/fonts/*.ttf` + `index.css` `@font-face`(weight 300/400/600/800), body/tailwind sans+mono 모두 Proxima. **한글 글리프 없음** → CJK 폴백(Apple SD Gothic/Malgun) 유지 필수. mono 도 Proxima라 숫자 정렬은 `font-variant-numeric: tabular-nums`.
- **수치 표기 = 세자리 콤마(`format.ts`)**: 가격은 `fmtPrice`(심볼 정밀도, `toLocaleString`), **수량/개수는 `fmtQty`**(콤마, 소수 최대 8자리·뒤 0 트림 — 예 1234567→"1,234,567"), **USDT 금액(잔고·손익·증거금·평가자산)은 `fmtUsd`**(콤마+소수 2자리). `fmtVol`(K/M/B)은 이제 공간이 좁은 차트 우측 축 티커 전용(레전드 거래량·호가창·포지션/주문 수량은 전부 콤마). 새 수치를 UI 에 추가할 땐 raw `toFixed`/원시 숫자 대신 이 헬퍼를 쓸 것(변동률 % 는 예외로 `toFixed`).
- **⚠ 아주 큰 값은 축약해서 보여준다(`fmtUsdShort`/`fmtQtyShort`)**: 이 사이트는 250배 레버리지 + 무한 조건부라 평가자산·수량이 **1e31 까지** 간다. 콤마 표기를 그대로 두면 폭이 정해진 칸(랭킹 행·헤더 평가자산·주문패널 정보란·호가창 수량)이 통째로 밀려 **다른 정보가 화면 밖으로 나간다**(실제 제보: 랭킹 1위 행에서 VIP 뱃지·순위가 사라짐). 규칙: 정수부가 `maxIntDigits`(랭킹/포지션 12, 좁은 칸 9)를 넘으면 한국식 단위(만/억/조/경/해/자/양)로 **반올림** 축약하고, 양(1e28)으로도 4자리를 넘으면 지수 표기(`5.00e+33`)로 떨어진다. **축약한 자리엔 반드시 `title` 로 전체값(`fmtUsd`/`fmtQty`)을 붙일 것** — 축약만 있으면 정확한 값을 확인할 방법이 없어진다. `fmtKor` 과의 차이: 그쪽은 VIP 기준선 표시용이라 **내림**(999,999 를 "100만"으로 올려 보이면 안 됨), 이쪽은 "대략 얼마인지"라 반올림. **⚠ 가격도 예외가 아니다(`fmtPriceShort`, 2026-09-03)** — **청산가**가 대표적이다(숏은 `진입가 + 평가자산/수량` 이라 잔고가 크고 수량이 작으면 1e20 을 예사로 넘는다). 포지션 표의 현재가·진입가·청산가·SL/TP·미체결 지정가·조건부 트리거가·주문내역 가격, 헤더 현재가, 차트 레전드 OHLC·거래량, 호가창 가격이 전부 이 규칙을 탄다. **⚠ 축약만으로는 부족하다** — 옆 칸이 밀리지 않게 금액 칸엔 `shrink-0`, 이름처럼 늘어나는 칸엔 `min-w-0`+`truncate` 를 같이 줄 것. 수량 입력칸처럼 **글자 수로 폭을 계산하는 곳은 상한을 둔다**(`PositionsPanel` 청산 수량 = 20ch — 1e30 이면 자릿수가 31 이라 입력칸 하나가 패널을 밀어낸다).
- **반응형**: `App.tsx` 모바일=세로 flex 스택(차트 45vh→주문→포지션), `md:`(≥768px)=2열 그리드(좌 차트+포지션 / 우 주문). 차트가 모바일서 좁던 원인=옛 가로 flex 의 `aside w-72` 고정폭 → 그리드 전환으로 해결.
- **DB 확인/수정**: 이제 서버 D1. `npx wrangler d1 execute ox64 --remote --command "SELECT name,balance FROM users"`. 잔고 리셋 등도 SQL 로. (구 `window.db`/DevTools IndexedDB 방식은 폐기 — 클라 조작 방지가 목적.)
- **인터벌→초 매핑 이중 관리**: `src/symbols.ts INTERVAL_GROUPS` 와 `functions/_shared.ts intervalSecFromCode`(OX 캔들 버킷팅용) 가 같은 값을 각자 보관한다(functions/ 는 src/ import 불가). 인터벌 코드를 추가/변경하면 두 곳 다 갱신할 것.
- **⚠ 시장가가 지정가로 걸리던 버그**: 차트/호가창 클릭(`setChartClickPrice`)이 예전엔 `OrderPanel` 을 무조건 지정가 탭으로 전환했다 — 시장가로 주문하려다 무심코 차트를 클릭하면 시장가 주문이 지정가로 걸렸다. 수정: 클릭은 **이미 지정가 탭일 때만** 지정가 입력을 채운다(시장가 탭에서의 클릭은 조회일 뿐 주문 유형을 안 바꿈). 지정가로 클릭 배치하려면 먼저 지정가 탭 선택.
- **⚠ 클릭 가격을 받는 칸은 항상 하나(`useMarketStore.priceTarget`)**: 클릭 가격을 쓰는 입력칸이 둘(주문패널 지정가 / 포지션의 청산 지정가)이라, 각 칸이 `chartClickNonce` 를 그냥 구독하면 **한 번 클릭에 둘 다 바뀐다**. 그래서 입력칸이 **포커스될 때 자기를 타깃으로 등록**(`''` / `close:<positionId>`)하고, 클릭 효과는 자기가 타깃일 때만 값을 받는다 — 차트를 클릭하는 순간 포커스가 풀리므로 `document.activeElement` 로는 판단할 수 없어 상태로 기억해야 한다. 대상 포지션이 사라지면(청산) 타깃을 `''` 로 되돌린다(안 그러면 청산 직후 첫 클릭이 사라진 칸으로 향해 삼켜짐). 청산 지정가 칸은 **현재 차트 심볼과 포지션 심볼이 같을 때만** 값을 받는다(BTC 차트 클릭이 OX 포지션 청산가로 들어가는 사고 방지).
- **⚠⚠ 체결내역의 매수/매도 라벨(색)은 "그 체결이 어느 방향으로 가격을 움직였나"에서 나온다(tick rule, 2026-08-19)**: 실제 시장에서 taker 매수는 매도호가를 들어올리며 체결되므로 **직전 체결보다 비싸게 찍힌 체결 = 매수(초록), 싸게 찍힌 것 = 매도(빨강)** 이고, 같은 가격(zero-tick)이면 **직전 라벨을 이어받는다**(표준 Lee-Ready 분류). 예전엔 봇이 라벨을 `Math.random() < buyProb` 로 **가격과 완전히 독립적으로** 뽑아서 실측 9.4만 건 중 **상승틱의 38.9% 가 빨강, 하락틱의 43.1% 가 초록**으로 찍혔다 — 가격은 오르는데 테이프는 빨강이라 "색이 반대다 / 메이커 기준으로 찍힌다"로 읽혔다(제보). 지금은 `simulateTick` 이 인쇄 가격에서 라벨을 뽑고(검증: 불일치 **0%**, 동가 계승 14.9%), 국면별 taker 편향(`nextMarketState.buyProb`)은 **동가 처리에만** 남는다 — 국면 쏠림은 가격 경로(`ret`)에 이미 들어있어 라벨 분포로 그대로 드러난다(틱 상승 구간 매수라벨 67.9% / 하락 구간 29.5%). **체결을 새로 찍는 코드를 추가할 땐 라벨을 임의로 정하지 말고 가격 방향에서 파생시킬 것.**
- **⚠ 유저 주문의 라벨은 "누가 덮쳤나"(`Aggressor`)로 갈린다**: 시장가·제출 즉시 체결되는 marketable 지정가는 유저가 taker 라 **유저 방향 그대로**(롱 진입=매수) 찍히지만, **이미 걸려 있던**(resting) 유저 지정가가 봇 재호가에 채워지면 taker 는 봇이므로 **유저 방향의 반대**로 찍힌다(내 매수 지정가가 시장가 매도에 채워지면 거래소 테이프에도 '매도'로 뜬다). `matchLimitPendingAgainstBook`/`matchReduceOnlyOxPending`/`closePositionAgainstBook` 의 `aggressor` 인자로 전달하며 **`sweepRestingOxPendings`(재호가 직후)와 `runTriggers`(폴링/cron)에서만 `'bot'`** 이다(order.ts 제출 경로는 기본값 `'user'`). ⚠ **뒤집히는 건 라벨뿐** — buyer/seller·포지션·잔고·수수료는 유저가 실제로 사고판 방향(`userSide`)을 쓴다(예전 코드가 `tapeSide` 로 buyer/seller 를 정하고 있어서, 라벨을 뒤집을 때 상대방까지 바뀌지 않도록 분리했다).
- **⚠ 호가창·체결 표시 개수는 유저 설정이고, 상한이 네 곳에 걸쳐 있다**: 클라가 그리는 행 수는 `useChartStore.bookRows`(설정 모달, 5~50, 기본 10 = 예전 `max-h-40` 과 같은 높이)이고 그 위에 **공급 상한**이 얹힌다 — ①`loadSpotMarket()` 의 `BOOK_LIMIT`(50, 가상 코인 호가 단계) ②`mergeRecentTrades(..., 50)`(가상 코인 체결 — ⚠ **이 50 은 봇 테이프에만 건다**. 유저 체결은 몇 건이든 전부 싣는다: 봇 한 틱이 몰리면 프린트를 40건까지 찍어서, 합쳐서 상위 50건만 남기면 **내 시장가 20줄 중 뒤쪽이 통째로 잘렸다**(제보 "20건인데 10건만 나온다"). 게다가 클라는 새 체결을 시각으로만 식별하므로(`t.time > lastAt`) 한 번 잘린 줄은 다음 폴링에 다시 실려도 **영영 화면에 안 나온다**. 유저 체결은 SQL 이 이미 `LIMIT 30` 으로 묶고 테이프는 JSON 이라, 전부 실어도 D1 읽기·쓰기는 0 증가다) ③`useMarketStore.MAX_TRADES`(400, 클라가 보관하는 체결 테이프 — 체결 필터를 세게 걸어도 목록이 비지 않게 크게 잡는다) ④**실제 코인은 바이낸스 부분 호가 스트림이 5/10/20 단계만 지원**해서 `orderbookStream(symbol, 20)` 의 20 이 물리적 상한이다(설정을 50 으로 해도 20 줄까지만 찬다 — 설정 모달에 그렇게 적어뒀다). 예전엔 서버 15 / 클라 8 고정이라 스프레드에서 먼 곳에 큰 지정가(벽)를 걸면 그 주문이 화면에서 통째로 안 보였다. **`BOOK_ROWS_MAX` 를 올릴 땐 ①② 를 같이 올릴 것**(③ 은 이미 400 이라 여유가 있다). ⚠ 단 `spot_trades` 의 `LIMIT 30` 은 그대로 둔다 — 테이프는 상태 행 JSON 이라 몇 건을 병합해도 읽기가 안 늘지만 테이블 쪽을 늘리면 1초 폴링에 그만큼 D1 읽기가 늘어난다(§6).
- **⚠ 격자 스냅 부동소수 함정(가격이 한 틱 밀리는 버그)**: `Math.floor(price / step) * step` 은 **정확히 격자 위에 있는 가격을 한 칸 아래로 떨어뜨린다** — `1.45/0.0001 = 14499.999999999998`, `2.3/0.01 = 229.99999999999997` 이라 floor 가 한 칸 작은 정수를 준다. 그래서 유저가 1.45 에 건 주문이 호가창에 1.4499 로 표시됐다("분명 1.1 에 올렸는데 미세하게 다르게 올라간다"던 버그). 격자 연산은 **나눈 값이 정수에서 1e-9 이내면 그 정수로 간주**하고(`OrderBook.snapToGrid` / `spot.ts humanQuotePrice`) 곱한 뒤 `toFixed` 로 자릿수를 정리할 것.
- **⚠ 캔들 조회는 마켓메이커를 굴리지 않는다**: `/api/spot?candles=1` 은 차트가 읽어가는 조회일 뿐이라 봇 틱을 돌리지 않는다(시장 클럭은 호가창 폴링 `useSpotPoll` 만 담당). 가상 코인이 둘이 된 뒤 **심볼 드롭다운이 코인마다 24h 변동률용 캔들을 5초 주기로 긁으므로**(`SymbolSelect`), 예전처럼 두면 드롭다운을 열어둔 것만으로 코인 수 × 요청 수만큼 봇이 돌아간다 — 코인 수에 비례해 늘어나는 바로 그 낭비다.
- **⚠ 봇 실패를 조용히 삼키지 말 것**: `/api/spot` 의 `runMarketMaker` 호출은 실패해도 유저 요청을 막지 않게 try/catch 로 감싸는데, 예전엔 **완전히 무시**해서 봇이 죽어도 화면상 멀쩡해 보였다(로컬에서 `spot_bot_state` 컬럼 마이그레이션 누락으로 배치가 통째로 롤백되는데 옛 호가가 남아 정상처럼 보임 → 원인 찾는 데 한참 걸림). 지금은 `console.error` 로 남긴다(`wrangler tail` 로 확인).
- **⚠⚠⚠ D1 예산 — 새 기능을 얹기 전에 여기부터 볼 것. 실제로 돈이 청구된 적이 있다.**
  **2026-08-01 사건: 7월분 청구서 $47** — 전액 **D1 Rows Written 초과분**($1/100만 행, 5,000만 행 포함).
  즉 7월에 **9,700만 행**을 썼다. 7/24 에 포함분을 다 쓰고 그때부터 하루 $5~9(=500~900만 행/일)씩 붙었다.
  **⚠⚠ 2026-08-14 부터 이 사이트는 Workers *Free* 플랜을 목표로 운영한다.** 그래서 판단 기준이 완전히
  바뀌었다 — Paid 는 한도를 넘기면 **돈이 더 나갈 뿐** 서비스는 돌지만, **Free 는 넘기는 순간 그 종류의
  작업이 실패한다**("further operations of that type will fail with an error"). 즉 쓰기 한도를 넘기면
  봇이 아니라 **거래 자체가 멈춘다**. 한도도 훨씬 빡빡하고, **행 수만이 아니라 요청 수·CPU·invocation당
  쿼리 수까지** 걸린다:
  | 한도 | 값(Free) | 현재(2026-08-14 전환 후 예상) |
  | --- | --- | --- |
  | 일 rows written | **10만/일** | **약 3~5만/일** (전환 전 30만) |
  | 일 rows read | **500만/일** | **약 30만/일** (전환 전 1억 1,000만) |
  | **Worker invocation 1회당 D1 쿼리** | **50** ⚠ Paid 는 1,000 | cron 1회 ≈ 25~35 (전환 전 ~400) |
  | 요청 수(Pages Functions 포함) | **10만/일** | 약 1.5~2만/일 |
  | CPU / invocation | **10 ms** ⚠ Paid 는 30초 | cron 실측 ~3.5ms(봇 24틱 순수 연산) |
  | DB당 최대 크기 | **500 MB** ⚠ Paid 는 10GB | 18 MB |
  - **⚠ invocation당 쿼리 50 이 새로 생긴 진짜 벽이다.** `DB.batch([...])` 는 **문장 하나하나가 1쿼리로**
    계산되고, 바인딩 호출도 subrequest 한도(50)에 함께 잡힌다. 전환 전 cron 1회가 ~400쿼리였던 이유는
    "틱마다 D1 을 왕복"했기 때문이고, 그래서 봇을 **메모리 시뮬 + 단일 커밋**으로 바꾼 것이 이번 전환의
    핵심이다(§ spot.ts runBotTicks). **새 경로를 추가할 땐 "이 요청이 D1 문장을 몇 개 쓰는가"를 먼저 셀 것.**
    **⚠⚠ 그리고 이 벽은 봇 경로가 아니라 "체결 한 방"에서 먼저 닿았다(2026-09-08).** OX 시장가 한 건이
    쓰는 쿼리는 대략 `31 + 프린트 줄 수` 다 — 트리거 평가 5 + 기준가 1 + 미실현 1 + 매칭 read 5 + 커밋
    batch(사다리 1 + 포지션 1 + 기준가 1 + 캔들 3 + 주문 1 + 수수료 3 + 봇정산 2~4) + `loadState` 5.
    프린트가 6줄이면 37 로 안전하지만 16줄이면 **47**, 20줄이면 **51** 이고, 여기에 보유 심볼 하나당
    외부 시세 fetch(OKX 실패 시 폴백까지)가 **같은 50 예산에서** 더 빠진다 → "가끔" 넘는다. 그래서
    **한 요청이 만드는 문장 수는 주문 크기·보유 심볼 수와 무관하게 상수여야 한다**:
    · 항목 수만큼 문장을 만드는 자리는 **다중행 INSERT** 로 묶는다(§4 `TRADE_INSERT_ROWS`).
    · 같은 행을 두 번 읽지 않는다 — 이 경로에서도 `users`(잔고+요율)를 한 번에, OX 기준가는 트리거
      평가가 이미 읽은 `marks` 를 재사용한다.
    · **루프 안에서 체결 batch 를 부르는 자리는 반드시 상한을 둔다** — `sweepRestingOxPendings` 는
      크로스된 대기 지정가가 여러 개면 한 요청에서 체결 batch 를 그 수만큼 돌려 `/api/state?tick=` 을
      통째로 500 으로 만들 수 있었다(`MAX_SWEEP_FILLS`=2, 첫 체결 우선. 나머지는 다음 틱 ≈1초 뒤).
    ⚠ 이 한도를 넘겨 batch 가 던져지면 **그 앞의 조건부 잔고 차감은 이미 커밋돼 있다**(charge-first 는
    D1 batch 의 "0행 UPDATE 도 성공" 함정을 피하려고 일부러 그렇게 둔 것이다, §4) — 즉 한도 초과는
    표시 오류가 아니라 **증거금만 빠지고 포지션이 안 생기는 사고**다. 문장 수를 세는 걸 게을리하지 말 것.
  - **⚠ 실사용 천장은 "동시 접속자"가 아니라 "하루 총 시청 시간(user-hour)"이다.** 폴링 3개가 각자
    요청을 보내므로 **OX 화면 1인 = 시간당 8,640요청**(호가 1s=3,600 + 캔들 1s=3,600 + state 2.5s=1,440,
    탭 숨기면 전부 정지)이고, 읽기는 인터벌에 따라 시간당 23만~48만 행이다(캔들 롤업 배수 때문 —
    아래 표). 그래서 실제 한계는:
    | 상황 | 시간당 요청 | 시간당 읽기 | 하루 한계(먼저 닿는 쪽) |
    | --- | --- | --- | --- |
    | 실제 코인 화면(state 폴링만) | 1,440 | 2.2만 | **68 user-hour** (요청) |
    | OX 화면(통합 폴링, 인터벌 무관) | 3,600 | 4.8만 | **27 user-hour** (요청) |
    측정치(2026-08-14, prod): 통합 틱 1회 ≈ **8행**(호가 3 + 봇 틱 3 + 캔들 2), 계정 상태를 실은 틱은
    **+16행**(트리거 평가 7 + loadState 9). cron 은 분당 ~27행(하루 3.9만).
    여기까지 오는 데 쓴 수단은 전부 **"같은 걸 반복해서 다시 읽거나 다시 쓰지 않는다"** 는 한 가지
    원칙이다: ①**폴링 3개를 하나로**(요청 8,640→3,600/시간) ②**주문내역 증분**(`ordersSince` — 매번
    같은 50행을 다시 읽던 것을 0~1행으로) ③**체결내역 시간 범위**(항상 30행 → 평상시 1행)
    ④**봇 선점 쓰기 제거**(같은 행을 1초에 두 번 쓰던 것을 한 번으로, 아래) ⑤**계량기 조회를 오늘
    한 행만**(달 전체 SUM → PK 조회) ⑥**액션 응답도 주문 증분**(②를 폴링에만 적용했던 누락).
    **다음 카드**: 폴링 주기(1초)를 늘리는 것 — 요청·읽기·쓰기가 그대로 비례해 줄지만 체결 체감이 느려진다.
  - **⚠ 2026-08-20 다이어트 — "같은 행을 두 번 쓰지 않는다"**(실측 기반, `npx wrangler d1 insights`).
    전환 직후 측정치는 쓰기 25,249행/일(상위 5쿼리) · 읽기 399,000행/일(상위 5쿼리)였고, 그 안에서
    **아무 기능도 하지 않는 몫**을 넷 찾아 걷어냈다:
    | 항목 | 실측(전) | 후 | 근거 |
    | --- | --- | --- | --- |
    | 봇 틱 **선점(claim) UPDATE** | 쓰기 4,688/일 (쓰기의 19%) | **0** | 커밋의 `last_run` 가드가 선점을 겸한다 |
    | 체결내역 조회 창 1시간 | 읽기 162,890/일 (읽기의 41%) | ~13,000 | 3분. 상위 50건은 어차피 최근 11초 안 |
    | 계량기 `day LIKE '2026-08%'` | 읽기 19,856/일 | ~1,030 | 월 누적은 차단 판정에 안 쓴다(표시용) |
    | 액션 응답의 주문 50행 | 읽기 37,950/일 | ~2,000 | 폴링만 증분이었고 액션은 누락돼 있었다 |
    합계 **쓰기 −19% · 읽기 −55%**(≈ 쓰기 3만/일 = 무료 한도의 30%, 읽기 20만/일 = 4%).
    - **④ 봇 선점 제거가 왜 안전한가**: 틱 계산(`simulateTick`)은 순수 함수라 **쓰기 직전에 판정해도
      똑같이 막힌다**. 겹친 요청들이 각자 계산하고 먼저 커밋한 쪽만 `WHERE id=? AND last_run=?` 를
      통과한다(진 쪽은 0행 → 그 틱을 폐기하고 **가격 경로도 빈 배열로 반환** — 커밋 안 된 가격으로
      트리거를 판정하면 존재한 적 없는 딥으로 스탑이 걸린다). ⚠ **같은 가드를 닫힌 캔들 flush 에도
      걸어야 한다** — D1 batch 는 0행 UPDATE 를 실패로 안 보므로(§4) 가드가 커밋에만 있으면 진 쪽의
      캔들만 반영돼 그 봉의 거래량이 부푼다(volume 은 합이라 멱등이 아니고 1h/1d 는 영구히 남는다).
      덤으로 **계량 단가가 정확해졌다** — 선점 1행은 `ROWS_PER_BOT_COMMIT`(1)에 안 잡혀 있었다.
    - **일부러 안 한 것 둘**(다음에 "최적화" 하려다 사고 나기 쉬운 지점이라 남긴다):
      · **유저 체결의 캔들 upsert(3행/체결 ≈ 3,100행/일)를 봇 `live_json` 으로 접기** — 봇 커밋과
        같은 칸을 쓰게 되어 **체결 사이에 낀 봇 틱이 서로를 덮어쓴다**(현재 봉의 거래량이 조용히
        사라지고 자기 복구도 안 된다). 3%를 아끼려고 시장 데이터를 틀리게 만드는 거래다.
      · **`idx_fee_ledger_user` 제거(1,000행/일)** — 이 인덱스는 2026-08-14 에 "원장을 user_id 로
        뽑을 때 쓴다"며 **의도적으로 하나만 남긴 것**이다. 지우려면 원장 자체를 지울지부터 결정할 것
        (읽는 코드는 지금도 없다 — 총액은 `users.total_fees`).
  - **⚠ 2026-08-26 다이어트 3차 — "같은 걸 한 요청 안에서 세 번 읽지 않는다"**(읽기·쿼리 절감, 쓰기 불변).
    2차가 "같은 행을 두 번 쓰지 않는다"였다면 이번은 그 읽기판이다. `?tick=` 요청 하나가 같은 데이터를
    반복해서 읽고 있었다:
    | 중복 | 전 | 후 |
    | --- | --- | --- |
    | `pending_orders WHERE symbol=?` | **3회**(봇 벽 판정 GROUP BY · sweep · 호가창 GROUP BY) | **1회** |
    | `spot_bot_state` 상태 행 | **2회**(`runMarketMaker` · `loadSpotMarket`) | **1회** |
    | 대기 주문이 없을 때의 sweep 조회 | 매 커밋 1회 | **0회**(위 조회가 "없다"를 이미 알려준다) |
    수단은 `TickCtx`(§ spot.ts) — `runMarketMaker` 가 **자기가 읽은 것을 반환**하고 `loadSpotMarket` 이
    그걸 받아 쓴다. 집계(GROUP BY)를 SQL 에서 메모리로 옮겨도 **읽는 행 수는 같다**(SQLite 는 집계하려고
    어차피 그 행들을 다 훑는다) — 순수하게 쿼리 3개와 스캔 2번이 사라진다. 게이트에 막힌 폴링(가장 흔한
    경로)도 이제 **상태 행 하나로 호가창까지 그린다**.
    ⚠ **`null` 은 "모른다"는 뜻이고 받는 쪽이 그때만 읽는다.** 봇 커밋이 경합에서 졌거나 sweep 이 실제로
    체결을 냈으면 손에 든 사다리·대기목록은 이미 낡았으므로 **반드시 `null` 로 되돌려야 한다** — 안 그러면
    이미 체결된 물량이 호가창에 1초 더 남는다(로컬 검증에서 이 경로가 실제로 타는 걸 확인했다).
  - **⚠ 2026-09-02 다이어트 4차 — 같은 행을 세 번 읽지 않는다(3차의 마무리)**. 3차에서 `?tick=` 요청의
    사다리·테이프·대기주문 중복을 `TickCtx` 로 걷어냈는데, **같은 상태 행을 읽는 나머지 둘**과 계정
    데이터 쪽이 남아 있었다:
    | 중복 | 전 | 후 |
    | --- | --- | --- |
    | `spot_bot_state` (한 `?tick=` 요청 안에서) | **3회**(봇 틱 · `loadSpotCandles` 의 live_json · `fetchPrice` 의 ref_price) | **1회** |
    | `positions`·`pending_orders`·`conditional_orders` (한 `/api/state` 요청 안에서) | **각 2회**(트리거 평가 · loadState) | **각 1회**(평가가 아무것도 못 바꿨을 때) |
    수단은 3차와 같다 — **먼저 읽은 쪽이 자기가 읽은 것을 넘겨준다**. `TickCtx` 에 `live`(진행 중 캔들
    버킷)와 `ref`(이 틱 뒤 기준가)를 실어 `loadSpotCandles`/`fetchPrices(…, seed)` 가 받아 쓰고,
    `scanTriggers`(구 `checkTriggers` 의 본체)가 평가에 쓴 스냅샷을 `loadState` 에 넘긴다.
    - ⚠ **스냅샷 재사용 판정은 "뭘 썼는지 추적"이 아니라 "쓸 수가 없었음"으로** 한다. 쓰기 지점마다
      플래그를 세우는 방식은 새 트리거 기능을 추가할 때 한 곳만 빠뜨려도 응답이 조용히 한 폴링 낡는다.
      대기 지정가도 조건부도 SL/TP 도 없으면 `runTriggers` 가 실행할 수 있는 쓰기는 강제청산뿐이고
      그건 반환값으로 안다 → 그때만 재사용하고, 뭔가 걸어둔 유저는 예전처럼 다시 읽는다(무회귀).
    - ⚠ 재사용 스냅샷은 `ORDER BY` 없이 읽힌 것이라 **loadState 가 메모리에서 정렬**한다(클라는 서버가
      준 순서를 그대로 그린다 — 안 맞추면 목록 순서가 폴링마다 들쭉날쭉해진다).
    - ⚠ `ref` 는 sweep 이 체결을 냈으면 **버린다**(그 체결이 기준가를 옮겼다). 반면 `live` 는 그대로
      유효하다 — 유저 체결은 `spot_candles` 에 직접 쓰지 이 칸을 건드리지 않는다.
    - 덤: `markPrices` 에 OX 기준가가 항상 실려, OX 포지션이 없어도 클라가 그 가격을 바로 갖는다.
  - **⚠ 과금 단위는 "문장 수"가 아니라 "행 수"다** — 정확한 규칙은 **`바뀐 행 1 + 갱신된 인덱스 항목 수`**
    이고, 여기서 인덱스에는 **`id TEXT PRIMARY KEY` 같은 암묵 인덱스도 포함**된다(`sqlite_autoindex`).
    실측 대조: `spot_trades` INSERT 3행(= 1 + PK + 명시 인덱스 1), `fee_ledger` INSERT 4행(= 1 + PK +
    명시 2), 비인덱스 컬럼 UPDATE 1행, `spot_candles` upsert 1행(기존 버킷 갱신이라 인덱스 불변).
    DELETE 는 지운 행마다 같은 계산. 그래서 **인덱스를 하나 더 다는 것은 그 테이블의 모든 INSERT 비용을
    올리는 결정**이고, "행 하나 INSERT 하고 나중에 DELETE" 는 왕복 ~4.5행이다.
  - **~~비용의 주인은 봇이다~~ → 이제 아니다(2026-08-14).** 예전엔 분당 24틱 도는 마켓메이커가 쓰기의
    63%를 만들었다(틱당 6행). 지금은 **틱 수와 쓰기가 분리**돼 있다 — 봇은 N틱을 메모리에서 돌리고
    **커밋 1회 = 1행**만 쓴다(상태 UPDATE 하나에 심리+사다리+테이프+진행중 캔들+미정산 누적이 전부
    들어있다). 실측: cron 1회에 **틱 20회 → 쓰기 3행**(전환 전이면 120행). 캔들은 **버킷이 닫힐 때만**
    테이블로 넘어가고(1m=분당 1행), 봇 수수료·계량기는 120틱마다 한 번 정산한다.
  - **이제 비용의 주인은 "체결"이다** — 체결 1건이 ~20행이라 하루 3,000건이면 6만 행이다. 그리고 체결
    수를 늘리는 건 사람 손이 아니라 **자동으로 반복되는 경로**다. 그런 경로는 셋뿐이고 전부 계량·차단
    아래에 있다(아래 서킷 브레이커): ①시장 깊이보다 큰 지정가의 **재체결** ②`continuous` 무한 조건부
    ③봇. 특히 ①은 prod 실측으로 **주문 하나가 하루 3,000건**을 체결하고 있었다(§ PARTIAL_FILL_COOLDOWN_MS).
  - **⚠ 봇 경로에서 "행을 남기는" 설계 자체를 피할 것**: 매 틱 통째로 교체되는 스냅샷(호가 사다리,
    체결 테이프)은 **이력이 아니라 링 버퍼**이므로 행으로 쪼개면 안 된다 — 이미 UPDATE 하고 있는 상태
    행의 JSON 칸에 담으면 **쓰기 비용이 0**이다(rows written 은 행 수만 세고 바이트는 세지 않는다).
    이 원칙을 두 번 위반해서 두 번 터졌다: `spot_orders` 사다리 44행/틱(7/31 수정, DB 3.38GB + 쿼리
    한도 950), `spot_trades` 합성 체결 4.5행/틱(8/01 수정, 하루 76만 행 = 전체의 79%).
  - 그래서 **가상 코인을 늘리려면 코인 수만큼 틱을 곱하면 안 된다** — 총 틱 예산(`MM_TICK_BUDGET`)을
    코인들이 나눠 갖고, 유저가 보고 있는 코인은 폴링이 클럭이 되므로 cron 이 물러난다(`POLL_ACTIVE_MS`).
  - **⚠ 남은 유일한 무한 쓰기 경로 = `continuous` 무한 조건부 주문**(§4). 체결 1건이 ~18행(users 1 +
    positions 3 + orders 3 + fee_ledger 4 + conditional 1 + 체결/캔들 등)이라, 1초 간격이던 예전엔
    **하나만 걸어둬도 하루 155만 행 = 월 4,650만 행**이었다 → **재실행 간격 하한 5초**로 월 930만 행까지
    내렸고(§4), 그 위에 아래 서킷 브레이커가 걸려 있다.
  - **⚠⚠ 방어는 2겹이다 — Cloudflare 는 D1 에 지출 상한(hard cap) 기능을 제공하지 않는다.**
    대시보드의 Budget alert 는 **사후 통보**일 뿐이고(그래서 $47 이 다 나간 뒤에 알았다), 지출을 강제로
    끊는 스위치가 없다. 그래서 둘 다 필요하다:
    1. **사람이 먼저 안다 — `npm run d1:budget`** (`scripts/d1-budget.mjs`). 이번 달 **일별** 쓰기와 누적,
       월말 예상치, 예상 초과 요금을 표로 뽑고 초과 페이스면 **exit 1** 로 실패한다.
       - `CLOUDFLARE_API_TOKEN`(Account Analytics·Read 권한만) 이 있으면 GraphQL Analytics 로 **정확한
         일별 총계**를 쓴다. 없으면 `wrangler d1 insights` 폴백 — ⚠ 그 명령은 `--count` 를 뭘 주든
         **상위 5개 쿼리만** 돌려주므로 총계가 아니라 하한(과소 추정)이다.
       - `npm run d1:check` 는 원시 insights JSON(쿼리별 `totalRowsWritten`/`numberOfTimesRun`).
       - DB 크기는 아무 쿼리의 응답 `meta.size_after` 가 바이트로 알려준다. ⚠ `COUNT(*)`/`GROUP BY` 는
         큰 테이블 풀스캔이라 30초 쿼리 한도에 걸리니 크기 확인엔 쓰지 말 것.
    2. **코드가 스스로 멈춘다 — `functions/_budget.ts` + `usage_meter` 테이블.**
       - **계량 지점은 딱 둘이다**: 봇 틱(`marketMakerTick`, 7행/틱)과 **모든 체결**
         (`_shared.ts feeAccrualStmts`, 20행/체결). 후자에 둔 이유는 그 함수가 **모든 체결 경로가 반드시
         지나는 유일한 병목**이라서다(시장가·지정가·지정가청산·SL/TP·조건부 1회성/반복·강제청산·OX walking
         = 11개 호출 지점 전부). **경로마다 계량을 흩뿌리면 새 체결 경로를 추가할 때 빠뜨리고, 그 누락이
         곧 다음 청구서다.** ⚠ 그래서 조건부 등에 계량을 **따로 넣으면 이중 계산**이 된다(한 번 그랬다가 정리).
       - ⚠ **체결 단가는 flat 이 아니다(2026-09-07)** — `rowsForFill(prints) = 24 + 3 × max(0, prints−3)`.
         flat 24 는 "프린트 3줄까지"를 품고, 그 이상은 그 체결이 실제로 찍은 줄 수를 `feeAccrualStmts` 의
         마지막 인자로 받아 정확히 더한다(§4 유저 체결 프린트 분해 — 상한 20줄이라 최악 +51행). **flat 을
         20줄 기준으로 올리면 안 된다**: 프린트가 1~3줄뿐인 평범한 체결까지 3배로 과대 계상돼 차단선이
         실제 사용량보다 훨씬 먼저 걸린다. 계량 문장 수는 그대로 1개라 **왕복·행 증가 0**.
       - 계량 안 하는 것: 주문 생성/취소/수정, 로그인, 퍼즐, 던전 — 전부 사람 손 속도에 묶이고 1~5행이다.
         즉 이 값은 **총계가 아니라 "폭주 가능한 몫"**(정확한 총계는 위 1번).
       - **차단은 3단이고, "잃는 게 적은 쪽"부터 끊는다**(무료 플랜 기준 재설정, 2026-08-14):
         | 대상 | 일일선 | 멈추면 잃는 것 |
         | --- | --- | --- |
         | 큰 지정가의 **재**체결 | `NIBBLE_BLOCK_DAY_ROWS` 45,000 | 없음에 가깝다 — 주문은 살아있고 잠시 뒤 이어서 채워진다 |
         | `repeating` 조건부 체결 | `REPEAT_BLOCK_DAY_ROWS` 55,000 | 그 주문 하나가 쉰다(국지적) |
         | 마켓메이커 봇 | `BOT_BLOCK_DAY_ROWS` 80,000 | 가상 코인 시장이 통째로 선다 = **최후 방어선** |
       - 무료 한도 10만에서 2만(`DAY_RESERVE_ROWS`)을 계량 안 되는 몫(주문 생성/취소, 퍼즐, 던전)과
         "차단 후에도 유저가 청산은 할 수 있어야 한다"는 여유로 남긴다. 날짜(KST)가 바뀌면 자동 해제.
       - **월선은 없앴다** — 무료 플랜의 한도는 일 단위라 월 누적은 의미가 없다(`npm run d1:budget` 표시용).
       - **계속 도는 것: 유저 수동 거래·강제청산·지정가·SL/TP·1회성 조건부** — 돈이 걸린 기능을 DB 비용
         때문에 막는 건 더 큰 사고다. 봇이 멈춰도 유저는 청산할 수 있어야 한다.
       - **⚠ 계량 문장은 반드시 이미 도는 batch 에 얹을 것**(`meterStmt`) — 단독 실행하면 계량기가 왕복을
         늘려 그 자체로 비용이 된다. 그래서 봇 틱 단가 7 = 실제 ~6행 + 계량기 1행(캔들 새 버킷은 2행이라 실측 6.3 → 7로 올려 잡음)이다.
       - **⚠ 계량 조회가 실패하면 0 을 돌려준다** — 계량기 고장으로 시장이 통째로 멈추는 게 더 큰 사고다
         (그 경우는 위 1번 월 점검이 잡는다). 조회는 isolate 안에서 60초 캐시(차단 중엔 10분)이므로 차단이
         최대 60초 늦게 걸린다(그 사이 수백 행 — 무해). 차단이 걸리면 `console.log('[budget] …')` 를 남긴다
         — 조용한 후퇴라 로그가 없으면 "봇이 왜 멈췄지?"를 알 방법이 없다.
       - 현재 페이스(하루 3~5만)면 이 선에 닿지 않는다 — **닿았다는 건 어딘가 새 폭주 경로가 생겼다는
         신호**이므로, 차단이 걸리면 임계값을 올리는 게 아니라 `npm run d1:budget` 으로 원인을 찾을 것.
  - **⚠ 폴링 경로 전수 점검 결과(2026-08-01)** — 클라의 모든 주기 요청 중 **D1 에 쓰기를 만드는 건 둘뿐**이고
    둘 다 위 계량·차단 아래에 있다. 새 폴링을 추가할 땐 이 표에 한 줄을 더할 수 있는지부터 확인할 것.
    | 폴링 | 주기 | D1 쓰기 | 요청 수(§ 10만/일) |
    | --- | --- | --- | --- |
    | `useSpotPoll` → `/api/state?tick=` | 1s (탭 숨기면 정지) | **봇 커밋 1행**(게이트 0.45~0.95s, 2026-08-20 이전엔 선점 UPDATE 1행이 더 있었다) + 체결 시 20행 — 계량·차단 대상 | 3,600/시 |
    | `useTriggerPoll` → `/api/state` | 2.5s (**OX 볼 땐 위가 대신하므로 건너뜀**) | 체결이 성립할 때만 **20행** | 1,440/시 (OX 볼 땐 0) |
    | ~~`Chart` → `/api/spot?candles=1`~~ | — | 위 통합 폴링에 흡수됨(과거봉 로드만 별도, 스크롤 시에만) | — |
    | `SymbolSelect` → `/api/spot?candles=1` ×2 | 5s (드롭다운 열었을 때만) | **0** | — |
    | `Leaderboard` → `/api/leaderboard` | 5s | **0** (읽기 전용) |
    | `useDungeonStore` → `/api/dungeon` GET | 0.5~4s | **0** (§8 — 계정당 평생 1회 stats INSERT 제외) |
    | `useMarkPrices` → OKX | 1.2s | **0** (외부 API, D1 미접촉) |
    | 퍼즐 | 폴링 없음 | 클릭당 2~3행 |
    | 상자깡(§10) | 랭킹 모달을 **열었을 때만** 5s (탭 숨기면 정지) | 액션당 **1행**(유저의 모든 상태가 crate_stats 한 행이라 개봉 10연도 1행), 랭킹 폴링은 **쓰기 0** |

  - **⚠⚠ 가상 코인 폴링을 0.2초로 당길 수 없는 이유(2026-08-19 검토)** — "체결·호가가 1초마다 갱신되니
    0.2초로 해달라"는 요청에 대한 결론은 **불가**이고, 막는 건 D1 행 수가 아니라 **요청 수와 쓰기**다.
    ①**요청**: OX 화면 1인이 시간당 3,600 요청(위 표) → 0.2초면 18,000/시간이라 **한 사람이 5.6시간**
    보면 무료 10만/일이 끝나고, 넘긴 순간 Pages Functions 가 실패해 **가상 코인이 아니라 거래 전체가
    멈춘다**. ②**쓰기**: 폴링만 당겨도 봇 재호가 게이트(0.45~0.95초)가 그대로라 **5번 중 1번만 새 데이터**
    → 요청·읽기만 5배 늘고 화면은 거의 그대로다. 진짜 5배 갱신을 위해 게이트까지 0.2초로 내리면 봇 커밋이
    초당 5행(18,000행/시간)이라 cron 몫(3.9만/일)을 빼고 **3.4시간**에 일일 쓰기 한도가 끝난다.
    ③읽기만 여유가 있다(8행 × 18,000 = 14.4만/시간 → 21시간). 그래서 **1초를 유지**하고, 대신 (a)게이트
    상한을 1.1→0.95초로 내려 1초 폴링이 **매번** 새 틱을 받게 했고(1.1초였을 땐 ~15% 의 폴링이 게이트에
    막혀 그 초가 통째로 멈춰 "가끔 2초"로 보였다) (b)**실제 코인 38종은 브라우저↔바이낸스 직결이라 예산과
    무관**하므로 호가 스트림을 `@1000ms`→`@100ms`(표시는 200ms 스로틀)로 당겼다(체결 aggTrade 는 원래 즉시).
  - **⚠ 그래서 "0.5초·0.1초라도" 를 D1 없이 얻는 방법 = 클라 재생(`dripTrades`, 2026-08-19)**: 새 데이터의
    **도착** 주기는 폴링(=요청)에 묶여 있어 못 줄이지만, 한 폴링에 오는 건 봇 틱 하나가 찍은 체결
    **2~40건(평균 ~12 — 낮은 확률로 몰리는 "flurry" 틱이 있다)** 이다. 그걸 통째로 top 에 꽂으면 "1초에 한 번 덜컥"으로 보이므로, 시간순으로 조금씩
    (`REVEAL_MIN_GAP_MS`=100ms ~ `REVEAL_MAX_GAP_MS`=250ms 간격, `REVEAL_WINDOW_MS`=700ms 안에 완료)
    내보낸다 → 목록이 실제 테이프처럼 흐른다. **이미 받은 데이터를 순서대로 꺼내는 것이라 요청·읽기·쓰기가
    하나도 안 늘고**, 대가는 그 묶음의 가장 새 체결이 최대 0.7초 늦게 보이는 것뿐이다(헤더 현재가·차트는
    그대로 즉시 갱신 → 목록 맨 위가 현재가를 반 박자 뒤따라간다 = 실제 거래소 테이프와 같은 모양).
    - **⚠⚠ 해상도의 상한은 타이머가 아니라 "그 초에 존재하는 체결 건수"다.** 0.1초 간격이면 스텝당
      1~2건 = 사실상 한 건씩 내보내는 것이고, 공개 횟수는 곧 초당 체결 건수다. 여기서 더 잘게 쪼개도
      보여줄 게 없어 빈 스텝만 늘어난다 — 더 촘촘히 흐르게 하려면 `BOT_TRADES_PER_TICK_MIN/MAX` 를 올려
      **체결 자체를 더 많이 찍어야** 한다(테이프는 링 버퍼 JSON 이라 D1 비용은 0). 2026-08-31 에 계층
      분포를 넣으면서 실제로 그렇게 했다 — 건수를 2배로 늘리고 **평균 크기를 절반으로 낮춰** 캔들 거래량은
      그대로 두었다(§ 수량의 계층 분포). 건수만 올리면 그건 시장 데이터(거래량) 변경이 된다.
    - **호가 사다리는 이 방법이 안 통한다** — 봇 틱당 스냅샷이 하나뿐이라 쪼갤 중간 상태가 없다(그대로 1초).
  - **호가까지 0.5초로 보이게 하려면 `runBotTicks(…, 2)`(폴링당 2틱)** 로 가야 하는데, 이것도 **D1 은 공짜**다
    (N틱 메모리 → 커밋 1회 구조라 틱을 늘려도 쓰기 1행). 공짜가 아닌 건 **시장 동역학**이다: 봇 틱 레이트가
    지금도 "보고 있으면 60/분 vs 안 보면 12/분(cron)" 으로 5배 벌어져 있는데, 2틱이면 10배가 되고 1분봉 폭이
    √2배(2.2%→3%)로 벌어진다 — 중간 사다리를 응답에 실어 클라가 0.5초 뒤 두 번째 상태를 그리는 작업 + **`npm
    run sim:bot` 재보정**이 선행돼야 한다. 지금은 안 했다.
  - **정말 0.2초가 필요하면 폴링이 아니라 스트리밍(SSE)이다** — 한 요청으로 연결을 유지하며 서버가
    메모리에서 틱을 굴려 push 하면 요청·읽기·쓰기가 **오히려 줄어든다**(연결 1개가 수십 틱을 커버하고
    커밋은 마지막에 1회 = 지금의 "N틱 메모리 → 커밋 1회" 구조를 그대로 늘린 것). 걸리는 건 D1 이 아니라
    다른 두 한도다: **invocation당 D1 쿼리 50** 과 **CPU 10ms**(실측 24틱 ≈ 3.5ms → 한 연결에 ~50틱이 상한)
    → 연결을 5~10초로 끊어 재연결하는 설계가 필요하고, 봇 틱 레이트가 5배가 되므로 **`npm run sim:bot`
    재보정이 선행**돼야 한다(1분봉 폭·국면 점유율이 틱 수에 직접 걸려 있다).


## 7. 퍼즐게임 (ox64.app/b, `functions/api/puzzle.ts` + `src/puzzle/`)

> "헬로타운 스핑크스 보석찾기"를 확장한 미니게임. **트레이딩과 완전히 무관** — 같은 계정(세션 쿠키 공유)을
> 쓰지만 재화·기록은 별도 테이블(`puzzle_stats`/`puzzle_games`). `src/main.tsx` 가 `location.pathname` 으로
> 진입점을 동적 import 해 트레이딩 번들이 딸려오지 않는다(라우터 없음).

- **규칙**: NxN 격자에 1~6칸짜리 보석이 숨어 있고, 칸을 열면(코스트 1) 빈 땅/조각 + 조각이면 **색(종류)과
  상하좌우 어느 방향으로 이어지는지("부위")** 를 보여준다 — 지뢰찾기식 숫자 힌트 아님. 보석 구성(색·모양·개수)은
  시작 전부터 범례(`Legend.tsx`)로 보이고 다 연 종류는 취소선. 전부 획득=클리어(보상), **재화 0=게임오버**, 판은 무한 재시작.
- **⚠ 서버 권위 = 보드 정답은 서버만 안다**: `puzzle_games.board` 와 `gems[gemId].cells` 는 응답에 절대 안 싣는다.
  `publicGame()` 이 `revealed` 칸만 `{x,y,gemId,label,color,connects}` 로 내려주고, `connects`(`connectsFor()`)는
  이어지는 방향만 알려준다 — 어디서 끝나는지는 열어봐야 안다.
- **범례(`legendOf()`)**: 종류별 `{색,모양,개수,찾은 수}` 만(위치 없음). 레벨 선택 화면도 `levels[].types` 로 같은 정보.
  ⚠ 오픈 직후 판이 끝나 서버 `activeGame` 이 `null` 이 되면 클라(`usePuzzleStore.open`)가 로컬 `legend` 의 `found` 를 +1 한다.
- **재화(`puzzle_stats.currency`)**: 시작 60, 영구 누적. 오픈마다 `OPEN_COST`(레벨 무관 1)를 조건부 UPDATE(`currency >= cost`)로
  원자 차감 — 실패면 오픈 자체 거부(상태 불변). 클리어 `reward` 는 레벨1=12 ~ 레벨10=105. 운 나쁘면 적자는 의도된 리스크.
  **재화 0 일 때만** `refill`(+40, 1일 5회, KST — `refill.ts` 패턴).
- **레벨 1~10**: 보드 6×6~12×12·구성(`LEVELS[].plan`)·보상이 완만히 커진다. **서버가 `GET /api/puzzle` 의 `levels` 로
  기준표를 내려주고 클라는 그대로 렌더**(중복 정의 없음). ⚠ 밸런스는 초기 추정값 — 체감 난이도는 `LEVELS` 한곳만 조정.
- **보석 모양(`SHAPES`)**: single/domino/tromino/square/cross/big(1~6칸). `generateBoard` 가 무작위 회전+반전으로 최대 300회
  시도해 놓고 실패한 인스턴스는 조용히 스킵. `Board.tsx` 는 열린 칸을 색 배경 + `connects` 방향 돌기로 그린다.
- **한 계정당 활성 1판**: `start` 가 기존 `active` 판을 전부 `abandoned` 로 접는다(코스트 환불 없음 — 그게 페널티).
  `abandon` 은 명시적 포기(같은 처리).
- **⚠ 클라는 서버 `activeGame` 스냅샷에 의존하지 않는다**: 그건 `status='active'` 만 찾아 승/패 직후 `null` 이 된다.
  `open` 응답의 `gameStatus`/`cell`/`justCompleted`/`reward` 를 로컬 보드에 이어붙여야 마지막 보드가 배너와 함께 남는다.
- **라우팅**: `main.tsx` 가 `/b` 면 `PuzzleApp.tsx` 를 동적 `import()`(별개 청크). 새로고침 404 는 `public/_redirects`
  (`/* /index.html 200`)로 폴백 — Functions·정적파일이 먼저 매칭되므로 `/api/*` 무영향.

## 8. 5분 던전 (ox64.app/5m, `functions/api/dungeon.ts` + `src/dungeon/`)

> 원작 "5-Minute Dungeon"(손패를 실시간 동시에 내어 요구 아이콘 조합을 맞추고 5분 안에 클리어하는 협동 카드게임)의
> 온라인 재현. **트레이딩·퍼즐과 무관** — 같은 계정, 재화 없이 승패 통계만 `dungeon_stats`. 카드 텍스트는 베끼지 않고
> **메커니즘**만 재현, 영웅·카드·몬스터는 오리지널. 규모: 아이콘 5 · 영웅 6 · 몬스터 24 · 함정 6 · 포션 4 · 보스 4 · 던전 4.

- **⚠ 동기화 = Durable Objects/WebSocket 아니라 D1 + 짧은 폴링**: DO 는 별도 Worker 배포가 필요한데 무료 플랜 목표(§6)라
  새 인프라를 안 늘리고 OX 마켓메이커(`useSpotPoll`)와 같은 패턴을 재사용했다(불가능해서가 아니라 잘 돌고 배포가 안 늘어서).
  액션(POST)은 자기 응답으로 즉시 갱신하므로 폴링 지연은 "남이 한 일이 보이기까지"에만 영향. ⚠ 간격을 줄이려면 §6 먼저.
- **⚠ 폴링은 적응형(`useDungeonStore.delayFor`)이고 전제는 "GET 이 싸다"**: 진행 중 0.5s / 로비 1s / 종료 2s / 방 없음 4s,
  자기 자신을 재예약하는 `setTimeout` 루프. **GET 은 D1 왕복 2회·쓰기 0회를 유지할 것** — (stats+내 방코드)/(방+파티원)을
  각각 `batch`, stats 행은 없을 때만(계정당 평생 1회) INSERT. 예전엔 왕복 6·쓰기 2(`ensureStats` 의 `INSERT OR IGNORE` 를
  폴링마다)라 4인 한 시간에 무료 쓰기 한도(10만/일)를 태웠다. 클라는 직전 응답과 JSON 이 같으면 `setState` 스킵
  (`lastSnapshot`); 타이머는 `GameBoard` 자체 250ms 틱.
- **파티**: 방 코드 6자(O/0/I/1 제외), 1~4명, 영웅 중복 불가. 유저는 최대 1개 방 — `dungeon_players.user_id` 로 서버가
  "내 방"을 역참조하므로 코드 위조로 남의 방을 못 만진다.
- **영웅 6종**(`_dungeonData.ts HEROES`), 각 16장(주 9 + 보조 4 + 와일드 2 + 특수 1): 바바리안(힘, 요구치 한 항목 즉시 3) ·
  위저드(마법, 체력 +2) · 닌자(민첩, 내 손패 보충) · 팔라딘(신성, 다음 함정 무효) · 드루이드(자연, 전원 손패 보충) ·
  음유시인(덱 절반 와일드, 남은 요구치에 2 자동 분배). 특수는 판당 1회, `useSpecial` 전용(일반 카드처럼 내면 서버가 거부).
- **⚠ 난이도는 인원수 스케일**(`partyScale`, 요구치는 3인 기준): 1인 0.55 · 2인 0.8 · 3인 1 · 4인 1.2배.
- **⚠ 파티가 못 내는 아이콘은 'any' 로 완화**(`adaptReq`): 안 그러면 커버 못 하는 몬스터에서 타이머 끝까지 교착. 덱 생성 시
  커버 아이콘 몬스터 우선 + 남는 미커버 아이콘은 «아무거나» → 어떤 조합이든 클리어 가능.
- **손패는 전원 공개**(`PlayerOut.hand`), 단 **개인 덱·몬스터 덱의 남은 순서는 서버만**(`deck_json`, 응답엔 개수만) — 서버 권위.
- **몬스터/함정/포션/보스**: 몬스터·포션은 `{아이콘:수량}` 요구치, 누구나 기여 → 충족 시 즉시 격파(포션은 체력 회복, `MAX_HP`=10).
  **함정은 공개 즉시 자동 발동**(체력 차감 + 전원 손패 일부 버림·리드로우) 후 다음 카드로(연쇄 처리, `revealNext`); 팔라딘 방벽
  (`dungeon_rooms.ward`)이 하나를 무효화. **보스는 항상 마지막 카드**, 2페이즈 — ⚠ `req2` 는 **현재 카드가 들고 다닌다**
  (큐에서 빠진 뒤라 덱엔 없다), 클라에 "다음 페이즈 예고"로 내려간다.
- **이벤트 로그**(`dungeon_rooms.log_json`, 최근 20): 함정·격파·페이즈·특수·승패를 `EventLog.tsx` 가 보여준다 — 폴링이라
  놓친 사건을 따라잡는 용도.
- **⚠ 동시성 = `version` 컬럼 낙관적 동시성**: `UPDATE dungeon_rooms … WHERE code=? AND version=?`, 0행이면 재조회 후 재시도
  (`applyContribution`, 최대 5회). **⚠ D1 batch 는 0행 UPDATE 도 성공으로 본다**(§4) — 격파→다음 카드·승패 확정은 **버전 가드
  UPDATE 를 단독으로 먼저 실행해 `meta.changes>0` 을 확인한 뒤에만** 후속 쓰기(남의 손패·통계)를 한다. 성공 전엔 아무것도
  안 쓰므로 재시도가 항상 안전.
- **⚠⚠ 남의 손패는 "바뀐 사람만, 버전 가드로"(카드 복사 버그)**: 전원 손패를 스냅샷으로 덮어쓰면 그 사이 카드를 낸 사람의
  손패가 옛 상태로 되돌아가 **기여는 집계되고 카드는 손에 돌아오는 복사**가 난다. 함정이 실제로 바꾼 사람만, 그 사람의
  `version` 이 그대로일 때만 쓰고 가드에 걸리면 그 버림 효과만 건너뛴다. 닌자/드루이드 보충도 동일. **`dungeon_players` 의
  hand/deck/discard 를 쓰는 코드는 반드시 이 규칙.** 회귀 검증: 4인 동시 연타 스트레스에서 (손패+덱+버림)=16장 유지.
- **⚠ 동시 입력은 에러가 아니라 재시도 대상**: 남의 격파 처리로 내 `version` 이 올라 `playCards`/`rest` 가 0행이면 서버가
  최신 상태로 몇 번 재시도해 조용히 성공시키고, 정말 카드가 넘어갔을 때만 이유("그 사이 다음 카드로 넘어갔습니다")를 돌려준다.
- **5분 타이머 = 폴링 시점 평가**(`expireIfNeeded`): `ends_at` 을 클라에 실어 카운트다운만 로컬, 서버는 다음 요청 때
  `Date.now() > ends_at` 이면 `lost`. 돈이 안 걸려 cron 불필요.
- **승패**: 보스 2페이즈 클리어=`won`(`best_clear_ms` 갱신). 타이머 만료 / 체력 0 / 전원 지침(`allExhausted`)=`lost`.
  확정 시 전원 `games_played`(+wins)를 한 batch.
- **방 나가기**(`leave`): 로비/종료에서만(진행 중 불가). 방장 승계, 마지막 인원 나가면 방 삭제.
- **UI 원칙**: `Rules.tsx`(로비 기본 펼침)·`IconLegend`·카드 타입 힌트(`EVENT_TYPE_META.hint`)·버튼 `title`. 카드엔 이모지 +
  **속성 이름**. "전부 내기"(`planAutoPlay`)는 전용 아이콘을 와일드보다 먼저, 남은 필요량을 넘지 않게 큰 값부터 배치.

## 9. 미니 RTS (ox64.app/s1, `src/sc/`)

> 스타크래프트1 스타일 RTS(테란 1종족, AI 1:1). 채집→인구→테크→교전 루프 재현. **블리자드 리소스 전혀 안 씀** — 그래픽은
> 전부 도형, 수치도 오리지널.

- **⚠ 이 게임만 서버가 없다(전부 클라)**: 초당 수십 회 시뮬은 Functions+D1 폴링으로 불가(던전 0.5s 의 40배). 온라인 대전을
  포기하고 AI 단일 플레이, 로그인도 `/api/*` 호출도 없다(`functions/` 에 대응 파일 없음).
- **⚠ 전적은 localStorage**(`ox64_s1_record`): 시뮬이 클라에 있어 서버에 기록해도 위조 가능 — 서버 권위 기록 옆에 가짜 권위를
  두지 않는다.
- **고정 틱 30Hz**(`TICK_S`): 렌더는 rAF, 시뮬은 누적 시간을 고정 간격으로만 전진(프레임레이트 무관 속도). 큰 dt 는 한 번에
  250ms 까지만 소화.
- **맵**: 64×64 타일(24px), **180° 회전 대칭** + 두 본진 연결성을 플러드 필로 확인(안 되면 재생성).
- **길찾기**: 그리드 A*(최소 힙, 대각 모서리 관통 금지, 평활화). ⚠ **유닛은 장애물로 넣지 않는다**(부대가 서로 막는다) —
  겹침은 분리력(`separate`), 막히면(`stuck`) 재탐색.
- **전장의 안개**: `explored` + `visible`. 적 유닛은 시야 안만, 적 건물은 한 번 본 자리면 계속. ⚠ **플레이어 쪽만 계산**
  — AI 는 전지형(의도적 생략).
- **⚠ 카메라는 방향키만(WASD 아님)**: A/S/D/B/F 가 전부 명령 단축키라 WASD 면 명령마다 화면이 밀린다.
- **⚠ 게임 상태는 React state 아니라 ref**: 루프가 state 를 읽으면 클로저가 낡고 쓰면 60fps 리렌더. React 는 HUD(8Hz 스냅샷)만,
  미니맵은 10Hz.
- **⚠⚠ 모바일 흰 화면 = 캔버스 백버퍼 재할당 루프**: `canvas.width=` 대입은 백버퍼 통째 재할당인데 모바일 주소창 때문에
  `clientHeight` 가 프레임마다 바뀌어 초당 60번 수 MB 재할당 → 탭 사망. 방어 3겹: (1) `100dvh`(폴백 `h-screen`) (2) 캔버스
  `touch-action: none` + `overscroll-behavior: none` (3) **8px 임계값** 아래 흔들림 무시. **캔버스 크기 코드를 건드릴 때 이
  임계값을 없애지 말 것.**
- **⚠ 터치엔 우클릭이 없다 — 탭이 선택과 명령을 겸한다**: 내 유닛/건물 탭=선택, 그 외(빈 땅·적·자원) 탭=선택된 것들에 명령,
  드래그=범위 선택. 마우스는 좌=선택/우=명령 그대로(`pointerType === 'touch'` 분기). 가장자리 스크롤은 마우스 전용.
- **⚠ 게임 루프 예외는 에러 바운더리가 못 잡는다**: rAF 콜백은 React 밖 — 루프 본문을 `try/catch` 로 감싸 화면에 띄우고,
  렌더 쪽은 `ErrorBoundary`.
- **AI**: 0.5s 마다 판단, 일꾼 14 → 인구 → 배럭 → 리파이너리 → 팩토리 → 병력 → 공격/후퇴. ⚠ **미네랄이 남으면 생산 시설
  부족** — 배럭 최대 6·대기열 3칸까지 채운다(예전 상한 3·1칸엔 1,000 넘게 쌓였다).
- **⚠ 검증은 헤드리스**: `Game`+`AI` 를 AI 대 AI 로 끝까지(`AI` 가 owner 를 생성자로 받는 이유), 렌더러는 가짜 2D 컨텍스트로
  프레임 검증. ⚠ 같은 코드끼리면 P0 가 7~8할 이긴다(엔티티 순서 처리) — 사람이 P0.

## 10. 상자깡 (ox64.app/c, `functions/api/crate.ts` + `functions/_crateData.ts` + `src/crate/`)

> 상자를 까서 재료·골드를 얻고 **같은 재료 2개를 합쳐(merge) 레벨을 올려 값을 불리는** 미니게임. 트레이딩·퍼즐·던전과 무관,
> 같은 계정. 재화(`crate_stats.coins`, 골드)는 USDT 와 별도 컬럼. 싱글플레이라 폴링 없음(랭킹 모달만 예외).

- **⚠⚠ 한 유저의 모든 상태가 `crate_stats` 한 행이다** — 인벤토리(`inv_json`)·보유 상자(`crates_json`)·도감(`seen_json`)이
  JSON 칸이라 개봉 10연도 **쓰기 1행**(§6, `book_json` 과 같은 사상). **아이템을 행으로 쪼개는 설계로 되돌리지 말 것** —
  개봉 한 번이 수십 행이 된다. 한 요청 = 읽기 1행 + 쓰기 1행(신규만 INSERT 1) → 쿼리 한도(50)와 무관.
- **⚠ 밸런스 진실원본은 `functions/_crateData.ts` 하나. 확률·가격·가치를 건드렸으면 반드시 `npm run sim:crate`**
  (`scripts/sim-crate.ts`, 상자당 20만 회). 회수율은 **나온 상자를 재귀적으로 끝까지 깐 값**으로 잰다. 합격선:
  naive(머지 없이 다 팔기) 78~92% · optimal(끝까지 머지) 125~320% · 두 정책 비 1.3 이상 · **요일 이벤트 7일 평균 naive
  100% 미만** · 잭팟의 optimal 몫 5% 미만. (2026-09-10 실측: naive 83~86% / optimal 132~203% / 이벤트 평균 90.4%.)
  **⚠⚠ 핵심 불변식: 상자만 까서 다 팔면 반드시 적자(naive < 100%)** — 넘으면 상자만으로 골드가 불어나는 무한 인플레.
  돈을 버는 건 머지다. 보상 장치는 하나하나 몇 %p 씩 얹히므로(처음 넣었을 때 naive 106%) 합계를 시뮬로 다시 잴 것.
- **보상 장치** — 숫자를 올리는 대신 **눈에 보이는 사건**으로(같은 +15% 라도 "✨ 보너스! 2개 더"는 매번 보인다):
  | 장치 | 내용 | 기여 |
  | --- | --- | --- |
  | ① 개봉 보너스(`BONUS_TIERS`) | 개봉마다 **하나만** — ✨보너스 14%(+2개) · 🔥더블 5% · ⚡트리플 1.2% · 💥메가 0.25%(×5+2개) | +14%p |
  | ② 마일스톤(`MILESTONES`) | 누적 40/200/1000회마다 상자, **`opened` 컬럼이 게이지**(저장 상태 0) | +8%p |
  | ③ 대량 개봉(`rollBulkBonus`) | 10개 이상이면 35% 확률로 공짜 1개 | +3.5%p |
  | ④ 업적(`ACHIEVEMENTS`) | 21개, 누적 통계 기준선 넘으면 자동 지급 | 일회성 |
  | ⑤ 요일 이벤트(`DAILY_EVENTS`) | 🎁선물·⛏️광부·💰황금·🧩조각·📦할인·🍀행운·🎉축제 | +9%p(7일 평균) |
  - **⚠⚠ ⑤는 KST 날짜에서 파생**(`eventOfDay(todayKst())`) — 저장 상태·스케줄러·cron 없음. 할인은 `priceOf(level, ev)` 가
    상점 응답과 구매 검증 **양쪽**에 적용. **7일 평균이 100% 를 넘으면 안 된다** — `sim:crate` 가 요일별·평균을 찍고 평균
    100% 이상이면 실패. 이벤트를 세게 하려면 평상시 드롭을 같이 낮출 것.
  - ⚠ 이벤트 잭팟 배수는 잭팟 슬롯에만(`slot.jackpot && ev`). ⚠ ③은 확정 지급 금지("10개마다 1개"면 +10%p 로 밸런스의 주인).
    ⚠ ①의 추가 항목은 잭팟 슬롯 제외(`rollExtraRewards`).
  - **⚠⚠ 업적 수령 기록은 `seen_json` 에 `a:<key>` 로** — prod 에 ALTER 를 못 돌려 컬럼을 못 늘렸다. `parseInvKey` 가 `null`,
    도감은 `CATS` 기준이라 재료에 안 섞인다. **재료 카테고리에 `a` 금지.** 지급은 `grantAchievements(w)` 한 곳(모든 액션 끝)
    에서만. 응답 `achieved`(방금 받은 것)와 `achievements[].done`(이미 받았나)은 다른 필드.
- **⚠ 이모지는 Unicode 11.0 이하만** — 12.0+(🪵 등)는 구형 폰트에서 두부(□)로 뜬다(목재는 🌳 로 교체).
- **머지 규칙** — 같은 카테고리·같은 레벨 2개 → 다음 레벨 1개, 가치 `MERGE_MULT`(2.25)배(개당 1.125배 = 유일한 성장 동력).
  **카테고리는 절대 안 바뀌고 레벨만 오른다.** 상자는 머지 대상 아님. 카테고리 8종 — 약초/목재/광석/섬유/보석/정수 **Lv1~12**
  (`MAX_MAT_LEVEL`), 상자조각 Lv1~4, 골드복권 Lv1 고정. 상자 Lv1~5(100 / 450 / 2,000 / 9,000 / 40,000골드).
  - **⚠⚠ 레벨 상한을 바꾸면 `MERGE_MULT` 도 재조정** — Lv1→최고 가치 배율은 `(MERGE_MULT/2)^(상한-1)` 로 상한에 지수 반응
    (6→12 로 올리며 2.35 를 두면 2.24→6.28배로 폭발, 2.25 로 3.65배).
  - ⚠ 상위 상자는 이미 합쳐진 고레벨 재료를 주므로 optimal 이 상위일수록 낮다(Lv1 203% → Lv5 132%) — 정상.
- **⚠⚠ 골드복권(`lotto`)** — 레벨 없음, **팔 수도 합칠 수도 없고 긁기만**(`noSell`, `maxLevel: 1`). `base` 는 **상금 기준액**
  (`LOTTO_BASE` 300)이고 상금은 0.1~800배, 기대 배수 2.57.
  - ⚠ 총자산·파산 판정은 판매가가 아니라 **기대 상금**(`inventoryValue`) — 안 그러면 복권 부자가 빈털터리로 판정된다.
  - ⚠ `noSell` 은 `loadState` 응답에 반드시 실을 것(판매 버튼 숨김 근거). ⚠ 꼬리를 키우면 기대 배수 재계산(`p×mult` 큰 항이 평균을 끈다).
- **⚠ 상자조각 일괄 개봉은 인벤토리 헤더 전용 버튼** — `mergeAll` 에선 일부러 뺐다(도박은 직접 눌러야). 한 요청 처리량
  `MAX_MERGE_TIMES`(200)를 클라에 내려주고(넘겨 보내면 조용히 잘린다), 결과는 **레벨별 집계**로 돌려준다.
- **⚠ 상자조각은 유일한 예외** — 최고 레벨(Lv4) 2개 → **랜덤 상자**(`SHARD_CRATE_ODDS`). 기댓값(444)이 Lv4 2개 판매가(260)보다
  확실히 높아야(×1.71) "조각은 합쳐라"가 성립 → `sellAll`·`mergeAll` 은 조각 최고 레벨을 건드리지 않는다.
- **⚠ 잭팟(`JACKPOTS`)** — 모든 상자 공통 1/2,000 · 1/25,000 · 1/250,000 슬롯, 보상은 상자 가격 ×25 · ×150 · ×1,500.
  **`Σ(p × mult) ≤ 0.05`(가격의 5%)** — 넘으면 밸런스의 주인이 잭팟이 되어 "많이 까면 확률적으로 이기는" 인플레.
- **⚠ 서버 권위** — 추첨(`rollCrate`)·머지·판매·잔고 전부 서버. 확률표·가격·가치는 `GET /api/crate`(`cats`/`shop`/`shardOdds`)로
  내려주고 클라는 그대로 렌더 — **클라에 표를 또 적지 말 것**(VIP 표와 같은 이유).
- **⚠ 모든 액션은 read-modify-write 라 `version` 가드 필수** — `commit()` 이 `WHERE user_id=? AND version=?` 로 막고 0행이면
  재시도(더블클릭이면 재현). **새 액션은 `commit()` 을 우회해 UPDATE 하지 말 것.**
- **애니메이션은 "아주 살짝만"**(`crate.css`, 0.2~0.7초). 여러 개 개봉은 같은 보상끼리 합산(`aggregate`)해 한 번에; 흔들림은
  `Promise.all` 로 최소 시간 보장.
- **⚠ 인벤토리는 6×8 고정 격자 + 페이징**(`Inventory.tsx`) — 빈 칸도 그려 항상 48칸(높이 고정), 조작은 격자 아래 **액션 바
  한 곳**(`min-h` 로 고정).
  - **한 칸 = 재료 1개(스택 아님)** — 머지가 "둘 겹치기"라 스택이면 상대가 사라진다. DB 는 개수만 저장 → D1 비용 동일.
    정렬 카테고리 → 레벨 오름차순.
  - ⚠ 포인터 좌표를 리렌더에 안 태운다 — 고스트는 `ref` 로 DOM 직접 이동, 리렌더는 드롭 대상이 바뀔 때만. 고스트는 항상 마운트
    + `pointer-events: none`.
  - ⚠ 선택 칸은 같은 그룹의 아무 칸으로 폴백(개수가 줄어 인덱스가 사라져도 액션 바 유지).
  - **⚠⚠ "끌 수 없다"≠"누를 수 없다"** — `onDown` 이 `count < 2` 에서 return 하면 그 칸은 선택 자체가 안 된다. `down` 은 항상
    기록하고 `draggable` 로 드래그만 막으며 `onUp` 은 `d` 없어도 탭 처리.
  - ⚠ 개수 배지는 "이 페이지에서 처음 나오는 칸"(`badgeAt`), 자릿수 늘면 `countClass`/`fmtCount`(만/억). 크기 클래스는 **완성된
    문자열로**(Tailwind 정적 스캔).
  - 끌어 놓기 · 탭(선택, 같은 종류 재탭=머지) · 호버 툴팁(PC 전용)을 같은 포인터 이벤트로 처리.
- **랭킹**(`GET /api/crate?board=1` + `Leaderboard.tsx`) — 골드 순위. 모달 열린 동안 5s, 탭 숨기면 정지.
  - **⚠ 읽기 전용 유지** — 폴링에 쓰기가 붙으면 "스스로 반복하는 쓰기 경로"(§6). 서버도 SELECT 하나.
  - 정렬은 `coins` 로 SQL `LIMIT 100`, 총자산(JSON 파생) 정렬은 그 100명 안에서 **클라가**. 두 기준을 함께 보여주는 이유:
    재료를 쌓으면 골드 순위는 내려가도 총자산은 그대로다.
- **⚠⚠ 회생 — 지원은 돈이 아니라 상자로**: 가난할수록 회복이 어렵다(머지엔 같은 재료 2개가 필요한데 골드 몇 푼으론 상자 한두
  개라 재료가 흩어져 적자만 반복). 상자를 여러 개 줘야 머지가 성립한다.
  - 두 단계, **컬럼 추가 없이** `refill_date`+`refill_count` 로: 그날 첫 수령(`refill_count === 0`)은 조건 없는 일일 지원(Lv1 상자
    4 + 200골드), 그 뒤는 **총자산 < 상자 3개 값**일 때만 파산 구제(상자 3 + 400골드, 하루 4회). 일일 지원에 조건이 없는 건
    부자에겐 푼돈·빈털터리엔 생명줄이라 그 자체가 따라잡기 장치.
  - **⚠ 파산선은 "상자 3개" 값**(`BROKE_CRATES`) — 1개론 머지가 안 성립해 "구제받았는데 회생 불가".
  - **⚠ 회생 검증은 `sim:crate`**(골드 0·재료 0 에서 14일): 합격선 **파산 탈출 60/60**(지원을 끄면 0/60). KST 날짜 바뀌면 자동 초기화.

## 11. 백로그 (열린 항목)

> 완료된 작업 78건의 배경·수정 내용·검증 기록은 **[docs/HISTORY.md](docs/HISTORY.md)** 로 옮겼다.
> 규칙·불변식의 진실원본은 언제나 이 문서 본문(§2·§4·§6)이고, 이력은 "왜 그렇게 됐는지"를 되짚을 때만 연다.
> ⚠ **새 작업을 끝내면 완료 기록은 HISTORY.md 에 쓰고, 이 문서에는 앞으로 지켜야 할 규칙만 남긴다** —
> CLAUDE.md 는 매 세션 통째로 컨텍스트에 실리므로 이력이 쌓이면 그게 곧 매 세션의 고정 비용이 된다.

- [ ] 가상 코인 3종 이상 추가 — 페어 파라미터화·봇 재고 분리는 끝났고(`VIRTUAL_PAIRS`/`bot_inventory`) `VIRTUAL_SYMBOLS`+`spot_bot_state` 시작가 행만 추가하면 된다. 틱 예산은 코인 수로 나눠 쓰므로 비용은 안 늘지만 코인당 움직임이 성겨진다
- [ ] 미니 RTS 확장(종족 추가, 유닛 다양화, 난이도 선택, 리플레이)
- [ ] 상자깡(§10) 확장 — 재료 카테고리 추가, 상자 Lv4 이상, 도감 완성 보상. ⚠ 무엇을 얹든 `npm run sim:crate` 로 naive 70%/optimal 110% 를 다시 맞출 것
- [ ] 펀딩비 반영
- [ ] 랭킹 새로고침 최적화(현재 5초 폴링 → 서버 캐시/집계)
