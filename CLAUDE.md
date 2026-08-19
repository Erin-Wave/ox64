# ox64 — Mock Trading Platform

> 지인들끼리 수익률을 겨루는 모의 선물 트레이딩 플랫폼.
> 실시간 시세(바이낸스) 기반 롱/숏 진입·청산 연습 + **친구 랭킹**.
> **서버 권위 구조**: 잔고·포지션·주문·손익은 전부 서버(Cloudflare D1)가 계산·보관하고,
> 체결가는 서버가 바이낸스에서 직접 받아 쓴다 → 클라이언트가 가격/잔고를 조작해도 무의미.
> 프론트(정적 SPA) + 백엔드(Cloudflare Pages Functions) 를 **한 레포·한 배포**로 운영.

## 1. 기술 스택 (선정 이유 = 성능 + 무결성)

| 역할 | 기술 | 이유 |
| --- | --- | --- |
| 프레임워크 | **Vite + React (TS)** | 순수 SPA, Pages 배포 최적화 |
| 차트 | **TradingView Lightweight Charts v4** | Canvas 초경량, 실시간 60fps |
| 실시간 시세 | **RxJS + Native WebSocket** | 초당 수십 틱 스트림, 렌더 병목 방지 (표시 전용) |
| 상태/UI | **Zustand + Tailwind CSS** | selector 구독으로 리렌더 차단 |
| **백엔드** | **Cloudflare Pages Functions** (`functions/`) | 프론트와 같은 레포·배포. `/api/*` 라우트 |
| **DB** | **Cloudflare D1 (SQLite)** | 서버 권위 저장소(users/positions/orders) |
| **인증** | HMAC 서명 세션 쿠키 + PBKDF2 패스코드 | DB 세션테이블 불필요. 이름+패스코드 로그인. 쿠키 30일 지속(자동로그인) — 클라 `init/refresh` 는 **401 일 때만** 로그아웃하고 일시적 네트워크/5xx 오류엔 세션을 유지(폴링 실패로 튕기던 문제 방지, `api.ts ApiError`) |

> **왜 서버 권위인가**: 클라이언트(IndexedDB/localStorage)에 둔 값은 콘솔로 100% 변조 가능
> → 랭킹 경쟁이 무의미해짐. 그래서 진실원본을 서버로 옮김. (구 IndexedDB/Dexie 구조는 제거됨.)

## 2. 폴더 구조 (역할 한 줄)

