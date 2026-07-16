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
| **인증** | HMAC 서명 세션 쿠키 + PBKDF2 패스코드 | DB 세션테이블 불필요. 이름+패스코드 로그인 |

> **왜 서버 권위인가**: 클라이언트(IndexedDB/localStorage)에 둔 값은 콘솔로 100% 변조 가능
> → 랭킹 경쟁이 무의미해짐. 그래서 진실원본을 서버로 옮김. (구 IndexedDB/Dexie 구조는 제거됨.)

## 2. 폴더 구조 (역할 한 줄)

```
ox64/
├── index.html              SPA 진입(다크). favicon(/favicon.png) + Proxima Nova 로드
├── wrangler.toml           Pages+Functions 설정. D1 바인딩(DB, database_id 박음) 코드 관리 → Git 배포가 읽음
├── schema.sql              D1 스키마(users[+refill_count/refill_date/ox_balance]/positions/orders/pending_orders/spot_orders/spot_trades) — wrangler d1 execute 또는 D1 Console 로 적용
├── vite.config.ts          @ alias(src), charts/rx 청크 분리
├── tailwind.config.js       색상 토큰이 CSS 변수 참조(rgb(var(--color-x) / <alpha-value>)) — 실제 값은 src/index.css 테마 블록
├── functions/              ── 백엔드 (Cloudflare Pages Functions, /api/*) ──
│   ├── _shared.ts          인증(HMAC 토큰/PBKDF2)·바이낸스 서버측 시세·D1 타입·loadState(positions/orders/pendingOrders)
│   ├── _trading.ts         checkTriggers(env,uid) — 강제청산(계좌 파산) 체크 → 지정가/SL/TP 체결 체크 순으로 평가(서버는 cron 없음, 폴링 시점마다 평가)
│   └── api/
│       ├── login.ts        POST /api/login  (없는 이름=가입, 있으면 패스코드 검증→세션쿠키)
│       ├── logout.ts       POST /api/logout (쿠키 제거)
│       ├── state.ts        GET  /api/state  (checkTriggers 호출 후 잔고+refillsLeft+포지션+주문+미체결주문, 인증필요)
│       ├── order.ts        POST /api/order  (open/close/limitOpen/cancelLimit/setSlTp — 서버가 체결가 fetch·손익 계산·D1 원자 갱신)
│       ├── refill.ts       POST /api/refill (강제청산 안전망 — 1일 최대 3회, 1회 +10,000 USDT)
│       ├── spot.ts         GET/POST /api/spot (OX/USDT 가상 코인 현물 — 유저 대 유저 지정가 주문매칭, 레버리지 없음. GET ?candles=1 로 spot_trades 기반 캔들 제공. runMarketMaker() 로 봇 유동성 공급도 여기서)
│       └── leaderboard.ts  GET  /api/leaderboard (친구 자산 순위=잔고+미실현PnL, 서버 시세)
├── public/
│   ├── favicon.png         아이콘(원본 src/resources/images/icon2_256.png)
│   └── fonts/              ProximaNova-{Light,Regular,Semibold,Extrabold}.ttf
└── src/                    ── 프론트 ──
    ├── App.tsx             세션확인→Login 또는 트레이딩 UI(반응형) + 랭킹/설정 모달
    ├── main.tsx            useSettingsStore 를 App 보다 먼저 import(저장된 테마 즉시 적용, FOUC 방지)
    ├── index.css           Tailwind + 테마 CSS 변수(:root/[data-theme=light|high-contrast]) + @font-face + tabular-nums
    ├── types.ts            도메인 타입(Candle/Order/Position[stopLoss/takeProfit]/PendingOrder/Side)
    ├── symbols.ts          거래 심볼 38종(바이낸스∩OKX) + VIRTUAL_SYMBOLS(OXUSDT)/isVirtualSymbol + 타임프레임 그룹(분/시간/일+) + KST_OFFSET(+9h 고정)
    ├── format.ts           fmtPrice(심볼 정밀도)/fmtVol(K·M·B)/precisionFromTick
    ├── services/
    │   ├── binanceRest.ts  초기 과거봉(스팟 REST) — 차트 표시용
    │   ├── binanceWs.ts    실시간 kline(스팟 WS) — 차트/현재가 표시용 + orderbookStream(부분 호가 스트림, 호가창용)
    │   ├── indicators.ts   EMA / Bollinger / RSI 계산
    │   └── api.ts          백엔드 클라이언트(/api/*, credentials 포함) — limitOpen/cancelLimit/setSlTp 포함
    ├── hooks/
    │   ├── useMarkPrices.ts   현재+포지션 심볼 가격 3초 폴링(다른 심볼 PnL 갱신). isVirtualSymbol 인 심볼은 바이낸스 배치조회에서 제외(안 하면 배치 전체가 깨짐)
    │   ├── useTriggerPoll.ts  로그인 시 5초마다 /api/state 재조회 → 서버 checkTriggers 를 실질적으로 구동시키는 폴링
    │   └── useSpotPoll.ts     현재 심볼이 가상(OXUSDT)일 때만 3초마다 /api/spot 재조회 → useTradingStore 의 spot 슬라이스 갱신
    ├── store/
    │   ├── useMarketStore.ts   symbol/interval(둘 다 localStorage 영속)/prices(심볼별 가격맵)/precisions(심볼별 소수자릿수)/connected/chartClickPrice+chartClickNonce(차트·호가창 클릭→지정가 입력 신호) + selectLastPrice/precisionOf
    │   ├── useChartStore.ts    차트 옵션(indicators: 기간/개수 자유 설정 가능한 EMA/BB/RSI 배열, visibleBars: 마지막 확대/축소 봉수, 카운트다운·거래량·매매마커·평단선·SL/TP선) localStorage 영속
    │   ├── useSettingsStore.ts 테마(dark/light/high-contrast)+거래모드(easy/standard) localStorage 영속, setTheme 이 document.documentElement.dataset.theme 도 갱신
    │   └── useTradingStore.ts  서버 상태 캐시(positions/orders/pendingOrders/refillsLeft) + init/login/logout/openMarket/closePosition/limitOpen/cancelLimit/setSlTp/refill + OX 스팟 슬라이스(oxBalance/spotOpenOrders/spotBook/spotTrades + spotRefresh/spotPlace/spotCancel, balance 필드는 레버리지와 공유)
    └── components/
        ├── Login.tsx           이름+패스코드 로그인/가입
        ├── Header.tsx          심볼(38+가상 1종, 공용목록, 정렬 가능)/현재가/연결/잔고/리필버튼(평가자산<=0 일 때만 활성화, N/3)/랭킹버튼/설정버튼/로그아웃
        ├── SymbolSelect.tsx    심볼 드롭다운 — 실제 38종(심볼/가격/24h변동, 컬럼 헤더 클릭 정렬, 바이낸스 ticker/24hr 폴링) + 가상 OX/USDT(뱃지 표시, /api/spot 최근체결가 폴링) 를 같은 목록에 통합
        ├── OrderBook.tsx       호가창 — 실제 심볼=상위 20호가(바이낸스 부분 호가 스트림, 1초 갱신) / 가상 심볼=useTradingStore.spotBook(useSpotPoll 이 3초 폴링) 을 동일한 그리드·"모아보기"·클릭反映 UI로 렌더링. Standard 모드 + 옵션(useChartStore.orderBook) 둘 다 켜져 있을 때만 표시
        ├── Settings.tsx        테마 3선택 + 거래모드(Easy/Standard) 2선택 + 폰트 크기 3선택 모달
        ├── Chart.tsx           Lightweight Charts: 타임프레임 그룹셀렉트(초봉 포함)·KST+9·OHLCV+인디케이터값 레전드(hover/터치)·다음봉 카운트다운·인디케이터(추가/삭제/기간편집)·매매 B/S/L 마커·포지션 평단선·SL/TP 수평선·차트 클릭→지정가 입력·테마 반응형 캔버스 재도색. 가상 심볼은 바이낸스 REST/WS 대신 api.spotCandles(3초 폴링, spot_trades 기반 서버 집계 캔들)로 분기
        ├── OrderPanel.tsx      실제 심볼: Easy=슬라이더로 비중만 정해 롱/숏 버튼 / Standard=시장가+지정가 탭·SL·TP 입력·수량 텍스트입력+단위(코인/USDT) 전환 (레버리지는 공통, 체결가는 서버가 fetch). 가상 심볼: 레버리지·SL/TP 없이 매수/매도 버튼만, Easy=호가창 최우선가 기준 마켓성 지정가 자동계산, Standard=지정가 직접입력 — api.spotPlace 호출
        ├── PositionsPanel.tsx  실제 심볼 탭: 포지션(청산가 표시·(Standard 전용) 부분청산 수량 입력·SL/TP 인라인 편집, Easy 는 전량청산 버튼만) / (Standard) 미체결 지정가 / 주문내역(전체 체결 이력, 강제청산 하이라이트). 가상 심볼: 포지션→보유 OX/USDT 읽기전용, 미체결→spotOpenOrders(취소 가능), 주문내역→spotTrades
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
- **가격 정밀도(심볼별)**: 소수점 2자리 고정은 버그(예 0.0002345→0.00). `binanceRest.fetchPricePrecision` 이 exchangeInfo `PRICE_FILTER.tickSize` 로 심볼별 자릿수를 구해 (a)차트 series `priceFormat`(우측축·크로스헤어) 적용 + (b)`useMarketStore.precisions[symbol]` 저장 → Header 현재가·PositionsPanel 진입가·차트 레전드가 `fmtPrice(v, precisionOf(...))` 로 표기. 거래량은 `fmtVol`(K/M/B). (BTC/SOL=2, ALLO=4, PEPE=8자리.)
- **거래량 히스토그램**: 차트 하단 오버레이(반투명 그린/레드), `useChartStore.volume`(기본 ON) 토글. 우측 축에 최신 거래량 티커(`lastValueVisible`, 1.23M 형식). RSI/거래량 동시 표시 시 하단을 [캔들]/[RSI]/[거래량] 으로 스택.
- **기본 표시 봉수 + 과거봉 lazy 로드**: 초기 로드 후 `fitContent` 대신 `setVisibleLogicalRange` 로 **최근 ~38봉만** 표시(모바일 가독성). 왼쪽으로 스크롤해 보이는 논리범위 `from<10` 이면 `fetchKlines(.., endTimeMs=oldest-1)` 로 과거 500봉 prepend(`subscribeVisibleLogicalRangeChange`). prepend 시 인덱스가 밀리므로 `getVisibleLogicalRange`+오프셋으로 뷰 위치 보존. `loadingMore`/`noMore`(fresh<450=끝) 가드. symbol/interval 변경 시 리셋.
- **차트(Chart.tsx)**: 시간축은 **KST(+9h) 고정** — 차트에 넣는 모든 시간값에 `KST_OFFSET` 을 더해 라벨을 한국시간으로(LWC v4 는 UTC 라벨이라 오프셋 방식). 타임프레임=`symbols.ts INTERVAL_GROUPS`(분/시간/일+, `<optgroup>`). 인디케이터=`services/indicators.ts`(EMA20/BB20·2/RSI14, RSI 는 하단 별도 priceScale). 매매마커=orders 필터(long=B 그린 arrowUp, short=S 레드 arrowDown, close=C). 평단선=현재 심볼 포지션 가중평균 `createPriceLine`. 옵션 토글은 `useChartStore`(localStorage). **바이낸스는 1년봉 미지원 → 최대 1개월봉**(1y 요청은 데이터소스 한계로 제외).

## 4. 모의 체결 로직 (서버 = `functions/api/order.ts`)

- **진입(open)**: 서버가 `fetchPrice(symbol)` → 증거금 `price*size/leverage` 를 잔고에서 **조건부 UPDATE**(`balance >= margin`)로 원자 차감. 부족하면 거부. 포지션+주문 INSERT 를 `DB.batch`(트랜잭션)로.
- **미실현 PnL**: `(mark-entry)*size*dir`. 랭킹/표시에서 계산(저장 안 함).
- **청산(close)**: 서버가 청산가 fetch → `pnl` 계산 → 잔고에 `margin+pnl` 반환, 포지션 DELETE, close 주문 기록(pnl 포함). 전부 batch. `size` 를 지정하면 **부분 청산**(보유수량보다 작을 때) — 증거금/포지션 수량을 비율만큼만 줄이고 포지션은 유지, 생략/전량이면 기존과 동일하게 DELETE.
- **입력 검증**: 심볼 allowlist(`SYMBOLS`), side∈long/short, size>0, leverage 1~125.
- **지정가(limitOpen)**: `pending_orders` 에 생성 시점 `limit_price` 기준 증거금을 즉시 잠금(조건부 UPDATE 동일 패턴). 체결가는 재계산 없이 `limit_price` 그대로 사용(델타 정산 불필요). `cancelLimit` 은 잠근 증거금을 그대로 환불.
- **SL/TP(setSlTp)**: `positions.stop_loss`/`take_profit` (포지션당 각 1개). 값은 항상 포지션 방향 기준으로 검증(롱: `stopLoss<entry<takeProfit`, 숏은 반대) — `validSlTp()`.
- **강제청산(계좌 파산)**: `checkTriggers` 맨 앞에서 평가자산(`balance + Σ 전 포지션 미실현손익`)이 0 미만이면 **전 포지션 강제청산 + 미체결 지정가 전부 취소 + 잔고 0 으로 리셋**, 각 포지션은 `kind='liquidation'` 주문으로 기록(청산가=그 시점 서버 시세). 심볼 가격을 하나라도 못 받아온 라운드는 건너뜀(불완전한 데이터로 오청산 방지, 다음 폴링에 재평가). 트리거되면 그 라운드의 지정가/SL·TP 평가는 스킵(이미 다 정리됐으므로).
- **청산가 표시(추정치)**: `PositionsPanel` 이 클라에서 `entry - (balance + 다른 포지션들 미실현손익) / (size*dir)` 로 "이 포지션 가격이 얼마가 되면 계좌가 파산하는지" 를 계산해 보여준다 — 위 강제청산 조건과 동일한 식이지만 어디까지나 클라 추정(실제 체결은 서버가 다음 폴링에서 판단).
- **리필(`functions/api/refill.ts`)**: 강제청산으로 자산이 0이 됐을 때를 위한 안전망. **평가자산(잔고+전 포지션 미실현손익 합)이 0 이하일 때만 지급** — 포지션이 있으면 서버가 그 심볼들 시세를 fetch 해 판정(가격 하나라도 못 받아오면 거부, 오판정 방지). 자산이 남아있으면 거부. 통과하면 `users.refill_count`/`refill_date`(KST 날짜)로 **1일 최대 3회, 1회 +10,000 USDT**. 날짜가 바뀌면 `refill_date !== 오늘` 이라 카운트를 0으로 취급(별도 리셋 cron 불필요 — `checkTriggers` 와 같은 "폴링 시점에 계산" 패턴). `loadState` 가 `refillsLeft` 를 계산해 응답에 포함. `Header.tsx` 도 동일한 식으로 클라 추정해 버튼을 미리 비활성화(실제 판정은 서버).
- **⚠ 체결 체크 = cron 없이 폴링 기반**: Cloudflare Pages Functions 는 정기 실행을 지원하지 않는다. 그래서 `functions/_trading.ts checkTriggers(env,uid)` 를 `state.ts`(GET, 클라가 `useTriggerPoll` 로 5초마다 호출)와 `order.ts`(POST 액션 진입 직후, 수동 조작과의 레이스 방지)에서 호출해 **그 유저의 요청이 들어올 때만** 강제청산/지정가/SL/TP 를 평가·체결한다. 즉 아무도 앱을 켜 두지 않은 동안은 체결되지 않음(지인 대상 모의투자라 허용된 트레이드오프). 체결가는 지정가/SL/TP 값 그대로 사용(슬리피지 모델링 없음).
- **아직 없음**: 펀딩비, 수수료.

### OX/USDT 현물 (서버 = `functions/api/spot.ts`) — 레버리지 시스템과 완전히 별개

지인들끼리 실제로 물건을 사고파는 걸 보여주기 위한 예시 1종. 38개 심볼처럼 외부 시세가 없고,
가입 시 지급된 **정해진 물량**(`users.ox_balance` DEFAULT 100)을 유저끼리 지정가 주문으로 직접
사고팔아서만 이동한다(추가 발행 없음, 리버리지·SL/TP·강제청산 없음).

- **에스크로**: 주문을 낼 때 즉시 잠근다 — 매수는 `price*size` 만큼 `users.balance`(기존 USDT 캐시와 동일 풀)를,
  매도는 `size` 만큼 `users.ox_balance` 를 조건부 UPDATE 로 차감. 부족하면 거부.
- **매칭(cron 불필요, 주문 즉시 처리)**: `checkTriggers` 와 달리 폴링을 기다릴 필요가 없다 —
  주문을 낸 그 요청 안에서 바로 반대편 최우선호가와 매칭한다(`matchBuy`/`matchSell`, 최대 200회 루프).
  매수는 가격 낮은 순(+시간순) 매도호가와, 매도는 가격 높은 순(+시간순) 매수호가와 매칭. **체결가는 항상
  먼저 있던(메이커) 주문의 가격**. 남은 수량은 `spot_orders`(status='open')에 그대로 호가로 남는다.
- **⚠ 가격개선분 환불**: 매수 주문은 본인 지정가 기준으로 전액을 미리 잠그기 때문에, 그보다 싼 매도호가에
  체결되면 차액(`(내 지정가-체결가)*체결수량`)을 그 즉시 `users.balance` 에 환불한다. 매도는 수량(가격 무관)
  기준으로 에스크로하므로 이런 환불 로직이 필요 없음 — 이 비대칭을 놓치면 매수자가 손해를 본다.
- **취소**: 남은 미체결 수량만큼 에스크로를 그대로 환불(매수=USDT, 매도=OX), `status='cancelled'`.
- **UI = 실제 심볼과 완전 통합**: 별도 모달(구 `SpotMarket.tsx`, 제거됨) 없이 `SymbolSelect` 콤보박스에서
  "OX/USDT(가상)" 을 고르면 `Chart`/`OrderBook`/`OrderPanel`/`PositionsPanel` 이 각자 내부에서
  `isVirtualSymbol(symbol)` 로 분기해 스팟 데이터소스(캔들 엔드포인트·`spotBook`·`spotPlace`·스팟 주문/체결)를
  쓴다 — 컴포넌트 자체는 하나, 레이아웃도 실제 심볼과 동일.
- **캔들(차트)**: 외부 시세가 없으므로 `spot_trades` 를 서버가 interval 단위로 JS 버킷팅해 OHLCV 를 만든다
  (`GET /api/spot?candles=1&interval=..&limit=..`, `loadSpotCandles()`). 거래량이 적어 SQL 윈도우함수 대신
  최근 거래 최대 5000건을 한 번에 읽어 그룹핑 — 모의투자 규모에선 충분. 실시간 갱신은 WS 대신 `Chart.tsx` 가
  3초마다 재요청.
- **마켓메이커 봇(유동성 공급)**: 예약된 봇 유저 2명(`bot-mm-1`/`bot-mm-2`, `BOT_USER_IDS`, schema.sql 에서
  시딩, 랭킹에서 제외)이 `spot.ts` 의 GET/POST 핸들러가 호출될 때마다(= 다른 체크와 동일하게 cron 없이
  폴링 시점에) `runMarketMaker()` 로 3~8초 간격을 두고 기준가를 랜덤워크시키며 그 주변에 매수/매도 호가를
  소량 깔고, 가끔 반대편 최우선호가를 즉시 크로스해 체결을 발생시킨다(다른 봇 또는 실유저 호가와 매칭 —
  `matchBuy`/`matchSell` 을 그대로 재사용). 상태(`last_run`/`ref_price`)는 `spot_bot_state` 테이블 1행.
  실유저가 전혀 거래하지 않아도 차트·호가·최근체결이 계속 살아있게 하기 위한 장치이며, LLM 호출은 아니다.

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
- **Secret**: `SESSION_SECRET` = `wrangler pages secret put SESSION_SECRET --project-name ox64` 로 production 에 설정됨(랜덤 32B hex). wrangler.toml 엔 두지 않음.
- 재적용 명령: 스키마 `npx wrangler d1 execute ox64 --remote --file=./schema.sql` / 시크릿 `echo <값> | npx wrangler pages secret put SESSION_SECRET --project-name ox64`.
- **Pages 빌드 설정**(Git 연동): Build command=`npm run build`, Output dir=`dist`(wrangler.toml `pages_build_output_dir`). Functions 는 `functions/` 자동 번들. 바인딩/시크릿은 **새 배포부터** 적용.
- 상태 점검(데이터 안 건드림): `curl https://ox64.app/api/state` → `{"error":"unauthorized"}`(401)면 정상(함수+D1+시크릿 OK). 500 + missingEnv 메시지면 바인딩/시크릿 누락.

