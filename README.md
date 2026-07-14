# ox64

지인들끼리 수익률을 겨루는 **모의 선물 트레이딩 플랫폼**.

실시간 시세(바이낸스) 기반으로 롱/숏 포지션을 연습하고, 친구들과 랭킹으로 경쟁합니다.
잔고·포지션·손익은 전부 서버(Cloudflare D1)가 계산·보관하므로, 클라이언트에서 가격이나
잔고를 조작해도 랭킹에는 반영되지 않습니다 — 공정한 경쟁을 위한 **서버 권위 구조**입니다.

## 주요 기능

- 📈 **실시간 차트** — TradingView Lightweight Charts, 38개 심볼, 다양한 타임프레임(분/시간/일+)
- 📊 **보조지표** — EMA20 / Bollinger Bands / RSI14, 거래량 히스토그램
- 💰 **모의 거래** — 시장가 롱/숏 진입·청산, 레버리지 1~125배
- 🏆 **친구 랭킹** — 잔고 + 미실현 손익 기준 실시간 순위
- 🔐 **간편 로그인** — 이름 + 패스코드만으로 가입/로그인
- 📱 **반응형 UI** — 모바일/PC 대응, OKX 스타일 다크 테마

## 기술 스택

| 구분 | 기술 |
| --- | --- |
| 프론트엔드 | Vite + React (TypeScript), Zustand, Tailwind CSS |
| 차트 | TradingView Lightweight Charts v4 |
| 실시간 시세 | RxJS + Native WebSocket (바이낸스 스팟) |
| 백엔드 | Cloudflare Pages Functions (`functions/`) |
| DB | Cloudflare D1 (SQLite) |
| 인증 | HMAC 서명 세션 쿠키 + PBKDF2 패스코드 해싱 |

프론트(정적 SPA)와 백엔드(Pages Functions)를 **한 레포·한 배포**로 운영합니다.

## 왜 서버 권위 구조인가

클라이언트(브라우저 저장소)에 잔고나 시세를 두면 콘솔로 얼마든지 변조할 수 있어 랭킹 경쟁이
무의미해집니다. 그래서 체결가 조회, 증거금 계산, 손익 정산을 모두 서버가 수행하고 D1에
원자적으로 기록합니다. 클라이언트가 보내는 값은 `symbol / side / size / leverage` 뿐이며,
가격은 서버가 직접 거래소에서 받아옵니다.

## 시작하기

```bash
npm install
npm run dev              # 프론트 개발 서버 (Vite) — /api 는 동작하지 않음

npm run build            # tsc -b && vite build → dist/
npx wrangler pages dev dist   # 백엔드(D1 + Functions) 포함 로컬 구동
```

D1 스키마 적용:

```bash
npx wrangler d1 execute ox64 --remote --file=./schema.sql
```

자세한 폴더 구조, 데이터 흐름, 배포 설정은 [`CLAUDE.md`](./CLAUDE.md)를 참고하세요.

## 로드맵

- [x] 서버 권위 백엔드(D1) + 친구 랭킹
- [x] 이름+패스코드 로그인
- [x] 반응형 UI, 커스텀 폰트/파비콘
- [ ] 지정가/스탑 주문
- [ ] 강제청산가 계산
- [ ] 거래 내역 패널
- [ ] 수수료·펀딩비 반영

## 라이선스

개인/친목용 프로젝트입니다. 별도 명시 없는 한 상업적 이용을 염두에 두지 않았습니다.
