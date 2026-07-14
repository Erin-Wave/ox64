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
├── schema.sql              D1 스키마(users/positions/orders) — wrangler d1 execute 또는 D1 Console 로 적용
├── vite.config.ts          @ alias(src), charts/rx 청크 분리
├── tailwind.config.js       OKX식 다크 팔레트(bg #0b0d0f/panel/panel2/elevated/border/up #00c076/down #f6465d/muted/text/accent) + fontFamily(Proxima Nova)
├── functions/              ── 백엔드 (Cloudflare Pages Functions, /api/*) ──
│   ├── _shared.ts          인증(HMAC 토큰/PBKDF2)·바이낸스 서버측 시세·D1 타입·loadState
│   └── api/
│       ├── login.ts        POST /api/login  (없는 이름=가입, 있으면 패스코드 검증→세션쿠키)
│       ├── logout.ts       POST /api/logout (쿠키 제거)
│       ├── state.ts        GET  /api/state  (잔고+포지션+주문, 인증필요)
│       ├── order.ts        POST /api/order  (open/close — 서버가 체결가 fetch·손익 계산·D1 원자 갱신)
│       └── leaderboard.ts  GET  /api/leaderboard (친구 자산 순위=잔고+미실현PnL, 서버 시세)
├── public/
│   ├── favicon.png         아이콘(원본 src/resources/images/icon2_256.png)
│   └── fonts/              ProximaNova-{Light,Regular,Semibold,Extrabold}.ttf
└── src/                    ── 프론트 ──
    ├── App.tsx             세션확인→Login 또는 트레이딩 UI(반응형) + 랭킹 모달
    ├── index.css           Tailwind + @font-face(Proxima Nova) + tabular-nums
    ├── types.ts            도메인 타입(Candle/Order/Position/Side)
    ├── symbols.ts          거래 심볼 38종(바이낸스∩OKX) + 타임프레임 그룹(분/시간/일+) + KST_OFFSET(+9h 고정)
    ├── format.ts           fmtPrice(심볼 정밀도)/fmtVol(K·M·B)/precisionFromTick
    ├── services/
    │   ├── binanceRest.ts  초기 과거봉(스팟 REST) — 차트 표시용
    │   ├── binanceWs.ts    실시간 kline(스팟 WS) — 차트/현재가 표시용
    │   ├── indicators.ts   EMA / Bollinger / RSI 계산
    │   └── api.ts          백엔드 클라이언트(/api/*, credentials 포함)
    ├── hooks/
    │   └── useMarkPrices.ts  현재+포지션 심볼 가격 3초 폴링(다른 심볼 PnL 갱신)
    ├── store/
    │   ├── useMarketStore.ts   symbol/interval/prices(심볼별 가격맵)/precisions(심볼별 소수자릿수)/connected + selectLastPrice/precisionOf
    │   ├── useChartStore.ts    차트 옵션(ema/bb/rsi/카운트다운/매매마커/평단선) localStorage 영속
    │   └── useTradingStore.ts  서버 상태 캐시 + init/login/logout/openMarket/closePosition
    └── components/
        ├── Login.tsx           이름+패스코드 로그인/가입
        ├── Header.tsx          심볼(38, 공용목록)/현재가/연결/잔고/유저명/랭킹버튼/로그아웃
        ├── Chart.tsx           Lightweight Charts: 타임프레임 그룹셀렉트·KST+9·OHLCV레전드(hover/터치)·다음봉 카운트다운·EMA/BB/RSI·매매 B/S 마커·포지션 평단선 (툴바 지표·옵션 팝오버로 토글)
        ├── OrderPanel.tsx      시장가 롱/숏 (심볼/방향/수량/레버리지만 전송, 가격 X)
        ├── PositionsPanel.tsx  포지션 + 실시간 미실현 PnL/ROE% (prices 맵 = 전 심볼) + 청산
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
- **거래량 히스토그램**: 차트 하단 오버레이(반투명 그린/레드), `useChartStore.volume`(기본 ON) 토글. RSI/거래량 동시 표시 시 하단을 [캔들]/[RSI]/[거래량] 으로 스택(priceScale scaleMargins 동적 계산).
- **차트(Chart.tsx)**: 시간축은 **KST(+9h) 고정** — 차트에 넣는 모든 시간값에 `KST_OFFSET` 을 더해 라벨을 한국시간으로(LWC v4 는 UTC 라벨이라 오프셋 방식). 타임프레임=`symbols.ts INTERVAL_GROUPS`(분/시간/일+, `<optgroup>`). 인디케이터=`services/indicators.ts`(EMA20/BB20·2/RSI14, RSI 는 하단 별도 priceScale). 매매마커=orders 필터(long=B 그린 arrowUp, short=S 레드 arrowDown, close=C). 평단선=현재 심볼 포지션 가중평균 `createPriceLine`. 옵션 토글은 `useChartStore`(localStorage). **바이낸스는 1년봉 미지원 → 최대 1개월봉**(1y 요청은 데이터소스 한계로 제외).

## 4. 모의 체결 로직 (서버 = `functions/api/order.ts`)

- **진입(open)**: 서버가 `fetchPrice(symbol)` → 증거금 `price*size/leverage` 를 잔고에서 **조건부 UPDATE**(`balance >= margin`)로 원자 차감. 부족하면 거부. 포지션+주문 INSERT 를 `DB.batch`(트랜잭션)로.
- **미실현 PnL**: `(mark-entry)*size*dir`. 랭킹/표시에서 계산(저장 안 함).
- **청산(close)**: 서버가 청산가 fetch → `pnl` 계산 → 잔고에 `margin+pnl` 반환, 포지션 DELETE, close 주문 기록(pnl 포함). 전부 batch.
- **입력 검증**: 심볼 allowlist(`SYMBOLS`), side∈long/short, size>0, leverage 1~125.
- **아직 없음**: 지정가/스탑, 부분 청산, 펀딩비, 강제청산, 수수료.

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
- **D1**: `ox64` (database_id `f32f600e-49ad-4026-843f-84f34a62df3c`), 스키마 3테이블 적용 완료. 바인딩은 `wrangler.toml` 의 `[[d1_databases]] binding="DB"` 로 코드 관리 → Git 배포가 자동 적용(대시보드 바인딩 UI 는 "managed through wrangler.toml" 로 잠기며, 이게 정상 — 코드가 진실원본).
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
  `npx tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom functions/_shared.ts functions/api/*.ts`. WebCrypto 바이트 인자는 `bs()`(BufferSource 캐스팅)로 TS lib 마찰 회피.
- **favicon**: `public/favicon.png` 교체(원본 `src/resources/images/icon2_256.png`). Vite public/ 은 해시 없이 dist 루트로 복사.
- **워드마크 로고**: 화면의 "ox64" 텍스트는 `src/resources/images/icon_256.png` 를 `import` 해 `<img>` 로 표시(Header/Login). 로고 바꾸려면 그 파일 교체 또는 import 경로 변경. (index.html `<title>` 의 "ox64" 는 탭 제목이라 유지.)
- **API 500 진단**: `functions/_shared.safe()`(핸들러 예외→500+메시지) + `missingEnv()`(D1/SECRET 미설정을 한국어로 안내)로 감쌈. 클라(`api.ts req`)가 `error` 필드를 그대로 throw→Login 화면에 표시. "HTTP 500"만 뜨고 원인 불명이면 이 래핑이 빠진 것.
- **폰트 = Proxima Nova(전체)**: `public/fonts/*.ttf` + `index.css` `@font-face`(weight 300/400/600/800), body/tailwind sans+mono 모두 Proxima. **한글 글리프 없음** → CJK 폴백(Apple SD Gothic/Malgun) 유지 필수. mono 도 Proxima라 숫자 정렬은 `font-variant-numeric: tabular-nums`.
- **반응형**: `App.tsx` 모바일=세로 flex 스택(차트 45vh→주문→포지션), `md:`(≥768px)=2열 그리드(좌 차트+포지션 / 우 주문). 차트가 모바일서 좁던 원인=옛 가로 flex 의 `aside w-72` 고정폭 → 그리드 전환으로 해결.
- **DB 확인/수정**: 이제 서버 D1. `npx wrangler d1 execute ox64 --remote --command "SELECT name,balance FROM users"`. 잔고 리셋 등도 SQL 로. (구 `window.db`/DevTools IndexedDB 방식은 폐기 — 클라 조작 방지가 목적.)

## 7. 다음 작업 후보 (백로그)

- [x] 서버 권위 백엔드(D1) + 친구 랭킹
- [x] 이름+패스코드 로그인
- [x] 반응형 모바일/PC, Proxima Nova, favicon
- [ ] 지정가/스탑 주문 + 미체결 목록 (서버)
- [ ] 강제청산가 계산 + 표시
- [ ] 인터벌(1m/5m/1h/1d) 전환 UI
- [ ] 거래 내역 패널(orders 이미 저장 중 → 조회 UI만)
- [ ] 수수료·펀딩비 반영
- [ ] 랭킹 새로고침 최적화(현재 5초 폴링 → 서버 캐시/집계)