## 6. 주의 / 함정

- **서버 권위 원칙**: 잔고/체결/손익/랭킹은 **절대 클라 값을 신뢰하지 않는다**. 새 거래 기능은 반드시 `functions/api/*` 에서 검증·계산. 프론트는 요청·표시만.
- **체결가는 서버가 fetch**: OrderPanel 은 가격을 안 보냄. 클라 price 를 받아 쓰면 조작 구멍이 됨(금지).
- **Lightweight Charts v4**: `addCandlestickSeries`. v5 는 `addSeries(...)`. 현재 v4 고정.
- **time = UTC seconds**: 바이낸스 ms → `/1000`.
- **바이낸스 지역차단**: 선물 WS 막힘 → 스팟 사용. 스팟마저 막히면 `data-api.binance.vision` 미러/프록시로 `services/` + `_shared.fetchPrice` 교체.
- **functions/ 타입**: 앱 `tsc -b`(src 전용)엔 안 잡힘. Cloudflare 도 타입체크 안 함. 수동 확인:
  `npx tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom functions/_shared.ts functions/_trading.ts functions/api/*.ts`. WebCrypto 바이트 인자는 `bs()`(BufferSource 캐스팅)로 TS lib 마찰 회피.
- **로컬 검증(선택)**: `npm run build && npx wrangler d1 execute ox64 --local --file=./schema.sql && npx wrangler pages dev dist` 로 로컬 D1(miniflare)까지 띄워 실제 `/api/order` 호출로 지정가/SL/TP 라이프사이클을 curl 로 검증 가능(`.dev.vars` 에 `SESSION_SECRET` 아무 값이나 채우면 됨, `--local` 이라 prod DB 안 건드림). 매번 세션 시작 시 `--local` D1 은 비어있으니 참고.
- **favicon**: `public/favicon.png` 교체(원본 `src/resources/images/icon2_256.png`). Vite public/ 은 해시 없이 dist 루트로 복사.
- **워드마크 로고**: 화면의 "ox64" 텍스트는 `src/resources/images/icon_256.png` 를 `import` 해 `<img>` 로 표시(Header/Login). 로고 바꾸려면 그 파일 교체 또는 import 경로 변경. (index.html `<title>` 의 "ox64" 는 탭 제목이라 유지.)
- **API 500 진단**: `functions/_shared.safe()`(핸들러 예외→500+메시지) + `missingEnv()`(D1/SECRET 미설정을 한국어로 안내)로 감쌈. 클라(`api.ts req`)가 `error` 필드를 그대로 throw→Login 화면에 표시. "HTTP 500"만 뜨고 원인 불명이면 이 래핑이 빠진 것.
- **폰트 = Proxima Nova(전체)**: `public/fonts/*.ttf` + `index.css` `@font-face`(weight 300/400/600/800), body/tailwind sans+mono 모두 Proxima. **한글 글리프 없음** → CJK 폴백(Apple SD Gothic/Malgun) 유지 필수. mono 도 Proxima라 숫자 정렬은 `font-variant-numeric: tabular-nums`.
- **반응형**: `App.tsx` 모바일=세로 flex 스택(차트 45vh→주문→포지션), `md:`(≥768px)=2열 그리드(좌 차트+포지션 / 우 주문). 차트가 모바일서 좁던 원인=옛 가로 flex 의 `aside w-72` 고정폭 → 그리드 전환으로 해결.
- **DB 확인/수정**: 이제 서버 D1. `npx wrangler d1 execute ox64 --remote --command "SELECT name,balance FROM users"`. 잔고 리셋 등도 SQL 로. (구 `window.db`/DevTools IndexedDB 방식은 폐기 — 클라 조작 방지가 목적.)
- **인터벌→초 매핑 이중 관리**: `src/symbols.ts INTERVAL_GROUPS` 와 `functions/_shared.ts intervalSecFromCode`(OX 캔들 버킷팅용) 가 같은 값을 각자 보관한다(functions/ 는 src/ import 불가). 인터벌 코드를 추가/변경하면 두 곳 다 갱신할 것.

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
- [ ] 수수료·펀딩비 반영
- [ ] 랭킹 새로고침 최적화(현재 5초 폴링 → 서버 캐시/집계)
