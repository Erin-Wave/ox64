# ox64 — Mock Trading Platform

> 지인들과 함께 쓰는 서버리스 모의 선물 트레이딩 플랫폼.
> 실시간 시세(바이낸스) 기반으로 롱/숏 진입·청산을 연습하고, 모든 자산/주문/포지션은
> 브라우저 로컬(IndexedDB)에 저장한다. 백엔드/DB 서버 없음 → Cloudflare Pages 정적 배포.

## 1. 기술 스택 (선정 이유 = 성능)

| 역할 | 기술 | 이유 |
| --- | --- | --- |
| 프레임워크 | **Vite + React (TypeScript)** | 순수 SPA. Next/Nuxt SSR 오버헤드 없이 Pages 배포 최적화 |
| 차트 | **TradingView Lightweight Charts v4** | Canvas 기반 초경량, 수만 봉 60fps 실시간 갱신 |
| 실시간 | **RxJS + Native WebSocket** | 초당 수십~수백 틱 스트림 최적화, 렌더 병목 방지 |
| 상태/UI | **Zustand + Tailwind CSS** | selector 구독으로 불필요한 리렌더 차단 |
| 로컬 백엔드 | **IndexedDB (Dexie.js)** | 서버 없이 자산/주문/포지션 브라우저 영속 |

## 2. 폴더 구조 (역할 한 줄)

```
ox64/
├── index.html              SPA 진입 HTML (다크 테마 고정)
├── vite.config.ts          @ alias(src), charts/rx 수동 청크 분리
├── tailwind.config.js      거래소 다크 팔레트(bg/panel/border/up/down/muted)
├── tsconfig.{app,node}.json  프로젝트 레퍼런스 분리(엄격 모드)
└── src/
    ├── main.tsx            React 진입점
    ├── App.tsx             레이아웃 셸(헤더/차트/포지션/주문) + IndexedDB hydrate
    ├── index.css           Tailwind + 한글 폰트 폴백
    ├── types.ts            공용 도메인 타입(Candle/Order/Position/Account/Side)
    ├── db/
    │   └── db.ts           Dexie 인스턴스 + 스키마 v1 + ensureSeed(기본계정 1만 USDT)
    ├── services/
    │   ├── binanceRest.ts  초기 과거봉 500개 (fapi REST)
    │   └── binanceWs.ts    실시간 kline 스트림 (RxJS webSocket + retry + share)
    ├── store/
    │   ├── useMarketStore.ts   symbol/interval/lastPrice/connected
    │   └── useTradingStore.ts  balance/positions/orders + IndexedDB 영속 로직
    └── components/
        ├── Header.tsx           심볼 선택 + 현재가 + 연결상태 + 잔고
        ├── Chart.tsx            Lightweight Charts (REST 초기 + WS 실시간 update)
        ├── OrderPanel.tsx       시장가 롱/숏 진입(수량·레버리지)
        └── PositionsPanel.tsx   보유 포지션 + 실시간 미실현 PnL + 청산
```

## 3. 데이터 흐름

```
바이낸스 fapi REST ──(초기 500봉)──► Chart.series.setData()
바이낸스 fstream WS ──(RxJS kline$)──► Chart.series.update() + useMarketStore.lastPrice
                                              │
OrderPanel ──openMarket()──► useTradingStore ─┼─► IndexedDB(Dexie) 영속
PositionsPanel ──closePosition(mark)──────────┘     (accounts/orders/positions)
```

- **시세 소스**: 바이낸스 USD-M 선물. REST=`fapi.binance.com`, WS=`fstream.binance.com/ws/{sym}@kline_{iv}`.
- **가격 틱 리렌더 방지**: `useMarketStore` 를 selector 로만 구독(`s => s.lastPrice`). 전체 스토어 구독 금지.
- **영속 규칙**: 스토어는 메모리 캐시, 모든 변경은 Dexie 트랜잭션에도 기록 → 새로고침에도 유지. hydrate()가 앱 마운트 시 복원.

## 4. 모의 체결 로직 (현재 = 단순화 버전)

- **진입**: 시장가 즉시 체결(현재가=진입가). 증거금 = `price * size / leverage` 를 잔고에서 차감.
- **미실현 PnL**: `(mark - entry) * size * dir` (long=+1, short=-1). PositionsPanel 이 실시간 표시.
- **청산**: 증거금 반환 + PnL 을 잔고에 반영, 포지션 삭제.
- **아직 없음**: 지정가 주문, 부분 청산, 펀딩비, 강제청산(liquidation), 수수료, 다중 계정 UI.

## 5. 빌드 / 실행

```bash
npm install          # 최초 1회 (esbuild postinstall 승인 필요: allowScripts 이미 등록됨)
npm run dev          # 개발 서버 (Vite)
npm run build        # tsc -b && vite build → dist/ (Pages 배포 대상)
npm run preview      # 빌드 결과 로컬 미리보기
npm run lint         # tsc --noEmit 타입체크
```

- **검증됨(2026-07-14)**: `tsc -b` 통과, `vite build` 성공. 청크 분리 확인(charts 162KB / rx 21KB / index 254KB).
- **Cloudflare Pages 설정**: Build command=`npm run build`, Output dir=`dist`, SPA(모든 경로 index.html fallback).

## 6. 주의 / 함정

- **Lightweight Charts v4 API**: `chart.addCandlestickSeries(...)`. v5 는 `addSeries(CandlestickSeries, ...)` 로 바뀌었으니 업그레이드 시 주의. 현재 v4 고정.
- **time 단위 = UTC seconds**: 바이낸스는 ms 라 `/1000` 필수. 차트 `UTCTimestamp` 로 캐스팅.
- **@types/node 필요**: vite.config.ts 의 `node:path`/`__dirname` 때문. devDependency 로 포함됨.
- **바이낸스 지역 차단**: 일부 지역에서 fapi/fstream 이 차단될 수 있음 → 프록시/대체 소스 필요 시 services/ 만 교체.

## 7. 다음 작업 후보 (백로그)

- [ ] 지인별 다중 계정 전환 UI (Account 테이블은 이미 있음)
- [ ] 지정가/스탑 주문 + 미체결 주문 목록
- [ ] 강제청산가 계산 + 표시
- [ ] 인터벌(1m/5m/1h/1d) 전환 UI (store 는 준비됨, Header 에 셀렉터만 추가)
- [ ] 거래 내역/체결 로그 패널
- [ ] 수수료·펀딩비 반영으로 정산 정밀화
