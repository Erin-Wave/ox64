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
├── schema.sql              D1 스키마(users[+refill_count/refill_date/ox_balance]/positions/orders/pending_orders[+reduce_only=지정가 청산]/spot_orders/spot_trades/spot_candles[OX 영속 캔들]) — wrangler d1 execute 또는 D1 Console 로 적용
├── vite.config.ts          @ alias(src), charts/rx 청크 분리
├── tailwind.config.js       색상 토큰이 CSS 변수 참조(rgb(var(--color-x) / <alpha-value>)) — 실제 값은 src/index.css 테마 블록
├── cron/                   ── 접속자 없이도 돌아가야 하는 백그라운드 작업 전용 Cron Worker (메인 Pages 프로젝트와 별도 배포) ──
│   ├── wrangler.toml       name="ox64-liquidation-cron", 같은 D1(ox64) 바인딩, [triggers] crons=["*/5 * * * *"](5분마다)
│   └── index.ts            scheduled() 가 5분마다 functions/_trading.ts sweepForcedLiquidations() + functions/api/spot.ts runMarketMaker() 둘 다 호출. fetch() 는 CRON_SECRET 헤더로 보호된 수동 트리거(테스트/즉시 재실행용)
├── functions/              ── 백엔드 (Cloudflare Pages Functions, /api/*) ──
│   ├── _middleware.ts      전역 미들웨어 — Host 가 ox64.app/localhost 가 아니면(*.pages.dev 포함) ox64.app 으로 301 리다이렉트(Pages 는 pages.dev 서브도메인을 끄는 대시보드 옵션이 없어서 미들웨어로 처리)
│   ├── _shared.ts          인증(HMAC 토큰/PBKDF2)·바이낸스 서버측 시세·D1 타입·loadState(positions/orders/pendingOrders)
│   ├── _trading.ts         checkTriggers(env,uid) — 접속(폴링) 시 강제청산→지정가→SL/TP 순으로 평가 / sweepForcedLiquidations(env) — 전 유저의 강제청산만 평가(cron/ 워커가 접속 여부 무관하게 호출)
│   └── api/
│       ├── login.ts        POST /api/login  (없는 이름=가입, 있으면 패스코드 검증→세션쿠키 30일 Max-Age=자동로그인)
│       ├── logout.ts       POST /api/logout (쿠키 제거)
│       ├── state.ts        GET  /api/state  (checkTriggers 호출 후 잔고+refillsLeft+포지션+주문+미체결주문, 인증필요)
│       ├── order.ts        POST /api/order  (open/close/limitClose/limitOpen/cancelLimit/editLimit/setSlTp — 서버가 체결가 fetch·손익 계산·D1 원자 갱신. close 는 OX 면 봇 호가창 walking 청산, limitClose 는 지정가 청산=reduce-only, editLimit 는 미체결 주문의 지정가·수량 수정)
│       ├── refill.ts       POST /api/refill (강제청산 안전망 — 1일 최대 3회, 1회 +10,000 USDT)
│       ├── spot.ts         GET /api/spot (OX/USDT 호가창·체결내역 "표시용" 시장 데이터, ?candles=1 로 캔들도) + runMarketMaker() (봇이 랜덤워크 기준가 주변에 호가 사다리를 깔아 만드는 합성 시세·호가·체결 — **한 틱=단일 batch(취소+사다리+합성체결+기준가)로 왕복 1회**, 봇 호가는 잔고 에스크로 안 함(봇 잔고는 어디서도 안 읽히는 write-only). OX 는 레버리지 롱/숏도 order.ts 로 실제 코인과 동일하게 거래됨, 체결가만 여기서 옴)
│       └── leaderboard.ts  GET  /api/leaderboard (친구 자산 순위=잔고+미실현PnL, 서버 시세)
├── public/
│   ├── favicon.png         아이콘(원본 src/resources/images/icon2_256.png)
│   └── fonts/              ProximaNova-{Light,Regular,Semibold,Extrabold}.ttf
└── src/                    ── 프론트 ──
    ├── App.tsx             세션확인→Login 또는 트레이딩 UI(반응형) + 랭킹/설정 모달
    ├── main.tsx            useSettingsStore 를 App 보다 먼저 import(저장된 테마 즉시 적용, FOUC 방지)
    ├── index.css           Tailwind + 테마 CSS 변수(:root/[data-theme=light|high-contrast]) + @font-face + tabular-nums
    ├── types.ts            도메인 타입(Candle/Order/Position[stopLoss/takeProfit]/PendingOrder/Side)
    ├── symbols.ts          거래 심볼 38종(바이낸스∩OKX) + VIRTUAL_SYMBOLS(OXUSDT)/isVirtualSymbol(체결가 소스만 다르다는 표시, 거래 로직은 동일) + 타임프레임 그룹(분/시간/일+) + KST_OFFSET(+9h 고정)
    ├── format.ts           fmtPrice(심볼 정밀도)/fmtVol(K·M·B)/precisionFromTick
    ├── services/
    │   ├── binanceRest.ts  초기 과거봉(스팟 REST) — 차트 표시용
    │   ├── binanceWs.ts    실시간 kline(스팟 WS) — 차트/현재가 표시용 + orderbookStream(부분 호가 스트림, 호가창용)
    │   ├── indicators.ts   EMA / Bollinger / RSI 계산
    │   └── api.ts          백엔드 클라이언트(/api/*, credentials 포함) — limitOpen/cancelLimit/setSlTp 포함
    ├── hooks/
    │   ├── useMarkPrices.ts   현재+포지션 심볼 가격 3초 폴링(다른 심볼 PnL 갱신). isVirtualSymbol 인 심볼은 바이낸스 배치조회에서 제외(안 하면 배치 전체가 깨짐)
    │   ├── useTriggerPoll.ts  로그인 시 5초마다 /api/state 재조회 → 서버 checkTriggers 를 실질적으로 구동시키는 폴링
    │   └── useSpotPoll.ts     현재 심볼이 가상(OXUSDT)일 때만 1.5초마다 /api/spot 재조회 → useTradingStore 의 spotBook/spotTrades(호가창·체결내역 표시용, 유저 개인 데이터 아님) 갱신. 이 폴링이 곧 봇 마켓메이커 클럭이라 짧게 잡아 체결 딜레이를 줄임
    ├── store/
    │   ├── useMarketStore.ts   symbol/interval(둘 다 localStorage 영속)/prices(심볼별 가격맵)/precisions(심볼별 소수자릿수)/connected/chartClickPrice+chartClickNonce(차트·호가창 클릭→지정가 입력 신호) + selectLastPrice/precisionOf
    │   ├── useChartStore.ts    차트 옵션(indicators: 기간/개수 자유 설정 가능한 EMA/BB/RSI 배열, visibleBars: 마지막 확대/축소 봉수, 카운트다운·거래량·매매마커·평단선·SL/TP선·지정가주문선) localStorage 영속
    │   ├── useSettingsStore.ts 테마(dark/light/high-contrast)+거래모드(easy/standard) localStorage 영속, setTheme 이 document.documentElement.dataset.theme 도 갱신
    │   └── useTradingStore.ts  서버 상태 캐시(positions/orders/pendingOrders/refillsLeft) + init/login/logout/openMarket/closePosition/limitOpen/cancelLimit/setSlTp/refill(OXUSDT 도 이 경로 그대로 탐) + spotBook/spotTrades/spotRefresh(OX 호가창·체결내역 "표시용" 시장 데이터, 유저 개인 잔고 아님)
    └── components/
        ├── Login.tsx           이름+패스코드 로그인/가입
        ├── Header.tsx          심볼(38+가상 1종, 공용목록, 정렬 가능)/현재가/연결/평가자산(잔고+미실현손익, 현금잔고 아님)/리필버튼(평가자산<=0 일 때만 활성화, N/3)/랭킹버튼/설정버튼/로그아웃. 모바일은 로고 숨김·아이콘만·"⋯" 더보기 드롭다운(랭킹/설정/유저/로그아웃)으로 한 줄에 수렴, `sm:` 이상은 기존 개별 버튼 레이아웃
        ├── SymbolSelect.tsx    심볼 드롭다운 — 실제 38종(바이낸스 ticker/24hr 폴링) + 가상 OX/USDT(뱃지) 를 **같은 목록·같은 정렬(심볼/가격/24h변동, 컬럼 헤더 클릭)에 통합**. OX 가격=`/api/spot` 최근체결가, OX 24h변동률=`/api/spot?candles=1&interval=1h&limit=24` 로 24h 전 시가 대비 계산(데이터 24h 미만이면 최초 시점 대비). `statOf(sym)` 이 심볼 종류에 따라 stat 소스만 분기해 정렬은 동일하게 처리
        ├── OrderBook.tsx       호가(매수 좌열·매도 우열, 각 최우선호가가 맨 위) / 체결(내부 탭으로 전환) — 실제 심볼=바이낸스 depth WS/aggTrade WS, 가상 심볼=useTradingStore.spotBook·spotTrades(useSpotPoll 1.5초 폴링). Standard 모드 + 옵션(useChartStore.orderBook) 둘 다 켜져 있을 때만 표시
        ├── Settings.tsx        테마 3선택 + 거래모드(Easy/Standard) 2선택 + 폰트 크기 3선택 모달
        ├── Clock.tsx           우측 구석 실시간 시계(KST, 시:분:초). 1초마다 자체 상태만 갱신하는 독립 컴포넌트(부모 리렌더 안 유발). Chart 툴바 우측에 마운트
        ├── Chart.tsx           Lightweight Charts: 타임프레임 그룹셀렉트(초봉 포함)·KST+9·OHLCV+인디케이터값 레전드(hover/터치, 종가 옆에 그 봉의 변동률 (종가-시가)/시가 % 표시)·툴바 우측 실시간 시계(Clock)·다음봉 카운트다운(트레이딩뷰처럼 우측 가격축의 현재가 티커=마지막 봉 종가 라벨 바로 아래에 붙임 — `priceToCoordinate`+`priceScale('right').width()` 로 위치 계산, WS 틱·폴링·팬/줌·1초 틱마다 갱신)·인디케이터(추가/삭제/기간편집)·매매 B/S/L 마커·포지션 평단선+청산가선(추정, 평단선 옵션에 묶임)·SL/TP 수평선·미체결 지정가 주문선(가격+수량, 매수녹색/매도적색)·차트 클릭→지정가 입력·테마 반응형 캔버스 재도색. 가상 심볼은 바이낸스 REST/WS 대신 api.spotCandles(3초 폴링, spot_trades 기반 서버 집계 캔들)로 분기하되 표시범위는 최초 로드 때만 설정(매 폴링마다 재설정하면 줌이 리셋되는 버그가 있었음)
        ├── OrderPanel.tsx      Easy=슬라이더로 비중만 정해 롱/숏 버튼 / Standard=시장가+지정가 탭·SL·TP 입력·수량 텍스트입력+단위(코인/USDT) 전환 (레버리지는 공통, 체결가는 서버가 fetch). **OXUSDT 도 이 컴포넌트 하나로 처리**(가상 전용 분기 없음 — 실제 코인과 완전히 동일한 레버리지 거래)
        ├── PositionsPanel.tsx  탭: 포지션(청산가 표시·(Standard 전용) 부분청산 수량 입력 + **지정가 청산 입력(비우면 시장가)**·SL/TP 인라인 편집, Easy 는 전량 시장가청산 버튼만) / (Standard) 미체결 지정가(reduce-only 는 "롱/숏 청산" 뱃지) / 주문내역(전체 체결 이력, 강제청산 하이라이트). **OXUSDT 도 이 컴포넌트 하나로 처리**(가상 전용 분기 없음)
        └── Leaderboard.tsx     친구 자산 순위 모달(5초 폴링)
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
- **PnL 표시 divergence**: PositionsPanel 미실현 PnL 은 클라 시세 기반 추정, 실현 손익·랭킹은 서버 시세라 미세 차이 가능(정상).
- **전 심볼 PnL 갱신**: `useMarketStore.prices`(심볼별 가격맵)를 (a)차트 WS(현재 심볼) + (b)`useMarkPrices` 3초 폴링(현재+보유 포지션 심볼들)으로 채운다. 예전엔 lastPrice 하나뿐이라 **다른 심볼 포지션 PnL 이 멈추던 버그** → prices 맵으로 해결. PositionsPanel 은 `prices[p.symbol]` 로 각 포지션 PnL 계산.
- **가격 정밀도(심볼별)**: 소수점 2자리 고정은 버그(예 0.0002345→0.00). `binanceRest.fetchPricePrecision` 이 exchangeInfo `PRICE_FILTER.tickSize` 로 심볼별 자릿수를 구해 (a)차트 series `priceFormat`(우측축·크로스헤어) 적용 + (b)`useMarketStore.precisions[symbol]` 저장 → Header 현재가·PositionsPanel 현재가/진입가/청산가·차트 레전드가 `fmtPrice(v, precisionOf(...))` 로 표기. 거래량은 `fmtVol`(K/M/B). (BTC/SOL=2, ALLO=4, PEPE=8, OX=4자리.) **⚠ precision 은 예전엔 차트가 "현재 보는 심볼"만 채워서, 다른 심볼 포지션의 가격이 소수 2자리(precisionOf 폴백)로 나오던 버그가 있었다 → `useMarkPrices` 가 보유 포지션·미체결·현재 심볼 전부의 precision 을 없으면 1회 조회해 채운다(가상 심볼은 4 고정).** PositionsPanel 포지션 탭은 현재가 컬럼(진입가 좌측)·수량 아래 증거금(USDT) 표기.
- **거래량 히스토그램**: 차트 하단 오버레이(반투명 그린/레드), `useChartStore.volume`(기본 ON) 토글. 우측 축에 최신 거래량 티커(`lastValueVisible`, 1.23M 형식). RSI/거래량 동시 표시 시 하단을 [캔들]/[RSI]/[거래량] 으로 스택.
- **기본 표시 봉수 + 과거봉 lazy 로드**: 초기 로드 후 `fitContent` 대신 `setVisibleLogicalRange` 로 **최근 ~38봉만** 표시(모바일 가독성). 왼쪽으로 스크롤해 보이는 논리범위 `from<10` 이면 `fetchKlines(.., endTimeMs=oldest-1)` 로 과거 500봉 prepend(`subscribeVisibleLogicalRangeChange`). prepend 시 인덱스가 밀리므로 `getVisibleLogicalRange`+오프셋으로 뷰 위치 보존. `loadingMore`/`noMore`(fresh<450=끝) 가드. symbol/interval 변경 시 리셋.
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
  - **⚠ OX/USDT 시장가 청산 = 봇 호가창 walking(있는 물량만큼만 청산)**: 예전엔 OX 청산이 호가창을 무시하고 `fetchPrice`(봇 ref) 한 값에 **전량** 정산돼, **호가창에 매물이 없어도(얇아도) 전 물량이 즉시 청산**되던 버그가 있었다. 이제 진입(`matchMarketOxOrder`)과 대칭으로 `spot.ts closePositionAgainstBook` 이 봇 호가를 가격-시간 우선순위로 walking 하며 **있는 물량만** 실제 호가 가격에 청산하고, 매물이 부족하면 **그만큼만(부분) 청산하고 나머지는 포지션에 남긴다**(호가가 아예 없으면 "청산할 수 있는 호가 물량이 없습니다"). PnL·증거금 환급은 실제 체결가(가중평균) 기준(슬리피지 반영). `order.ts close` 액션이 OX 면 `marketCloseOxPosition` 으로 분기.
- **⚠ 미체결 주문 수정(editLimit)**: 미체결 지정가 주문의 **지정가·수량을 취소 없이 수정**한다. 진입 지정가는 새 값으로 증거금을 재계산해 델타(신규−기존)만큼 잔고를 조정 — **잔고 차감을 먼저 원자 가드(`balance − delta >= −uPnL`)로 확정하고 성공했을 때만 pending 을 UPDATE 한다**(⚠ batch 로 묶으면 잔고 가드가 0행이어도 pending UPDATE 가 그대로 커밋돼 "증거금 없이 주문만 커지는" 상태가 된다 — D1 batch 는 조건부 UPDATE 0행을 실패로 안 봄). reduce-only(지정가 청산)는 증거금이 없어 값만 갱신. 수정 후 OX 는 새 가격으로 즉시 재매칭(marketable 이면 바로 체결). UI 는 `PositionsPanel` 미체결 탭의 "수정" 버튼(지정가/수량 인라인 편집) + 차트 주문선 옆 취소(X) 버튼.
- **⚠ 지정가 청산(limitClose, reduce-only)**: 포지션을 특정 가격에 청산 예약하는 기능(수량뿐 아니라 지정가로도 청산). `pending_orders.reduce_only=1` 로 쌓되 **증거금은 새로 안 잠근다(청산이므로, margin=0)**. 주문 방향(side)은 포지션 반대(롱 청산=`short`=매도, 숏 청산=`long`=매수). 체결 시 새 포지션을 열지 않고 대상 포지션(반대 side)을 그 수량만큼 줄인다. **OX** 는 제출 즉시 + 재호가 sweep + `checkTriggers` 가 `matchReduceOnlyOxPending`(위 `closePositionAgainstBook` 를 limitPrice 로 walking)로 봇 호가창에 매칭. **실제 코인** 은 `_trading.ts settleReduceOnlyClose` 가 mark 가 지정가를 크로스하면(매도청산 `mark>=limit`, 매수청산 `mark<=limit`) 그 지정가에 정산. 대상 포지션이 이미 없으면(전량청산·강제청산됨) 고아 pending 은 자동 삭제. 취소는 `cancelLimit`(margin=0 이라 환불 0). UI 는 `PositionsPanel` 청산 셀의 "지정가(비우면 시장가)" 입력 + 미체결 탭 "롱/숏 청산" 뱃지 + 차트 "청산 매수/매도" 주문선. **⚠ SL/TP 루프는 이제 포지션을 스냅샷이 아니라 최신 상태로 다시 읽는다** — reduce-only 청산이 같은 폴링에서 이미 줄이거나 없앤 포지션을 SL/TP 가 이중 청산(사라진 포지션에 잔고 재환급)하지 않게 하는 방어.
- **입력 검증**: 심볼 형식(USDT 페어), side∈long/short, `size>0 && size<=1e15`, leverage 1~125. ⚠ 수량 상한은 예전 `1,000,000` 이었는데 PEPE 등 **싼 코인은 정상적으로 수십억 개**를 거래해서 "수량 오류"가 나던 버그가 있었다 → `1e15` 로 완화(실제 한도는 `margin<=balance` 조건이 잡아주고, 이 캡은 부동소수 폭주 방지용 안전장치).
- **⚠ 진입 지연 감소**: 실제 코인 `open` 은 `checkTriggers`(보유 심볼 시세 fetch)와 체결가 `fetchPrice(symbol)` 를 `Promise.all` 로 **병렬** 실행한다(둘 다 끝난 뒤에만 잔고/기존포지션을 읽으므로 원자성 안전) — 예전엔 순차라 외부 시세를 두 번 왕복했다. 아울러 서버 시세 소스 fetch 에 `timedFetch`(2.5s AbortController) 를 걸어, 한 소스가 느리면 즉시 다음 폴백으로 넘어가 롱/숏 버튼 체감 지연의 tail 을 줄였다.
- **지정가(limitOpen)**: `pending_orders` 에 생성 시점 `limit_price` 기준 증거금을 즉시 잠금(조건부 UPDATE 동일 패턴). **실제 코인 38종**은 체결가를 재계산 없이 `limit_price` 그대로 사용(델타 정산 불필요, `checkTriggers` 가 `mark` 이 `limit_price` 를 크로스하면 체결). **OX/USDT 는 예외** — 봇 호가창을 실제로 walking 매칭한다(§ OX/USDT "실제 호가창 매칭 엔진", `spot.ts matchLimitPendingAgainstBook`): 있는 물량만 실제 호가 가격에 체결, 잔량은 대기. `cancelLimit` 은 잠근(잔량분) 증거금을 그대로 환불.
- **SL/TP(setSlTp)**: `positions.stop_loss`/`take_profit` (포지션당 각 1개). 값은 항상 포지션 방향 기준으로 검증(롱: `stopLoss<entry<takeProfit`, 숏은 반대) — `validSlTp()`.
- **강제청산(계좌 파산)**: `checkTriggers` 맨 앞에서 평가자산(위 정의: `balance + Σ(margin + 미실현손익)`)이 0 미만이면 **전 포지션 강제청산 + 미체결 지정가 전부 취소 + 잔고 0 으로 리셋**, 각 포지션은 `kind='liquidation'` 주문으로 기록(청산가=그 시점 서버 시세). 심볼 가격을 하나라도 못 받아온 라운드는 건너뜀(불완전한 데이터로 오청산 방지, 다음 폴링에 재평가). 트리거되면 그 라운드의 지정가/SL·TP 평가는 스킵(이미 다 정리됐으므로).
- **청산가 표시(추정치)**: `PositionsPanel`/`Chart` 가 클라에서 `entry - (balance + Σ전체margin + 다른 포지션들 미실현손익) / (size*dir)` 로 "이 포지션 가격이 얼마가 되면 계좌가 파산하는지" 를 계산해 보여준다 — 위 강제청산 조건과 동일한 식(증거금 항 포함)이지만 어디까지나 클라 추정(실제 체결은 서버가 다음 폴링에서 판단).
- **⚠ markPrices(청산가 즉시·일관 표시)**: 청산가/평가자산은 보유 심볼의 **현재가**가 있어야 계산되는데, 예전엔 클라가 그 값을 (a)차트 WS(현재 심볼만) (b)`useMarkPrices` 바이낸스 폴링(가상심볼 제외)으로만 채워서, **OX 를 안 보고 있으면 OX 포지션 현재가가 안 들어와 전 포지션 청산가가 통째로 안 나오고**, 진입 직후엔 폴링 전까지 청산가가 비어 있었다. 수정: `checkTriggers` 가 자기가 fetch 한 시세 맵을 반환하고, `loadState(env,uid,marks)` 가 이를 `markPrices` 로 응답에 실어보내면 클라 `useTradingStore.apply` 가 `useMarketStore.prices` 에 시드한다 → 서버 강제청산과 **똑같은 시세**로, 폴링을 기다리지 않고 즉시 계산(OX 미열람·진입 직후 포함). `open` 은 방금 체결가를, `close` 는 청산가를 marks 에 추가해 새 심볼도 바로 반영.
- **리필(`functions/api/refill.ts`)**: 강제청산으로 자산이 0이 됐을 때를 위한 안전망. **평가자산(잔고+전 포지션 미실현손익 합)이 0 이하일 때만 지급** — 포지션이 있으면 서버가 그 심볼들 시세를 fetch 해 판정(가격 하나라도 못 받아오면 거부, 오판정 방지). 자산이 남아있으면 거부. 통과하면 `users.refill_count`/`refill_date`(KST 날짜)로 **1일 최대 3회, 1회 +10,000 USDT**. 날짜가 바뀌면 `refill_date !== 오늘` 이라 카운트를 0으로 취급(별도 리셋 cron 불필요 — `checkTriggers` 와 같은 "폴링 시점에 계산" 패턴). `loadState` 가 `refillsLeft` 를 계산해 응답에 포함. `Header.tsx` 도 동일한 식으로 클라 추정해 버튼을 미리 비활성화(실제 판정은 서버).
- **⚠ 체결 체크 = cron 없이 폴링 기반(지정가/SL·TP 한정)**: Cloudflare Pages Functions 는 정기 실행을 지원하지 않는다. 그래서 `functions/_trading.ts checkTriggers(env,uid)` 를 `state.ts`(GET, 클라가 `useTriggerPoll` 로 5초마다 호출)와 `order.ts`(POST 액션 진입 직후, 수동 조작과의 레이스 방지)에서 호출해 **그 유저의 요청이 들어올 때만** 강제청산/지정가/SL/TP 를 평가·체결한다. 체결가는 지정가/SL/TP 값 그대로 사용(슬리피지 모델링 없음).
- **강제청산만은 접속 여부와 무관하게 매시 자동 실행**: `cron/`(별도 배포되는 작은 Worker, Pages 는 Cron Trigger 미지원이라 분리) 가 매시 정각 `sweepForcedLiquidations(env)`(`functions/_trading.ts`) 를 호출해 **포지션이 있는 전 유저**를 훑어 강제청산만 평가·체결한다(지정가/SL·TP 는 여전히 접속 기반 — 강제청산만 이 요청을 받았다는 이유). `checkTriggers` 의 강제청산 로직을 `liquidateIfBankrupt()` 로 추출해 1인분(`checkTriggers`)과 전체(`sweepForcedLiquidations`) 양쪽에서 재사용. 같은 D1 을 바인딩하므로 별도 동기화 불필요. 배포·시크릿 설정은 §5 참고.
- **아직 없음**: 펀딩비, 수수료.

### OX/USDT (서버 = `functions/api/order.ts` + `functions/api/spot.ts`) — 실제 코인과 동일한 레버리지, 체결가만 봇이 생성

**OX 는 다른 38종과 완전히 동일하게 레버리지 롱/숏으로 거래된다** — `OrderPanel`/`PositionsPanel`/
`order.ts` 어디에도 OX 전용 분기가 없다(가상 전용 매칭·에스크로·보유 OX 개념은 전부 제거됨, 예전엔
있었으나 "실제 코인과 다르게 할 이유가 없다"는 판단으로 통합). **유일한 차이는 체결가 소스**: 실제
코인은 OKX/Coinbase, OX 는 `spot.ts` 의 봇이 만드는 내부가격(`fetchPrice` 의 `isVirtualSymbol` 분기).

- **체결가 = 봇("AI") 이 만든 합성 시세**: `functions/api/spot.ts` 의 예약된 봇 유저 2명(`bot-mm-1`/
  `bot-mm-2`, `BOT_USER_IDS`, schema.sql 에서 시딩, 랭킹에서 제외) 중 한 명이 폴링 틱마다 기준가를
  랜덤워크로 살짝 옮기고(`spot_bot_state.ref_price`) 그 주변에 매수/매도 호가 사다리(레벨 8, 물량
  2000~10000)를 깐다. 이 기준가를 실제 코인의 OKX 시세 대신 그대로 체결가로 쓴다 — LLM 호출이 아니라
  결정론적 랜덤워크 알고리즘.
- **⚠ DB I/O 최소화(runMarketMaker 재작성, 2026-07-18)**: 예전엔 한 틱에 봇 호가 16개를 "개별 batch 로
  취소"(16 왕복)하고 다시 16개를 "개별 `placeBotOrder`"(각각 매칭 SELECT 2회+쓰기 = 32 왕복)로 깔아 한
  틱에 수십~100+ 문장/수십 왕복이 나갔다. 지금은 **(취소 1문 + 사다리 16문 + 합성체결 1문 + 기준가 1문)을
  단 하나의 `DB.batch`(왕복 1회)** 로 처리하고, 재호가 게이트(현재 `BOT_TICK_MIN/MAX_MS`=0.9~2.2초, 체결
  딜레이 감소용으로 예전 3~8초에서 단축)를 통과하지 못한 폴링은 **state read
  1회로 즉시 반환**한다(동시 폴링은 조건부 upsert 로 이 틱을 원자 선점 → 중복 requote 방지). `matchBuy`/
  `matchSell`/`placeBotOrder`/봇 정산(`botCreditStmt`)은 전부 제거했다 — **봇 잔고(users.balance/
  ox_balance)는 랭킹 제외·시세는 spot_bot_state·호가는 spot_orders 에서 읽으므로 "어디서도 읽히지 않는
  write-only" 값**이라, 취소마다 환불·체결마다 정산하던 왕복이 순수 낭비였다(무한 유동성 풀). 유저↔봇
  체결의 물량 소비만 조건부 UPDATE 로 원자 처리하면 되고 봇 잔고 숫자는 무의미하다.
- **⚠ 호가 역전 방지 = 매 틱 페어 전체 비우고 재호가**: 봇이 2명이라 "선택된 액터의 호가만" 취소하면
  다른 봇의 오래된 호가가 남아 랜덤워크 후 역전(최우선매수 > 최우선매도)이 생긴다(예전엔 봇끼리 크로스
  매칭이 이걸 정리했지만 그 왕복을 없앴다). 그래서 한 틱마다 `UPDATE spot_orders SET status='cancelled'
  WHERE pair=? AND status='open'`(두 봇 모두)로 봇 호가를 통째로 비우고 한 액터가 일관된 사다리를 다시
  깐다 — spot_orders 엔 봇 호가만 있어(유저 주문은 pending_orders) pair 전체를 지워도 유저 주문엔 영향
  없고, batch 원자성으로 호가창이 빈 순간은 노출되지 않는다. 봇끼리 체결로 테이프를 움직이던 방식 대신
  **합성 체결 1건을 같은 batch 안에서 기록**(체결가=새 기준가 mid, 매칭 왕복 없음)해 차트/체결내역이 계속
  움직이게 한다. 호가 스프레드는 실거래소처럼 타이트하게(base ~0.12%, 깊은 레벨로 갈수록 확대) 잡아
  시장가 체결이 mid 근처에서 이뤄지되 대량 주문엔 슬리피지가 생긴다.
- **⚠ 봇이 유저 지정가 "벽"을 존중(가짜 high 버그 수정)**: 예전엔 봇 기준가(랜덤워크)가 유저의 최우선 매도벽
  위로(또는 매수벽 아래로) 자유롭게 움직이고 그 값에 합성체결을 찍어서, **"1.1 에 큰 매도벽을 걸어둬도 봇이
  1.11 에 체결을 찍어 차트 high 만 1.11 로 가짜로 뜨고(벽은 안 팔림)"** 버그가 있었다. 실제 시장이라면 그 벽을
  먼저 소비해야 벽 너머 가격이 나온다. 수정: 매 틱 유저 pending 의 최우선 매수벽/매도벽을 한 쿼리로 구해
  기준가를 `[wallBid, wallAsk]` 안으로 **클램프**하고, 벽에 눌리면(press) 그 벽 가격에 봇 호가를 하나 더 얹어
  아래 `sweepRestingOxPendings` 가 **벽을 그 가격에 실제 체결로 조금씩 소비**하게 한다 → 벽 너머 가짜 체결이
  안 찍히고(차트 high 가 벽에서 멈춤), 유저 벽은 물량이 소진될 때까지 저항으로 작동하다 뚫린다(실거래소 동일).
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
  - 봇 maker 는 원자적 선점(조건부 UPDATE, 동시 이중체결 방지)으로 소비한다. 봇에게 대금/코인을 정산하던
    부기는 제거했다(봇 잔고는 write-only 무한 풀 — 위 "DB I/O 최소화" 참고). 봇 유동성은 크게 유지(레벨 8,
    물량 2000~10000).
  - 결과: 큰 주문은 실제 호가를 walking 하며 슬리피지와 함께 부분 체결되고 잔량은 대기하다 유동성이
    생기면 이어서 체결(가격이 위로 밀리는 시장충격 발생). 실제 코인 38종은 별도 봇 시장이 없어 기존
    `limit_price` 체결(`checkTriggers`)·외부시세 시장가 경로 그대로.
- **유저 체결이 합성 시장에 반영**: 진입(시장가/지정가)은 위 매칭 엔진이 봇 호가를 실제 소비하며 체결
  테이프(`spot_trades`)·기준가(`ref_price`)를 직접 갱신한다. **청산(close)·SL/TP** 는 여전히 서버 시세
  (ref)로 정산한 뒤 `spot.ts` 의 `recordVirtualFill()` 로 시장에 반영한다 — 체결내역에 기록하고 기준가를
  그 가격으로 당기며 **반대편 최우선호가부터 체결수량만큼 `spot_orders` 를 소비**한다(파생 청산은 mark
  정산이 표준이라 진입처럼 호가창을 walking 하진 않음). 봇 잔고는 무한 풀이라 조정 불필요.
- **⚠ 가격 정밀도(4자리 틱) 무결성**: OX 는 외부 거래소가 없어 봇이 만드는 가격이라, 예전엔 봇 기준가(랜덤워크)·호가(`.toFixed(6)`)·체결가가 4자리를 넘어(예 1.096912) 화면 표기(4자리)와 실제 체결이 어긋났다. 수정: `spot.ts roundOx(p)=Number((Math.round(p*1e4)/1e4).toFixed(4))` 로 **봇 ref/패시브호가/크로스호가/체결기록(recordVirtualFill)** 을 전부 0.0001 틱에 스냅하고, `order.ts` 는 유저가 넣은 **OX 지정가도 4자리로 라운딩**한다 → 실제 코인처럼 정해진 소수 자릿수 이상으로는 호가·체결이 생기지 않는다.
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
- **평단선/SL·TP선/청산가/미실현PnL/강제청산은 전부 공짜**: OX 포지션도 `positions` 테이블의 평범한
  한 행이라, `Chart.tsx`(심볼 필터)·`PositionsPanel.tsx`(청산가 계산)·`_trading.ts`(강제청산 평가) 가
  이미 심볼에 무관하게 동작하므로 별도 구현 없이 실제 코인과 똑같이 표시·평가된다.
- **잔존 컬럼**: `users.ox_balance`/`spot_orders`/`spot_trades` 는 스키마 변경 없이 남아있지만, 이제
  **봇 유저 2명의 내부 매매 전용**이다(실유저는 더 이상 참조/사용 안 함 — DROP COLUMN 마이그레이션은
  안 함, 그냥 안 쓰이는 채로 방치).

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
  - **⚠ `pending_orders.reduce_only`(지정가 청산, 2026-07-19)**: `npx wrangler d1 execute ox64 --remote --command "ALTER TABLE pending_orders ADD COLUMN reduce_only INTEGER NOT NULL DEFAULT 0"`. **코드(limitClose INSERT)가 이 컬럼을 참조하므로 코드 배포 전에 먼저 적용돼 있어야 한다** — prod 엔 이미 적용 완료. 재실행 시 "duplicate column name"(무시 가능).
- **Secret**: `SESSION_SECRET` = `wrangler pages secret put SESSION_SECRET --project-name ox64` 로 production 에 설정됨(랜덤 32B hex). wrangler.toml 엔 두지 않음.
- 재적용 명령: 스키마 `npx wrangler d1 execute ox64 --remote --file=./schema.sql` / 시크릿 `echo <값> | npx wrangler pages secret put SESSION_SECRET --project-name ox64`.
- **Pages 빌드 설정**(Git 연동): Build command=`npm run build`, Output dir=`dist`(wrangler.toml `pages_build_output_dir`). Functions 는 `functions/` 자동 번들. 바인딩/시크릿은 **새 배포부터** 적용.
- 상태 점검(데이터 안 건드림): `curl https://ox64.app/api/state` → `{"error":"unauthorized"}`(401)면 정상(함수+D1+시크릿 OK). 500 + missingEnv 메시지면 바인딩/시크릿 누락.

### 백그라운드 Cron Worker (`cron/`) — 메인 Pages 배포와 별개, **배포 완료·운영 중** (`ox64-liquidation-cron`)
- Cloudflare Pages 프로젝트는 Cron Trigger 를 지원하지 않는다(Durable Objects 도 Pages 안에서 새로 정의 불가 — 둘 다 별도 Worker 배포가 필요). 그래서 `cron/` 를 **완전히 별개의 Workers 프로젝트**로 배포했다(Git 연동 Pages 배포로는 자동 적용되지 않음 — Pages 를 재배포해도 이 Worker 는 그대로 유지됨).
- 배포 URL: `https://ox64-liquidation-cron.erinwaveofficial.workers.dev` (스케줄만 쓰고 fetch 는 수동 트리거 용도라 사람이 직접 방문할 일은 없음).
- 코드/스케줄 변경 시 재배포: `cd cron && npx wrangler deploy` (Pages 처럼 Git 연동 자동배포 아님 — 수동, `CRON_SECRET` 시크릿은 최초 1회만 설정하면 재배포해도 유지됨).
- 수동 재실행/점검: `curl -X POST https://ox64-liquidation-cron.erinwaveofficial.workers.dev/ -H "x-cron-secret: <값>"` → `{"liquidation":{"checked":N,"liquidated":M}}` (runMarketMaker 는 결과를 반환하지 않고 그냥 실행만 됨).
- 주기는 `cron/wrangler.toml` 의 `[triggers] crons`(현재 5분마다) — 강제청산·OX 마켓메이커 봇 둘 다 이 한 스케줄로 처리(§3 "마켓메이커 봇" 참고). 로컬 검증은 `cd cron && npx wrangler dev` 뒤 `curl http://127.0.0.1:8787/cdn-cgi/handler/scheduled`(스케줄은 로컬에서 자동 발화 안 됨, 수동 트리거만) — 로컬 D1 은 `wrangler dev` 와 `wrangler d1 execute --local` 이 별도 프로세스로 뜬 채 겹치면 데이터가 안 보일 수 있으니(포트 점유), 테스트 전 `netstat`/`tasklist` 로 이전 `wrangler dev` 잔여 프로세스가 없는지 확인할 것.

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
- **워드마크 로고**: 화면의 "ox64" 텍스트는 `src/resources/images/icon_256.png` 를 `import` 해 `<img>` 로 표시(Header/Login). 로고 바꾸려면 그 파일 교체 또는 import 경로 변경. (index.html `<title>` 의 "ox64" 는 탭 제목이라 유지.)
- **API 500 진단**: `functions/_shared.safe()`(핸들러 예외→500+메시지) + `missingEnv()`(D1/SECRET 미설정을 한국어로 안내)로 감쌈. 클라(`api.ts req`)가 `error` 필드를 그대로 throw→Login 화면에 표시. "HTTP 500"만 뜨고 원인 불명이면 이 래핑이 빠진 것.
- **폰트 = Proxima Nova(전체)**: `public/fonts/*.ttf` + `index.css` `@font-face`(weight 300/400/600/800), body/tailwind sans+mono 모두 Proxima. **한글 글리프 없음** → CJK 폴백(Apple SD Gothic/Malgun) 유지 필수. mono 도 Proxima라 숫자 정렬은 `font-variant-numeric: tabular-nums`.
- **수치 표기 = 세자리 콤마(`format.ts`)**: 가격은 `fmtPrice`(심볼 정밀도, `toLocaleString`), **수량/개수는 `fmtQty`**(콤마, 소수 최대 8자리·뒤 0 트림 — 예 1234567→"1,234,567"), **USDT 금액(잔고·손익·증거금·평가자산)은 `fmtUsd`**(콤마+소수 2자리). `fmtVol`(K/M/B)은 이제 공간이 좁은 차트 우측 축 티커 전용(레전드 거래량·호가창·포지션/주문 수량은 전부 콤마). 새 수치를 UI 에 추가할 땐 raw `toFixed`/원시 숫자 대신 이 헬퍼를 쓸 것(변동률 % 는 예외로 `toFixed`).
- **반응형**: `App.tsx` 모바일=세로 flex 스택(차트 45vh→주문→포지션), `md:`(≥768px)=2열 그리드(좌 차트+포지션 / 우 주문). 차트가 모바일서 좁던 원인=옛 가로 flex 의 `aside w-72` 고정폭 → 그리드 전환으로 해결.
- **DB 확인/수정**: 이제 서버 D1. `npx wrangler d1 execute ox64 --remote --command "SELECT name,balance FROM users"`. 잔고 리셋 등도 SQL 로. (구 `window.db`/DevTools IndexedDB 방식은 폐기 — 클라 조작 방지가 목적.)
- **인터벌→초 매핑 이중 관리**: `src/symbols.ts INTERVAL_GROUPS` 와 `functions/_shared.ts intervalSecFromCode`(OX 캔들 버킷팅용) 가 같은 값을 각자 보관한다(functions/ 는 src/ import 불가). 인터벌 코드를 추가/변경하면 두 곳 다 갱신할 것.
- **⚠ 시장가가 지정가로 걸리던 버그**: 차트/호가창 클릭(`setChartClickPrice`)이 예전엔 `OrderPanel` 을 무조건 지정가 탭으로 전환했다 — 시장가로 주문하려다 무심코 차트를 클릭하면 시장가 주문이 지정가로 걸렸다. 수정: 클릭은 **이미 지정가 탭일 때만** 지정가 입력을 채운다(시장가 탭에서의 클릭은 조회일 뿐 주문 유형을 안 바꿈). 지정가로 클릭 배치하려면 먼저 지정가 탭 선택.
- **⚠ 호가창 표시 개수 ≠ 서버가 주는 개수**: `functions/api/spot.ts loadSpotMarket()` 는 가격대별 최대 15단계까지 반환하는데, `OrderBook.tsx` 가 예전엔 그중 상위 8개만 잘라서 그렸다 — 스프레드에서 먼 곳에 큰 지정가(벽)를 걸어두면 정확히 그 주문이 8번째 밖으로 밀려 화면에서 통째로 안 보이는 버그가 있었다. 지금은 15개까지 보여주고 컬럼을 스크롤 가능하게 뒀지만(`BOOK_DEPTH`), 향후 표시 개수를 또 줄일 땐 서버 `LIMIT` 값과 맞춰야 한다.

## 7. 다음 작업 후보 (백로그)

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
- [ ] 수수료·펀딩비 반영
- [ ] 랭킹 새로고침 최적화(현재 5초 폴링 → 서버 캐시/집계)