```
ox64/
├── index.html              SPA 진입(다크). favicon(/favicon.png) + Proxima Nova 로드
├── wrangler.toml           Pages+Functions 설정. D1 바인딩(DB, database_id 박음) 코드 관리 → Git 배포가 읽음
├── schema.sql              D1 스키마(users[+refill_count/refill_date/ox_balance]/positions/orders/pending_orders[+reduce_only=지정가 청산, +last_fill_at=부분 재체결 간격 하한]/conditional_orders[조건부/스탑 주문 +repeating/armed/rearm_price/fill_count/max_fills=무한 반복]/spot_orders/spot_trades/spot_candles[OX 영속 캔들]/spot_bot_state[+drift/vol/sentiment/anchor/regime/regime_ticks/peak/trough=봇 심리상태(고점·저점 기억 포함), +book_json=호가 사다리, +tape_json=체결 테이프 링 버퍼, +live_json=진행 중 캔들 버킷, +pend_notional/pend_rows/pend_ticks=봇 수수료·계량기 누적]/usage_meter[D1 쓰기 예산 계량기, §6]/puzzle_stats/puzzle_games[퍼즐게임, §7]/dungeon_stats/dungeon_rooms/dungeon_players[5분 던전, §8]) — wrangler d1 execute 또는 D1 Console 로 적용
├── scripts/                운영 스크립트 — d1-budget.mjs(D1 쓰기 예산 점검, §6) · sim-bot.ts(봇 심리 모델 장기 시뮬레이션, `npm run sim:bot` — 심리 파라미터를 바꿨으면 반드시 돌릴 것)
├── vite.config.ts          @ alias(src), charts/rx 청크 분리
├── tailwind.config.js       색상 토큰이 CSS 변수 참조(rgb(var(--color-x) / <alpha-value>)) — 실제 값은 src/index.css 테마 블록
├── cron/                   ── 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker (메인 Pages 프로젝트와 별도 배포) ──
│   ├── wrangler.toml       name="ox64-liquidation-cron", 같은 D1(ox64) 바인딩, [triggers] crons=["* * * * *"](매 1분)
│   └── index.ts            scheduled() 가 매 1분 "페어별 봇 버스트(runMarketMakerBurst) → 트리거 평가(sweepTriggers) **1회**"를 호출. ⚠ 예전엔 이걸 4라운드 번갈아 돌려 가격 경로를 4번 샘플링했는데, sweep 한 번이 D1 쿼리 ~18개라 **무료 플랜의 invocation당 한도(50)** 를 넘겼다 → 지금은 버스트가 **지나온 기준가 경로**를 돌려주고(rangeOfPath) 그 최저/최고로 한 번에 판정한다(4점 샘플링보다 정확 — 그 구간의 딥/스파이크를 하나도 안 놓친다, § _trading.ts runTriggers ranges). fetch() 는 CRON_SECRET 헤더로 보호된 수동 트리거(테스트/즉시 재실행용)
├── functions/              ── 백엔드 (Cloudflare Pages Functions, /api/*) ──
│   ├── _middleware.ts      전역 미들웨어 — Host 가 ox64.app/localhost 가 아니면(*.pages.dev 포함) ox64.app 으로 301 리다이렉트(Pages 는 pages.dev 서브도메인을 끄는 대시보드 옵션이 없어서 미들웨어로 처리)
│   ├── _shared.ts          인증(HMAC 토큰/PBKDF2)·바이낸스 서버측 시세·D1 타입·loadState(positions/orders/pendingOrders)
│   ├── _budget.ts          **D1 쓰기 예산 계량기 + 자동 쓰기 차단(서킷 브레이커)** — Cloudflare 엔 D1 지출 상한 기능이 없어서(예산 알림은 사후 통보) "포함분을 넘기면 멈춘다"를 코드로 만든 것. 스스로 반복해서 도는 경로(봇 틱·repeating 조건부)만 `usage_meter` 에 누적하고, 이번 달 누적이 `BLOCK_AT_ROWS`(포함분 5,000만의 90%)를 넘으면 그 경로들이 조용히 물러난다(수동 거래·트리거 sweep 은 계속 동작). 계량 문장은 **이미 도는 batch 에 얹어** 계량기 자체가 비용이 되지 않게 하고, 조회도 **오늘 한 행만**(PK) 읽는다 — 예전엔 `day LIKE '이번달%'` 로 달 전체를 SUM 해서 조회 하나가 날짜 수만큼 행을 읽었다(§6)
│   ├── _trading.ts         runTriggers(...) — 강제청산→지정가→SL/TP→조건부 평가 본체(순수 로직 분리 패턴) / checkTriggers(env,uid) — 접속(폴링) 시 그 유저 1인분 / sweepTriggers(env) — cron 이 접속 여부 무관하게 호출하는 전 유저 sweep(**같은 본체를 공유**해서 "접속 중에만 되는 기능"이 갈라지지 않게)
│   ├── _dungeonData.ts     "5분 던전"(§8) 콘텐츠 정의 — 아이콘 5종/영웅 6종 덱 구성표(HEROES/heroDeckSpec), 몬스터 24·함정 6·포션 4·보스 4 풀, 던전 4개(DUNGEONS, 난이도별 구성), 인원수 난이도 스케일(partyScale). 서버 권위 콘텐츠(원작 카드 텍스트를 그대로 베끼지 않은 오리지널 구성)
│   ├── _dungeonEngine.ts   "5분 던전" 순수 게임 로직(D1 I/O 없음) — 셔플/덱빌드(buildDungeonDeck)/드로우(drawUpTo)/요구치 판정(isReqMet)/함정 자동발동(applyTrap, ward 무효화 포함)/파티 커버 아이콘 보정(adaptReq). _trading.ts 와 같은 "로직은 순수 함수로 분리" 패턴
│   └── api/
│       ├── login.ts        POST /api/login  (없는 이름=가입, 있으면 패스코드 검증→세션쿠키 30일 Max-Age=자동로그인)
│       ├── logout.ts       POST /api/logout (쿠키 제거)
│       ├── state.ts        GET  /api/state  (checkTriggers 호출 후 잔고+refillsLeft+포지션+주문+미체결주문, 인증필요). **`?tick=<pair>` 통합 폴링 모드** — 호가·체결·캔들(+`&state=1` 이면 계정 상태까지)을 한 요청으로. OX 화면의 폴링 3개를 합쳐 요청을 1/2.4 로 줄인 것(§6). ⚠ 이 파일이 `api/spot.ts` 를 import 하는 방향이어야 한다(반대로 하면 `_trading → api/spot` 과 순환)
│       ├── order.ts        POST /api/order  (open/close/limitClose/limitOpen/cancelLimit/editLimit/setSlTp/conditionalOpen/cancelConditional — 서버가 체결가 fetch·손익 계산·D1 원자 갱신. 응답은 `loadState(…, body.ordersSince)` 로 **주문내역을 증분**으로 싣는다(§6 — 액션마다 주문 50행을 다시 읽던 낭비 제거). close 는 OX 면 봇 호가창 walking 청산, limitClose 는 지정가 청산=reduce-only, editLimit 는 미체결 주문의 지정가·수량 수정, conditionalOpen 은 조건부/스탑 주문 예약)
│       ├── refill.ts       POST /api/refill (강제청산 안전망 — 1일 최대 3회, 1회 +10,000 USDT)
│       ├── spot.ts         GET /api/spot (OX/USDT 호가창·체결내역 "표시용" 시장 데이터, ?candles=1 로 캔들도) + runMarketMaker() (봇이 심리 모델(nextMarketState: 추세/변동성 클러스터링/과열회귀/탐욕-공포 국면)로 기준가를 옮기고 그 주변에 호가 사다리를 깔아 만드는 합성 시세·호가·체결 — **틱은 순수 계산(simulateTick)이고 N틱을 메모리에서 돌린 뒤 커밋 1회 = 상태 행 1행만 쓴다(runBotTicks)** — 사다리(`book_json`)·체결 테이프(`tape_json`)·진행 중 캔들(`live_json`)이 전부 그 한 행이라, 틱을 몇 개 돌리든 D1 왕복·쓰기가 안 늘어난다, 봇 호가는 잔고 에스크로 안 함(무한 유동성 풀 — 단 체결된 뒤의 재고/현금은 `botFillStmts` 가 정산). OX 는 레버리지 롱/숏도 order.ts 로 실제 코인과 동일하게 거래됨, 체결가만 여기서 옴)
│       ├── leaderboard.ts  GET  /api/leaderboard (친구 자산 순위=잔고+미실현PnL, 서버 시세)
│       ├── puzzle.ts       GET/POST /api/puzzle — "스핑크스 보석찾기" 퍼즐게임(§7, ox64.app/b). 트레이딩과 별도 재화(puzzle_stats), 보드 정답(puzzle_games.board)은 서버만 알고 클라 응답엔 "이미 연 칸"만 내려줌
│       └── dungeon.ts      GET/POST /api/dungeon — "5분 던전"(§8, ox64.app/5m) 방 생성/참가/던전선택/영웅선택/시작/카드플레이(여러 장 동시)/휴식/특수카드/나가기. GET 폴링(진행 중 0.5초)이 곧 동기화 수단(Durable Objects/WebSocket 없이 D1만으로) — ⚠ **GET 은 D1 왕복 2회·쓰기 0회**로 유지할 것(§8)
├── public/
│   ├── favicon.png         아이콘(원본 src/resources/images/icon2_256.png)
│   ├── _redirects          `/* /index.html 200` — SPA 폴백(Functions/정적파일이 먼저 매칭되므로 /api/* 는 영향 없음). /b, /5m, /s1 로 직접 진입/새로고침해도 index.html 이 서빙되게 함
│   └── fonts/              ProximaNova-{Light,Regular,Semibold,Extrabold}.ttf
└── src/                    ── 프론트 ──
    ├── App.tsx             세션확인→Login 또는 트레이딩 UI(반응형) + 랭킹/설정 모달
    ├── main.tsx            location.pathname 으로 트레이딩(App)·퍼즐게임(puzzle/PuzzleApp, /b)·5분 던전(dungeon/DungeonApp, /5m)·미니 RTS(sc/ScApp, /s1) 를 분기(라우터 없음, 동적 import 로 서로의 번들이 안 섞이게). useSettingsStore 를 먼저 import(저장된 테마 즉시 적용, FOUC 방지). ⚠ /s1 만 StrictMode 를 안 씌운다 — 개발 모드의 이펙트 2회 실행이 rAF 루프와 Game 인스턴스를 두 벌 만들어 시뮬이 2배속으로 도는 것처럼 보인다
    ├── index.css           Tailwind + 테마 CSS 변수(:root/[data-theme=light|high-contrast]) + @font-face + tabular-nums
    ├── types.ts            도메인 타입(Candle/Order/Position[stopLoss/takeProfit]/PendingOrder/Side)
    ├── symbols.ts          거래 심볼 38종(바이낸스∩OKX) + VIRTUAL_SYMBOLS(OXUSDT·EWUSDT)/isVirtualSymbol(체결가 소스만 다르다는 표시, 거래 로직은 동일) + 타임프레임 그룹(분/시간/일+) + KST_OFFSET(+9h 고정)
    ├── format.ts           fmtPrice(심볼 정밀도)/fmtVol(K·M·B)/precisionFromTick
    ├── services/
    │   ├── binanceRest.ts  초기 과거봉(스팟 REST) — 차트 표시용
    │   ├── binanceWs.ts    실시간 kline(스팟 WS) — 차트/현재가 표시용 + orderbookStream(부분 호가 스트림 `@depth<N>@100ms` 를 `BOOK_THROTTLE_MS`(200ms)로 솎아 내려줌, 호가창용) + aggTradeStream(체결, 발생 즉시 push). ⚠ 이 셋은 **브라우저↔바이낸스 직결**이라 Cloudflare 요청·D1 을 안 쓴다 — 실제 코인 호가/체결 갱신 주기는 예산과 무관하게 당길 수 있다(가상 코인은 서버 폴링이라 반대다, §6)
    │   ├── indicators.ts   EMA / Bollinger / RSI 계산
    │   └── api.ts          백엔드 클라이언트(/api/*, credentials 포함) — limitOpen/cancelLimit/setSlTp 포함
    ├── hooks/
    │   ├── useMarkPrices.ts   현재+포지션 심볼 가격 1.2초 폴링(다른 심볼 PnL 갱신 + 현재 심볼 mark). **가격 소스=OKX(services/okxRest, 서버 체결가와 동일 소스)**, 실패 시 바이낸스 폴백. isVirtualSymbol 은 제외(OX 는 서버 ref/spotCandles 로 옴). 실제 코인 mark 를 OKX 로 통일한 이유는 §시세 참고(바이낸스 mark 였을 때 고배율 진입 즉시 손익 튐)
    │   ├── useTriggerPoll.ts  로그인 시 **항상 2.5초마다** /api/state 재조회 → 서버 checkTriggers 를 실질적으로 구동시키는 폴링(=OX 안 볼 때 지정가/SL·TP 체결 지연 + 내 잔고/PnL 갱신 주기). in-flight 가드로 중첩 방지. ⚠ 예전엔 연속 무한 조건부가 있으면 1초로 당기는 적응형이었는데, 그 모드에 재실행 간격 하한 5초가 생겨(§4) 2.5초로 충분해져 분기를 없앴다
    │   └── useSpotPoll.ts     현재 심볼이 가상(OXUSDT)일 때만 1초마다 /api/spot 재조회 → useTradingStore 의 spotBook/spotTrades(호가창·체결내역 표시용, 유저 개인 데이터 아님) 갱신. 이 폴링이 곧 봇 마켓메이커 클럭이라 짧게 잡아 체결 딜레이를 줄임. **탭이 백그라운드면 정지**(§6 — 안 보이는 화면에 봇 틱과 요청을 쓰는 건 순수 낭비)
    ├── store/
    │   ├── useMarketStore.ts   symbol/interval(둘 다 localStorage 영속)/prices(심볼별 가격맵)/precisions(심볼별 소수자릿수)/connected/chartClickPrice+chartClickNonce(차트·호가창 클릭→지정가 입력 신호)+priceTarget(그 신호를 받을 칸: ''=주문패널 지정가, 'close:<positionId>'=그 포지션의 청산 지정가) + selectLastPrice/precisionOf
    │   ├── useChartStore.ts    차트 옵션(indicators: 기간/개수 자유 설정 가능한 EMA/BB/RSI 배열, visibleBars: 마지막 확대/축소 봉수, 카운트다운·거래량·매매마커·평단선·SL/TP선·지정가주문선, bookRows: 호가·체결 한 화면 표시 행수 5~50/기본 10 + BOOK_ROWS_MIN·MAX·DEFAULT·clampRows) localStorage 영속
    │   ├── useSettingsStore.ts 테마(dark/light/high-contrast)+거래모드(easy/standard) localStorage 영속, setTheme 이 document.documentElement.dataset.theme 도 갱신
    │   └── useTradingStore.ts  서버 상태 캐시(positions/orders/pendingOrders/refillsLeft) + init/login/logout/openMarket/closePosition/limitOpen/cancelLimit/setSlTp/refill(OXUSDT 도 이 경로 그대로 탐) + spotBook/spotTrades/spotRefresh(OX 호가창·체결내역 "표시용" 시장 데이터, 유저 개인 잔고 아님). **체결 목록은 `dripTrades` 가 0.1~0.25초 간격으로 한 건씩 흘려보낸다**(§6 — 봇 틱 하나가 3~12건을 한꺼번에 찍어서 목록이 1초에 한 번 덜컥 갱신되던 것을, 이미 받은 데이터를 시간순으로 내보내 실제 테이프처럼 흐르게 한 것 — 요청·D1 증가 0). ⚠ 간격을 더 줄여도 소용없다 — **해상도 상한은 타이머가 아니라 "그 초에 존재하는 체결 건수"**(초당 3~12건 → 실측 초당 4.8회 공개)이고, 더 잘게 쪼개면 빈 스텝만 늘어 리렌더만 낭비된다. ⚠ 새 체결 식별은 **`createdAt`** 으로 한다 — 봇 테이프가 링 버퍼라 `id`(`t<시각>-<인덱스>`)가 폴링마다 바뀐다. 코인 전환 시 `spotClear` 가 남은 슬라이스 타이머를 반드시 지울 것
    └── components/
        ├── VipModal.tsx        VIP 진행도 모달(뱃지 클릭) — 다음 등급까지 진행 막대·남은 거래대금·등급표. 기준표는 서버(loadState.vipTiers)에서 받음
        ├── VipBadge.tsx        VIP 등급 뱃지(등급 높을수록 진해짐, title 에 요율·다음 등급까지 남은 거래대금)
        ├── Logo.tsx            ox64 워드마크 — 15×3 픽셀아트를 옮긴 인라인 SVG(보간 없음, currentColor 로 테마 대응). 높이는 3의 배수로 주고 폭은 w-auto
        ├── Login.tsx           이름+패스코드 로그인/가입
        ├── Header.tsx          심볼(38+가상 1종, 공용목록, 정렬 가능)/현재가/연결/평가자산(잔고+미실현손익, 현금잔고 아님)/리필버튼(평가자산<=0 일 때만 활성화, N/3)/랭킹버튼/설정버튼/로그아웃. 모바일은 로고 숨김·아이콘만·"⋯" 더보기 드롭다운(랭킹/설정/유저/로그아웃)으로 한 줄에 수렴, `sm:` 이상은 기존 개별 버튼 레이아웃
        ├── SymbolSelect.tsx    심볼 드롭다운 — 실제 38종(바이낸스 ticker/24hr 폴링) + 가상 OX/USDT(뱃지) 를 **같은 목록·같은 정렬(심볼/가격/24h변동, 컬럼 헤더 클릭)에 통합**. OX 가격=`/api/spot` 최근체결가, OX 24h변동률=`/api/spot?candles=1&interval=1h&limit=24` 로 24h 전 시가 대비 계산(데이터 24h 미만이면 최초 시점 대비). `statOf(sym)` 이 심볼 종류에 따라 stat 소스만 분기해 정렬은 동일하게 처리
        ├── OrderBook.tsx       호가(매수 좌열·매도 우열, 각 최우선호가가 맨 위) / 체결(내부 탭으로 전환). **내 미체결 주문이 있는 가격대는 accent 링+점+굵은 수량으로 강조**(서버가 가격대별 `mine` 을 따로 합산해 내려줌) — 체결 행은 가격과 **수량 모두** 테이커 방향 색(매수 up / 매도 down) — 가격만 칠하면 목록을 훑을 때 매수·매도 흐름이 안 읽힌다. 실제 심볼=바이낸스 depth WS(100ms 스냅샷을 200ms 로 솎음)/aggTrade WS, 가상 심볼=useTradingStore.spotBook·spotTrades(useSpotPoll 1.5초 폴링). Standard 모드 + 옵션(useChartStore.orderBook) 둘 다 켜져 있을 때만 표시. **PC(md=768px 이상)에서는 `useChartStore.bookTogether` 를 켜면 탭 없이 호가(위)·체결(아래)을 같이** 본다(`useIsDesktop` 이 App.tsx 의 2열 분기와 **같은 경계**를 봐야 한다 — 모바일은 폭이 좁아 항상 탭이고, 사이드바가 18rem 이라 좌우 3열로 쪼개면 숫자가 뭉개져서 세로로 쌓는다). ⚠ 훅 호출을 `옵션 && useIsDesktop()` 처럼 단축 평가 뒤에 두면 렌더마다 훅 개수가 바뀌어 터진다. **한 화면에 보이는 행 수는 설정(useChartStore.bookRows, 5~50)** — 각 열/체결 목록의 높이를 `rows × ROW_PX(16)` 로 잡아 딱 그만큼만 보이게 한다(행 마크업이 `leading-[14px]`+`py-px` 라 폰트 크기와 무관하게 16px 고정 — 행 높이를 바꾸면 ROW_PX 도 같이)
        ├── Settings.tsx        테마 3선택 + 차트 색상 3선택 + **호가·체결 표시 개수(슬라이더 5~50 + 5/10/20/30/50 프리셋) + "PC 에서 호가·체결 같이 보기" 토글** + 거래모드(Easy/Standard) 2선택 + 폰트 크기 3선택 모달. 섹션이 늘어 작은 화면에서 넘칠 수 있어 모달 자체가 `max-h-[90dvh] overflow-y-auto`
        ├── Clock.tsx           우측 구석 실시간 시계(KST, 시:분:초). 1초마다 자체 상태만 갱신하는 독립 컴포넌트(부모 리렌더 안 유발). Chart 툴바 우측에 마운트
        ├── Chart.tsx           **⚠ 캔들을 직접 폴링하지 않는다** — 통합 폴링(useSpotPoll→spotTick)이 스토어에 넣은 봉을 구독만 한다(과거봉 lazy 로드만 자기 요청). 연결 표시는 fetch 실패가 아니라 **신선도**(마지막 갱신 8초 경과)로 판정. Lightweight Charts: 타임프레임 그룹셀렉트(초봉 포함)·KST+9·OHLCV+인디케이터값 레전드(hover/터치, 종가 옆에 그 봉의 변동률 (종가-시가)/시가 % 표시)·툴바 우측 실시간 시계(Clock)·다음봉 카운트다운(트레이딩뷰처럼 우측 가격축의 현재가 티커=마지막 봉 종가 라벨 바로 아래에 붙임 — `priceToCoordinate`+`priceScale('right').width()` 로 위치 계산, WS 틱·폴링·팬/줌·1초 틱마다 갱신)·인디케이터(추가/삭제/기간편집)·매매 B/S/L 마커·포지션 평단선+청산가선(추정, 평단선 옵션에 묶임)·SL/TP 수평선·미체결 지정가 주문선(가격+수량, 매수녹색/매도적색)·조건부(스탑) 주문 수평선(트리거가에 앰버 점선 "조건부 롱/숏 ≥/≤ 수량", 취소 X 버튼은 `cancelConditional` 로 라우팅 — 지정가/조건부 모두 `pendingLine` 옵션에 묶임)·차트 클릭→지정가 입력·테마 반응형 캔버스 재도색. 가상 심볼은 바이낸스 REST/WS 대신 api.spotCandles(1초 폴링)로 분기하되 표시범위는 최초 로드 때만 설정(매 폴링마다 재설정하면 줌이 리셋되는 버그가 있었음). **⚠ 폴링은 최초 1회만 500봉을 받고 이후엔 "마지막 로드 이후 흐른 시간 ÷ 인터벌 + 2"봉만 받는다**(§6 — 예전엔 1초마다 500봉을 통째로 다시 받아 하루 1,050만 행을 읽었다. 서버 롤업까지 겹쳐 요청 하나가 500×배수 행이었다). **탭이 백그라운드면 폴링 정지**, 돌아오면 쉰 시간만큼 봉을 더 받아 구멍을 메운다
        ├── OrderPanel.tsx      Easy=슬라이더로 비중만 정해 롱/숏 버튼 / Standard=시장가+지정가+조건부 탭·SL·TP 입력·수량 텍스트입력+단위(코인/USDT) 전환 (레버리지는 공통, 체결가는 서버가 fetch). **⚠ 수량 입력의 진실원본은 입력칸 문자열(`amtInput`, 현재 unit 기준)이고 코인 수량은 `sizeCoin` 으로 파생** — 예전엔 코인 수량을 상태로 두고 USDT 표시를 coin×가격으로 매 렌더 재계산했는데, 그 왕복에서 정밀도가 깨져(coin toFixed(6)) USDT 로 입력하면 타이핑이 엉뚱한 값으로 튀었다(BTC 에 "1 USDT" → 0.98). 단위 전환·슬라이더는 현재 unit 값으로 입력칸을 1회 채운다. **OXUSDT 도 이 컴포넌트 하나로 처리**(가상 전용 분기 없음 — 실제 코인과 완전히 동일한 레버리지 거래)
        ├── PositionsPanel.tsx  탭: 포지션(청산가 표시·(Standard 전용) 부분청산 수량 입력 + **지정가 청산 입력(비우면 시장가, 칸을 포커스하면 차트·호가창 클릭 가격이 여기로 들어옴 — accent 링으로 표시)**·SL/TP 인라인 편집, 청산 실행 후에도 수량·지정가 입력값 유지, Easy 는 전량 시장가청산 버튼만) / (Standard) 미체결 지정가(reduce-only 는 "롱/숏 청산" 뱃지) / 주문내역(전체 체결 이력, 강제청산 하이라이트). **OXUSDT 도 이 컴포넌트 하나로 처리**(가상 전용 분기 없음)
        └── Leaderboard.tsx     친구 자산 순위 모달(5초 폴링) + 상단에 거래소 수수료 수익(유저분/봇분/누적 거래대금)
    └── puzzle/                 ── 퍼즐게임(/b, §7) — App.tsx/useTradingStore 와 완전히 분리된 독립 진입점 ──
        ├── api.ts              /api/puzzle 전용 클라이언트(src/services/api.ts 재사용 안 함 — 별도 번들 유지)
        ├── usePuzzleStore.ts   zustand: currency/activeGame/levels + init/login/logout/start/open/abandon/refill. open() 은 서버 activeGame(= status active 인 판만 반환)에 의존하지 않고 로컬 보드에 이번 칸 결과만 이어붙임(승/패로 막 끝난 판도 화면에서 안 사라지게)
        ├── PuzzleLogin.tsx     이름+패스코드 로그인(트레이딩과 같은 계정/세션 쿠키 재사용)
        ├── Board.tsx           보드 격자 렌더링 — 서버가 내려준 "이미 연 칸"만 그리고, 안 연 칸은 전부 빈 버튼(정답 없음)
        └── PuzzleApp.tsx       진입 컴포넌트 — 로그인 게이트 → 레벨 선택(1~10) or 보드+HUD(재화/보석 진행도/포기·클리어·게임오버)
    └── sc/                     ── "미니 RTS"(/s1, §9) — **서버·로그인 없이 전부 클라이언트에서 도는 유일한 게임** ──
        ├── types.ts            도메인 타입 + 상수(타일 24px, 맵 64×64, 고정 틱 30Hz, 자원량/채집 시간)
        ├── data.ts             테란 유닛 4종(일꾼/마린/파이어뱃/시즈탱크)·건물 5종(커맨드/디팟/배럭/리파이너리/팩토리) 스펙. 밸런스는 여기만 고치면 됨
        ├── map.ts              맵 생성(180° 회전 대칭·본진 연결성 보장) + 통행 격자(rebuildBlocked) + 전장의 안개(explored/visible)
        ├── pathfind.ts         그리드 A*(최소 힙, 대각선 모서리 관통 금지, 경로 평활화). 유닛은 장애물로 넣지 않는다
        ├── game.ts             시뮬레이션 코어 — 고정 틱, 명령(이동/공격/공격이동/사수/채집/건설), 유닛 분리력, 타겟 획득·사격·스플래시, 채집 왕복, 건설 진행, 생산 큐, 인구, 승패
        ├── ai.ts               컴퓨터 상대 — 0.5초마다 판단(일꾼→인구→배럭→가스→팩토리→병력→타이밍 공격). owner 를 생성자로 받아 AI 대 AI 헤드리스 검증이 가능
        ├── render.ts           Canvas 렌더 — 지형/자원/건물/유닛/궤적/안개(가로 런 병합)/미니맵. 스프라이트 없이 전부 도형
        ├── Hud.tsx             자원·인구·시계, 미니맵, 선택 정보, 커맨드 카드(건설/생산/명령 버튼)
        └── ScApp.tsx           메뉴 + 대전 화면 — rAF 루프, 드래그 선택·우클릭 명령·건물 배치·부대 지정, HUD 스냅샷 8Hz
    └── dungeon/                ── "5분 던전"(/5m, §8) — 트레이딩·퍼즐 어느 쪽과도 완전히 분리된 독립 진입점 ──
        ├── api.ts              /api/dungeon 전용 클라이언트(별도 번들 유지). playCards 는 여러 장을 한 요청에 보낸다
        ├── data.ts             표시 전용 메타(아이콘 이모지/색/난이도 라벨) + planAutoPlay("전부 내기" 배치 계산)·remainingReq·fmtClock — 실제 덱 구성·판정은 서버(functions/_dungeonData.ts)가 유일한 진실원본
        ├── useDungeonStore.ts  zustand: room/players/heroes/dungeons/stats + create/join/chooseDungeon/chooseHero/start/playCard/autoPlay/rest/useSpecial/leave + **적응형 폴링**(delayFor: 진행 중 0.5s / 로비 1s / 종료 2s / 방 없음 4s, setInterval 이 아니라 자기 자신을 다시 예약하는 setTimeout 루프) + 직전 응답과 같으면 setState 스킵(리렌더 억제)
        ├── DungeonLogin.tsx    이름+패스코드 로그인(트레이딩과 같은 계정/세션 쿠키 재사용)
        ├── Rules.tsx           게임 규칙 설명 패널(로비에 기본 펼침) + IconLegend(아이콘 범례, 게임 화면에서도 재사용)
        ├── EventLog.tsx        던전 기록 — 서버가 방에 남긴 이벤트(함정 발동/격파/페이즈/특수)를 흘려보여준다. 폴링이라 놓친 사건을 따라잡는 용도
        ├── Lobby.tsx           방 없음(생성/코드 참가+규칙 설명) 또는 로비(던전 선택[방장]·영웅 선택·파티원 목록·시작)
        ├── GameBoard.tsx       진행 중/종료 화면 — 던전 진행도 막대, 파티 체력·방벽, 타이머 막대, 현재 카드 요구치(항목별 진행 막대+보스 2페이즈 예고), 내 손패(낼 수 있는 카드만 강조)·전부 내기·휴식·특수, 파티원 공개 손패, 종료 시 기여도 통계
        ├── Card.tsx            카드 1장 시각 컴포넌트(아이콘 이모지+기여값+속성 이름, sm/md 크기)
        └── DungeonApp.tsx      진입 컴포넌트 — 로그인 게이트 → 로비 or 게임보드
```

## 3. 데이터 흐름

```
시세(표시 전용):
  바이낸스 스팟 REST ─(초기 500봉)─► Chart.setData()
  바이낸스 스팟 WS   ─(RxJS kline$)─► Chart.update() + useMarketStore.lastPrice

거래(서버 권위):
  Login ──POST /api/login──► [세션쿠키]
  OrderPanel ──POST /api/order {symbol,side,size,leverage}──► functions/api/order.ts
                                                                │ 서버가 바이낸스서 체결가 fetch
                                                                │ 증거금/손익 계산·검증
                                                                ▼
                                                            D1 (users/positions/orders) 원자 갱신
                                                                │
  useTradingStore ◄──(갱신된 전체 state 응답)──────────────────┘
  Leaderboard ──GET /api/leaderboard──► 전 유저 equity(잔고+미실현) 순위
```

- **시세 소스 = 바이낸스 스팟**(REST `api.binance.com/api/v3/klines`, WS `stream.binance.com:9443`).
  선물(fapi/fstream)은 지역/IP 에 따라 WS 스트리밍이 막힘(소켓 OPEN 되나 데이터 0). 스팟은 전역 접근 가능 + 주요 종목 가격 사실상 동일 + 메시지 포맷 동일.
- **클라 시세는 표시 전용**. 체결가는 서버(`functions/_shared.fetchPrice`)가 별도로 받는다 → 클라가 lastPrice 를 조작해도 체결/손익은 서버가 받은 진짜 가격으로 계산됨.
- **⚠ 서버 시세 소스 = OKX → Coinbase → 바이낸스미러 폴백** (바이낸스 아님): **바이낸스는 Cloudflare Worker egress IP 를 전 호스트(api.binance.com·data-api.binance.vision)에서 403 차단**한다(브라우저는 되지만 서버 fetch 는 안 됨 → "price fetch 403"). 그래서 서버는 OKX(`www.okx.com`, USDT 페어 정확 일치) 우선, Coinbase(`api.exchange.coinbase.com`, USD≈USDT), 바이낸스미러 순으로 폴백. 클라 차트는 여전히 바이낸스 스팟(브라우저라 OK). 새 심볼 추가 시 OKX instId(`BASE-USDT`)·Coinbase product(`BASE-USD`) 매핑 확인.
- **⚠ 실제 코인 mark(현재가/PnL) 소스 = OKX (차트 캔들만 바이낸스, 2026-07-24)**: 서버는 실제 코인 체결가를 **OKX** 에서 받는데(바이낸스는 Worker egress 403), 예전엔 클라 mark(현재가·PnL 기준)가 **바이낸스**(차트 WS + useMarkPrices)라 둘이 코인별 0.005~0.3% 어긋났다. **고배율에선 이게 크게 증폭**돼(200배면 0.05% 괴리도 10% ROE, PEPE 는 진입 즉시 -57%) "평단가가 차트에 없던 값에 체결된 것처럼" 보이고 진입 즉시 손익이 튀었다("사기?" 제보). 수정: `useMarkPrices` 와 `useMarketStore.prices` 를 **OKX(`services/okxRest.fetchOkxPrices`)** 로 채워 체결가=mark 로 통일 → 진입 손익 ~0 에서 시작(open 응답의 `markPrices[symbol]=체결가` 시드로 진입 순간엔 정확히 0). **차트 WS(binanceWs.klineStream)는 캔들만 그리고 더 이상 `setPrice` 하지 않는다**(실제 코인 분기 — OX 스폿캔들 경로 489줄의 setPrice 는 OX ref=체결소스라 유지). OKX 가 지역 차단이면 useMarkPrices 가 바이낸스로 폴백(그 유저만 예전 괴리로 degrade, 무회귀). 차트 캔들은 바이낸스 유지(전역 접근·전 인터벌 — OKX 는 8h 미지원). 실제 코인 현재가는 이제 WS 가 아니라 1.2초 OKX 폴링으로 갱신(캔들은 여전히 WS 로 부드럽게 애니메이션).
- **PnL 표시 divergence(잔존)**: 실현 손익·랭킹은 서버 OKX 시세, 클라 mark 도 이제 OKX 라 예전보다 훨씬 작지만, 폴링 타이밍(체결 시각 vs 폴링 시각) 차이로 미세한 차이 가능(정상). 차트 캔들(바이낸스)과 포지션 현재가(OKX)는 괴리 큰 코인에서 소수점 몇 자리 다를 수 있으나 진입 손익 튐은 없다.
- **전 심볼 PnL 갱신**: `useMarketStore.prices`(심볼별 가격맵)를 `useMarkPrices`(현재+보유 포지션 심볼, OKX, 1.2초)로 채운다. 예전엔 차트 WS(현재 심볼, 바이낸스)도 채웠으나 위 이유로 실제 코인 mark 는 OKX 폴링만 쓴다. PositionsPanel 은 `prices[p.symbol]` 로 각 포지션 PnL 계산.
- **가격 정밀도(심볼별)**: 소수점 2자리 고정은 버그(예 0.0002345→0.00). `binanceRest.fetchPricePrecision` 이 exchangeInfo `PRICE_FILTER.tickSize` 로 심볼별 자릿수를 구해 (a)차트 series `priceFormat`(우측축·크로스헤어) 적용 + (b)`useMarketStore.precisions[symbol]` 저장 → Header 현재가·PositionsPanel 현재가/진입가/청산가·차트 레전드가 `fmtPrice(v, precisionOf(...))` 로 표기. 거래량은 `fmtVol`(K/M/B). (BTC/SOL=2, ALLO=4, PEPE=8.) **⚠ precision 은 예전엔 차트가 "현재 보는 심볼"만 채워서, 다른 심볼 포지션의 가격이 소수 2자리(precisionOf 폴백)로 나오던 버그가 있었다 → `useMarkPrices` 가 보유 포지션·미체결·현재 심볼 전부의 precision 을 없으면 1회 조회해 채운다(⚠ **가상 심볼은 조회 대상이 아니라 가격에서 파생** — 유효숫자 4자리라 자릿수가 가격대에 따라 바뀌므로 `useMarketStore.setPrice` 가 매 갱신마다 계산한다, § 가격 정밀도).** PositionsPanel 포지션 탭은 현재가 컬럼(진입가 좌측)·수량 아래 증거금(USDT) 표기.
- **⚠ 거래량 히스토그램 색은 캔들 색에서 파생**(`volColors`/`withAlpha`, alpha 0.45): 차트 하단 오버레이, `useChartStore.volume`(기본 ON) 토글. 예전엔 `rgba(0,192,118,0.45)` 처럼 **하드코딩**돼서 테마/프리셋(라이트·고대비·바이낸스·OKX·트레이딩뷰)을 바꿔도 거래량만 옛 배색으로 남아 캔들과 따로 놀았다(어떤 테마의 캔들색과도 일치하지 않는 값이었다). 새 색을 직접 쓰지 말고 항상 `volColors(chartColors(...))` 를 거칠 것. **⚠ 히스토그램은 색이 각 데이터 포인트에 박혀 있어 `applyOptions` 로 안 바뀐다** — 테마 변경 이펙트가 `syncIndicators()` 를 다시 불러 전체를 새 색으로 그린다. 우측 축에 최신 거래량 티커(`lastValueVisible`, 1.23M 형식). RSI/거래량 동시 표시 시 하단을 [캔들]/[RSI]/[거래량] 으로 스택.
- **⚠ 과거봉 lazy 로드는 실제 심볼·OX 양쪽 모두** — OX 분기가 예전엔 `subscribeVisibleLogicalRangeChange` 설정 **전에 곧장 return** 해버려서 가상코인만 과거 조회가 통째로 없었다(맨 왼쪽까지 스크롤해도 아무 일도 안 일어남). 지금은 OX 도 같은 패턴으로 `api.spotCandles(interval, 500, oldest*1000)` 를 호출해 이어 받는다(서버 `loadSpotCandles` 가 `endTime` 파라미터로 `bucket < ?` 페이지네이션). **1s 등 <60s 는 영속 캔들이 없어 과거 페이지가 존재하지 않으므로 `endTime` 이 오면 빈 배열을 반환**해 클라가 "더 없음"으로 확정하게 한다(최신 구간을 다시 주면 같은 구간을 무한히 덧붙인다). **⚠ 1.5초 폴링이 과거봉을 덮어쓰지 않게 병합**한다 — 폴링 결과로 배열을 통째로 갈아끼우면 왼쪽 스크롤로 붙여둔 과거봉이 매번 날아가 사실상 과거 조회가 불가능하다(최신 구간만 교체하고 그보다 앞선 구간은 보존). **기본 표시 봉수 + 과거봉 lazy 로드**: 초기 로드 후 `fitContent` 대신 `setVisibleLogicalRange` 로 **최근 ~38봉만** 표시(모바일 가독성). 왼쪽으로 스크롤해 보이는 논리범위 `from<10` 이면 `fetchKlines(.., endTimeMs=oldest-1)` 로 과거 500봉 prepend(`subscribeVisibleLogicalRangeChange`). prepend 시 인덱스가 밀리므로 `getVisibleLogicalRange`+오프셋으로 뷰 위치 보존. `loadingMore`/`noMore`(fresh<450=끝) 가드. symbol/interval 변경 시 리셋.
- **차트(Chart.tsx)**: 시간축은 **KST(+9h) 고정** — 차트에 넣는 모든 시간값에 `KST_OFFSET` 을 더해 라벨을 한국시간으로(LWC v4 는 UTC 라벨이라 오프셋 방식). 타임프레임=`symbols.ts INTERVAL_GROUPS`(분/시간/일+, `<optgroup>`). 인디케이터=`services/indicators.ts`(EMA20/BB20·2/RSI14, RSI 는 하단 별도 priceScale). 매매마커=orders 필터(long=B 그린 arrowUp, short=S 레드 arrowDown, close=C). 평단선=현재 심볼 포지션 가중평균 `createPriceLine`. 옵션 토글은 `useChartStore`(localStorage). **바이낸스는 1년봉 미지원 → 최대 1개월봉**(1y 요청은 데이터소스 한계로 제외).

## 4. 모의 체결 로직 (서버 = `functions/api/order.ts`)

- **진입(open)**: 서버가 `fetchPrice(env, symbol)` → 증거금 `price*size/leverage` 를 잔고에서 **조건부 UPDATE**(`balance >= margin`)로 원자 차감. 부족하면 거부. 포지션+주문 INSERT 를 `DB.batch`(트랜잭션)로. `fetchPrice` 는 `isVirtualSymbol(symbol)`(OXUSDT) 이면 OKX/Coinbase 대신 봇이 만드는 내부가격(`spot_bot_state.ref_price`)을 반환 — **OX 도 다른 38종과 완전히 동일한 이 코드로 거래되며, 체결가 소스만 다르다.**
  **⚠ 같은 심볼·같은 방향 물타기 = 포지션 병합(중복 생성 버그 수정)**: 이미 보유 중인 포지션이 있으면
  새 행을 또 만들지 않고 그 포지션에 합친다(평단가 재계산, 거래소들의 "원웨이 모드"와 동일). 레버리지는
  **최초 진입 때 값으로 고정**(포지션 하나에 레버리지가 섞이면 증거금 계산 불가) — 클라에서 보낸 레버리지는
  기존 포지션이 있으면 무시하고 `existing.leverage` 를 그대로 씀. `limitOpen` 체결(`_trading.ts`)도 동일한
  병합 로직을 탄다(`posBySymbolSide` 맵으로 같은 폴링 라운드 안의 연속 체결까지 올바르게 병합).
- **미실현 PnL**: `(mark-entry)*size*dir`. 랭킹/표시에서 계산(저장 안 함).
- **마진 모드 = 크로스(Cross) 고정**: 모든 포지션이 계좌 전체(여유잔고+전 포지션 증거금)를 공유 담보로 쓰고, 강제청산은 **계좌 평가자산이 0 이하일 때 전 포지션 동시**로만 일어난다(개별 포지션이 자기 증거금만 소진했다고 청산되는 아이솔레이티드가 아님). 청산가도 계좌 전체가 뒷받침한다는 전제로 계산된다(아래 산식). 아이솔레이티드 옵션은 없음. UI 는 OrderPanel 레버리지 뱃지·PositionsPanel 포지션/미체결 뱃지에 "크로스"를 명시.
- **⚠ 크로스 가용 증거금 = 여유잔고 + 전 포지션 미실현손익** (`= 평가자산 − 사용중 증거금`, `_shared.unrealizedTotal`): 신규 주문(open/limitOpen)이 쓸 수 있는 증거금은 여유 현금뿐 아니라 **보유 포지션의 미실현이익까지 포함**한다 — 예전엔 여유 현금(balance)만 봐서 "평가자산 10만인데 슬라이더 100%가 2만밖에 안 잡히던" 버그가 있었다(이익 중인 포지션의 미실현이익이 새 주문에 안 잡힘 = 사실상 아이솔레이티드처럼 동작). 이익을 담보로 열면 여유잔고(`users.balance`)가 **음수까지 허용**되며(미실현이익이 상쇄), 잔고 차감 가드는 `balance − margin >= −uPnL`(⟺ `가용 >= margin`)로 원자적으로 막는다. 손실 중이면 가용이 여유잔고보다 작아진다(정상). 클라(OrderPanel 슬라이더·"가용(크로스)" 표시)도 서버 `markPrices` 기준으로 동일 계산해 어긋나지 않게 한다. OX 시장가도 `matchMarketOxOrder(…, floorPnL)` 로 동일 적용.
- **⚠ 평가자산(equity) = 여유잔고 + Σ(잠긴 증거금 + 미실현손익)** — 진입 시 증거금은 잔고(`users.balance`)에서 이미 빠져나가지만(그게 곧 담보), 청산 시 `balance += margin + pnl` 로 되돌아오므로 **증거금은 순자산의 일부다**. 강제청산(`_trading.ts liquidateIfBankrupt`)·리필(`refill.ts`)·랭킹(`leaderboard.ts`)·클라 표시(Header/PositionsPanel/Chart 청산가)가 전부 이 식을 쓴다. 예전엔 증거금 항을 빠뜨리고 `잔고+미실현`으로만 계산해서, 증거금 비중을 크게 잡으면(슬라이더 100% 등) **진입 즉시 강제청산**되고 랭킹 자산도 증거금만큼 깎여 보이던 치명적 버그가 있었음(수정됨).
- **청산(close)**: **실제 코인 38종**은 서버가 청산가 fetch → `pnl` 계산 → 잔고에 `margin+pnl` 반환, 포지션 DELETE, close 주문 기록(pnl 포함). 전부 batch. `size` 를 지정하면 **부분 청산**(보유수량보다 작을 때) — 증거금/포지션 수량을 비율만큼만 줄이고 포지션은 유지, 생략/전량이면 DELETE(로컬 호가창이 없어 외부시세 mark 정산이 표준, 유동성 사실상 무한).
  - **⚠ 시장가 매칭 = 스냅샷 기반(2026-07-24 재설계 — "대량 매수가 느리고 조금씩·급락·멈춤" 심각 버그 수정)**: 예전엔 `matchMarketOxOrder`/`closePositionAgainstBook` 이 봇 호가를 **청크마다** (포지션 SELECT + 15개 인터벌 캔들 upsert 포함 batch + 리쿼트와 경합하는 조건부 claim)로 **remote D1 를 왕복**하며 walking 했다. 대량 주문이면 수십~수백 왕복이 나고, 접속 폴링(useSpotPoll/useTriggerPoll)이 유발하는 봇 리쿼트가 walking 도중 봇 호가를 취소해 **claim 실패→refund→continue 스핀**으로 진행이 막혀, 체결이 조금씩·느리게 되고 심하면 몇 분간 멈췄다. 지금은 봇 호가를 **스냅샷 1회**로 읽어 **메모리에서 walking**(실사다리 소진 후 합성 흡수까지 전부 메모리)하고 결과를 **단일 batch**로 적용한다 → 왕복이 주문 크기와 무관하게 상수(수 read + charge + batch 1회), claim 경합 스핀 없음(소비한 실호가는 best-effort UPDATE — 리쿼트가 이미 취소했어도 봇은 무한 유동성이라 체결은 그대로 성립). 합성 흡수는 여전히 `SYNTH_STEPS`=24 균등 분할 + `SYNTH_MAX_IMPACT`=3% 상한(슬리피지 완만). 지정가(reduce-only 청산·limitOpen marketable)는 합성 안 함 — 크로스 호가 없으면 잔량 대기. 체결 테이프는 시장가 1건(집계)으로 기록하고 ref_price 를 최종 체결가로 갱신한다. **실측(로컬 D1): 1천만개 매수/청산이 단일 요청에 전량 즉시 체결, 매수→ref +3%·매도→-3%.**
  - **⚠ 유저 체결이 적정가(anchor)를 끌어당긴다(`ANCHOR_TRADE_PULL`=0.5) — "매수했는데 오히려 급락" 수정**: 예전엔 유저 시장가 체결이 `ref` 만 밀고 `anchor` 는 그대로라, 다음 봇 틱의 평균회귀(적정가 대비 과열도로 되돌림)가 그 움직임을 통째로 되돌려 매수 직후 되레 급락하는 것처럼 보였다(특히 옛 코드에선 체결이 조금씩이라 시장 노이즈에 파묻혔다). 실제 시장에서 대량 주문은 정보/수요라 적정가 자체를 옮긴다 — `matchMarketOxOrder`/`closePositionAgainstBook` 이 체결 후 `anchor` 를 체결가 방향으로 절반쯤 당겨(`newAnchor = anchor + (newRef−anchor)×0.5`) 시장충격이 "굳게" 한다(나머지 절반만 서서히 되돌아옴 = 현실적 임팩트 감쇠). **봇 전용 시뮬레이션엔 이 경로가 없어 장기 안정성 불변**(`BOT_BASE_PULL` 이 anchor 를 기준선 1 로 약하게 tether). 봇↔봇 합성체결엔 적용 안 함.
  - **⚠ 시장가 진입은 목표 수량을 "감당 가능한 만큼" 먼저 클램프**(부풀린 평단→즉시 강제청산 버그): `affordableUnits = (balance + floorPnL) × 0.999 / (est/lev + est×feeRate)` 로 목표를 줄인 뒤 스냅샷 walking 한다. ⚠ 메모리 정산 시 감당분을 `avail` 딱 100% 가 아니라 `avail×(1−1e-6)`(budget)로 잘라야 한다 — 정확히 avail 에 맞추면 최종 잔고 차감(charge)의 원자 가드가 부동소수 오차로 실패해 체결이 통째로 0 이 된다. 청산(`closePositionAgainstBook`)은 잔고를 환급하므로 감당 클램프가 없다(포지션 전량이 목표).
  - **⚠ OX/USDT 시장가 청산 = 봇 호가창 walking(있는 물량만큼만 청산)**: 예전엔 OX 청산이 호가창을 무시하고 `fetchPrice`(봇 ref) 한 값에 **전량** 정산돼, **호가창에 매물이 없어도(얇아도) 전 물량이 즉시 청산**되던 버그가 있었다. 이제 진입(`matchMarketOxOrder`)과 대칭으로 `spot.ts closePositionAgainstBook` 이 봇 호가를 가격-시간 우선순위로 walking 하며 **있는 물량만** 실제 호가 가격에 청산하고, 매물이 부족하면 **그만큼만(부분) 청산하고 나머지는 포지션에 남긴다**(호가가 아예 없으면 "청산할 수 있는 호가 물량이 없습니다"). PnL·증거금 환급은 실제 체결가(가중평균) 기준(슬리피지 반영). `order.ts close` 액션이 OX 면 `marketCloseOxPosition` 으로 분기.
- **⚠ 미체결 주문 수정(editLimit)**: 미체결 지정가 주문의 **지정가·수량을 취소 없이 수정**한다. 진입 지정가는 새 값으로 증거금을 재계산해 델타(신규−기존)만큼 잔고를 조정 — **잔고 차감을 먼저 원자 가드(`balance − delta >= −uPnL`)로 확정하고 성공했을 때만 pending 을 UPDATE 한다**(⚠ batch 로 묶으면 잔고 가드가 0행이어도 pending UPDATE 가 그대로 커밋돼 "증거금 없이 주문만 커지는" 상태가 된다 — D1 batch 는 조건부 UPDATE 0행을 실패로 안 봄). reduce-only(지정가 청산)는 증거금이 없어 값만 갱신. 수정 후 OX 는 새 가격으로 즉시 재매칭(marketable 이면 바로 체결). UI 는 `PositionsPanel` 미체결 탭의 "수정" 버튼(지정가/수량 인라인 편집) + 차트 주문선 옆 취소(X) 버튼.
- **⚠ 지정가 청산(limitClose, reduce-only)**: 포지션을 특정 가격에 청산 예약하는 기능(수량뿐 아니라 지정가로도 청산). `pending_orders.reduce_only=1` 로 쌓되 **증거금은 새로 안 잠근다(청산이므로, margin=0)**. 주문 방향(side)은 포지션 반대(롱 청산=`short`=매도, 숏 청산=`long`=매수). 체결 시 새 포지션을 열지 않고 대상 포지션(반대 side)을 그 수량만큼 줄인다. **OX** 는 제출 즉시 + 재호가 sweep + `checkTriggers` 가 `matchReduceOnlyOxPending`(위 `closePositionAgainstBook` 를 limitPrice 로 walking)로 봇 호가창에 매칭. **실제 코인** 은 `_trading.ts settleReduceOnlyClose` 가 mark 가 지정가를 크로스하면(매도청산 `mark>=limit`, 매수청산 `mark<=limit`) 그 지정가에 정산. 대상 포지션이 이미 없으면(전량청산·강제청산됨) 고아 pending 은 자동 삭제. 취소는 `cancelLimit`(margin=0 이라 환불 0). **⚠ 청산 가능 수량 검증(2026-07-24)**: 지정가 청산 수량은 `보유수량 − 이미 걸어둔 reduce-only 청산 합`(원웨이 모드라 symbol+closeSide 의 reduce_only 는 전부 이 포지션 대상) 이내여야 한다 — 예전엔 `size > pos.size` 로만 봐서 100 짜리에 청산 예약 100 을 여러 번 쌓아 **보유량을 초과하는 청산 주문**을 걸 수 있었다(체결 땐 `min(pending, pos)` 로 캡되지만 예약 자체가 유령). `limitClose`·`editLimit`(reduce-only) 둘 다 예약 합을 빼고 검증. 클라(`PositionsPanel`)도 청산 수량 placeholder 를 `청산 가능(=보유−예약)` 으로 표시하고, 지정가 청산 시 수량 비우면 전량 대신 청산 가능분을 기본값으로 보낸다. UI 는 `PositionsPanel` 청산 셀의 "지정가(비우면 시장가)" 입력 + 미체결 탭 "롱/숏 청산" 뱃지 + 차트 "청산 매수/매도" 주문선. **⚠ SL/TP 루프는 이제 포지션을 스냅샷이 아니라 최신 상태로 다시 읽는다** — reduce-only 청산이 같은 폴링에서 이미 줄이거나 없앤 포지션을 SL/TP 가 이중 청산(사라진 포지션에 잔고 재환급)하지 않게 하는 방어.
- **입력 검증**: 심볼 형식(USDT 페어), side∈long/short, `badSize(size)`(=`size>0 && isFinite && size<=MAX_ORDER_SIZE`), leverage 1~200.
  - **⚠ 수량 상한(`_shared.MAX_ORDER_SIZE`) = 1e30, "부동소수 폭주 방지용"일 뿐이다** — 실제 한도는 `증거금+수수료 <= 크로스 가용` 가드가 잡는다. 그래서 이 값은 "정상 거래로 도달 가능한 최대"보다 **훨씬 크게** 잡아야 한다: 캡이 낮으면 정상 주문이 "수량 오류"로 막히고, 유저는 왜 막혔는지 알 수 없다. 히스토리 = `1e6`(PEPE 수십억 개에서 터짐) → `1e15`(2026-07-30 에 또 터짐: OX 하한 0.0001·PEPE 1e-5 를 200배로 담으면 잔고 1억 USDT 수준에서 이미 1000조 개를 넘어 **슬라이더 100% 가 곧 수량 오류**였다) → `1e30`. 캡을 넘는 값은 어차피 증거금 가드가 "증거금이 부족합니다"로 정확히 거부한다(검증 통과 후 OX 는 감당 가능 수량으로 클램프해 부분 체결).
  - **⚠ 잔여/전량 판정 오차는 고정값이 아니라 `_shared.sizeEps(size)=max(1e-9, size*1e-12)`** — double 유효자리가 ~16자리뿐이라 1e15 개를 여러 청크로 walking 체결하면 합산 오차가 0.1~1 단위로 나온다. 고정 `1e-9` 로 비교하면 그 먼지가 "미체결 잔량"으로 남아 **전량 청산해도 포지션이 안 지워지고**(청산 버튼을 눌러도 수량이 0 이 안 됨) 미체결/조건부도 영원히 남는다. 적용 지점: `spot.ts` 청산 `fullyClosed`·pending 소진, `_trading.ts` reduce-only `fullyClosed`·조건부 잔량, `order.ts` 보유수량 초과/부분청산/청산가능수량 검증. **전량 판정이 참이면 증거금은 비율 계산이 아니라 잠긴 전액(`pos.margin`)을 환급**한다(반올림 손실이 잔고에 남지 않게).
- **⚠ 진입 지연 감소**: 실제 코인 `open` 은 `checkTriggers`(보유 심볼 시세 fetch)와 체결가 `fetchPrice(symbol)` 를 `Promise.all` 로 **병렬** 실행한다(둘 다 끝난 뒤에만 잔고/기존포지션을 읽으므로 원자성 안전) — 예전엔 순차라 외부 시세를 두 번 왕복했다. 아울러 서버 시세 소스 fetch 에 `timedFetch`(2.5s AbortController) 를 걸어, 한 소스가 느리면 즉시 다음 폴백으로 넘어가 롱/숏 버튼 체감 지연의 tail 을 줄였다.
- **지정가(limitOpen)**: `pending_orders` 에 생성 시점 `limit_price` 기준 증거금을 즉시 잠금(조건부 UPDATE 동일 패턴). **실제 코인 38종**은 체결가를 재계산 없이 `limit_price` 그대로 사용(델타 정산 불필요, `checkTriggers` 가 `mark` 이 `limit_price` 를 크로스하면 체결). **OX/USDT 는 예외** — 봇 호가창을 실제로 walking 매칭한다(§ OX/USDT "실제 호가창 매칭 엔진", `spot.ts matchLimitPendingAgainstBook`): 있는 물량만 실제 호가 가격에 체결, 잔량은 대기. `cancelLimit` 은 잠근(잔량분) 증거금을 그대로 환불.
- **SL/TP(setSlTp)**: `positions.stop_loss`/`take_profit` (포지션당 각 1개). 값은 항상 포지션 방향 기준으로 검증(롱: `stopLoss<entry<takeProfit`, 숏은 반대) — `validSlTp()`.
- **⚠ 조건부(스탑) 주문(conditionalOpen/cancelConditional)**: 지정가와 별개의 주문 타입. `conditional_orders` 테이블에 `trigger_price`+`trigger_dir`('above'=이상/'below'=이하)+진입 방향(long/short)+수량+레버리지를 저장하되 **증거금은 미리 잠그지 않는다**(스탑 주문 관행 — 트리거 전엔 예약일 뿐). `checkTriggers` 의 `settleConditionalOrder(_trading.ts)` 가 매 폴링에서 `mark` 이 트리거를 넘어섰는지 보고(above=`mark>=trigger`, below=`mark<=trigger`), 넘었으면 **그 자리에서 시장가로 남은 수량만큼 진입**한다. **OX** 는 `matchMarketOxOrder`(봇 호가창 walking — 있는 물량만 실제 호가 가격에, 잔량은 조건 유지), **실제 코인**은 `mark` 가에 즉시 체결하되 **가용 증거금(크로스=여유잔고+미실현손익)만큼만** 체결하고 못 채운 잔량은 조건을 살려둔다 → **"예약 수량이 다 안 채워지면 계속 조건이 살아있음"**(부분 체결마다 `conditional_orders.size` 를 줄이고, 0 이 되면 삭제). ⚠ 실제 코인 경로는 **잔고 차감을 먼저 원자 가드로 확정한 뒤에만** 포지션/원장 batch 를 커밋한다(editLimit 과 동일 — batch 안에 조건부 UPDATE 를 넣으면 0행이어도 나머지가 커밋돼 "증거금 없이 포지션만 생기는" 함정). 물타기 시 기존 포지션 레버리지로 고정·평단 재계산(원웨이 모드). SL/TP 는 지원 안 함(진입만 예약). `conditionalOpen` 은 INSERT 직후 `checkTriggers` 를 한 번 돌려 **이미 트리거된 스탑은 즉시 체결**시킨다(거래소 동일). 취소(`cancelConditional`)는 잠근 증거금이 없어 환불 0. UI 는 `OrderPanel` 세 번째 주문 타입 탭("조건부", 이상/이하 토글+트리거가) + `PositionsPanel` "조건부" 탭(방향/트리거조건/수량/반복/취소).
- **⚠ 무한(반복) 조건부(`repeating`, 2026-07-28)**: "1.5 이하로 떨어질 때마다 시장가 123개 매수"처럼 **체결돼도 주문이 사라지지 않고** 계속 일하는 모드. `repeating=1` 이면 `size` 는 남은 목표가 아니라 **1회 실행 수량(차감 안 함)** 이고, 체결 후 행을 지우는 대신 `fill_count+1`·`last_fill_at` 을 갱신한다. 반복 방식(`repeat_mode`)이 두 가지다:
  - **`continuous`(기본)** — 조건이 참인 **동안 계속** 실행한다(체결 후에도 `armed=1` 유지 → 다음 폴링에서 또 진입). "떨어져 있는 동안 계속 사 모으는" 물타기/DCA 용도이며 유저가 명시적으로 요청한 기본 동작이다.
    **⚠⚠ 재실행 간격 하한 = 5초**(`_shared.ts MIN_CONTINUOUS_COOLDOWN_MS`, 2026-08-01). 예전엔 `cooldown_ms=0`(=평가마다 ≈1초)이 기본이자 허용값이었는데, 그러면 **주문 하나가 하루 8.6만 번 체결되고 체결 1건이 D1 에 ~18행을 쓰므로 하루 155만 행 = 월 4,650만 행** — 월 rows written 포함분(5,000만)을 그 주문 하나로 거의 다 먹는다. 실제로 이것과 봇 쓰기가 겹쳐 **7월분 $47 이 청구됐다**(§6). 5초면 같은 주문이 월 930만 행이 되어 봇(600만)과 합쳐도 3배 여유가 남고, 가격이 조건 아래에 머무는 시간은 보통 분 단위라 DCA 체감은 거의 같다.
    **⚠ 판정은 저장값이 아니라 `effectiveCooldownMs(c.cooldown_ms)` 로 한다** — 하한 도입 전에 만들어진 주문들이 DB 에 `cooldown_ms=0` 으로 남아 있어서, 생성 시 검증만 고치면 그 주문들은 계속 1초 간격으로 돌아 예산을 태운다. `order.ts` 는 저장값도 하한으로 올려(UI 표시와 실제 동작이 어긋나지 않게) 이중으로 막는다.
    **⚠ 그래도 스스로 멈추지는 않는다** — 브레이크는 `cooldown_ms`(≥5초)와 `max_fills`(최대 실행 횟수)뿐이고, `max_fills` 를 안 걸면 조건이 참인 동안 잔고가 바닥날 때까지 진입한다(그 뒤엔 가용 부족으로 체결 0 → 강제청산). 이건 버그가 아니라 선택된 동작이므로 UI 에 경고 문구를 붙였다. 특히 **트리거가 현재가에서 아주 먼 값이면 조건이 영구히 참**이라(예: OX 시세 1.0 에 "1.8 이하 매수") 사실상 무한 매수기가 된다.
    **⚠ 이 사이트에서 유일하게 "스스로 무한히 D1 쓰기를 만드는" 유저 경로**라, `settleConditionalOrder` 는 체결 전에 `autoWritesBlocked(env)`(§6, `_budget.ts`)를 물어보고 이번 달 예산을 넘겼으면 조용히 물러난다. 1회성 조건부는 총량이 유한해서 막지 않는다(막으면 걸어둔 스탑이 안 걸리는 게 더 큰 사고다).
  - **`rearm`** — 한 번 실행되면 `armed=0` 이 되고, 가격이 **트리거 반대편**(`rearm_price`, 미설정이면 `trigger_price`)으로 돌아왔을 때만 `armed=1` 로 복구된다(below 면 `mark >= rearm`, above 면 `mark <= rearm`) → "내려갈 때마다 한 번씩". `settleConditionalOrder` 는 재무장 대기 중이면 **재무장 판정만 하고 즉시 return**(그 폴링에선 절대 체결 안 함)한다. `rearm_price` 는 방향 검증을 받는다(below 는 `rearm >= trigger`, above 는 `rearm <= trigger` — 반대편이 아니면 재무장이 성립하지 않는다).
  - `max_fills`(1~100,000, NULL=무제한)에 도달하면 그 체결 batch 안에서 주문을 **삭제**한다. `fill_count` 는 표시용 겸 상한 판정용.
  - 체결 후 행 처리는 OX/실제코인 양쪽이 `conditionalAfterFillStmt()` 하나를 공유한다(1회성=잔량 차감/삭제, 무한=횟수+1·`continuous` 는 무장 유지·`rearm` 은 armed=0·상한 도달 시 삭제). OX 는 `filled > EPS` 일 때만 부르고(유동성 부족으로 0 체결이면 상태 그대로 유지 → 다음 폴링 재시도), 실제 코인은 잔고 차감 가드를 통과한 뒤 같은 batch 에 얹는다.
  - **⚠ `useTriggerPoll` 은 항상 2.5초다(적응형 폐기, 2026-08-01)** — 예전엔 `continuous` 무한 조건부가 하나라도 있으면 폴링을 2.5초 → 1초로 당겼다(그 모드가 "폴링마다 1회"라 폴링 주기가 곧 매수 간격이었다). 지금은 그 모드에 **재실행 간격 하한 5초**가 있어 2.5초 폴링으로 하한을 충분히 따라잡으므로 분기를 없앴다. 폴링을 더 당기려면 §6 D1 예산을 먼저 계산할 것.
  - **⚠ 반복 실행은 앱을 닫아둬도 계속된다(2026-07-29부터)** — cron 워커가 매 1분 `sweepTriggers` 로 전 유저를 훑기 때문(아래 §"접속 여부와 무관하게 매 1분 자동 실행"). 예전엔 `checkTriggers`(유저 요청 시점)만이 클럭이라 앱을 닫으면 반복이 멈췄다. 대신 **주기가 달라진다**: 접속 중 ~1초마다 / 접속 없으면 1분마다 4회 몰아서 → `cooldown_ms`/`max_fills` 를 안 걸었으면 **앱을 끄고 자는 동안에도 잔고가 계속 나간다**(브레이크는 여전히 그 둘뿐).
  - **⚠ 신규 컬럼은 마이그레이션 전 DB 에서 `undefined` 로 온다** — 읽는 쪽은 전부 `?? 기본값`(`repeatModeOf()` 포함)으로 방어하지만 `conditionalOpen` 의 INSERT 는 컬럼이 없으면 실패하므로 **코드 배포 전에 ALTER 를 먼저 적용**할 것(§5).
  - UI: `OrderPanel` 조건부 탭의 "무한 반복" 체크박스(켜면 반복 방식 토글 + `continuous` 는 재실행 간격(초) / `rearm` 은 재무장 가격 + 최대 실행 횟수, 그리고 모드별 동작·위험 설명), `PositionsPanel` 조건부 탭의 "반복" 컬럼(`계속 ∞`/`되돌아올 때 ∞`, 실행 횟수·간격·무장 상태), `Chart` 주문선 라벨 `조건부∞`(재무장 대기면 재무장 가격에 흐린 점선을 하나 더 그려 "왜 지금은 안 걸리는지"를 보여준다).
- **⚠ 조건부 주문 수정(`editConditional`, 2026-07-28)**: 트리거가·수량·조건(이상/이하)·레버리지 + 반복 설정(방식/간격/재무장가/최대횟수)을 취소 없이 바꾼다. **`editLimit` 과 달리 잔고 정산이 전혀 없다** — 조건부는 증거금을 미리 잠그지 않으므로 단순 UPDATE 한 방이면 된다(그래서 "잔고 차감 먼저 확정" 같은 순서 함정도 없다). 안 보낸 필드는 기존 값 유지, `null`/`''` 로 보내면 해제(`parseRepeatOpts(body, …, prev)` 가 `undefined`=유지 / `null`=해제를 구분). 검증은 `conditionalOpen` 과 같은 함수를 공유하고, `max_fills` 는 **이미 실행한 횟수보다 커야** 한다(작게 넣으면 저장 즉시 사라지는 주문이 된다). 수정 후 **`armed=1` 로 되살리고** `checkTriggers` 를 한 번 돌린다 — 재무장 대기 중에 조건을 고쳤는데 계속 잠들어 있으면 "수정했는데 안 걸린다"가 되고, 새 조건을 이미 만족하면 거래소처럼 즉시 체결돼야 한다. UI 는 `PositionsPanel` 조건부 탭의 "수정" 버튼(인라인 편집: ≥/≤ 토글·트리거가·수량·반복 설정).
- **강제청산(계좌 파산)**: `checkTriggers` 맨 앞에서 평가자산(위 정의: `balance + Σ(margin + 미실현손익)`)이 0 미만이면 **전 포지션 강제청산 + 미체결 지정가 전부 취소 + 잔고 0 으로 리셋**, 각 포지션은 `kind='liquidation'` 주문으로 기록(청산가=그 시점 서버 시세). 심볼 가격을 하나라도 못 받아온 라운드는 건너뜀(불완전한 데이터로 오청산 방지, 다음 폴링에 재평가). 트리거되면 그 라운드의 지정가/SL·TP 평가는 스킵(이미 다 정리됐으므로).
- **청산가 표시(추정치)**: `PositionsPanel`/`Chart` 가 클라에서 `entry - (balance + Σ전체margin + 다른 포지션들 미실현손익) / (size*dir)` 로 "이 포지션 가격이 얼마가 되면 계좌가 파산하는지" 를 계산해 보여준다 — 위 강제청산 조건과 동일한 식(증거금 항 포함)이지만 어디까지나 클라 추정(실제 체결은 서버가 다음 폴링에서 판단).
- **⚠ markPrices(청산가 즉시·일관 표시)**: 청산가/평가자산은 보유 심볼의 **현재가**가 있어야 계산되는데, 예전엔 클라가 그 값을 (a)차트 WS(현재 심볼만) (b)`useMarkPrices` 바이낸스 폴링(가상심볼 제외)으로만 채워서, **OX 를 안 보고 있으면 OX 포지션 현재가가 안 들어와 전 포지션 청산가가 통째로 안 나오고**, 진입 직후엔 폴링 전까지 청산가가 비어 있었다. 수정: `checkTriggers` 가 자기가 fetch 한 시세 맵을 반환하고, `loadState(env,uid,marks)` 가 이를 `markPrices` 로 응답에 실어보내면 클라 `useTradingStore.apply` 가 `useMarketStore.prices` 에 시드한다 → 서버 강제청산과 **똑같은 시세**로, 폴링을 기다리지 않고 즉시 계산(OX 미열람·진입 직후 포함). `open` 은 방금 체결가를, `close` 는 청산가를 marks 에 추가해 새 심볼도 바로 반영.
- **리필(`functions/api/refill.ts`)**: 강제청산으로 자산이 0이 됐을 때를 위한 안전망. **평가자산(잔고+전 포지션 미실현손익 합)이 0 이하일 때만 지급** — 포지션이 있으면 서버가 그 심볼들 시세를 fetch 해 판정(가격 하나라도 못 받아오면 거부, 오판정 방지). 자산이 남아있으면 거부. 통과하면 `users.refill_count`/`refill_date`(KST 날짜)로 **1일 최대 3회, 1회 +10,000 USDT**. 날짜가 바뀌면 `refill_date !== 오늘` 이라 카운트를 0으로 취급(별도 리셋 cron 불필요 — `checkTriggers` 와 같은 "폴링 시점에 계산" 패턴). `loadState` 가 `refillsLeft` 를 계산해 응답에 포함. `Header.tsx` 도 동일한 식으로 클라 추정해 버튼을 미리 비활성화(실제 판정은 서버).
- **체결 체크 = 접속 폴링(빠른 경로) + cron sweep(접속 무관, 느린 경로)**: Cloudflare Pages Functions 는 정기 실행을 지원하지 않는다. 그래서 `functions/_trading.ts checkTriggers(env,uid)` 를 `state.ts`(GET, 클라가 `useTriggerPoll` 로 1~2.5초마다 호출)와 `order.ts`(POST 액션 진입 직후, 수동 조작과의 레이스 방지)에서 호출해 **그 유저의 요청이 들어올 때** 강제청산/지정가/SL·TP/조건부를 평가·체결한다(체결가는 지정가/SL/TP 값 그대로, 슬리피지 모델링 없음). 그리고 **아무도 접속하지 않아도** 같은 평가가 돌도록 `cron/` 워커가 매 1분 `sweepTriggers(env)` 로 전 유저를 훑는다(아래) → **주기만 다르고 기능 차이는 없다**.
- **⚠ 접속 여부와 무관하게 매 1분 자동 실행 = `sweepTriggers`(2026-07-29, 예전엔 강제청산만)**: `cron/`(별도 배포되는 작은 Worker, Pages 는 Cron Trigger 미지원이라 분리) 가 매 1분 `sweepTriggers(env)`(`functions/_trading.ts`) 를 호출해 **포지션·미체결·조건부가 있는 전 유저**를 훑어 강제청산·지정가·SL/TP·조건부(무한 반복 포함)를 전부 평가·체결한다. 같은 D1 을 바인딩하므로 별도 동기화 불필요. 배포·시크릿 설정은 §5 참고(⚠ cron 워커는 수동 재배포).
  - **예전엔 이 sweep 이 `sweepForcedLiquidations`(강제청산만)** 이라, 무한 조건부를 걸어둬도 **앱(차트 화면)을 닫으면 반복 매수가 멈췄다**("차트 켜놨을 때만 조건부가 작동함" 제보). 근본 원인은 조건부/지정가/SL·TP 평가가 `checkTriggers` 안에만 있어서 = **유저 요청이 유일한 클럭**이었던 것. 수정: 평가 본체를 `runTriggers(env,uid,pendings,positions,conditionals,prices)` 로 추출해 `checkTriggers`(1인분)와 `sweepTriggers`(전 유저)가 **공유**한다 → 새 트리거 기능을 추가해도 자동으로 양쪽에서 돈다(한쪽에만 추가되는 실수 방지).
  - **⚠ 마켓메이커 틱 예산은 총량 고정, 코인들이 나눠 쓴다**(`cron/index.ts` `MM_TICK_BUDGET`=24, `MM_BUDGET_PER_PAIR = MM_TICK_BUDGET / VIRTUAL_PAIRS.length`): 현재 2코인 × 12틱. **⚠ 이 값을 정하는 기준이 바뀌었다(2026-08-14)** — 예전엔 틱 하나가 D1 왕복 ~14쿼리라 쿼리 한도가 상한을 정했지만, 지금은 틱이 순수 계산이고 커밋이 페어당 1회라 **틱 수가 쿼리 수도 쓰기도 거의 안 늘린다**(§ spot.ts runBotTicks). 이제 상한을 정하는 건 **CPU(무료 10ms/invocation)** 다 — 실측 24틱 ≈ 3.5ms. 코인을 늘릴 때도 총량을 그대로 두면 코인당 틱만 줄어(움직임이 성겨짐) 비용은 불변이다.
  - **⚠ 유저가 보고 있으면 cron 은 물러난다**(`marketMakerTickBudget`, `POLL_ACTIVE_MS`=20s, `BURST_MIN_TICKS`=4): `/api/spot` 폴링(1초)이 이미 초당 한 번씩 재호가를 돌리는데 cron 이 12틱을 더 얹는 건 순수 중복이라, 쓰기만 배로 나가고 차트가 더 살아나지도 않는다. `last_run` 이 방금 전이면 폴링이 클럭 역할 중이라는 뜻이므로 최소치만 돌린다(cron 이 직접 찍은 `last_run` 은 다음 실행 때 60초 전이라 두 경우가 안 섞인다).
    **⚠⚠ 이 판정은 라운드 루프 밖에서 실행당 한 번만 한다** — `runMarketMakerBurst` 는 끝날 때 `last_run` 을 찍으므로, 안에서 라운드마다 판정하면 **다음 라운드가 직전 라운드의 자기 발자국을 보고 "누가 폴링 중"이라 오판**해 아무도 없는데도 cron 이 스스로 물러난다(실측: 분당 12틱이어야 할 것이 4틱). 라운드 간격이 밀리초라 시각만으로는 cron 자신과 유저 폴링을 구분할 수 없다.
  - **⚠ 트리거는 "현재가 한 점"이 아니라 "지나온 가격 범위"로 판정한다**(`_trading.ts` `PriceRanges`/`rangeOfPath`, 2026-08-14): OX 가격은 벽시계가 아니라 **봇 틱이 돌 때만** 움직이는데 cron 은 1분치 틱을 한 번에 몰아 돌린다 — 끝난 뒤 현재가 한 점만 보면 그 사이 지나간 딥/스파이크를 통째로 놓친다(예: "1.0 이하로 내려가면 매수"인데 8번째 틱에서만 1.0 을 찍고 되돌아온 경우). 예전엔 이걸 "sweep 을 4라운드 반복"으로 때웠으나 sweep 한 번이 D1 쿼리 ~18개라 무료 한도(50)를 넘겼다. 지금은 버스트가 돌려준 경로의 **최저/최고**로 한 번에 판정한다 — 실제 거래소가 구간 고가/저가로 스탑을 판정하는 방식과 같고, 4점 샘플링보다 오히려 정확하다. 적용 대상은 조건부(발동·재무장)·SL/TP·지정가 크로스이고, **강제청산만은 현재가로 본다**(스쳐간 저가로 계좌를 파산시키면 되돌릴 수 없다).
  - **⚠ 한 invocation 에서 훑는 유저 수 상한 `MAX_SWEEP_USERS`(8)**: 유저가 늘어도 invocation 쿼리 수가 늘지 않게 분 단위로 회전하며 나눠 훑는다(무료 한도 50 방어). 접속 중인 유저는 자기 폴링(2.5초)이 즉시 처리하므로 늦어지는 건 앱을 닫아둔 유저뿐이고, 그마저 몇 분 안에 차례가 온다. 현재 대상 유저는 4명이라 회전이 아예 일어나지 않는다.
  - **⚠ 실제 코인 시세는 한 cron 안에서 재사용, OX 는 매 라운드 새로 읽는다**(`sweepTriggers(env, cachedPrices?)` → 반환한 `prices` 를 다음 라운드에 넘김): 실제 코인은 외부 거래소 fetch(비싸고 라운드마다 거의 같은 값), OX 는 `spot_bot_state.ref_price`(D1 read, 라운드마다 실제로 바뀜).
  - **체감 주기**: 접속 중이면 폴링(2.5초) / 접속을 끊으면 1분마다 1회. 단 `continuous` 무한 조건부의 실제 실행 간격은 **재실행 간격 하한 5초**가 상한을 잡으므로 접속 중엔 분당 최대 12회, 앱을 닫으면 분당 1회다. 더 촘촘하게 하려면 cron 주기(1분이 Cloudflare 최소)를 줄여야 하는데 그게 최소값이고, **D1 쓰기가 계속 나가는 기능**이라 §6 예산을 먼저 계산할 것.
  - 한 유저의 평가가 예외로 터져도 나머지 유저는 계속 평가한다(try/catch + `console.error`, 다음 라운드/다음 cron 에서 재시도).
  - 로컬 검증(`cd cron && npx wrangler dev` → `curl .../cdn-cgi/handler/scheduled`, **유저 요청 0회**): OX 무한 `continuous` 가 4라운드에 정확히 4회 체결(fill_count=4, 무장 유지), `cooldown_ms`=60s 는 1회로 제한, 1회성 조건부(실제 코인 BTCUSDT)는 체결 후 행 삭제, 실제 코인 지정가 pending 체결, SL 히트로 포지션 청산까지 전부 확인.
- **⚠ 거래 수수료 + VIP 등급(2026-07-20)**: 모든 체결에 `수수료 = 명목금액(체결가×수량) × VIP 요율` 이 붙는다.
  - **등급 = 누적 거래대금(`users.total_volume`)** 으로 결정. 증거금이 아니라 **명목금액(레버리지 포함)** 이라 고배율일수록 빨리 오른다. 진입·청산 각각 그 체결의 명목금액만큼 누적.
  - **⚠⚠ 등급은 표가 아니라 공식이고 상한이 없다(2026-08-09, 무한 레벨)**: 예전엔 `VIP_TIERS` 13행 상수표(VIP0~12, 1단계당 100배)였다 — (a)VIP12 에서 끝나 그 위로는 아무리 거래해도 변화가 없고 (b)한 칸이 100배라 RPG 로 치면 "레벨이 12개뿐이고 다음 레벨까지 경험치 100배"였다. 지금은 등비수열 두 개로 무한히 이어진다(`_shared.ts`):
    ```
    등급 t 진입 거래대금 = VIP_BASE_VOLUME(1만) × VIP_VOLUME_GROWTH(4)^(t-1)   (t>=1, VIP0=0)
    등급 t 수수료율      = max(VIP_MIN_RATE(1e-9), VIP_BASE_RATE(0.0003) × VIP_RATE_DECAY(0.79)^t)
    ```
    | 등급 | 누적 거래대금(USDT) | 요율 |
    | --- | --- | --- |
    | VIP0 | 0 | 0.03% |
    | VIP1 | 1만 | 0.0237% |
    | VIP5 | 256만 | 0.00923% |
    | VIP10 | 26억 | 0.00284% |
    | VIP20 | 2.7경 | 0.000269% |
    | VIP30 | 2.9해 | 0.0000255% |
    | VIP40 | 3.0자 | 0.0000024% |
    | VIP54+ | 8.1e35 | 0.0000001%(하한) |
    - **밸런스 근거**: ①거래대금 **4배/등급** — 첫 등급이 1만 USDT 라 몇 번만 거래해도 VIP1 이 뜨고(초반 보상), 이후로도 "조금만 더 하면 오른다"가 유지된다. 거래대금은 명목금액이라 고배율 유저는 한 판에 몇 등급씩 뛴다 → 100배가 아니라 4배로 촘촘히 썰어야 레벨업이 자주 일어난다. 현재 최상위 유저(~1e24)가 VIP34 근처. ②요율 **×0.79/등급** — **옛 13행 표를 그대로 근사한 값**이다(1e12→옛 0.001%/새 0.00111%, 1e20→옛 0.00005%/새 0.0000517%, 1e24→옛 0.00001%/새 0.00000992%). 즉 **등급 숫자만 촘촘해지고 실제 경제(이만큼 거래하면 수수료가 이 정도)는 그대로**다. 5등급이면 대략 반토막. ③하한 **0.0000001%** — 0 으로 두면 상위 등급 거래가 거래소 수익에 전혀 안 잡힌다(랭킹 수수료 수익 표시가 멈춤).
    - ⚠ 표시 자릿수 **`format.ts fmtFeeRate`(소수 8자리)** 는 이 하한에 맞춰져 있다(6자리였을 땐 0.0000001% 가 "0" 으로 뭉개졌다). 하한을 더 내리면 그쪽도 같이 늘릴 것.
    - ⚠ **로그로 구한 등급은 기준선에 정확히 걸친 값에서 한 칸 어긋난다**(1e4·4^k 를 넣어도 지수가 k−1e-16 으로 나옴) — `vipOf` 는 계산 뒤 실제 기준선(`vipMinVolume`)과 대조해 양방향으로 보정한다. 검증: 1~45 등급 기준선에서 정확히 그 등급 / 기준선 직전 값은 한 등급 아래.
    - ⚠ **등급표를 통째로 클라에 내려보낼 수 없다**(무한). `loadState` 는 `vipTierWindow(tier)`(현재 등급 −2 ~ +6)만 보내고, 진행률에 필요한 현재 구간 하한은 **`vipFrom` 으로 따로** 보낸다 — 예전처럼 클라가 표에서 `find(t => t.tier === tier)` 로 찾으면 창을 벗어나는 순간 조용히 0 이 되어 진행률이 100% 로 굳는다. 곡선 파라미터(`vipCurve`)도 함께 보내 모달 설명 문구("한 등급당 ×4 / ×0.79")를 하드코딩하지 않는다.
    - ⚠ `VipBadge` 배색은 13단계뿐이라 **`STYLE_SPAN`(3)등급마다 한 칸씩** 올라가고 끝에서 고정된다(3인 이유: 새 곡선 3등급 ≈ 옛 곡선 1등급이라 같은 거래대금이면 예전과 거의 같은 색).
  - **등급은 컬럼으로 저장하지 않는다** — `_shared.ts vipOf(totalVolume)` 가 항상 파생한다(총거래량 하나만 진실원본이라 등급이 어긋날 여지가 없음). `loadState` 가 `vipTier/feeRate/vipNextAt/vipFrom/vipTiers/vipCurve/totalVolume/totalFees` 를 응답에 실어 보낸다.
  - **⚠ 진입은 증거금과 "함께" 차감해야 한다**: 조건부 UPDATE 가드가 `balance - (margin + fee) >= -uPnL` 이어야 원자성이 유지된다. 따로 빼면 증거금은 통과하고 수수료만 실패하는 틈이 생긴다. 청산은 환급액에서 차감(`margin + pnl - fee`). 지정가는 **주문 시점이 아니라 체결 시점**에 뗀다(거래소 관행 — 증거금은 주문 시 이미 잠갔으므로 체결 때 수수료만 차감).
  - **⚠ 강제청산은 수수료를 걷지 않는다** — 직후 잔고를 0 으로 리셋하므로 실제로 걷을 수 없는 돈이다(부과하면 원장에 걷지도 못한 수익이 잡힌다). 대신 거래대금은 누적하고 `fee=0` 인 `kind='liquidation'` 원장 행을 남겨 "강제청산으로 얼마가 돌았는지"도 집계된다.
  - **⚠ OX 호가창 walking 경로**(청크 체결)는 청크마다 잔고만 정산하고 **부기(카운터+원장)는 합계로 1번만** 부른다(원장이 청크 수만큼 불어나지 않게). 요율은 주문 하나당 한 번만 확정 — 청크마다 다시 읽으면 체결 도중 등급이 올라 청크별 요율이 달라진다. 시장가의 "감당 가능한 만큼만" 역산도 **1코인당 비용에 수수료를 포함**해야 한다(`price/leverage + price*rate`) — 빼먹으면 딱 가용만큼 사려다 가드에 걸려 체결이 멈춘다.
  - **수익 원장 = `fee_ledger`**(체결 1건당 1행: user/symbol/kind/notional/rate/fee/created_at). 심볼별·기간별·종류별 분해가 필요할 때 쓰는 진실원본.
  - **⚠ 거래소 수수료 수익 총액은 `users` 를 집계한다(원장 아님)**: `GET /api/leaderboard` 가 `revenue{total,fromUsers,fromBots,volume}` 를 함께 내려주고 랭킹 모달 상단에 표시한다. 값은 `SUM(users.total_fees)` — **`fee_ledger` 를 SUM 하면 정확하지만 그 테이블은 체결 1건당 1행이라 봇 때문에 빠르게 수백만 행이 된다**(랭킹은 5초 폴링이라 매번 전체 스캔할 수 없다). `feeAccrualStmts` 가 원장과 `users.total_fees` 를 같은 batch 에서 함께 갱신하므로 두 값은 항상 일치한다(prod·로컬에서 검증). 봇이 물량 대부분을 만들어 수수료도 대부분 봇에서 나오므로 유저분/봇분을 분리해 보여준다.
  - **⚠ 클라 슬라이더도 수수료를 넣고 역산**: 서버 가드가 `증거금+수수료 <= 가용` 이므로 `명목가 = 가용 / (1/leverage + feeRate)`. 빼먹으면 200배에서 수수료가 증거금의 ~6% 라 기존 0.1% 여유로는 못 덮어 **슬라이더 100% 가 그대로 거부된다**.
  - UI: `VipBadge.tsx`(헤더 이름 옆·모바일 더보기·랭킹 각 행) + **`VipModal.tsx` 진행도 모달**(뱃지 클릭 → 다음 등급까지 진행 막대·%·남은 거래대금·누적 거래대금/낸 수수료·현재 등급 주변 등급표 + "계속 이어집니다(상한 없음)" 행). 모바일 더보기엔 미니 진행 막대. `OrderPanel` 정보란에 예상 수수료 + 현재 등급/요율. **⚠ 등급 기준은 서버가 `loadState`(vipTiers/vipFrom/vipCurve)로 내려준 값을 그대로 쓴다** — 클라에 같은 공식을 또 적으면 서버 기준이 바뀔 때 조용히 어긋나고, 수수료는 서버가 떼므로 화면만 틀리게 된다. 진행률 = `(누적 − vipFrom) / (vipNextAt − vipFrom)`.
  - **⚠ 큰 금액 표시는 `fmtKor`(만/억/조) 이고 반올림이 아니라 내림** — 등급 기준이 억/조 단위라 K/M/B 보다 직관적이고, 999,999 를 "100만" 으로 올려 보여주면 기준선을 넘은 것처럼 읽혀("100만인데 왜 아직 VIP0?") 혼란스럽다.
- **아직 없음**: 펀딩비.

### 가상 코인 — OX/USDT · EW/USDT (서버 = `functions/api/order.ts` + `functions/api/spot.ts`) — 실제 코인과 동일한 레버리지, 체결가만 봇이 생성

> **⚠ 가상 코인은 2종이고 전부 페어 파라미터로 흐른다(2026-07-31).** 아래 설명이 "OX" 라고 적혀 있어도
> 전부 페어별로 독립 동작한다(봇 심리상태·호가 사다리·캔들·체결 테이프·재고가 모두 pair 키). **새 가상
> 코인을 추가할 때 손댈 곳은 딱 셋** — `functions/api/spot.ts VIRTUAL_PAIRS`, `src/symbols.ts
> VIRTUAL_SYMBOLS`, D1 `spot_bot_state` 시작가 행(§5). 그 외에 심볼을 하드코딩하면 그 경로만 OX 전용이
> 되어 조용히 갈라지므로 절대 금지. EW/USDT 는 2026-07-31 에 시작가 1 USDT 로 개설했다.
> ⚠ 코인을 늘릴 때 **cron 틱 예산(`MM_TICK_BUDGET`)을 코인 수만큼 곱하지 말 것** — invocation당 D1
> 쿼리 한도(1,000)에 부딪힌다(§ cron). 현재 24틱을 2코인이 12틱씩 나눠 쓴다.

**OX 는 다른 38종과 완전히 동일하게 레버리지 롱/숏으로 거래된다** — `OrderPanel`/`PositionsPanel`/
`order.ts` 어디에도 OX 전용 분기가 없다(가상 전용 매칭·에스크로·보유 OX 개념은 전부 제거됨, 예전엔
있었으나 "실제 코인과 다르게 할 이유가 없다"는 판단으로 통합). **유일한 차이는 체결가 소스**: 실제
코인은 OKX/Coinbase, OX 는 `spot.ts` 의 봇이 만드는 내부가격(`fetchPrice` 의 `isVirtualSymbol` 분기).

- **체결가 = 봇("AI") 이 만든 합성 시세**: `functions/api/spot.ts` 의 예약된 봇 유저 2명(`bot-mm-1`/
  `bot-mm-2`, `BOT_USER_IDS`, schema.sql 에서 시딩, 랭킹에서 제외) 중 한 명이 폴링 틱마다 기준가를
  아래 심리 모델로 옮기고(`spot_bot_state`) 그 주변에 매수/매도 호가 사다리(레벨 8, 물량
  2000~10000)를 깐다. 이 기준가를 실제 코인의 OKX 시세 대신 그대로 체결가로 쓴다 — LLM 호출이 아니라
  결정론적 알고리즘.
- **⚠ 봇 매매 심리 모델(`nextMarketState`, 2026-07-20)**: 예전 기준가는
  `ref * (1 + (rand-0.5)*0.012)` 짜리 **IID 랜덤워크** 하나였다 — 매 틱이 직전과 완전히 독립이라 추세도
  변동성 뭉침도 과열도 공포도 없는 무특징 노이즈였고, 차트에 읽을 구조가 없어 분석도 재미도 성립하지
  않았다("사람 심리가 안 들어간 매매라 노잼"). 지금은 실제 시장의 정형화된 사실(stylized facts)을 작은
  상태기계로 재현한다. 상태(`drift`/`vol`/`sentiment`/`anchor`/`regime`/`regime_ticks`/`peak`/`trough`)는
  **`spot_bot_state` 행에 얹혀 틱 사이에 지속**되므로 추가 DB 왕복이 없다(어차피 읽고 쓰던 행 — 컬럼이
  몇 개든 UPDATE 는 1행이라 **쓰기 비용도 그대로 0 증가**다, §6):
  - **추세 지속** — 수익률이 AR(1) 자기상관(`drift = drift*0.86 + noise`) → 한 번 잡힌 방향이 여러 틱 이어짐
  - **변동성 클러스터링** — `vol` 이 AR(1) + 2% 확률의 "뉴스" 충격 → 잔잔한 구간과 거친 구간이 뭉침
  - **과열 후 평균회귀** — 적정가(`anchor`) 대비 괴리(`stretch`)가 커질수록 되돌림이 **제곱으로** 강해짐
  - **탐욕-공포 국면**(`REGIME_PARAMS`) — `calm→rally→euphoria→panic→capitulation→…` 전이. **비대칭**:
    `panic` 이 `euphoria` 보다 bias·변동성·거래량이 모두 크다(떨어질 땐 빠르고 거칠게). 각 국면은
    `minTicks` 만큼 최소 지속돼 1틱만에 튕기지 않는다. 실측 점유율 ≈ calm 50 / rally 26 / pullback 16 /
    panic 5 / euphoria 3 / capitulation 0.04%
  - **라운드넘버 자석**(50틱 간격 근처에서 머뭇거림), **팻테일**(3% 확률로 수익률 2~4배), 그리고
    **거래량·체결 방향(taker buy 비율)·호가 스프레드가 국면에 함께 반응**(패닉엔 거래량 폭증 + 스프레드
    확대 = 마켓메이커 후퇴) — 한 틱의 체결들도 직전 기준가에서 새 기준가로 "걸어가며" 찍어 봉마다
    시가/고가/저가/종가와 꼬리가 제대로 생긴다(예전엔 전부 같은 가격이라 꼬리 없는 몸통뿐이었다).
  - **⚠ 탐욕/공포 심화(2026-08-12)**: 위 항목들은 **가격의 통계적 성질**이지 사람의 행동이 아니었다 —
    군중 심리(`sentiment`)가 사실상 최근 수익률의 즉석 함수라 "쌓였다 꺼지는 무드"가 아니었고, 시장이
    **자기 고점/저점을 기억하지 않아** 저항 돌파·지지 붕괴 같은 사람이 읽는 사건이 아예 없었다. 그래서:
    - **무드의 관성·군집(herding)** — `sentiment` 가 자기 자신을 되먹이되 `s(1-s²)` 라 극단에서 포화한다.
      ⚠ 실효 지속계수가 `0.90 + HERD_GAIN(0.06) = 0.96 < 1` 이라 **수학적으로 발산이 불가능**하다 —
      되먹임을 넣을 땐 이 상한을 반드시 유지할 것(1 을 넘기면 무드가 한쪽으로 굳어 시장이 멈춘다).
    - **고점/저점 기억(`peak`/`trough`)** — 새 극값이면 즉시 갱신, 아니면 현재가 쪽으로 서서히 잊힌다
      (`EXTREME_DECAY`, 반감기 ≈ 230틱). 여기서 **공포 = 고점 대비 낙폭 / 탐욕 = 저점 대비 상승폭**
      (`GAUGE_FULL`=10% 에서 100%)을 뽑아 전이 확률·변동성·거래량·호가 두께에 먹인다.
      ⚠ 이 게이지가 **포화되면(항상 ~1) 모든 게 망가진다** — 초기 튜닝에서 `GAUGE_FULL` 이 6%,
      감쇠가 느려서 평균 공포 0.86 이 나왔고, 그 결과 공포 기반 전이가 전부 최대치로 걸려 panic 점유율이
      17%(정상 5%)까지 치솟고 1분봉 폭이 5.7%(정상 2.2%)로 폭발했다. 목표는 **평균 0.3 안팎**이다.
    - **사건 2종** — 신고점 돌파 추격(FOMO)과 지지 붕괴 손절 연쇄(cascade). **연쇄가 1.5배 크고 더 자주**
      터진다(계단으로 오르고 엘리베이터로 떨어진다). 그 방향으로 이미 쏠려 있을 때만 발동해 평상시엔
      아무 일도 안 일어난다.
    - **투매(`capitulation`) 국면** — 공포가 극단(>0.9)이고 무드가 -0.7 아래인 `panic` 에서만 열리는
      마지막 단계. bias -1.1%/틱·거래량 5.5배로 짧고 격렬하게 쏟아진 뒤 3~4틱 만에 소진돼 반등한다
      (V 바닥). 실측 하루 2~3회 — **가끔 나와야 사건이 된다**(초기 튜닝에선 하루 200회가 나왔다).
    - **레버리지 효과** — 떨어질 때가 오를 때보다 시끄럽다(공포 게이지로 이번 틱 변동성만 증폭).
      ⚠ 증폭분을 상태에 **저장하면 안 된다** — AR(1) 에 곱해져 공포가 이어지는 동안 기하급수로 커진다.
    - **버블 피로** — `euphoria` 는 오래 끌수록·적정가에서 벌어질수록 붕괴 확률이 커진다(예전엔 고정
      34% 라 "고점일수록 위험하다"는 감각이 없었다).
    - **호가 깊이의 비대칭** — 공포장엔 매수벽이 걷히고 매도벽이 쌓인다(반대로 광기엔 매도호가가
      사라진다). 실측 공포 구간 매수/매도 두께비 **0.5**, 광기 구간 **5.1** — 심리가 가격뿐 아니라
      **유동성**으로 드러나므로 같은 크기 시장가라도 패닉 때 훨씬 깊게 파고든다(대량 주문은 여전히
      `synthMaker` 의 3% 시장충격 상한이 막는다).
    - 실측 비대칭: 수익률 왜도 **-1.5**, 급락(-0.5%↓) 4.1% vs 급등(+0.5%↑) 3.2%.
  - **⚠ 장기 안정성 — 파라미터를 바꿨으면 `npm run sim:bot` 을 반드시 돌릴 것**(`scripts/sim-bot.ts`,
    모델이 DB 접근 없는 순수 함수라 5~20일치를 몇 초에 굴린다. `SIM_DAYS`/`SIM_RUNS` 로 조절):
    `REGIME_PARAMS.bias` 는 국면 점유율로 가중하면 합이 ~0 이 되게 맞춰져 있고, 그 위에 `anchor` 를
    기준선(`BOT_BASE_PRICE=1`)으로 아주 약하게 당기는 힘(반감기 ~14h)을 얹었다. 둘 중 하나라도 빠지면
    며칠 만에 가격이 0 으로 붕괴하거나 발산한다(초기 튜닝에서 5일 -40%, 이번 확장 중에도 5일 -73% 와
    +730% 를 각각 실측했다). ⚠ **평형은 놀랄 만큼 민감하다** — 틱당 편향 `2.8e-5`(rally bias 를
    0.0010→0.0009 만큼) 차이가 5일 뒤 가격 2.4배로 나타난다. 검증 기준: 5~20일치에서 가격이 시작가의
    0.5~2배 안, 수익률 lag1 자기상관 ~0.27(추세), |수익률| lag1 자기상관 ~0.30(변동성 뭉침), 1분봉 평균
    고저폭 ~2.2%, 국면 점유율이 위 표와 비슷할 것. 실측(20일×4회): 종가 0.90~1.23, MDD -60%.
  - **⚠ 가격 하한(2026-07-24)**: `nextMarketState` 의 기준가 클램프는 `clamp(s.ref*(1+ret), 0.0001, 1e6)`
    이다. 예전엔 하한이 **0.02** 라 "가격이 0.02 밑으로 안 내려가는" 버그가 있었다(유저가 아무리 팔아도
    0.02 에서 막힘) → 4자리 틱 최소값 0.0001 로 낮췄다. 유저 체결이 anchor 를 끌어당기고(위 `ANCHOR_TRADE_PULL`)
    `BOT_BASE_PULL` 이 1 로 tether 하므로 실사용에선 0.02 밑까지 잘 안 가지만, 이제 갈 수는 있다.
- **⚠ DB I/O 최소화(runMarketMaker 재작성, 2026-07-18)**: 예전엔 한 틱에 봇 호가 16개를 "개별 batch 로
  취소"(16 왕복)하고 다시 16개를 "개별 `placeBotOrder`"(각각 매칭 SELECT 2회+쓰기 = 32 왕복)로 깔아 한
  틱에 수십~100+ 문장/수십 왕복이 나갔다. 지금은 **(취소 1문 + 사다리 16문 + 합성체결 1문 + 기준가 1문)을
  단 하나의 `DB.batch`(왕복 1회)** 로 처리하고, 재호가 게이트(현재 `BOT_TICK_MIN/MAX_MS`=0.45~0.95초, 체결
  딜레이 감소용으로 예전 3~8초에서 단축)를 통과하지 못한 폴링은 **state read
  1회로 즉시 반환**한다(동시 폴링은 조건부 upsert 로 이 틱을 원자 선점 → 중복 requote 방지). `matchBuy`/
  `matchSell`/`placeBotOrder`/**호가 에스크로**(주문 걸 때 잠그고 취소 때 환불)는 전부 제거했다 — 봇은
  무한 유동성 공급자라 "돈이 모자라 호가를 못 깐다"는 상태가 없어서, 틱마다 수십 번 나가던 그 왕복이
  순수 낭비였다. 유저↔봇 체결의 물량 소비만 조건부 UPDATE 로 원자 처리하면 된다.
  **⚠ 단, 체결된 뒤의 재고/현금 정산은 한다(`botFillStmts`, 2026-07-23 복원)** — 에스크로와 달리 이미
  도는 batch 에 문장 하나가 얹힐 뿐이라 왕복이 안 늘어난다. 아래 "봇 재고/현금 정산" 참고.
- **⚠⚠ 봇 호가 사다리 = `spot_bot_state.book_json` 한 칸(2026-07-31, `spot_orders` 폐기)**: 위 2026-07-18
  개편으로 **왕복**은 1회가 됐지만 **문장 수**는 그대로 44+1 이었다. 그게 두 가지를 동시에 터뜨렸다 —
  (a) 하루 172만 행을 쓰고 지워 월 rows written 포함분(5,000만)을 넘겼고 (b) **cron 1회가 D1 쿼리
  한도(invocation당 1,000)의 950 을 먹어** 가상 코인을 하나도 더 못 늘렸다(2개면 1,900 → 확정 초과).
  근본 원인은 "매 틱 통째로 교체되는 **스냅샷**을 44행짜리 테이블로 들고 있었던 것" — 이력이 아니므로
  행으로 쪼갤 이유가 없다. 지금은 사다리 전체가 `{"o":액터봇,"b":[[가격,수량]..],"a":[..]}` JSON 한 칸이고,
  **봇이 어차피 갱신하던 심리상태 UPDATE 에 컬럼 두 개가 붙을 뿐**이라 재호가 문장이 45개 → **0개**다.
  - 읽는 쪽은 전부 `parseBook`/`makerLevels`(가격 우선순위 정렬 + 지정가 크로스 필터) → 메모리 walking →
    `bookWriteStmt` 1문장. `makerLevels` 가 돌려주는 원소는 **book 안의 객체 참조**라 `level.size -= take`
    로 깎으면 그대로 직렬화된다.
  - 소비 되쓰기는 `book_version` 가드(낙관적 동시성) — 그 사이 재호가가 새 사다리를 깔았으면 0행이 되어
    **옛 사다리로 덮어쓰는 사고를 막는다**. 0행이어도 체결은 그대로 성립한다(봇은 무한 유동성이라
    "물량이 모자라 못 판다"가 없다 — 예전 `spot_orders` best-effort 소비와 같은 관용구).
  - 덤으로 `matchLimitPendingAgainstBook` 이 **청크마다 왕복하던 최대 500회 루프**(체결 하나에 D1 쿼리
    수백 개)를 시장가 경로와 같은 "스냅샷 → 메모리 walking → 단일 batch" 로 통일했다. 대신 한 방에
    체결하므로 **pending 을 조건부 UPDATE/DELETE 로 먼저 선점**(claim-first)해 유저 폴링과 cron sweep 이
    같은 주문을 두 번 체결하지 못하게 한다(예전엔 봇 호가 claim 이 그 역할을 간접적으로 했다).
  - `recordVirtualFill`(SL/TP 등 호가 walking 안 타는 정산)도 최우선호가 SELECT+UPDATE 를 50회까지
    왕복하던 걸 메모리 walking + 1문장으로 바꿨다.
  - **⚠ `spot_orders` 테이블은 이제 아무도 읽지도 쓰지도 않는다**(롤백 여지로 정의만 남김). 새 코드에서
    이 테이블을 다시 참조하지 말 것.
- **⚠ 사람처럼 "떨어지는" 호가 가격·수량(price clustering, 2026-07-20)**: 예전엔 호가를 전부
  `ref * (1 ± spread)` 로만 찍어서 **1.4067 / 1.4074 / 1.4081** 처럼 어중간한 값이 기계적으로 균일한
  간격으로 늘어섰다 — 실제 호가창은 그렇게 안 생겼다. 사람은 **1.4000 / 1.3900 같은 딱 떨어지는 가격에
  주문을 몰아 걸고, 그 자리 물량이 훨씬 크다**(심리적 지지·저항 "벽"). 수정: `humanQuotePrice()` 가
  목표가를 `PRICE_GRIDS`(0.05 / 0.01 / 0.005 / 0.001, 굵을수록 `sizeMult` 큼)로 끌어당기고 그 자리에
  물량을 몇 배로 얹는다. **매수는 내림(floor)·매도는 올림(ceil)** 으로만 스냅해 항상 mid 에서 멀어지는
  방향이라 **호가 역전이 원천적으로 불가능**하다. 얼마나 끌려갈지는 `tol`(깊은 레벨일수록 관대)로
  제한해 사다리가 뭉개지지 않게 하고, 두 레벨이 같은 가격이 되면 원래 목표가로 되돌려 호가창 단계 수를
  유지한다. **수량은 반대로 불규칙하게 둔다** — 가격과 달리 수량엔 라운드
  넘버 심리가 약해서, 실제 호가창은 2,384 개 같은 어중간한 값이 대부분이고 딱 떨어지는 수량은 가끔
  섞일 뿐이다(예전엔 전부 1,000/5,000 으로 맞춰서 그것대로 기계 같았다). `humanSize()` 는 기본은
  정수로만 다듬고 **18% 만** 떨어지는 수량으로 만든다. **체결 테이프도 65% 확률로 0.001 격자에 스냅** — 실제 시장의 체결은 "거기 걸려 있던
  호가" 가격에 일어나므로 테이프만 어중간하면 호가창과 따로 노는 시장으로 보인다. 실측: 호가의 약 79%
  가 0.001 이상 배수(0.01 배수 24%·0.005 배수 19%·0.001 배수 36%), 나머지 21% 만 어중간한 값.
  ⚠ 라운드 가격 `sizeMult` 때문에 호가창 총 유동성이 예전의 ~2배가 됐다(시장가 슬리피지가 그만큼 줄었다).
  ⚠ **격자 스냅은 반드시 오차 흡수(1e-9)와 함께** — `Math.floor(price/step)` 을 그냥 쓰면 정확히 격자
  위에 있는 값이 한 칸 밀린다(`1.45/0.0001 = 14499.999999999998` → 1.4499). 봇 호가(`humanQuotePrice`)와
  클라 호가창 묶어보기(`OrderBook.snapToGrid`) 양쪽 모두 이 함정이 있었다(§6 참고).
  ⚠ **호가 밀도는 봇 계정 수가 아니라 한 봇이 까는 단계 수로 만든다** — 호가창은 가격대별 합계만
  보여주므로 계정을 늘려도 화면상 차이가 없다. `BOT_LEVELS_PER_SIDE` 를 8→22 로 올려 촘촘하게 채웠다.
- **⚠ 호가 역전 방지 = 매 틱 페어 전체 비우고 재호가**: 봇이 2명이라 "선택된 액터의 호가만" 취소하면
  다른 봇의 오래된 호가가 남아 랜덤워크 후 역전(최우선매수 > 최우선매도)이 생긴다(예전엔 봇끼리 크로스
  매칭이 이걸 정리했지만 그 왕복을 없앴다). 그래서 한 틱마다 `DELETE FROM spot_orders WHERE pair=?`
  (두 봇 모두)로 봇 호가를 통째로 비우고 한 액터가 일관된 사다리를 다시
  깐다 — spot_orders 엔 봇 호가만 있어(유저 주문은 pending_orders) pair 전체를 지워도 유저 주문엔 영향
  없고, batch 원자성으로 호가창이 빈 순간은 노출되지 않는다. 봇끼리 체결로 테이프를 움직이던 방식 대신
  **합성 체결을 같은 batch 안에서 기록**(체결가=새 기준가 mid, 매칭 왕복 없음)해 차트/체결내역이 계속
  움직이게 한다. 호가 스프레드는 실거래소처럼 타이트하게(base ~0.12%, 깊은 레벨로 갈수록 확대) 잡아
  시장가 체결이 mid 근처에서 이뤄지되 대량 주문엔 슬리피지가 생긴다.
- **⚠⚠ 봇이 만드는 행은 "쌓이면 안 된다"(2026-07-31, DB 무한 증식 차단)**: 봇은 분당 12틱 이상 영구히
  도는 유일한 컴포넌트라, **틱당 남기는 행 하나가 곧 "하루 2만 행"** 이다. 실제로 그렇게 터졌다 —
  재호가가 옛 호가를 지우지 않고 `status='cancelled'` 로 **마킹만** 해서 prod 에 `spot_orders`
  **1,358만 행**(하루 +86만 행)이 쌓였고, 영구 보존이던 `spot_trades` 도 157만 행이 됐다. 그 결과
  **DB 3.38GB / 하루 +200MB → D1 의 DB당 한도 10GB 까지 한 달**(도달하면 D1 이 쓰기를 거부해 가상코인이
  아니라 **트레이딩 전체가 정지**한다). 지금은 (a)재호가가 `DELETE` 로 **실제로 지우고**(그 테이블은 항상
  "지금 깔린 호가 ~45행"만 들고 있는 임시 스냅샷이다 — 부분/전량 체결로 `filled` 이 된 행도 같이 청소된다)
  (b)체결 테이프는 `TRADE_RETENTION_MS`(6시간)만 보존한다(가끔 도는 틱이 잘라냄). 차트 히스토리는
  `spot_candles` 가 따로 영구 보관하므로 잃는 게 없다. **⚠ 봇 경로에 새 INSERT 를 추가할 땐 "이 행을
  누가 언제 지우는가"를 반드시 같이 정할 것** — 안 정하면 그게 다음 3GB 다.
- **⚠⚠⚠ 봇 합성 체결 테이프 = `spot_bot_state.tape_json` 링 버퍼(2026-08-01, 실제 $47 청구서를 만든 항목)**:
  위 (b)로 "쌓이지는" 않게 됐지만 **쓰고 지우는 행 자체가 과금 대상**이라는 걸 놓쳤다. 봇은 한 틱에 3~6건을
  찍으므로 **초당 ~4.5행이 영구히 INSERT** 되고 6시간 뒤 같은 수만큼 DELETE 됐다 → 실측(`wrangler d1
  insights`, 2026-08-01) **하루 96만 행 중 76만 행(79%)이 이 테이프**였다(INSERT 51만 + DELETE 25만).
  근본 원인은 §6 의 원칙 위반 — 이 테이프를 읽는 곳은 (a)호가창 "체결" 탭 최근 30건 (b)`<60s` 캔들
  버킷팅뿐이고 차트 히스토리는 `spot_candles` 가 따로 보관하므로, **이력 테이블이 아니라 최근 N건짜리 링
  버퍼**다. 사다리(`book_json`)와 똑같이 상태 행의 JSON 한 칸(`tape_json`, 최근 `TAPE_MAX`=400건,
  `[[가격,수량,1=매수테이커/0=매도,시각ms],…]`)에 담으니 **봇이 어차피 매 틱 UPDATE 하던 문장에 컬럼
  하나가 붙을 뿐**이라 테이프 쓰기 비용이 **0**이 되고, 보존기간 DELETE 도 통째로 사라졌다(링 버퍼는 넘치는
  쪽이 자동으로 잘려나가므로 "누가 언제 지우나" 문제 자체가 없다). 남는 건 **틱당 5행**(상태 1 + 캔들 3 +
  봇 수수료 카운터 1)뿐이다. prod 검증(2026-08-01 배포 직후): 합성 체결 INSERT **0건**, 테이프·`book_version`·
  `ref_price` 정상 전진, 유저 체결만 테이블에 들어옴.
  - **⚠ 유저 체결은 계속 `spot_trades` 에 행으로 남긴다** — 사람이 내는 주문은 하루 수백 건 규모라 비용이
    없고 체결 원장으로서의 가치는 그대로다. 그래서 읽는 쪽(`loadSpotMarket`·`bucketTradesToCandles`)이
    **테이프와 테이블을 시간순으로 병합**한다(`mergeRecentTrades`). 테이프 항목엔 행 id 가 없어 `t<시각>-<i>`
    합성 키를 준다(리스트 렌더 key 용도). **새 체결 경로를 추가할 때: 봇이 만드는 것이면 테이프에, 유저
    것이면 테이블에.**
  - `<60s`(1s) 캔들이 볼 수 있는 과거 범위가 링 버퍼 길이(≈90초)로 제한된다 — `<60s` 는 애초에 과거
    페이지가 없고(`loadSpotCandles` 가 `endTime` 에 빈 배열 반환) 기본 표시가 ~38봉이라 실사용 영향은 없다.
    더 길게 보여주고 싶으면 `TAPE_MAX` 만 올리면 된다(**행 수가 아니라 바이트만 늘어 과금과 무관**).
  - cron 버스트는 테이프를 시작에 한 번 읽어 틱 사이에 메모리로 이어받는다. cron 과 유저 폴링 틱이 겹치면
    뒤에 쓴 쪽이 상대의 append 를 덮어쓸 수 있는데, 잃는 건 **표시용 테이프 몇 건**뿐이다(캔들·기준가·
    잔고·재고는 각자 자기 문장으로 쓴다).
- **⚠ 봇 거래량(한 틱=버스트) + 접속 무관 활성화(cron 버스트)**: 예전엔 한 틱에 5~45 짜리 합성체결 1건이라
  캔들 거래량이 ~300 에 그쳐 "봇이 쫄보"였고, 게다가 마켓메이커는 `/api/spot` 폴링(=유저가 OX 를 볼 때)
  으로만 돌아서 **아무도 안 켜놓으면 cron(예전 5분) 때만 1틱** → 차트가 사실상 멈췄다. 수정:
  (1) `marketMakerTick()` 이 한 틱에 **큰 합성체결 여러 건**(3~6건 × 1,000~8,000, 방향 70% 편향+섞음)을
  찍는다 — 캔들 거래량이 요청당 ~1.5만~4만, 유저가 볼 때 분당 수십만으로 뛴다. 캔들은 버스트 총량으로
  1회 upsert(문장 수 억제). (2) **cron 은 매 1분**(`cron/wrangler.toml`)마다 `runMarketMakerBurst()` 로
  **여러 틱을 몰아** 돌린다 → 접속자 없어도 매 분 가격 움직임+거래량이 생긴다.
  **⚠ 버스트 체결 시각은 절대 소급하지 않는다(마감된 봉이 변하던 버그)**: 예전엔 각 틱을 `[now-55s, now]`
  에 퍼뜨려 빈 봉을 메웠는데(cron 이 5분 주기이던 시절의 잔재), 매 1분이 된 뒤로는 그 소급분이 **이미
  마감된 직전 분봉 버킷**에 upsert 돼 `high/low/close/volume` 이 계속 갱신됐다 → OX 차트는 1.5초마다
  캔들 전체를 `setData` 로 다시 그리므로 "봉이 마감됐는데 이전 봉이 계속 바뀌는" 현상이 그대로 보였다.
  지금은 각 틱의 시각을 **그 틱을 실제로 실행하는 시점(`Date.now()`, 단조 증가)** 으로 찍어 과거 버킷을
  건드리지 않는다(cron 이 매 분 도니 1분봉은 어차피 매 봉 채워져 빈 봉도 안 생김). 새 체결 경로를 추가할
  땐 **`candleUpsertStmts` 에 넘기는 `now` 가 과거 시각이면 마감된 봉이 변조된다**는 점을 반드시 지킬 것. `runMarketMaker()`(폴링용, 게이트 있음)와 `marketMakerTick()`
  (실제 한 틱, 게이트 없음)을 분리해 폴링/cron 이 공유. **⚠ cron 워커는 Git 자동배포가 아니라 수동 재배포
  필요**(`cd cron && npx wrangler deploy`) — 스케줄/코드 변경은 이 명령을 돌려야 반영됨(§5).
- **⚠ 벽 소비량은 벽 크기에 비례(`wallAbsorbSize`)**: 예전엔 press 시 벽 가격에 놓는 봇 호가가 **벽 크기와 무관하게 항상 2,000~10,000** 이라, 100만주 벽이면 뚫는 데 수 분씩 걸리고 그동안 기준가가 벽에 붙어 굳어버렸다("봇이 쫄보라 큰 벽을 못 뚫는 느낌"). 실제 시장에서 큰 벽은 **저항**이지 무한 방벽이 아니다. 지금은 벽 물량의 일정 비율(기본 5~12%)을 먹되 **국면 공격성**(`REGIME_PARAMS.sizeMult`, calm 0.55 ~ panic 2.9)과 **군중 심리 강도**로 배수를 걸고, **6% 확률로 "고래 스윕"** 이 터져 벽의 35~90% 를 한 틱에 쓸어간다. 작은 벽은 기존 절대량(2,000~10,000)이 하한이라 예전처럼 즉시 정리된다. 이를 위해 벽 조회가 가격뿐 아니라 **그 가격의 총 물량**까지 가져온다. 실측(100만주 벽): 예전 ~4.5분 → calm 54초 / panic 17초, 로컬 D1 검증에서 고래 스윕으로 3초 만에 54% 소진.
- **⚠ 봇이 유저 지정가 "벽"을 존중(가짜 high 버그 수정)**: 예전엔 봇 기준가(랜덤워크)가 유저의 최우선 매도벽
  위로(또는 매수벽 아래로) 자유롭게 움직이고 그 값에 합성체결을 찍어서, **"1.1 에 큰 매도벽을 걸어둬도 봇이
  1.11 에 체결을 찍어 차트 high 만 1.11 로 가짜로 뜨고(벽은 안 팔림)"** 버그가 있었다. 실제 시장이라면 그 벽을
  먼저 소비해야 벽 너머 가격이 나온다. 수정: 매 틱 유저 pending 의 최우선 매수벽/매도벽을 한 쿼리로 구해
  기준가를 `[wallBid, wallAsk]` 안으로 **클램프**하고, 벽에 눌리면(press) 그 벽 가격에 봇 호가를 하나 더 얹어
  아래 `sweepRestingOxPendings` 가 **벽을 그 가격에 실제 체결로 조금씩 소비**하게 한다 → 벽 너머 가짜 체결이
  안 찍히고(차트 high 가 벽에서 멈춤), 유저 벽은 물량이 소진될 때까지 저항으로 작동하다 뚫린다(실거래소 동일).
  **⚠ 단, marketable 주문은 벽에서 제외한다(2026-07-24 교착 버그 수정)**: 벽은 **현재가 너머**의 저항/지지여야
  한다 — 매도벽은 `price >= prev.ref`(현재가 이상), 매수벽은 `price <= prev.ref`(현재가 이하)만 인정. 유저가
  현재가보다 **낮게 건 매도**(=지금 팔겠다는 marketable 청산/지정가)나 **높게 건 매수**를 벽으로 잡으면, 기준가를
  그 주문 가격으로 끌어내려/끌어올려 **시장이 그 주문 쪽으로 통째로 끌려가고**(예: 시세 1.0 인데 0.5 청산 예약
  하나에 시장이 0.5 로 붕괴), 사다리가 그 가격에 깔려 정작 그 주문이 크로스가 안 돼 거의 안 팔리는 교착이 생겼다.
  marketable 주문은 벽에서 빼면 sweep 이 정상 사다리에 walking 체결한다(비-marketable 저항/지지 벽은 그대로 존중
  → 가짜 high 방지 유지). 로컬 검증: 시세 1.0 에 0.5 청산 예약 → 시장이 0.5 로 안 끌려가고 몇 틱 만에 전량 체결.
- **⚠ 봇도 거래 수수료를 낸다(`botFillStmts`)**: 합성 체결(봇끼리)이든 유저 상대 체결(maker 로 잡힌 물량)이든 봇도 요율을 적용받는다. **시장 물량의 대부분이 봇에서 나오는데 봇만 면제하면 수수료 집계가 실제 거래량과 동떨어진다**. 요율은 유저와 똑같이 누적 거래대금에서 파생(`vipOf`)하므로 봇도 거래가 쌓이면 등급이 오른다(특혜 없음).
  **⚠ 단 봇은 `fee_ledger` 에 행을 남기지 않는다(2026-07-31)** — 봇은 영구히 도니 하루 2.9만 행씩 원장을 채우는데 정작 그 행을 읽는 곳이 없었다: 랭킹의 "거래소 수수료 수익"은 `users.total_fees` 를 집계하고(`leaderboard.ts` — 원장은 행이 너무 많아 5초 폴링으로 스캔 불가), 원장의 존재 이유인 "유저별·심볼별 분해"에서 봇 몫은 애초에 분해 대상이 아니다. 총액은 카운터에 그대로 누적되므로 **화면 숫자는 1원도 안 바뀐다**. 겸사겸사 봇 부기를 (카운터 UPDATE + 원장 INSERT + 현금/재고 UPDATE) 3문장 → **1문장**으로 합쳤다(같은 행을 두 번 UPDATE 할 이유가 없다).
- **⚠ 봇 재고/현금 정산(`botFillStmts`, 2026-07-23)**: 유저 상대로 체결되면 봇의 `users.balance`(USDT)·`ox_balance`(OX 재고)가 실제로 움직인다 — 봇이 팔면 현금 +명목금액·재고 −수량, 사면 반대(수수료는 양쪽 다 차감). **예전엔 이 정산이 아예 없어서 두 봇의 잔고가 DB I/O 개편(2026-07-18) 시점 값에 영구히 얼어붙어 있었다**(아무리 사고팔아도 숫자가 그대로 → "봇 재고"라는 개념 자체가 없었다). 정산 위치는 각 매칭 함수가 이미 부르는 **합계 batch 1회**(청크마다 부기하면 원장·문장이 청크 수만큼 불어난다) — 왕복 증가 0.
  - **⚠ 잔고 가드는 절대 붙이지 않는다**(조건부 UPDATE 아님, 호가 에스크로도 부활시키지 않는다) — 봇은 설계상 무한 유동성 공급자라 현금/재고가 **음수로 내려가도 체결이 계속돼야** 한다. 가드를 붙이는 순간 대량 시장가 완결(`synthMaker` 경로)이 봇 잔고 바닥에서 끊긴다. 봇 재고는 "유저 전체 순포지션의 거울"이라 유저가 순매수면 봇 OX 는 자연히 마이너스로 간다(정상).
  - **합성 체결(봇↔봇)은 재고 변화 0** — `buyer_id=seller_id=actor` 라 같은 계정 안에서 상계된다(`botSide=null` → 수수료만). 로컬 검증: 합성 틱을 아무리 돌려도 잔고 불변.
  - **⚠ 강제청산도 반드시 반영**(`_trading.ts liquidateIfBankrupt` → `reflectVirtualFill`): 진입 때 봇이 판 물량을 청산 때 되사주지 않으면 **유저가 청산될 때마다 봇 재고가 한쪽으로 영구히 어긋난다**(진입 −수량만 남고 +수량이 영영 안 들어옴). 겸사겸사 청산 물량이 체결 테이프/차트에도 찍힌다. 유저는 청산 수수료를 안 내지만(위 참고) 봇은 낸다.
  - **⚠ `synthMaker` 는 스텝마다 두 봇을 번갈아** 쓴다 — 예전엔 `BOT_USER_IDS[0]` 하드코딩이라 대량 시장가의 합성 흡수분이 전부 1번 봇에 쌓여 누적 거래대금이 **700배 넘게** 벌어졌고(prod 실측 2.39조 vs 33.9억), 그 탓에 두 봇의 VIP 요율까지 갈라졌다(VIP4 vs VIP2).
  - 로컬 D1 검증: 5만개 진입 → 봇 재고 정확히 −50,000·현금 +명목−수수료, 청산 시 +50,000 복귀. 121만개 대량 시장가(합성 흡수 포함)도 두 봇 합계가 정확히 −1,216,654, 강제청산 후 전량 복귀(수량 보존 오차 0).
- **호가창·체결내역 = "표시용" 시장 데이터**: `GET /api/spot` 은 이제 유저별 데이터(잔고/내 주문) 없이
  시장 전체의 `{ book, trades }` 만 반환한다(`loadSpotMarket()`). `OrderBook.tsx` 가 실제 코인은
  바이낸스 WS, OX 는 이 데이터를 1.5초 폴링(`useSpotPoll`)해서 **같은 컴포넌트, 같은 UI**로 보여준다 —
  클릭하면 그 가격이 지정가 입력에 채워지는 것도 동일.
- **⚠ 호가창에 유저 자신의 지정가가 안 보이던 버그와 그 수정**: OX 지정가 주문은 `order.ts` 의
  `pending_orders` 에 쌓이는데, 호가창은 봇 전용 `spot_orders` 만 읽어서 **유저가 건 지정가가 호가창에
  절대 안 나타나는** 구조적 문제가 있었다(실제 코인은 바이낸스의 진짜 시장이 워낙 커서 이 괴리가
  안 보이지만, OX 는 그 자체가 유일한 "시장"이라 바로 티가 남). **수정**: `loadSpotMarket()` 의 bids/asks
  쿼리가 `spot_orders` 와 `pending_orders`(symbol='OXUSDT', long=매수/short=매도, limit_price 기준)를
  `UNION ALL` 해서 같은 가격대끼리 합산한다. `pending_orders` 는 취소/체결 시 즉시 그 행이 사라지므로
  별도 동기화 로직 없이 항상 최신 상태가 자동 반영된다.
- **⚠ 호가 역전 & "20만개가 유령가격에 즉시 체결" 버그와 그 근본 수정 — 실제 호가창 매칭 엔진** —
  OX 는 사실상 **두 개의 분리된 주문 풀**이 화면에서만 UNION 으로 합쳐 보였다: 봇 호가(`spot_orders`)는
  봇끼리만 매칭하고, 유저 주문은 **호가창을 완전히 무시한 채 스칼라 `ref_price` 한 값에 "전량" 체결**됐다
  (예전 `fillOxPending`/`fillMarketableOxLimits`, 이제 제거됨). 그래서 (1) 봇 매도호가가 유저의 더 높은
  매수를 안 보고 지나가 호가 역전이 나고, (2) **있지도 않은 20만개가 최우선 매도호가보다도 싼 유령가격에
  즉시 체결**되는 심각한 버그가 있었다(호가창엔 매도물량이 ~280개뿐이고 최저가가 1.0996인데 20만개를
  1.0969 에 매수). **근본 수정 = 실제 호가창 매칭 엔진**(`spot.ts`):
  - `matchLimitPendingAgainstBook(env, pendingId)` — 유저 지정가 하나를 봇 호가창(`spot_orders`)에
    **가격-시간 우선순위로 walking** 매칭. 있는 물량만, 실제 호가 가격에 체결(매수는 최우선 매도가부터
    위로, 최우선호가보다 싸게는 절대 안 삼). 못 채운 잔량은 `pending_orders` 에 그대로 남아 대기.
    증거금은 생성 시 `limit_price` 로 잠갔으므로 실제 체결가와의 차액을 환불(매수)/추가징수(드묾)한다.
  - `matchMarketOxOrder(env,…)` — 시장가는 가격제한 없이 walking, 있는 만큼만 체결하고 잔량은 버린다
    (체결분마다 실제 체결가로 조건부 증거금 차감).
  - `sweepRestingOxPendings(env)` — `runMarketMaker()` 가 **봇 재호가(requote) 직후** 호출해 **전 유저의
    대기 지정가**를 새 봇 유동성에 이어서 매칭 → 주문 낸 유저의 접속/폴링과 무관하게(크론 포함) 체결이
    진행되고 호가 역전이 화면에 안 남는다(예전엔 게이트와 무관하게 매 폴링 sweep 했으나, 호가창은 requote
    틱에만 바뀌므로 낭비 → 제거). `checkTriggers`(그 유저 5초 폴링)·`order.ts`(제출 직후)도 공유 호출.
  - 봇 maker 는 원자적 선점(조건부 UPDATE, 동시 이중체결 방지)으로 소비한다. 봇 쪽 대금/재고 정산은
    청크마다가 아니라 **주문 하나당 합계 batch 1회**(`botFillStmts`, 위 "봇 재고/현금 정산" 참고).
    봇 유동성은 크게 유지(레벨 22, 물량 2000~10000).
  - 결과: 큰 주문은 실제 호가를 walking 하며 슬리피지와 함께 부분 체결되고 잔량은 대기하다 유동성이
    생기면 이어서 체결(가격이 위로 밀리는 시장충격 발생). 실제 코인 38종은 별도 봇 시장이 없어 기존
    `limit_price` 체결(`checkTriggers`)·외부시세 시장가 경로 그대로.
- **유저 체결이 합성 시장에 반영**: 진입(시장가/지정가)은 위 매칭 엔진이 봇 호가를 실제 소비하며 체결
  테이프(`spot_trades`)·기준가(`ref_price`)를 직접 갱신한다. **청산(close)·SL/TP** 는 여전히 서버 시세
  (ref)로 정산한 뒤 `spot.ts` 의 `recordVirtualFill()` 로 시장에 반영한다 — 체결내역에 기록하고 기준가를
  그 가격으로 당기며 **반대편 최우선호가부터 체결수량만큼 `spot_orders` 를 소비**한다(파생 청산은 mark
  정산이 표준이라 진입처럼 호가창을 walking 하진 않음). 봇 잔고는 무한 풀이라 조정 불필요.
- **⚠ 가격 정밀도 = 유효숫자 4자리 고정(2026-08-01, 예전엔 "소수 4자리" 고정)**: 가상 코인은 외부 거래소가 없어 봇이 만드는 가격이라, 봇 기준가·호가·체결가를 정해진 틱에 스냅하지 않으면 화면 표기와 실제 체결이 어긋난다. 예전 규칙은 **틱 0.0001 절대 고정**이었는데 그건 가격이 1 USDT 근처일 때만 성립한다 — 0.002 대로 내려가면 유효숫자가 2자리뿐이라 한 틱이 4%씩 튀고(0.0024↔0.0025), 100 USDT 를 넘으면 의미 없는 자릿수(123.4567)가 붙는다. 지금은 실제 거래소처럼 **가격대에 따라 틱이 10배씩** 바뀐다: `0.9234→0.0001 / 0.002434→0.000001 / 123.4→0.1`.
  - 진실원본은 `_shared.ts` 의 `virtualTick`/`roundVirtual`/`virtualPrecision`(+`VIRTUAL_SIG_DIGITS=4`). 지수는 `Math.log10` 이 아니라 `toExponential` 로 뽑는다 — `Math.log10(0.001)=-3.0000000000000004` 라 floor 가 한 자리 어긋난다. `roundVirtual` 은 `Number(p.toExponential(3))` 이라 0.99996→1.000 같은 자릿수 올림 캐리도 알아서 처리한다.
  - `spot.ts roundOx = roundVirtual` 이 봇 ref/호가 사다리/체결 테이프/`recordVirtualFill` 을, `order.ts` 가 유저 지정가·청산 지정가·조건부 트리거가·재무장가를 이 틱에 스냅한다.
  - **⚠ 틱이 가격 비례이므로 가격 관련 상수를 절대값으로 쓰면 안 된다** — 전부 "틱 몇 개"로 적는다: `PRICE_GRIDS`(라운드 가격 격자, 50/10/5틱), `ROUND_STEP_TICKS`(라운드넘버 자석, 50틱), 합성 체결 테이프 스냅(5틱). 예전 값(0.05/0.01/0.005/0.001)은 가격이 1 근처일 때의 그 값과 정확히 같다.
  - **⚠ 사다리 레벨이 겹치면 원래 목표가로 되돌리지 말고 mid 에서 한 틱씩 더 민다**(`placeQuote`) — 틱이 굵어지면(예 1.05 근처는 0.001) 레벨 간 목표 간격이 한 틱보다 좁아져서, 되돌린 목표가도 이미 쓴 가격이라 22단계 사다리가 몇 단계로 뭉개진다.
  - 클라 표시 자릿수는 `src/format.ts` 의 **같은 규칙 사본**(intervalSec 과 같은 이유로 독립 보관 — ⚠ 한쪽만 고치면 보이는 자릿수와 실제 체결 틱이 어긋난다)에서 나오고, `useMarketStore.setPrice` 가 가상 심볼이면 가격에서 `precisions[symbol]` 을 파생한다(진실원본 1곳 → 차트를 안 보는 심볼도 헤더/포지션에서 올바른 자릿수). `Chart` 는 캔들이 올 때마다 `applyPrec` 로 축·크로스헤어 `priceFormat` 을 갱신한다.
  - 로컬 D1 검증(0.99 / 0.002434 / 123.4 세 가격대): 호가 44개가 전부 유효숫자 4자리, 사다리 22단계 유지, 호가 역전 0, 지정가 121.4567→121.5·100.1234→100.1·조건부 118.98765→119 로 스냅, 시장가 진입/청산 walking 정상.
- **레버리지는 포지션당 고정**: `OrderPanel.tsx` 는 현재 심볼에 보유 포지션이 있으면 그 레버리지로
  슬라이더를 동기화하고 잠근다(서버도 물타기 시 항상 기존 포지션의 레버리지를 쓰므로, 슬라이더가
  다른 값을 보여주면 실제 체결과 화면이 어긋나 보이는 문제가 있었음).
- **⚠ 캔들(차트) = 영속 집계 테이블(`spot_candles`, 시간 지나도 히스토리 안 지워짐)**: 외부 시세가
  없어 서버가 체결 기록으로 OHLCV 를 만든다(`GET /api/spot?candles=1&interval=..&limit=..`,
  `loadSpotCandles()`). **예전엔 매 요청마다 "최신 `spot_trades` 5000건"을 JS 버킷팅**해서, 총 거래가
  5000건을 넘으면 오래된 거래가 읽기 창 밖으로 밀려 **옛 캔들이 통째로 사라졌다**(특히 큰 인터벌은
  5000건이 몇 시간치뿐이라 봉이 몇 개만 남음 = "시간 지나면 차트 데이터가 지워지는" 문제). **지금은 모든
  체결(봇 합성체결 `runMarketMaker`·유저 매칭체결 `spotTradeStmts`·`recordVirtualFill`)이
  `candleUpsertStmts` 로 인터벌별 OHLCV 를 `spot_candles` 에 누적 upsert**(같은 batch, 왕복 추가 없음)하고,
  `loadSpotCandles` 는 그 테이블에서 `(pair,interval)` 인덱스로 필요한 봉만 읽는다 → 거래가 아무리 쌓여도
  히스토리 영구 보존 + 읽기도 가볍다. **1s(및 <60s)만 예외**로 영속화하지 않고(단기 조회 전용) 최신 거래
  버킷팅(`bucketTradesToCandles`, 위 최신 5000건 방식)으로 처리한다. 영속 테이블이 아직 빈 인터벌(신규
  배포 직후)은 거래 버킷팅으로 폴백해 차트가 비지 않게 한다(백필 스크립트 불필요 — 체결이 쌓이며 자연히
  채워짐). 실시간 갱신은 WS 대신 `Chart.tsx` 가 **1.5초마다** 재요청(단, 표시 범위는 최초 로드 때만 설정 —
  매 폴링마다 재설정하면 사용자가 확대/축소한 뷰가 계속 리셋되는 버그가 있었음).
  **⚠ 저장하는 인터벌은 `PERSIST_INTERVALS` = 1m/1h/1d 세 종류뿐이다(2026-07-31)** — 예전엔 15종을 전부
  upsert 해서 체결 한 묶음마다 15문장이 나갔고, 봇이 영구히 도니 그것만으로 하루 29만 write 였다. 나머지
  (3m/5m/15m/30m, 2h/4h/6h/8h/12h, 3d/1w/1M)는 전부 이 셋의 **정수배**라 `loadSpotCandles` 가 조회 시
  굴려서(rollup: open=첫 봉, close=마지막 봉, high/low=극값, volume=합) 만든다 — 값이 저장했을 때와
  정확히 같다. 원본을 `limit × 배수` 만큼 더 읽고 `slice(-limit)` 로 잘라내므로, 페이지 맨 왼쪽 봉이
  드물게 부분 집계일 수 있다(스크롤 페이지 경계에서만, 시각적으로 무해). **인터벌을 추가할 땐 그게 1m/
  1h/1d 중 하나의 정수배인지 확인할 것** — 아니면 가장 가까운 하위 인터벌로 떨어져 버킷이 어긋난다.
- **평단선/SL·TP선/청산가/미실현PnL/강제청산은 전부 공짜**: OX 포지션도 `positions` 테이블의 평범한
  한 행이라, `Chart.tsx`(심볼 필터)·`PositionsPanel.tsx`(청산가 계산)·`_trading.ts`(강제청산 평가) 가
  이미 심볼에 무관하게 동작하므로 별도 구현 없이 실제 코인과 똑같이 표시·평가된다.
- **잔존 컬럼**: `users.ox_balance`/`spot_orders`/`spot_trades` 는 스키마 변경 없이 남아있지만, 이제
  **봇 유저 2명 전용**이다(실유저는 더 이상 참조/사용 안 함 — DROP COLUMN 마이그레이션은 안 함).
  `ox_balance` 는 위 "봇 재고/현금 정산" 이후로 **봇의 OX 재고**로 실제 쓰인다(유저에겐 여전히 무의미 —
  유저의 OX 노출은 `positions` 의 레버리지 포지션이지 현물 잔고가 아니다).

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
- **D1**: `ox64` (database_id `f32f600e-49ad-4026-843f-84f34a62df3c`), 스키마 4테이블(users/positions/orders/pending_orders) 적용 완료. 바인딩은 `wrangler.toml` 의 `[[d1_databases]] binding="DB"` 로 코드 관리 → Git 배포가 자동 적용(대시보드 바인딩 UI 는 "managed through wrangler.toml" 로 잠기며, 이게 정상 — 코드가 진실원본).
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
- **⚠ 아주 큰 값은 축약해서 보여준다(`fmtUsdShort`/`fmtQtyShort`)**: 이 사이트는 200배 레버리지 + 무한 조건부라 평가자산·수량이 **1e31 까지** 간다. 콤마 표기를 그대로 두면 폭이 정해진 칸(랭킹 행·헤더 평가자산·주문패널 정보란·호가창 수량)이 통째로 밀려 **다른 정보가 화면 밖으로 나간다**(실제 제보: 랭킹 1위 행에서 VIP 뱃지·순위가 사라짐). 규칙: 정수부가 `maxIntDigits`(랭킹/포지션 12, 좁은 칸 9)를 넘으면 한국식 단위(만/억/조/경/해/자/양)로 **반올림** 축약하고, 양(1e28)으로도 4자리를 넘으면 지수 표기(`5.00e+33`)로 떨어진다. **축약한 자리엔 반드시 `title` 로 전체값(`fmtUsd`/`fmtQty`)을 붙일 것** — 축약만 있으면 정확한 값을 확인할 방법이 없어진다. `fmtKor` 과의 차이: 그쪽은 VIP 기준선 표시용이라 **내림**(999,999 를 "100만"으로 올려 보이면 안 됨), 이쪽은 "대략 얼마인지"라 반올림. **⚠ 축약만으로는 부족하다** — 옆 칸이 밀리지 않게 금액 칸엔 `shrink-0`, 이름처럼 늘어나는 칸엔 `min-w-0`+`truncate` 를 같이 줄 것. 수량 입력칸처럼 **글자 수로 폭을 계산하는 곳은 상한을 둔다**(`PositionsPanel` 청산 수량 = 20ch — 1e30 이면 자릿수가 31 이라 입력칸 하나가 패널을 밀어낸다).
- **반응형**: `App.tsx` 모바일=세로 flex 스택(차트 45vh→주문→포지션), `md:`(≥768px)=2열 그리드(좌 차트+포지션 / 우 주문). 차트가 모바일서 좁던 원인=옛 가로 flex 의 `aside w-72` 고정폭 → 그리드 전환으로 해결.
- **DB 확인/수정**: 이제 서버 D1. `npx wrangler d1 execute ox64 --remote --command "SELECT name,balance FROM users"`. 잔고 리셋 등도 SQL 로. (구 `window.db`/DevTools IndexedDB 방식은 폐기 — 클라 조작 방지가 목적.)
- **인터벌→초 매핑 이중 관리**: `src/symbols.ts INTERVAL_GROUPS` 와 `functions/_shared.ts intervalSecFromCode`(OX 캔들 버킷팅용) 가 같은 값을 각자 보관한다(functions/ 는 src/ import 불가). 인터벌 코드를 추가/변경하면 두 곳 다 갱신할 것.
- **⚠ 시장가가 지정가로 걸리던 버그**: 차트/호가창 클릭(`setChartClickPrice`)이 예전엔 `OrderPanel` 을 무조건 지정가 탭으로 전환했다 — 시장가로 주문하려다 무심코 차트를 클릭하면 시장가 주문이 지정가로 걸렸다. 수정: 클릭은 **이미 지정가 탭일 때만** 지정가 입력을 채운다(시장가 탭에서의 클릭은 조회일 뿐 주문 유형을 안 바꿈). 지정가로 클릭 배치하려면 먼저 지정가 탭 선택.
- **⚠ 클릭 가격을 받는 칸은 항상 하나(`useMarketStore.priceTarget`)**: 클릭 가격을 쓰는 입력칸이 둘(주문패널 지정가 / 포지션의 청산 지정가)이라, 각 칸이 `chartClickNonce` 를 그냥 구독하면 **한 번 클릭에 둘 다 바뀐다**. 그래서 입력칸이 **포커스될 때 자기를 타깃으로 등록**(`''` / `close:<positionId>`)하고, 클릭 효과는 자기가 타깃일 때만 값을 받는다 — 차트를 클릭하는 순간 포커스가 풀리므로 `document.activeElement` 로는 판단할 수 없어 상태로 기억해야 한다. 대상 포지션이 사라지면(청산) 타깃을 `''` 로 되돌린다(안 그러면 청산 직후 첫 클릭이 사라진 칸으로 향해 삼켜짐). 청산 지정가 칸은 **현재 차트 심볼과 포지션 심볼이 같을 때만** 값을 받는다(BTC 차트 클릭이 OX 포지션 청산가로 들어가는 사고 방지).
- **⚠⚠ 체결내역의 매수/매도 라벨(색)은 "그 체결이 어느 방향으로 가격을 움직였나"에서 나온다(tick rule, 2026-08-19)**: 실제 시장에서 taker 매수는 매도호가를 들어올리며 체결되므로 **직전 체결보다 비싸게 찍힌 체결 = 매수(초록), 싸게 찍힌 것 = 매도(빨강)** 이고, 같은 가격(zero-tick)이면 **직전 라벨을 이어받는다**(표준 Lee-Ready 분류). 예전엔 봇이 라벨을 `Math.random() < buyProb` 로 **가격과 완전히 독립적으로** 뽑아서 실측 9.4만 건 중 **상승틱의 38.9% 가 빨강, 하락틱의 43.1% 가 초록**으로 찍혔다 — 가격은 오르는데 테이프는 빨강이라 "색이 반대다 / 메이커 기준으로 찍힌다"로 읽혔다(제보). 지금은 `simulateTick` 이 인쇄 가격에서 라벨을 뽑고(검증: 불일치 **0%**, 동가 계승 14.9%), 국면별 taker 편향(`nextMarketState.buyProb`)은 **동가 처리에만** 남는다 — 국면 쏠림은 가격 경로(`ret`)에 이미 들어있어 라벨 분포로 그대로 드러난다(틱 상승 구간 매수라벨 67.9% / 하락 구간 29.5%). **체결을 새로 찍는 코드를 추가할 땐 라벨을 임의로 정하지 말고 가격 방향에서 파생시킬 것.**
- **⚠ 유저 주문의 라벨은 "누가 덮쳤나"(`Aggressor`)로 갈린다**: 시장가·제출 즉시 체결되는 marketable 지정가는 유저가 taker 라 **유저 방향 그대로**(롱 진입=매수) 찍히지만, **이미 걸려 있던**(resting) 유저 지정가가 봇 재호가에 채워지면 taker 는 봇이므로 **유저 방향의 반대**로 찍힌다(내 매수 지정가가 시장가 매도에 채워지면 거래소 테이프에도 '매도'로 뜬다). `matchLimitPendingAgainstBook`/`matchReduceOnlyOxPending`/`closePositionAgainstBook` 의 `aggressor` 인자로 전달하며 **`sweepRestingOxPendings`(재호가 직후)와 `runTriggers`(폴링/cron)에서만 `'bot'`** 이다(order.ts 제출 경로는 기본값 `'user'`). ⚠ **뒤집히는 건 라벨뿐** — buyer/seller·포지션·잔고·수수료는 유저가 실제로 사고판 방향(`userSide`)을 쓴다(예전 코드가 `tapeSide` 로 buyer/seller 를 정하고 있어서, 라벨을 뒤집을 때 상대방까지 바뀌지 않도록 분리했다).
- **⚠ 호가창·체결 표시 개수는 유저 설정이고, 상한이 네 곳에 걸쳐 있다**: 클라가 그리는 행 수는 `useChartStore.bookRows`(설정 모달, 5~50, 기본 10 = 예전 `max-h-40` 과 같은 높이)이고 그 위에 **공급 상한**이 얹힌다 — ①`loadSpotMarket()` 의 `BOOK_LIMIT`(50, 가상 코인 호가 단계) ②`mergeRecentTrades(..., 50)`(가상 코인 체결) ③`useMarketStore.MAX_TRADES`(50, 클라가 보관하는 체결 테이프) ④**실제 코인은 바이낸스 부분 호가 스트림이 5/10/20 단계만 지원**해서 `orderbookStream(symbol, 20)` 의 20 이 물리적 상한이다(설정을 50 으로 해도 20 줄까지만 찬다 — 설정 모달에 그렇게 적어뒀다). 예전엔 서버 15 / 클라 8 고정이라 스프레드에서 먼 곳에 큰 지정가(벽)를 걸면 그 주문이 화면에서 통째로 안 보였다. **`BOOK_ROWS_MAX` 를 올릴 땐 ①②③ 을 같이 올릴 것.** ⚠ 단 `spot_trades` 의 `LIMIT 30` 은 그대로 둔다 — 테이프는 상태 행 JSON 이라 몇 건을 병합해도 읽기가 안 늘지만 테이블 쪽을 늘리면 1초 폴링에 그만큼 D1 읽기가 늘어난다(§6).
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
       - 현재 페이스(하루 20~25만)면 이 선에 닿지 않는다 — **닿았다는 건 어딘가 새 폭주 경로가 생겼다는
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
    **3~12건**이다. 그걸 통째로 top 에 꽂으면 "1초에 한 번 덜컥"으로 보이므로, 시간순으로 조금씩
    (`REVEAL_MIN_GAP_MS`=100ms ~ `REVEAL_MAX_GAP_MS`=250ms 간격, `REVEAL_WINDOW_MS`=700ms 안에 완료)
    내보낸다 → 목록이 실제 테이프처럼 흐른다. **이미 받은 데이터를 순서대로 꺼내는 것이라 요청·읽기·쓰기가
    하나도 안 늘고**, 대가는 그 묶음의 가장 새 체결이 최대 0.7초 늦게 보이는 것뿐이다(헤더 현재가·차트는
    그대로 즉시 갱신 → 목록 맨 위가 현재가를 반 박자 뒤따라간다 = 실제 거래소 테이프와 같은 모양).
    - **⚠⚠ 해상도의 상한은 타이머가 아니라 "그 초에 존재하는 체결 건수"다.** 틱당 3~12건이라 0.1초
      간격이면 스텝당 1~2건 = 사실상 한 건씩 내보내는 것이고, **실측 초당 4.8회 공개**가 나온다(=초당 체결
      건수와 같다). 여기서 더 잘게 쪼개도 보여줄 게 없어 빈 스텝만 늘어난다 — 진짜로 초당 10회를 채우려면
      `BOT_TRADES_PER_TICK_MIN/MAX` 를 올려 **체결 자체를 더 많이 찍어야** 하고(테이프는 링 버퍼 JSON 이라
      D1 비용은 0), 그건 캔들 거래량이 그만큼 커지는 **시장 데이터 변경**이다.
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

> "헬로타운 스핑크스 보석찾기" 이벤트를 확장한 미니 퍼즐게임. **코인 트레이딩과 완전히 무관** —
> 같은 계정(이름+패스코드, 세션 쿠키 공유)을 그대로 쓰지만 재화·기록은 `users.balance`(USDT)와
> 전혀 다른 별도 D1 테이블(`puzzle_stats`/`puzzle_games`)이다. 트레이딩 쪽 번들이 딸려오지 않도록
> `src/main.tsx` 가 `location.pathname` 만으로 완전히 분리된 진입점을 동적 import 한다(라우터 없음).

- **규칙**: NxN 격자에 여러 칸을 차지하는 보석(모양별로 다름 — 배틀쉽처럼 1~6칸)이 숨어 있다. 칸을
  하나씩 열 때마다(코스트 1 소모) 그 칸이 "보석 조각"인지 "빈 땅"인지 알려주는데, 조각이면 **색깔
  (보석 종류) + 같은 보석이 상하좌우 어느 방향으로 더 이어지는지("부위")** 까지 함께 보여줘서, 색과
  이어지는 모양을 보고 다음에 열 칸을 유추해가며 찾는다(위치 자체를 미리 알려주진 않음 — 지뢰찾기식
  숫자 힌트도 아니고, 정확히 원작의 "색+부위 보고 유추" 방식). 보드에 어떤 보석이 몇 개 숨어있는지
  (색·모양·개수)는 게임 시작 전부터 "범례"로 보여주고, 한 보석의 모든 칸을 다 열어 획득하면 그 종류를
  범례에서 지운 것처럼 표시한다(취소선+흐리게, `Legend.tsx`). 목표 보석을 전부 획득하면 클리어(재화
  보상). **재화가 0이 되면 게임오버**. 클리어 없이도 다음 판을 몇 번이든 다시 시작할 수 있다("무한
  도전" — 원작의 일일 시도 횟수 제한이 없음).
- **⚠ 서버 권위 = 보드 정답은 서버만 안다**: `puzzle_games.board`(좌표→보석ID JSON)와 각 보석의 전체
  칸 목록(`gems[gemId].cells`, 안 연 칸 포함)은 클라 응답에 절대 포함하지 않는다. `publicGame()` 이
  `revealed`(이미 연 칸) 배열만 걸러 `{x,y,gemId,label,color,connects}` 로 내려준다 —
  `connects`(상하좌우 4방향 boolean)는 **그 칸이 같은 보석의 어느 방향으로 더 이어지는지**만 알려주고
  (`connectsFor()`, 전체 `cells` 목록 대비 계산), 몇 칸 뒤에서 끝나는지·정확히 어디인지는 여전히 안 연
  칸을 열어봐야 안다 — 개발자도구로도 안 연 칸의 정답을 미리 볼 방법이 없다. 트레이딩의 "체결가는
  서버가 fetch" 원칙과 동일한 사상.
- **범례(`legendOf()`, `PuzzleGame.legend`)**: 이 보드에 실제로 배치된 보석을 종류별로 묶어
  `{색,모양,개수,그중 몇개 찾음}` 만 알려주고 위치는 안 준다. 레벨 선택 화면에서도 `levels[].types`
  로 같은 정보를 미리 보여준다(시작 전부터 "이 레벨엔 뭐가 숨어있는지" 알 수 있음). ⚠ 클라
  (`usePuzzleStore.open`) 는 오픈 직후 판이 끝나(won/lost) 서버 `activeGame` 이 `null` 로 빠지는
  경우, 로컬 `legend` 에서 방금 완성된 보석의 `label` 을 매칭해 `found` 를 수동으로 +1 해 흉내낸다
  (서버가 다시 계산해 내려줄 게 없으므로).
- **재화(`puzzle_stats.currency`)**: 신규 유저 시작값 60, 영구 누적(USDT 잔고와 완전 별도 컬럼).
  칸 오픈마다 `OPEN_COST`(현재 레벨 무관 고정 1) 만큼 원자적 조건부 UPDATE(`currency >= cost`)로
  차감 — 실패하면(잔고 부족) 그 오픈 자체가 거부된다(게임 상태 불변). 클리어 시 레벨별 `reward`
  (레벨1=12 ~ 레벨10=105)를 더한다. 색+부위 힌트가 있어도 완전한 좌표 힌트는 아니라 운이 나쁘면
  코스트를 많이 써서 재화가 마이너스 추세로 갈 수 있다 — 이건 원작의 긴장감과 같은 의도된 리스크
  (트레이딩의 강제청산과 유사한 포지션). **재화가 0일 때만** `refill`(+40, 1일 최대 5회, KST 날짜
  기준 — `functions/api/refill.ts` 와 동일한 리필 패턴)로 재도전 가능.
- **레벨 1~10**: 보드 크기(6×6~12×12)·보석 구성(`LEVELS[].plan`, `functions/api/puzzle.ts`)·클리어
  보상이 완만하게 커진다. 등급표(VIP_TIERS)와 같은 패턴으로 **서버가 `GET /api/puzzle` 의 `levels`
  필드로 기준표를 내려주고 클라는 그걸 그대로 렌더**(중복 정의 없음). ⚠ 색+부위 힌트가 있어도 실측
  밸런스가 아니라 초기 추정값이다 — 체감 난이도를 보고 `LEVELS` 배열(보드 크기/보석 개수/보상)만
  조정하면 된다(한곳에 모아둠).
- **보석 모양(`SHAPES`)**: single(1칸)/domino(2)/tromino(3)/square(4)/cross(5)/big(6). 배치
  (`generateBoard`)는 각 인스턴스마다 무작위 회전(0/90/180/270)+반전 후 빈 칸에 겹치지 않게 최대
  300회 시도해서 놓는다 — 실패하면(공간 부족) 그 보석 인스턴스만 조용히 스킵(낮은 밀도로 설계돼
  거의 발생 안 함). `Board.tsx` 는 열린 보석 칸을 색깔 배경 + `connects` 방향으로 튀어나온 작은
  "돌기"(퍼즐 조각 이음새 느낌)로 그려서 어느 쪽을 더 열어야 할지 시각적으로 유추되게 한다.
- **한 계정당 활성 게임 1판**: `start` 액션은 그 유저의 기존 `status='active'` 판을 전부
  `abandoned` 로 접고 새 판을 만든다(이미 쓴 코스트는 환불하지 않음 — 언제든 새로 시작 가능해야
  "무한 도전"이 성립하므로 페널티는 그 판에서 쓴 코스트로 충분). `abandon` 액션은 명시적 포기(같은
  처리, 자산에 영향 없음).
- **⚠ 클라가 서버의 `activeGame` 스냅샷에 의존하지 않는 이유**: `loadPuzzleState().activeGame` 은
  `status='active'` 인 판만 찾는다 — 그래서 방금 오픈으로 승/패가 확정된 판은 거기서 `null` 이 된다.
  `open` 응답은 그 오픈의 결과를 `gameStatus`/`cell`/`justCompleted`/`reward` 로 별도로 실어보내고,
  클라(`usePuzzleStore.open`)는 로컬에 들고 있던 보드에 이 결과만 이어붙인다 — 그래야 클리어/게임오버
  직후에도 마지막 보드 상태가 화면에서 사라지지 않고 "클리어!"/"게임 오버" 배너와 함께 보인다.
- **라우팅**: 별도 라우터 라이브러리 없음. `src/main.tsx` 가 `location.pathname === '/b'` 면
  `src/puzzle/PuzzleApp.tsx` 를, 아니면 `src/App.tsx` 를 동적 `import()` 한다 — 빌드 시 별개
  청크(`PuzzleApp-*.js`)로 분리돼 트레이딩 스토어/서비스가 퍼즐 페이지 번들에 안 딸려온다. Cloudflare
  Pages 는 정적 SPA 기본 동작상 `/` 외 경로 새로고침이 404 날 수 있어 `public/_redirects`
  (`/* /index.html 200`)로 폴백시킨다(Functions·정적파일이 `_redirects` 보다 먼저 매칭되므로
  `/api/*` 는 영향 없음).

## 8. 5분 던전 (ox64.app/5m, `functions/api/dungeon.ts` + `src/dungeon/`)

> 원작 "5-Minute Dungeon"(2~5인이 손패를 실시간으로 동시에 내어 몬스터가 요구하는 아이콘 조합을
> 맞추고, 5분 벽시계가 다 되기 전에 던전을 클리어하는 협동 카드게임)을 재현한 온라인 실시간
> 멀티플레이. **코인 트레이딩·퍼즐 어느 쪽과도 완전히 무관** — 같은 계정(이름+패스코드, 세션 쿠키
> 공유)을 그대로 쓰지만 재화 없이 승패 통계만 별도 D1 테이블(`dungeon_stats`)에 기록한다. 원작
> 카드의 정확한 텍스트/수량은 기억에 확신이 없어 그대로 베끼지 않았다 — **메커니즘**(아이콘 매칭,
> 개인 덱 히든드로우, 손패 공개, 함정/포션/보스, 5분 타이머, 파티 체력, 인원수 난이도 스케일링)은
> 재현하되 영웅 이름·카드 구성·몬스터 목록은 이 프로젝트 오리지널이다. 현재 규모: **아이콘 5종 ·
> 영웅 6종 · 몬스터 24 · 함정 6 · 포션 4 · 보스 4 · 던전 4개**(난이도별).

- **⚠ 동기화 = Durable Objects/WebSocket 이 아니라 D1 + 짧은 폴링**: 진짜 실시간(수십 ms) 응답을
  주는 Durable Objects 는 Cloudflare Workers **유료 플랜**이 필요하고 별도 Worker 배포도 필요하다
  (D1·Pages·기존 cron 워커는 전부 무료 플랜으로 충분했던 것과 다름). 대신 기존 OX 마켓메이커
  (`useSpotPoll`)와 완전히 같은 "D1 + 짧은 폴링" 패턴을 재사용해 무료 플랜을 유지하고 새 인프라
  없이(같은 Pages 배포 안에서) 구현했다.
  **⚠ 정정(2026-07-31): 이 계정은 실제로는 Workers Paid 다** — 당시 prod D1 이 3.38GB 였는데 무료 플랜은
  DB당 500MB 한도라 애초에 불가능하고, 쓰기도 무료 한도(10만/일)의 20배가 나가고 있었다(§6 "D1 예산").
  실제로 7월분 **$47 이 D1 rows written 초과로 청구됐다** — 그 이후 봇 쓰기를 틱당 4행까지 줄여 월 600만
  행(포함분 5,000만)으로 내려왔고, DB 도 15MB 로 회수됐다. 폴링 간격을 줄이려면 §6 을 먼저 읽을 것.
  즉 **Durable Objects 를 쓸 수 있다**. 위 "무료 플랜 유지" 는 당시의 (틀린) 전제였을 뿐이고, 지금도
  D1+폴링을 유지하는 이유는 비용이 아니라 "이미 잘 돌고 새 인프라·배포가 안 늘어난다" 쪽이다. 모든 액션(POST)은 자기 응답으로 즉시 상태를 갱신하므로
  (폴링을 기다리지 않음 — 트레이딩 스토어와 동일) 폴링 지연은 "남이 한 일이 내 화면에 보이기까지"
  에만 영향을 준다.
- **⚠ 폴링 간격은 적응형이고, 그 전제는 "GET 이 싸다"는 것**(`useDungeonStore.delayFor`):
  진행 중 **0.5초** / 로비 1초 / 종료 2초 / 방 없음 4초. `setInterval` 이 아니라 자기 자신을 다시
  예약하는 `setTimeout` 루프라 매 틱마다 방 상태로 간격을 다시 계산한다.
  **간격을 더 줄이려면 반드시 서버 GET 비용부터 확인할 것** — 처음엔 GET 한 번이 D1 왕복 6회였고
  그중 2회가 쓰기(`ensureStats` 의 `INSERT OR IGNORE` 를 폴링마다 두 번)였다. D1 무료 플랜은
  읽기(5M/일)보다 **쓰기(100K/일) 한도가 훨씬 빡빡해서**, 그 상태로 0.5초 폴링을 켜면 4인 파티
  한 시간에 쓰기 10만 건을 넘겨 한도를 태운다. 지금은 (stats+내 방코드)/(방+파티원)을 각각 `batch`
  로 묶어 **왕복 2회·쓰기 0회**이고, stats 행은 실제로 없을 때만(계정당 평생 1회) INSERT 한다.
  클라도 직전 응답과 JSON 이 같으면 `setState` 를 건너뛰어(`lastSnapshot`) 0.5초마다 전체 트리가
  리렌더되지 않게 한다 — 타이머 카운트다운은 `GameBoard` 의 자체 250ms 틱이 따로 굴린다.
- **파티**: 방 코드(6자, 헷갈리는 O/0/I/1 제외)로 모인 1~4명, 각자 영웅 1종 선택(방 내 중복 불가).
  한 유저는 항상 최대 1개 방에만 속한다(`dungeon_players` 에서 `user_id` 로 자기 방을 역참조 —
  클라가 코드를 안 보내도 서버가 세션으로 "내 방"을 찾는다, 코드 위조로 남의 방을 조작할 수 없음).
- **영웅 6종**(`functions/_dungeonData.ts HEROES`), 각 16장 개인 덱(주 아이콘 9장 + 보조 4장 +
  와일드 2장 + 고유 특수카드 1장): 바바리안(힘, "결전의 함성"=요구치 한 항목 즉시 3) · 위저드(마법,
  "치유의 주문"=체력 +2) · 닌자(민첩, "그림자 밟기"=내 손패 보충) · 팔라딘(신성, "수호의 방벽"=다음
  함정 1개 무효) · 드루이드(자연, "자연의 부름"=파티 전원 손패 보충) · 음유시인(자연/마법이지만
  **덱 절반이 와일드**인 만능형, "영감의 노래"=남은 요구치에 총 2 자동 분배). 특수는 판당 1회이고
  손패의 특수카드는 일반 카드처럼 못 내며 `useSpecial` 액션 전용이다(서버가 거부).
- **⚠ 난이도는 인원수에 맞춰 스케일된다**(`partyScale`, 요구치는 3인 기준으로 적혀 있다): 1인 0.55배 ·
  2인 0.8배 · 3인 1배 · 4인 1.2배. 사람이 많을수록 초당 낼 수 있는 카드가 늘기 때문.
- **⚠ 파티가 낼 수 없는 아이콘은 'any' 로 완화된다**(`adaptReq`): 예컨대 바바리안(힘/민첩) 혼자
  들어간 판에서 «밴시»(신성+마법)를 만나면 와일드 2장으로는 절대 못 잡아 **타이머가 끝날 때까지
  교착**된다. 그래서 덱 생성 시 (1)파티가 커버하는 아이콘만 쓰는 몬스터를 우선 고르고 (2)그래도
  남는 미커버 아이콘은 «아무거나»로 바꾼다 → 어떤 영웅 조합이든 항상 클리어 가능하다.
- **손패는 파티 전원에게 공개**(원작처럼 다 같이 보고 소리치며 조합 — `PlayerOut.hand` 를 서버가
  모두에게 그대로 내려준다). 단 **개인 덱의 남은 순서와 몬스터/이벤트 덱의 남은 순서는 서버만
  안다**(`dungeon_players.deck_json`/`dungeon_rooms.deck_json`, 응답엔 개수만) — 트레이딩의 "체결가는
  서버가 fetch"·퍼즐의 "보드 정답은 서버만 앎"과 같은 서버 권위 원칙.
- **몬스터/함정/포션/보스**: 몬스터·포션은 `{아이콘:수량}` 요구치를 공개하고, 파티원 누구나 자기
  손패에서 맞는 아이콘 카드를 버려 기여 → 총합 충족 시 즉시 격파(포션은 격파 시 체력 회복, 최대
  `MAX_HP`=10)하고 다음 카드 공개. **함정은 공개 즉시 자동 발동**(체력 차감 + 전원 손패 일부 강제
  버림+리드로우)한 뒤 조용히 다음 카드로 넘어간다(연쇄 함정도 처리, `revealNext`). 팔라딘의 방벽
  (`dungeon_rooms.ward`)이 있으면 그 함정 하나가 통째로 무효화된다. **보스는 덱의 항상 마지막
  카드**(원작 관행)이고 2페이즈 — ⚠ 2페이즈 요구치(`req2`)는 **현재 카드가 들고 다닌다**(보스는
  이미 큐에서 빠진 뒤라 덱을 다시 뒤져도 없다). 클라에도 같이 내려가 "다음 페이즈 예고"로 보여준다.
- **이벤트 로그**(`dungeon_rooms.log_json`, 최근 20개): 함정 발동·격파·페이즈 전환·특수 사용·승패를
  서버가 방에 기록하고 `EventLog.tsx` 가 보여준다. **폴링 방식이라 내가 손패를 보는 사이에 함정이
  터지거나 몬스터가 격파될 수 있는데**, 그걸 놓치면 화면이 갑자기 바뀐 것처럼만 보인다.
- **⚠ 동시성 = `version` 컬럼 낙관적 동시성 제어(다인원 조건부 UPDATE)**: 트레이딩 전반의
  `UPDATE ... WHERE balance>=margin` 원자 가드 관용구를 다인원 상태로 일반화했다 — 여러 파티원이
  동시에 카드를 내도(`playCards`) `UPDATE dungeon_rooms SET ... WHERE code=? AND version=?` 로
  경합을 막고, 0행이면 재조회 후 재시도(`applyContribution`, 최대 5회). **⚠ D1 batch 는 조건부
  UPDATE 가 0행이어도 "성공"으로 본다**(editLimit/conditionalOpen 과 같은 교훈, §4) — 그래서 카드
  격파→다음 카드 공개(+함정 연쇄로 다른 파티원 손패 변경)·승패 확정은 **반드시 버전 가드 UPDATE 를
  단독으로 먼저 실행해 성공(`meta.changes>0`)을 확인한 뒤에만** 다른 플레이어 손패 갱신·통계 반영
  같은 후속 쓰기를 수행한다 — 성공 전엔 아무 것도 안 쓰므로 재시도가 항상 안전하다.
- **⚠⚠ 남의 손패를 쓸 땐 "바뀐 사람만, 버전 가드로"(카드 복사 버그)**: 격파 처리(`applyContribution`)는
  함정이 다른 파티원 손패를 건드릴 수 있어 파티원 행도 쓴다. 예전엔 **전원의 손패를 처리 시작 시점
  스냅샷으로 무조건 덮어썼는데**, 그 사이에 다른 파티원이 카드를 내면 그 사람의 손패가 **낸 카드까지
  포함된 옛 상태로 되돌아갔다** — 기여는 이미 집계됐는데 카드는 손에 돌아오는 **카드 복사** 버그였다
  (동시 입력이 잦은 4인에서 잘 터진다). 지금은 (1)함정이 실제로 바꾼 사람만 쓰고 (2)그 사람의
  `version` 이 그대로일 때만 쓴다. 가드에 걸리면 그 함정의 버림 효과만 건너뛴다(복사보다 훨씬 낫다).
  같은 이유로 닌자/드루이드의 손패 보충 특수도 전부 버전 가드로 쓴다. **`dungeon_players` 의
  hand/deck/discard 를 쓰는 코드를 추가할 땐 반드시 이 규칙을 지킬 것.**
  회귀 방지: 4인이 쉬지 않고 동시에 카드를 내는 스트레스 테스트로 **각 플레이어의 (손패+덱+버림)이
  항상 정확히 16장**임을 매 라운드 검증했다(복사가 생기면 즉시 16을 넘는다).
- **⚠ 동시 입력은 에러가 아니라 재시도 대상**: 다른 파티원의 격파 처리가 내 행 `version` 을 올리면
  `playCards`/`rest` 의 조건부 UPDATE 가 0행이 된다. 예전엔 그대로 "다시 시도해주세요"를 띄웠는데
  4명이 동시에 누르는 게 정상인 게임이라 **평범한 플레이 중에도 자주** 떴다 — 지금은 서버가 최신
  상태로 몇 번 다시 읽어 조용히 성공시키고, 정말로 카드가 넘어간 경우에만 사람이 읽을 수 있는
  이유("그 사이 다음 카드로 넘어갔습니다")를 돌려준다.
- **5분 타이머 = 폴링 시점 평가**(`expireIfNeeded`): `dungeon_rooms.ends_at` 을 그대로 클라에 실어
  보내 로컬에서 카운트다운만 그리고(Chart.tsx 카운트다운과 동일 패턴), 서버는 다음 poll/action
  요청이 들어올 때 `Date.now() > ends_at` 이면 그 자리에서 `status='lost'` 로 전환한다. 강제청산과
  달리 **돈이 걸려있지 않으므로 cron 불필요**(checkTriggers 의 "접속 시점에 평가" 철학 재사용).
- **승패**: 보스 2페이즈까지 클리어하면 승리(`status='won'`, 클리어 소요시간을 `dungeon_stats
  .best_clear_ms` 최단기록으로 갱신). 타이머 만료 / 파티 체력 0 / 전원 동시 지침(덱+버림더미+손패가
  모두 빈 상태, `allExhausted`) 중 하나면 패배(`status='lost'`). 승패 확정 시 파티 전원의
  `dungeon_stats.games_played`(+wins)를 한 batch 로 갱신.
- **방 나가기**: 로비/종료(승·패) 상태에서만 가능(`leave`), 진행 중(active)엔 이탈 불가(막판에
  파티원이 빠져 판이 깨지는 것 방지). 방장이 나가면 다음 참가자에게 방장이 승계되고, 마지막 인원이
  나가면 방이 삭제된다.
- **UI 설명 원칙**: 처음 들어온 사람이 규칙을 몰라 멈추지 않도록 `Rules.tsx`(로비에 기본 펼침)에
  전체 규칙을, `IconLegend` 로 아이콘 뜻을, 카드 타입마다 한 줄 힌트(`EVENT_TYPE_META.hint`)를,
  버튼마다 `title` 툴팁을 붙였다. 카드에도 이모지뿐 아니라 **속성 이름을 같이** 적는다(이모지만
  있으면 무슨 속성인지 안 읽힌다). **"전부 내기"**(`planAutoPlay`)는 지금 요구치에 쓸 수 있는 카드를
  한 번에 다 내서 클릭 수와 요청 수를 함께 줄인다 — 요구치를 넘겨 낭비하지 않도록 전용 아이콘을
  와일드보다 먼저, 남은 필요량을 넘지 않는 선에서 큰 값부터 배치한다.

## 9. 미니 RTS (ox64.app/s1, `src/sc/`)

> 스타크래프트1 스타일 실시간 전략 게임(테란 1종족, 컴퓨터와 1:1). 자원 채집 → 인구 관리 →
> 테크 → 교전이라는 핵심 루프를 재현했다. **블리자드 리소스는 전혀 쓰지 않는다** — 그래픽은
> 전부 도형으로 코드에서 그리고, 유닛 구성·수치도 감각만 맞춘 오리지널이다(퍼즐/5분 던전에서
> 원작을 그대로 베끼지 않은 것과 같은 방침).

- **⚠ 이 게임만 서버가 없다(전부 클라이언트)**: RTS 는 초당 수십 회 시뮬레이션이 필요한데
  Pages Functions + D1 폴링으로는 근처도 못 간다(5분 던전이 0.5초 폴링인 걸 생각하면 40배 차이).
  그래서 **온라인 대전을 포기하고 AI 대전 단일 플레이**로 만들었고, 서버 코드도 로그인도 없다
  (`/api/*` 를 아예 안 부른다). 다른 게임들과 달리 `functions/` 에 대응 파일이 없는 이유.
- **⚠ 전적은 D1 이 아니라 localStorage**(`ox64_s1_record`): 시뮬레이션이 통째로 클라에 있어서
  서버에 기록해봐야 콘솔로 얼마든지 위조할 수 있고, 그러면 트레이딩 잔고 같은 **진짜 서버 권위
  기록 옆에 가짜 권위 기록**이 하나 생긴다. 위조 가능한 값은 위조 가능한 곳에 둔다.
- **고정 틱 30Hz**(`TICK_S`): 렌더는 rAF 로 매 프레임 돌지만 시뮬은 누적 시간을 쪼개 항상 같은
  간격으로만 전진한다 — 안 그러면 프레임레이트에 따라 유닛 속도·공격속도가 달라진다. 탭 전환 등으로
  큰 dt 가 들어와도 한 번에 250ms 까지만 소화한다(갑자기 순간이동하지 않게).
- **맵**: 64×64 타일(타일 24px). **180° 회전 대칭**으로 생성해 양쪽 시작 조건을 같게 맞추고,
  생성 후 **두 본진이 실제로 이어져 있는지 플러드 필로 확인**해 안 되면 다시 만든다(바위가 맵을
  반으로 가르면 그 판은 시작부터 성립하지 않는다).
- **길찾기**: 그리드 A*(최소 힙, 대각선 모서리 관통 금지, 직선 구간 평활화). ⚠ **유닛은 장애물로
  넣지 않는다** — 넣으면 한 부대가 서로를 막아 길이 계속 끊긴다. 대신 겹침은 분리력(`separate`)으로
  밀어내고, 이동이 막힌 게 감지되면(`stuck`) 길을 다시 찾는다.
- **전장의 안개**: `explored`(한 번이라도 본 곳) + `visible`(지금 시야). 적 유닛은 시야 안에서만,
  적 건물은 한 번 본 자리면 계속 보인다(원작의 "마지막으로 본 모습"). 안 보이는 적은 클릭도 안 된다.
  ⚠ **안개는 플레이어 쪽만 계산한다** — AI 는 맵 전체를 보는 전지형이다(AI 용 시야를 따로 굴리는
  비용에 비해 체감 차이가 거의 없어 의도적으로 생략).
- **⚠ 카메라는 방향키만(WASD 아님)**: A=공격, S=정지/일꾼, D=디팟, B=건설, F=팩토리/파이어뱃처럼
  알파벳이 전부 명령 단축키라서, WASD 를 카메라에 주면 **명령을 누를 때마다 화면이 밀린다**.
  원작도 화면 이동은 방향키·미니맵·화면 가장자리다.
- **⚠ 게임 상태는 React state 가 아니라 ref**: 매 프레임 도는 루프가 state 를 읽으면 클로저가 낡고,
  state 를 쓰면 초당 60번 리렌더가 난다. React 는 HUD 표시에만 쓰고(8Hz 스냅샷), 시뮬레이션·입력·
  카메라는 전부 ref 로 처리한다. 미니맵도 10Hz 로만 다시 그린다(타일 64×64 를 60fps 로 칠하면
  그것만으로 프레임을 깎아먹는다).
- **⚠⚠ 모바일에서 시작 몇 초 뒤 흰 화면으로 튕기던 원인 = 캔버스 백버퍼 재할당 루프**:
  `canvas.width = …` 대입은 백버퍼를 **통째로 재할당**한다(폰 해상도면 한 번에 수 MB). 그런데
  모바일은 스크롤에 따라 주소창이 접혔다 펴지며 `clientHeight` 가 **프레임마다** 바뀌고, 예전 코드는
  크기가 1px 만 달라도 즉시 다시 잡았다 → 초당 60번 수 MB 재할당 → 몇 초 만에 탭이 메모리로 죽는다.
  방어를 세 겹으로 둔다: (1) 컨테이너 높이를 **`100dvh`**(주소창 뺀 실제 보이는 높이, 미지원 브라우저는
  `h-screen`=100vh 로 폴백) (2) 캔버스에 **`touch-action: none`** + `overscroll-behavior: none` 으로
  스크롤/핀치줌 자체를 브라우저에 넘기지 않음 (3) 그래도 남는 흔들림은 **8px 임계값** 아래면 무시.
  **캔버스 크기를 다시 잡는 코드를 건드릴 땐 이 임계값을 없애지 말 것.**
- **⚠ 터치엔 우클릭이 없다 — 탭 하나가 선택과 명령을 겸한다**: 모바일에선 우클릭이 없어서 그대로 두면
  이동·공격·채집을 **아예 시킬 수 없다**. 규칙: **내 유닛/건물을 탭하면 선택, 그 외(빈 땅·적·자원)를
  탭하면 지금 선택한 것들에게 명령**(드래그는 데스크톱과 같이 범위 선택). 마우스는 기존 좌클릭=선택 /
  우클릭=명령 그대로다(`pointerType === 'touch'` 로만 분기). 화면 가장자리 스크롤도 마우스 전용 —
  터치는 손을 뗀 뒤에도 마지막 좌표가 남아 화면이 혼자 밀린다.
- **⚠ 게임 루프 예외는 에러 바운더리가 못 잡는다**: rAF 콜백은 React 렌더 밖이라 `ErrorBoundary` 가
  잡지 못하고, 화면만 멈춘 채 원인이 아무 데도 안 남는다(폰에선 콘솔을 볼 방법도 마땅치 않다).
  그래서 루프 본문을 `try/catch` 로 감싸 메시지를 화면에 띄우고, React 렌더 쪽은 별도로
  `ErrorBoundary` 가 받는다 — 흰 화면 대신 항상 무엇이 터졌는지가 보이게.
- **AI**: 0.5초마다 판단하고 사람처럼 정해진 순서로 확장한다(일꾼 14기 → 인구 → 배럭 → 리파이너리 →
  팩토리 → 병력 → 기준선 넘으면 공격, 밀리면 후퇴 후 재집결). ⚠ **미네랄이 남으면 생산 시설이
  부족하다는 뜻** — 예전엔 배럭 상한 3·대기열 1칸이라 AI 가 미네랄을 1,000 넘게 쌓아두고도 병력을
  못 뽑았다. 지금은 자원이 쌓이면 배럭을 6개까지 늘리고 대기열도 최대 3칸까지 채운다.
- **⚠ 검증은 헤드리스로 한다**: 빌드가 통과한다고 게임이 되는 게 아니라서, `Game` + `AI` 둘을
  붙여 **AI 대 AI 로 끝까지 돌려** 채집·건설·생산·교전·승부가 실제로 일어나는지 확인했다(`AI` 가
  owner 를 생성자로 받는 이유). 실측 12판 전부 정상 진행, 판당 3~6분에 결착. 렌더러는 시뮬이 한 줄도
  실행하지 않으므로 **가짜 2D 컨텍스트를 물려 202프레임을 그려보는** 별도 검증을 돌렸다.
  ⚠ 같은 코드끼리 붙이면 P0 가 7~8할 이긴다 — 한 틱 안에서 엔티티 순서대로 처리해 먼저 생성된 쪽이
  먼저 쏘기 때문(순차 시뮬의 구조적 특성). 사람이 P0 라 이 미세한 이점은 플레이어 쪽으로 간다.

## 10. 다음 작업 후보 (백로그)

- [x] 서버 권위 백엔드(D1) + 친구 랭킹
- [x] 이름+패스코드 로그인
- [x] 반응형 모바일/PC, Proxima Nova, favicon
- [x] 지정가/스탑로스/테이크프로핏 주문 + 미체결 목록 (서버, `functions/_trading.ts` checkTriggers)
- [x] 사용자 설정 UI(테마 다크/라이트/고대비/폰트 크기, 거래모드 Easy/Standard)
- [x] 강제청산가 계산 + 표시, 강제청산(계좌 파산) 시스템 + 리필(1일 3회)
- [x] 인터벌 전환 UI(초봉 포함)
- [x] 거래 내역 패널(PositionsPanel "주문내역" 탭)
- [x] 부분 청산
- [x] 호가창(바이낸스 부분 호가 스트림) + 모아보기(가격 그룹핑) + 클릭 시 지정가 반영, Easy 모드에선 숨김 + ON/OFF 옵션
- [x] Easy 모드 단순화(슬라이더+롱숏만, 부분청산 불가) / OX·USDT 가상 코인 현물 유저간 주문매칭(예시 1종)
- [x] OX/USDT 를 별도 모달에서 메인 SymbolSelect/Chart/OrderBook/OrderPanel/PositionsPanel 로 통합 + 마켓메이커 봇(랜덤워크 유동성 공급, LLM 아님)
- [x] *.pages.dev → ox64.app 301 리다이렉트(functions/_middleware.ts)
- [x] 강제청산 + OX 마켓메이커 봇을 접속 여부와 무관하게 5분마다 자동 실행(cron/ 별도 Worker, 배포 완료)
- [x] OX/USDT 를 레버리지 롱/숏 전용으로 재통합(가상 전용 매칭/보유OX 개념 제거) — OrderPanel/PositionsPanel 가상분기 삭제, fetchPrice(env,symbol) 가 OX 만 봇 내부가격으로 분기
- [x] 호가창 역전 버그 수정(cancel-and-requote), 가상심볼 차트 줌 리셋 버그 수정
- [x] OX 실제 호가창 매칭 엔진(`matchLimitPendingAgainstBook`/`matchMarketOxOrder`/`sweepRestingOxPendings`) — 유저 주문이 봇 호가를 가격-시간 우선순위로 walking 체결(있는 물량만·실제 호가 가격·최우선호가보다 유리하게는 안 삼·잔량 대기), 봇 유동성 증대. "20만개가 유령가격에 즉시 체결"·호가 역전·"체결 안 됨" 근본 해결(ref 한 값 전량체결 방식 폐기)
- [x] 호가창에 호가/체결 탭 분리(실제 심볼도 바이낸스 aggTrade 연동), 매수/매도 좌우 2열 레이아웃
- [x] 헤더: 현금잔고 대신 평가자산 표시 + 모바일 1줄 컴팩트화(더보기 드롭다운)
- [x] 평가자산 공식에 잠긴 증거금 포함(진입 즉시 강제청산 버그 수정) — 서버 강제청산/리필/랭킹 + 클라 Header/PositionsPanel/Chart 전부 `잔고+Σ(margin+미실현)` 로 통일
- [x] `state` 응답에 `markPrices` 추가 — OX 미열람 시에도 전 포지션 청산가 계산, 진입 직후 청산가 즉시 표시(서버와 동일 시세)
- [x] OX 가격 4자리 틱 무결성(`roundOx`), 수량 캡 1e15 로 완화(싼 코인 대량 거래), open 지연 감소(병렬 fetch + 시세 타임아웃), 시장가 주문이 지정가로 걸리던 클릭 버그 수정
- [x] 마켓메이커 DB I/O 대폭 감축(runMarketMaker 한 틱 수십 왕복 → 단일 batch 1왕복, 게이트 미통과 폴링은 read 1회, 봇 잔고 에스크로/정산 제거) + 매 틱 페어 전체 비우고 재호가(2봇 호가 역전 방지) + 게이트 전 sweep 제거 + `matchBuy`/`matchSell`/`placeBotOrder`/`botCreditStmt` 제거 + 호가 스프레드 타이트화 + 호가창 행 높이 컴팩트화(`pending_orders(symbol)` 인덱스 추가)
- [x] **OX 영속 캔들(`spot_candles` 테이블) — 차트 히스토리 영구 보존**: 모든 체결이 `candleUpsertStmts` 로 인터벌별 OHLCV 를 누적 upsert, `loadSpotCandles` 가 테이블에서 읽음(1s 만 최신거래 버킷팅 폴백). 예전 "최신 5000 거래 버킷팅"이 총거래 5000 초과 시 옛 캔들을 지우던 문제 해결. **체결 딜레이 감소**: 봇 재호가 게이트 3~8s→0.9~2.2s + 프론트 폴링(useSpotPoll·Chart OX 캔들) 3s→1.5s → 크로스되는 유저 물량이 ~1~2s 마다 체결(sweepRestingOxPendings 가 재호가 직후 호가창 매물을 즉시 체결)
- [x] **OX 청산 = 봇 호가창 walking(있는 물량만큼만)** — 예전 "매물 없어도 ref 한 값에 전량 청산" 버그 수정(`closePositionAgainstBook`/`marketCloseOxPosition`, 진입과 대칭). 매물 부족하면 부분 청산·잔량 유지, 없으면 거부. + **지정가 청산(limitClose, reduce-only)** — 포지션을 지정가에 청산 예약(증거금 안 잠금), OX=호가창 walking·실제코인=mark 크로스 시 limit 정산(`matchReduceOnlyOxPending`/`settleReduceOnlyClose`), 고아 pending 자동정리, SL/TP 루프 최신 포지션 재조회(이중청산 방어). UI: PositionsPanel 지정가 청산 입력 + 미체결 "롱/숏 청산" 뱃지 + 차트 청산 주문선
- [x] **미체결 주문 수정(editLimit)** — 취소 없이 지정가·수량 변경(진입 지정가는 증거금 델타 원자 재계산, ⚠ 잔고 차감 먼저 확정 후 pending UPDATE) + **차트 주문선 옆 취소(X) 버튼**(각 지정가 y좌표에 오버레이, 카운트다운과 동일 재배치 패턴) + **전 수치 세자리 콤마**(`fmtQty`/`fmtUsd`)
- [x] **봇이 유저 지정가 벽 존중(가짜 high 버그 수정)** — 기준가를 [최우선 매수벽, 매도벽]으로 클램프 + 벽에 눌리면 그 가격에 봇 호가를 얹어 sweep 이 벽을 실제 체결로 소비(벽 너머 가짜 체결/차트 high 제거, 벽은 저항으로 작동하다 소진되면 뚫림). 로컬 D1 검증: 매도벽 위로 체결가 안 넘어감·벽 실제 소비
- [x] **봇 거래량 대폭 증가 + 접속 무관 활성화** — 한 틱=합성체결 버스트(3~6건×1,000~8,000, 거래량 ~300→분당 수십만), cron 매 1분 `runMarketMakerBurst`(여러 틱 몰아 최근 55초에 분산 → 아무도 안 켜놔도 차트가 살아있음). `marketMakerTick`/`runMarketMaker`/`runMarketMakerBurst` 분리. ⚠ cron 워커 수동 재배포 필요
- [x] **포지션/미체결/주문내역의 심볼 클릭 → 그 심볼 차트로 이동**(PositionsPanel `setSymbol`)
- [x] **마감된 봉이 계속 바뀌던 버그 수정** — cron 버스트가 체결 시각을 최근 55초에 소급 분산해 이미 마감된 직전 분봉 버킷에 upsert 하던 것을, 실제 실행 시점(단조 증가) 기록으로 변경(`runMarketMakerBurst`)
- [x] **봇 매매 심리 모델** — IID 랜덤워크(무특징 노이즈)를 추세 지속·변동성 클러스터링·과열 후 평균회귀·탐욕/공포 국면 전환(비대칭)·라운드넘버 자석·팻테일로 교체(`nextMarketState`, 상태는 `spot_bot_state` 에 지속). 거래량/체결방향/호가 스프레드도 국면에 반응, 봉 안에 시가/고가/저가/종가와 꼬리 생성. 5일치 시뮬레이션으로 장기 안정성 검증
- [x] **로고 선명화** — 흐릿하던 워드마크(투명여백 41%+정사각형 왜곡+비정수 축소 보간)를 인라인 SVG(`Logo.tsx`)로 교체, 라이트 테마 대응(currentColor)
- [x] **사람처럼 떨어지는 호가(price clustering)** — 호가 가격을 라운드 격자(0.05/0.01/0.005/0.001)로 끌어당기고 그 자리에 물량을 몇 배로(1.4000 에 두꺼운 벽), 수량도 1,000/5,000 처럼 떨어지게(`humanQuotePrice`/`humanSize`). 매수 내림·매도 올림 스냅이라 호가 역전 불가. 체결 테이프도 같은 격자에 스냅
- [x] **거래 수수료 + VIP 등급** — 누적 거래대금(레버리지 포함) 기준 5단계(0.03%~0.001%), 전 체결 경로(시장가/지정가/청산/SL·TP/OX 호가창 walking)에 적용, 수익 원장(`fee_ledger`) 별도 보관, 헤더·랭킹 뱃지 + 주문 예상 수수료 표시
- [x] **호가창 현실화 2차** — 봇 호가 8→22단계(계정 수가 아니라 한 봇이 촘촘히 까는 방식), 수량은 불규칙하게(라운드는 18%만), 봇도 수수료 부과(`botFeeStmts`), 내 미체결 주문 호가창 강조(`mine`), 격자 스냅 부동소수 버그 수정(1.45→1.4499), 봇 실패 로깅
- [x] **VIP 진행도 표시** — 뱃지 클릭 → 진행 막대(%)·다음 등급까지 남은 거래대금·누적/수수료 통계·등급표 모달(`VipModal`), 모바일 더보기에 미니 막대, 한국식 단위(만/억/조) 내림 표기
- [x] **차트 테마 싱크 + OX 과거봉 로드 수정** — 거래량 막대 색을 캔들 색에서 파생(하드코딩 제거, 테마 변경 시 재도색), 가상코인 과거봉 lazy 로드 추가(서버 `endTime` 페이지네이션 + 폴링 병합으로 과거 구간 보존)
- [x] **거래소 수수료 수익 표시** — 랭킹 모달 상단에 총 수익(유저분/봇분 분리)·누적 거래대금. 원장 전체 스캔 대신 `users.total_fees` 집계(폴링 부담 제거)
- [x] **큰 벽 돌파력 강화** — 벽 소비량을 벽 크기 비례로(국면 공격성·심리 배수 + 6% 고래 스윕), 100만주 벽 4.5분→17~54초
- [x] **대량 시장가 진입/청산 완결** — 봇 사다리 소진 후 무한 유동성으로 잔량 흡수(`synthMaker`, 고정 24스텝·시장충격 상한 3%). 5천만~2억개도 한 번에 100% 체결(예전 부분청산 후 멈춤 → 버튼 반복 눌러야 하던 버그)
- [x] **체결 딜레이 추가 단축** — 봇 재호가 게이트 0.9~2.2s→0.45~1.1s, useSpotPoll 1.5s→1s, Chart OX 캔들 1.5s→1s, useTriggerPoll 5s→2.5s(+in-flight 가드). OX 볼 때 지정가 ~1초, 안 볼 때 ~2.5초 안에 체결(시장가는 원래 즉시)
- [x] **시장가 진입 부풀린 평단→강제청산 버그 수정** — 감당 못 할 수량을 좇아 합성 가격이 램프되며 평단이 +3% 부풀고 잔고 0→즉시 청산되던 것을, 진입 목표를 감당 가능 수량으로 선(先)클램프해 평단=시세 유지
- [x] **봇 재고/현금 정산 복원(`botFillStmts`)** — 유저 상대 체결마다 봇 `balance`/`ox_balance` 를 실제로 갱신(가드 없음=무한 유동성 유지, 이미 도는 batch 에 문장만 추가라 왕복 0). 2026-07-18 개편 이후 봇 잔고가 통째로 얼어붙어 있던 문제. 강제청산도 봇이 되사주게 해 재고 어긋남 방지 + `synthMaker` 를 두 봇 교대로(1번 봇에만 거래대금 700배 몰리던 편중 수정)
- [x] **조건부(스탑) 주문(`conditional_orders`)** — 트리거 가격 이상/이하 도달 시 시장가 진입(증거금 미리 안 잠금), 부분 체결 시 잔량 조건 유지(OX=봇 호가창 walking, 실제코인=가용만큼 체결). `settleConditionalOrder`(checkTriggers) + OrderPanel 조건부 탭 + PositionsPanel 조건부 탭
- [x] **OX 시장가 매칭 스냅샷 재설계 + 급락/정체 수정** — `matchMarketOxOrder`/`closePositionAgainstBook` 을 청크별 remote 왕복(리쿼트 경합 스핀으로 대량이 조금씩·느리게·멈춤)에서 **스냅샷 1회 → 메모리 walking → 단일 batch** 로(주문 크기 무관 상수 왕복, 1천만개도 단일 요청 전량 체결). 유저 체결이 anchor 를 끌어당겨(`ANCHOR_TRADE_PULL`) 매수→상승·유지(급락 방지). 가격 하한 0.02→0.0001(0.02 밑으로 못 내려가던 버그). marketable 주문을 벽에서 제외(시장이 예약가로 끌려가 교착되던 버그). budget 안전여유로 감당분 charge 부동소수 실패 방지
- [x] **세자리 콤마 전면 적용** — 편집 입력칸(주문/청산/SL·TP 수량·가격)에 표시용 콤마(`fmtNumInput`/`unfmtNum`, 상태는 raw 유지), 미실현PnL ROE% 콤마(`fmtPct`), 헤더 평가자산 뒤 "USDT", 청산수량 입력폭을 보유수량 텍스트 길이에 맞춰 확대
- [x] **USDT 단위 수량 입력 수정** — 입력칸 문자열(`amtInput`)을 진실원본으로 삼고 코인 수량(`sizeCoin`)을 파생 → USDT 로 입력할 때 왕복 재계산(coin toFixed(6))으로 값이 튀던 버그 해결. 청산 가능 수량 초과 청산 주문 거부(예약된 reduce-only 합산 검증)
- [x] **ox64.app/5m 5분 던전 추가** — 원작 실시간 협동 카드게임 재현(영웅 3종 축소판), Durable Objects 대신 D1+1초 폴링으로 동기화(무료 플랜 유지), `version` 컬럼 낙관적 동시성으로 다인원 카드 기여 경합 처리
- [x] **5분 던전 콘텐츠 확장 + 폴링 단축 + 카드 복사 버그 수정** — 아이콘 5종/영웅 6종/몬스터 24/던전 4개(난이도별), 인원수 난이도 스케일 + 파티 미커버 아이콘 완화(교착 방지). 폴링 GET 을 D1 왕복 6회·쓰기 2회 → 왕복 2회·쓰기 0회로 줄인 뒤 진행 중 간격 1s→**0.5s**(적응형). ⚠ 격파 처리가 전원 손패를 스냅샷으로 덮어써 동시 입력 시 **카드가 복사되던 버그** 수정(바뀐 사람만·버전 가드), 동시 입력 실패는 에러 대신 서버 재시도. 이벤트 로그·진행도·기여도 통계, 규칙 설명/아이콘 범례/"전부 내기" UI 추가
- [x] **ox64.app/s1 미니 RTS 추가** — 스타크래프트1 스타일 실시간 전략(테란 1종족, AI 대전). ⚠ 사이트에서 유일하게 **서버·로그인 없이 전부 클라이언트**(RTS 는 초당 수십 틱이 필요해 D1 폴링으로 불가능) — 고정 틱 30Hz, A* 길찾기, 전장의 안개, Canvas 도형 렌더, 전적은 localStorage. 헤드리스 AI 대 AI 12판으로 채집·건설·생산·교전·승부 검증 + 가짜 캔버스로 렌더러 202프레임 검증
- [x] **무한(반복) 조건부 주문 + 조건부 수정** — 체결돼도 주문이 남아 반복 실행. 두 방식: **`continuous`(기본)=조건이 참인 동안 계속**(폴링마다 ≈1초, `cooldown_ms`/`max_fills` 만이 브레이크 — 안 걸면 잔고 소진까지 진입하는 게 의도된 동작) / `rearm`=트리거 반대편으로 되돌아왔을 때만 1회씩. `continuous` 주문이 있으면 `useTriggerPoll` 이 2.5초→1초로 당겨진다. `editConditional` 로 트리거가·수량·조건·반복 설정을 취소 없이 수정(증거금 미잠금이라 잔고 정산 없는 단순 UPDATE, 수정 후 armed 되살리고 재평가). 로컬 D1 검증: continuous 가 폴링마다 정확히 1회씩 매수(0.001→0.006), 간격 5초 설정 시 5초에 1회로 제한, max_fills 도달 시 자동 삭제·정지, rearm 은 5회 폴링 동안 재실행 0건, 1회성 무회귀, OX 봇 호가창 경로도 동일(123→246→369→492)
- [x] **수량 상한 1e15 → 1e30(`MAX_ORDER_SIZE`) + 크기 비례 잔여 오차(`sizeEps`)** — "1000조 개를 넘기면 수량 오류" 버그 수정(싼 코인 고배율이면 슬라이더 100% 가 그대로 막혔다). 상한은 부동소수 폭주 방지용일 뿐이고 실제 한도는 증거금 가드가 잡는다(초과분은 "증거금이 부족합니다"/OX 는 감당분 클램프). 함께 전량·잔여 판정 오차를 수량 비례로 바꿔 대량 포지션이 먼지 없이 닫히게 했다. 로컬 D1 검증: OX 5e15 진입(전량 체결·평단 0.9956) → 전량 청산 시 포지션 삭제, 명시 수량 전량 청산도 동일, 지정가 3e15→4e15 수정·취소 시 증거금 정확 환급, 조건부 6e15 예약, BTCUSDT 2e15 는 "증거금이 부족합니다"(수량 오류 아님), 1e31/0 은 여전히 "수량 오류", 극단 1e30 주문은 감당분(1.006e19 개)만 체결되고 그것도 전량 청산됨
- [x] **접속 없이도 조건부·지정가·SL/TP 체결(`sweepTriggers`)** — "차트 화면 켜놨을 때만 조건부가 작동한다" 제보 수정. 평가 본체를 `runTriggers()` 로 추출해 접속 폴링(`checkTriggers`)과 cron sweep 이 공유하고, cron 워커가 매 1분 "봇 틱 3회 → 트리거 평가"를 4라운드 번갈아 돌려 봇 가격 경로를 여러 번 샘플링한다(실제 코인 시세는 라운드 간 재사용, OX 는 매 라운드 새로 읽음). 예전 cron 은 `sweepForcedLiquidations`(강제청산만)이라 앱을 닫으면 무한 조건부가 멈췄다. 로컬 검증(유저 요청 0회): continuous 4회/rearm/cooldown 60s 1회/1회성 삭제/실제코인 지정가 체결/SL 청산 전부 확인
- [x] **DB 무한 증식 차단(2026-07-31, ①③)** — 재호가가 옛 봇 호가를 `status='cancelled'` 로 마킹만 하고 안 지워 prod `spot_orders` 가 **1,358만 행**(하루 +86만), `spot_trades` 는 영구 보존이라 157만 행 → **DB 3.38GB / +200MB일, 10GB 한도까지 한 달** 남은 상태였다. 재호가를 `DELETE FROM spot_orders WHERE pair=?` 로 바꾸고(체결로 `filled` 이 된 행까지 청소) 체결 테이프는 6시간만 보존(`TRADE_RETENTION_MS`, 차트 히스토리는 `spot_candles` 가 영구 보관). 로컬 검증: 18회 폴링 동안 `spot_orders` 가 44행에 **고정**(이전엔 틱마다 +44), 취소 잔재 0, 호가창/체결/캔들 정상. 기존 누적분은 일회성 정리(schema.sql 2026-07-31 블록)
- [x] **봇 비용 구조 재설계 — 가상 코인 확장의 전제(2026-07-31, ②④⑤⑥)** — ①③ 으로 용량은 잡았지만 **틱당 문장 수**가 그대로여서 (a)월 rows written 포함분 초과 (b)**cron 1회가 D1 쿼리 한도(1,000)의 950** 이라 코인을 하나도 더 못 늘리는 상태였다. ②봇 사다리 44행을 `spot_bot_state.book_json` 한 칸으로(재호가 문장 45→**0**, 매칭은 `parseBook`/`makerLevels` 로 메모리 walking + `book_version` 낙관적 가드, `matchLimitPendingAgainstBook` 의 최대 500회 왕복 루프와 `recordVirtualFill` 의 50회 루프도 스냅샷 방식으로 통일 + pending claim-first 로 이중체결 방지, `spot_orders` 폐기) ④캔들 저장을 15종→**1m/1h/1d 3종**만 하고 나머지는 조회 시 롤업 ⑤봇 `fee_ledger` 행 제거 + 봇 부기 3문장→1문장 ⑥틱 예산을 코인 수로 나누고(`MM_TICK_BUDGET`) 유저가 보고 있으면 cron 이 물러남(`POLL_ACTIVE_MS`). **틱당 문장 ~70 → ~11**. 로컬 D1 검증: 시장가 진입/부분청산/전량청산/지정가 대기·즉시체결/지정가청산(reduce-only)/SL 히트/100만개 합성흡수 전부 정상, 호가창에 내 주문 표시·봇 재고 정확 상쇄(진입 −4000 → 청산 +4000)·`spot_orders` 0행·에러 0
- [x] **가상 코인 호가 단위를 유효숫자 4자리로 고정** — 소수 4자리 절대 고정(틱 0.0001)이라 저가에선 호가가 뭉텅이로 튀고 고가에선 의미 없는 자릿수가 붙던 것을, 가격대에 따라 틱이 10배씩 바뀌는 방식으로 교체(`_shared.roundVirtual`/`virtualTick`/`virtualPrecision`). 가격 격자·자석·테이프 스냅 상수를 전부 "틱 개수"로 바꾸고, 사다리 겹침을 한 틱씩 밀어 해소. 클라 표시 자릿수도 가격에서 파생
- [x] **봇 체결 테이프를 링 버퍼 한 칸으로 — 실제 $47 청구서의 원인 제거(2026-08-01)** — 7월분 청구서 **$47 이 전액 D1 Rows Written 초과**(9,700만 행/월, 포함분 5,000만)로 나왔다. `wrangler d1 insights` 로 실측하니 **하루 96만 행 중 76만(79%)이 봇 합성 체결**이었다 — 한 틱에 3~6건을 `spot_trades` 에 INSERT(초당 ~4.5행, D1 은 INSERT 를 "2+인덱스 수" 행으로 센다) 하고 6시간 뒤 같은 수를 DELETE 하는 구조. 7/31 에 사다리를 JSON 한 칸으로 옮긴 것과 **정확히 같은 실수를 테이프에서 반복**한 것(매 틱 통째로 교체되는 스냅샷을 행으로 쪼갬). `spot_bot_state.tape_json`(최근 400건 링 버퍼)로 옮겨 봇이 어차피 쓰던 상태 UPDATE 에 컬럼 하나만 붙이니 **테이프 쓰기 0행 + 보존기간 DELETE 소멸 → 틱당 4행**(상태 1 + 캔들 3), **월 2,900만 → 약 600만 행**(포함분의 12%). 유저 체결은 계속 테이블에 남기고 읽는 쪽이 병합(`mergeRecentTrades`). 로컬 D1 검증: cron 4회(16라운드) 동안 `spot_trades` **0행 증가**(이전 같은 조건 ~430행), 테이프 122건/3.5KB, 호가창 체결 30건 DESC·고유 key, 1s 캔들 버킷팅·1m 영속 캔들·유저 진입(테이블 1행 추가 후 병합 표시)·전량 청산 전부 정상. §6 에 과금 모델(INSERT=2+인덱스)·월 점검 명령·"봇 경로에 행을 남기지 말 것" 원칙을 못박음
- [x] **D1 예산 방어 2겹 — 재실행 간격 하한 + 서킷 브레이커(2026-08-01)** — 봇을 잡은 뒤 남은 유일한 무한 쓰기 경로가 `continuous` 무한 조건부였다(1초 간격 × 체결당 ~18행 = **월 4,650만 행**, 그것 하나로 포함분을 거의 다 먹는다). ①**재실행 간격 하한 5초**(`MIN_CONTINUOUS_COOLDOWN_MS`) — 저장값도 올리고 평가 시점에도 `effectiveCooldownMs` 로 판정해 **하한 도입 전에 만들어진 기존 주문까지** 막는다(월 930만 행). 하한 덕에 `useTriggerPoll` 의 1초 적응형 분기도 폐기(항상 2.5초). ②**서킷 브레이커**(`functions/_budget.ts` + `usage_meter`) — 봇 틱·반복 조건부만 계량해 이번 달 누적이 포함분의 90%(4,500만)를 넘으면 그 경로들이 조용히 멈추고, 수동 거래·강제청산·지정가·SL/TP 는 계속 돈다(Cloudflare 엔 D1 지출 상한 기능이 없어 코드로 만들어야 한다). ③**`npm run d1:budget`** — 이번 달 일별 쓰기/누적/월말 예상/예상 초과요금 표, 초과 페이스면 exit 1(토큰 있으면 GraphQL 정확 총계, 없으면 insights 폴백). 로컬 D1 검증: `cooldownSec=0` 으로 보내도 5000ms 로 저장, 5초 안 연타 6회에 추가 체결 0·하한 경과 후 1회씩 체결, 봇 틱 3회에 계량기 정확히 +18, 계량기를 4,600만으로 올리면 봇 틱·반복 조건부 **완전 정지**(book_version·fill_count 불변)하면서 **수동 진입은 정상 성공**
- [x] **일일 상한 + 계량 병목 통합 — "하루 100만 행" 보증(2026-08-01, 전 경로 감사)** — 월 상한만으로는 **반복 조건부 3개(하루 100만 = 월 3,100만)가 월 차단선(4,500만) 아래라 영원히 안 걸리면서** 하루 목표치를 넘긴다는 구멍을 감사에서 찾았다(반복 조건부는 **개수 제한이 없다**). ①**일일 2단 차단** — 반복 조건부 60만 / 봇 80만(봇 단독 최악 58.7만이라 못 닿는 최후 방어선, 80만×31=2,480만 이므로 일일선이 곧 월 보증). ②**계량 지점을 `feeAccrualStmts` 하나로 통합** — 모든 체결 경로가 반드시 지나는 병목이라 여기 한 줄이면 11개 체결 경로가 전부 잡히고, 경로별로 흩뿌릴 때의 누락 위험이 사라진다(조건부에 따로 넣었던 계량은 이중 계산이라 제거). ③**폴링 경로 전수 점검** — 클라의 8개 주기 요청 중 D1 쓰기를 만드는 건 `useSpotPoll`(봇 틱)과 `useTriggerPoll`(체결) 둘뿐이고 둘 다 계량·차단 아래임을 확인(던전 GET·캔들 조회·랭킹·심볼목록은 쓰기 0). ④과금 규칙을 정확히 정정: `바뀐 행 1 + 갱신된 인덱스 항목 수`(암묵 PK 인덱스 포함). 로컬 D1 검증: 실제코인/OX 체결 각 정확히 +20·주문 생성은 +0·이중 계산 0, 61만에서 **반복만 정지**(봇 5틱 +30 계속), 81만에서 **봇까지 정지**(전부 불변)하면서 수동 진입은 정상
- [x] **VIP 무한 레벨(등급표 → 공식)** — 13행 상수표(VIP0~12, 1단계당 100배)를 등비수열 두 개로 교체: 진입 거래대금 `1만 × 4^(t-1)`, 요율 `0.03% × 0.79^t`(하한 0.0000001%). 요율 곡선은 **옛 표를 근사**해 실제 수수료 부담은 그대로 두고 등급 칸만 3배 촘촘하게 만들었다(1e12·1e20·1e24 에서 옛 값과 거의 일치). `vipMinVolume`/`vipRate`/`vipTierWindow` 추가, 응답에 `vipFrom`/`vipCurve` 추가(무한이라 표를 통째로 못 보냄 → 창 + 하한 별도), `fmtFeeRate` 8자리, `VipBadge` 배색 3등급당 1칸. 검증: 1~45 등급 기준선 경계 정확(로그 오차 보정), 곡선이 옛 표와 1e10~1e28 구간에서 ±20% 이내
- [x] **아주 큰 금액/수량 축약 표시(`fmtUsdShort`/`fmtQtyShort`)** — 평가자산 1.02e31 같은 값이 콤마 표기로 나와 랭킹 행을 밀어내고 VIP 뱃지·순위를 화면 밖으로 보내던 문제(제보). 정수부가 임계 자릿수를 넘으면 한국식 단위로 축약(그 위는 지수 표기) + `title` 에 전체값. 적용: 랭킹(수수료 수익·평가자산·미실현) · 헤더 평가자산 · 주문패널 정보란(가용/명목가/증거금/수수료) · 포지션 패널(수량·증거금·PnL·주문내역) · 호가창 수량 · VIP 모달 누적 수수료. 함께 레이아웃 방어(`shrink-0`/`min-w-0`+`truncate`, 청산 수량 입력칸 폭 상한 20ch)
- [x] **봇 심리에 탐욕/공포 심화(2026-08-12)** — 기존 모델은 추세·변동성 뭉침 같은 **가격의 통계적 성질**이지 사람의 행동이 아니었다(무드가 최근 수익률의 즉석 함수라 관성이 없고, 시장이 고점/저점을 기억하지 않아 저항 돌파·지지 붕괴가 아예 없었다). 무드 군집(herding, 실효 지속계수 0.96 로 발산 불가)·고점/저점 기억(`peak`/`trough` → 탐욕/공포 게이지)·신고점 돌파 추격(FOMO)과 지지 붕괴 손절 연쇄(1.5배 크고 잦다)·**투매(`capitulation`) 국면**(공포 극단에서만 열리는 V 바닥, 하루 2~3회)·레버리지 효과(떨어질 때 더 시끄럽다)·버블 피로(euphoria 는 오래 끌수록 붕괴 확률 ↑)·**호가 깊이 비대칭**(공포장 매수/매도 두께비 0.5, 광기 5.1)을 추가. 상태 컬럼 2개가 늘었지만 **D1 쓰기 비용은 0 증가**(같은 행 UPDATE). 검증: `npm run sim:bot`(새 스크립트) 20일×4회에서 종가 0.90~1.23·1분봉 폭 2.2%·국면 점유율 calm 50/rally 26/pullback 16/panic 5/euphoria 3%·수익률 왜도 -1.5, 로컬 D1 에서 두 페어 봇 틱·시장가 진입/청산·지정가 대기 정상
- [x] **Cloudflare 무료 플랜 전환(2026-08-14)** — 읽기 1억 1,000만/일 · 쓰기 30만/일 이던 것을 무료 한도(읽기 500만 · 쓰기 10만 · **invocation당 D1 쿼리 50** · 요청 10만/일 · CPU 10ms)에 맞춰 재구조화. ①**`orders(user_id, created_at)` 복합 인덱스** — TEMP B-TREE 정렬로 유저당 35,249행을 읽던 쿼리가 읽기의 **96%(하루 1억 570만 행)** 였다. 단독 인덱스를 지워 쓰기 비용 증가 0, 쿼리 11.203ms→0.095ms. ②**차트 증분 폴링** — 1초마다 500봉 전체 재조회(하루 1,050만 행)를 "쉰 시간만큼만" 으로, 탭 숨김 시 정지. `SymbolSelect` 가 드롭다운만 열어도 봇을 굴리던 경로 제거. ③**봇 틱 = 순수 계산 + 커밋 1회** — 틱마다 D1 을 왕복(틱당 ~14쿼리·6행)하던 것을 `simulateTick`(순수) + `runBotTicks`(N틱 메모리 → 단일 batch)로. 진행 중 캔들은 `live_json` 에 누적하고 **버킷이 닫힐 때만** 테이블로 넘긴다(조회 시 병합). 봇 수수료·계량기는 120틱마다 정산. 실측 **틱 20회 → 쓰기 3행**(이전 120행). ④**cron sweep 1회 + 가격 범위 판정** — 4라운드 반복(=D1 쿼리 ~400)을 1회로 줄이되 버스트가 지나온 **기준가 경로의 최저/최고**로 트리거를 판정해 샘플링 정확도는 오히려 상승(`PriceRanges`/`rangeOfPath`). 강제청산만은 현재가 유지. `MAX_SWEEP_USERS`(8) 회전으로 유저가 늘어도 쿼리 수 고정. ⑤**부분 재체결 간격 하한 5초**(`PARTIAL_FILL_COOLDOWN_MS`) — 시장 깊이보다 큰 지정가가 재호가마다 조금씩 영원히 체결되며 **주문 하나가 하루 3,000건**을 만들던 경로(첫 체결은 그대로 즉시). ⑥**서킷 브레이커를 무료 기준 3단으로**(재체결 4.5만 → 반복 조건부 5.5만 → 봇 8만, 잃는 게 적은 순). 검증: 폴링 틱 5회=쓰기 5행, cron 3회(틱 20)=쓰기 3행·에러 0, 15초에 폴링 12회→체결 3건, 1m/1h/15m 롤업에 진행 중 봉 정상 병합, 버킷 마감 flush·유저 체결 행과의 합산, 시장가/지정가/TP(정확히 지정가에 체결) 전부 정상
- [x] **호가·체결 표시 개수 설정(5~50)** — 예전엔 `max-h-40`(=10행) 고정 높이에 depth 22 라 더 깊은 호가를 보려면 매번 열마다 스크롤해야 했다. 설정 모달에 슬라이더(+5/10/20/30/50 프리셋)를 두고 `useChartStore.bookRows` 로 영속화, 호가 두 열과 체결 목록의 높이를 `rows × 16px` 로 잡아 스크롤 없이 딱 그만큼 보이게 했다(기본 10 = 예전과 동일한 높이). 공급 상한도 함께 올림 — `BOOK_LIMIT` 40→50, 체결 병합 30→50, 클라 `MAX_TRADES` 40→50(전부 메모리 슬라이스라 D1 읽기·쓰기 증가 0, `spot_trades` 의 `LIMIT 30` 은 읽기 예산 때문에 유지). 실제 코인은 바이낸스 부분 호가 스트림이 20단계까지라 그 위로는 안 채워진다(설정 모달에 명시)

- [x] **PC 호가·체결 동시 표시 옵션 + 실제 코인 호가 갱신 5배** — 탭 전환 없이 호가(위)·체결(아래)을 같이 보는 옵션(`bookTogether`, PC 전용 — 모바일은 사이드바 폭이 없어 그대로 탭). 함께 "0.2초 갱신" 요청을 검토해 **가상 코인은 1초 유지**(요청 10만/일·쓰기 10만/일 한도에 한 사람 3~5시간이면 닿고, 게이트 때문에 화면도 안 빨라진다 — 위 §6 계산)하고, **비용이 0 인 쪽만** 당겼다: 실제 코인 호가 스트림 `@1000ms`→`@100ms`(200ms 스로틀), 봇 게이트 상한 1.1→0.95초(1초 폴링이 매번 새 틱을 받게 — 예전엔 ~15% 가 게이트에 막혀 2초처럼 보였다)

- [x] **체결 목록을 0.1초 해상도로 흘려보내기(클라 재생) + 체결 수량 방향색** — 폴링 주기(1초)는 요청·쓰기 한도 때문에 못 줄이지만, 한 폴링에 오는 체결 3~12건을 0.1~0.25초 간격으로 한 건씩 내보내 실제 테이프처럼 흐르게 했다(`dripTrades` — **요청·D1 읽기·쓰기 증가 0**, 대가는 가장 새 체결이 최대 0.7초 늦게 보이는 것). 체결 행의 수량도 가격과 같은 테이커 방향색으로. 가상 시계 시뮬레이션(폴링 60회)으로 정렬 유지·이미 본 체결 보존·다음 폴링 전 완료·누락 0 검증 + 실측 **초당 4.8회 공개 / 최대 표시 지연 600ms**(그 이상 잘게 쪼개도 초당 체결 건수가 상한이라 의미 없음)

- [x] **체결내역 매수/매도 색이 뒤집혀 보이던 문제(라벨을 가격 방향에서 파생)** — 봇이 체결 라벨을 `Math.random() < buyProb` 로 **인쇄 가격과 무관하게** 뽑고 있어서 상승틱의 38.9%가 빨강·하락틱의 43.1%가 초록으로 찍혔다(실측 9.4만 건, 일치율 49.5% = 동전 던지기). tick rule(Lee-Ready)로 교체 — 직전 체결보다 비싸면 매수·싸면 매도·같으면 직전 라벨 계승. 실측 불일치 **0%**, 국면 편향은 그대로(틱 상승 구간 매수라벨 67.9% / 하락 29.5%), 가격 경로엔 손 안 댔으므로 `npm run sim:bot` 지표 불변(1분봉 2.16%·acf1 0.264·국면 점유율 동일). 겸사겸사 **maker/taker 구분**(`Aggressor`)을 넣어 **걸려 있던 유저 지정가가 봇 호가에 채워질 때는 봇이 taker** 로 찍히게 했다(실제 거래소 규칙 — 라벨만 뒤집고 장부는 유저 방향 유지)

- [x] **D1 읽기/쓰기 다이어트 2차(2026-08-20)** — `wrangler d1 insights` 실측으로 "아무 기능도 안 하는 몫"만 골라냈다. ①**봇 틱 선점(claim) UPDATE 제거** — 게이트 통과 직후 `last_run` 만 찍던 별도 쓰기가 하루 **4,688행(전체 쓰기의 19%)** 이었다. 틱 계산이 순수 함수라 커밋의 `last_run` 가드가 선점을 그대로 대신한다(진 쪽은 0행 → 틱 폐기 + 가격 경로도 빈 배열 반환). ⚠ 같은 가드를 **닫힌 캔들 flush 에도** 걸었다 — batch 는 0행 UPDATE 를 실패로 안 봐서 가드가 커밋에만 있으면 진 쪽의 캔들만 반영돼 거래량이 부푼다. ②**체결내역 조회 창 1시간 → 3분** — 하루 **16.3만 행(읽기의 41%, 1위)** 을 읽었는데 `mergeRecentTrades` 가 상위 50건만 쓰고 봇 테이프 혼자 그 50건을 최근 11초로 채우므로, 나머지는 정렬에서 밀려 버려지는 행이었다. ③**계량기 조회를 오늘 한 행만** — `day LIKE '2026-08%'` 가 달 전체를 SUM 해 조회당 19행(월말 31행) × 하루 1,026회 = 1.99만 행이었고, 그 월 누적은 차단 판정에 쓰지도 않았다(무료 플랜 한도는 일 단위). ④**액션 응답도 주문내역 증분** — 폴링엔 `ordersSince` 를 적용해뒀는데 `POST /api/order` 응답만 누락돼 액션마다 50행을 다시 읽었다(하루 3.8만 행). 클라가 커서를 들고 모든 주문 액션에 실어 보낸다(`api.ts setOrdersCursor`). 합계 **쓰기 −19% · 읽기 −55%**. 로컬 D1 검증: 순차 폴링 5회=커밋 정확히 5, **동시 폴링 8회=커밋 정확히 1**(중복 requote 차단), cron 버스트 3회=페어별 커밋 3 + 닫힌 버킷만 캔들 4행, 상태 행 없는 페어 부트스트랩 후 사다리 22/22 정상, 가드 불일치 시 캔들 upsert 가 실제로 스킵됨(volume 100→125, 미일치분 50 반영 안 됨), 액션 응답 `ordersPartial=true`·증분 2건, 시장가 진입/청산 무회귀

- [ ] 가상 코인 3종 이상 추가 — 페어 파라미터화·봇 재고 분리는 끝났고(`VIRTUAL_PAIRS`/`bot_inventory`) `VIRTUAL_SYMBOLS`+`spot_bot_state` 시작가 행만 추가하면 된다. 틱 예산은 코인 수로 나눠 쓰므로 비용은 안 늘지만 코인당 움직임이 성겨진다
- [ ] 미니 RTS 확장(종족 추가, 유닛 다양화, 난이도 선택, 리플레이)
- [ ] 펀딩비 반영
- [ ] 랭킹 새로고침 최적화(현재 5초 폴링 → 서버 캐시/집계)
