// 거래 가능 심볼 — 전부 바이낸스 스팟(차트 WS) ∩ OKX 스팟(서버 체결가) 교집합.
// 새 심볼 추가 시 두 거래소 모두에 USDT 페어가 있어야 함(없으면 차트/체결 중 하나가 깨짐).
export const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT',
  'TRXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT',
  'XLMUSDT', 'SUIUSDT', 'ARBUSDT', 'POLUSDT', 'HBARUSDT', 'INJUSDT', 'CRVUSDT', 'ENAUSDT',
  'WLDUSDT', 'TAOUSDT', 'PEPEUSDT', 'FETUSDT', 'ONDOUSDT', 'JTOUSDT', 'ZECUSDT', 'KAITOUSDT',
  'PUMPUSDT', 'XPLUSDT', 'GRAMUSDT', 'KITEUSDT', 'SENTUSDT', 'ALLOUSDT',
];

// 외부 시세 없는 가상 코인(봇이 체결가를 만든다, functions/api/spot.ts). 실제 심볼과 같은
// 콤보박스(SymbolSelect)에서 선택하지만 차트/호가/주문 데이터소스가 완전히 다르다.
// ⚠ 여기에 심볼을 추가하면 `functions/api/spot.ts VIRTUAL_PAIRS` 와 D1 `spot_bot_state` 시작가 행도
// 같이 추가해야 한다(셋 중 하나라도 빠지면 목록엔 뜨는데 시세가 안 도는 유령 코인이 된다).
export const VIRTUAL_SYMBOLS = ['OXUSDT', 'EWUSDT'] as const;
export const isVirtualSymbol = (s: string): boolean => (VIRTUAL_SYMBOLS as readonly string[]).includes(s);

// ── 원화(KRW) 마켓 — 빗썸(2026-09-24) ──
// 차트·호가·체결은 브라우저가 빗썸에 직접 붙고(services/bithumb.ts, CORS 허용 — Cloudflare 요청·D1 0),
// 체결가는 서버가 빗썸에서 받는다(functions/_shared.ts fromBithumb). **원화 지갑**으로 거래한다(USDT 지갑과
// 분리된 크로스 담보, 환전으로만 오간다). ⚠ 서버 사본 functions/_shared.ts KRW_SYMBOLS 와 같은 목록이어야 한다
// (서버는 화이트리스트라 여기만 늘리면 "알 수 없는 심볼"로 거부된다).
export const KRW_SYMBOLS = ['BTCKRW', 'ETHKRW', 'SOLKRW', 'FKRW'] as const;
/** 빗썸 한글명 — 심볼 검색이 "비트", "솔라나" 로도 걸리게. */
export const KRW_NAMES: Record<string, string> = { BTCKRW: '비트코인', ETHKRW: '이더리움', SOLKRW: '솔라나', FKRW: '신퓨처스' };
export const isKrwSymbol = (s: string): boolean => (KRW_SYMBOLS as readonly string[]).includes(s);
export type Quote = 'USDT' | 'KRW';
/** 결제통화. ⚠ 'FKRW' 처럼 기준통화가 한 글자인 심볼이 있어서 접미사로 가른다. */
export const quoteOf = (s: string): Quote => (s.endsWith('KRW') ? 'KRW' : 'USDT');
/** 기준통화(코인) — 'BTCKRW' → 'BTC', 'OXUSDT' → 'OX'. 수량 단위 표기용. */
export const baseOf = (s: string): string => s.slice(0, -quoteOf(s).length);
/** 화면 표기 — 'BTC/KRW', 'OX/USDT'. ⚠ 결제통화가 둘이라 'BTC' 만 쓰면 어느 마켓인지 모른다. */
export const pairLabel = (s: string): string => `${baseOf(s)}/${quoteOf(s)}`;
/** 환율 키 — 가격 맵(useMarketStore.prices)에 1 USDT = ? 원 으로 실린다(서버 USDT_KRW 와 같은 키). */
export const USDT_KRW = 'USDTKRW';
/** 심볼 선택기 분류 필터. */
export type SymbolCategory = 'KRW' | 'USDT' | 'VIRTUAL';
export const categoryOf = (s: string): SymbolCategory =>
  isVirtualSymbol(s) ? 'VIRTUAL' : quoteOf(s) === 'KRW' ? 'KRW' : 'USDT';

export interface IntervalDef {
  code: string; // 바이낸스 kline interval
  label: string; // 표시명
  sec: number; // 봉 길이(초) — 카운트다운/정렬용 (1M 은 근사 30일)
}
export interface IntervalGroup {
  name: string;
  items: IntervalDef[];
}

// 분봉 / 시간봉 / 일봉+ 그룹. (바이낸스는 1년봉 미지원 → 최대 1개월봉)
export const INTERVAL_GROUPS: IntervalGroup[] = [
  {
    name: '초',
    items: [{ code: '1s', label: '1초', sec: 1 }],
  },
  {
    name: '분',
    items: [
      { code: '1m', label: '1분', sec: 60 },
      { code: '3m', label: '3분', sec: 180 },
      { code: '5m', label: '5분', sec: 300 },
      { code: '15m', label: '15분', sec: 900 },
      { code: '30m', label: '30분', sec: 1800 },
    ],
  },
  {
    name: '시간',
    items: [
      { code: '1h', label: '1시간', sec: 3600 },
      { code: '2h', label: '2시간', sec: 7200 },
      { code: '4h', label: '4시간', sec: 14400 },
      { code: '6h', label: '6시간', sec: 21600 },
      { code: '8h', label: '8시간', sec: 28800 },
      { code: '12h', label: '12시간', sec: 43200 },
    ],
  },
  {
    name: '일 이상',
    items: [
      { code: '1d', label: '1일', sec: 86400 },
      { code: '3d', label: '3일', sec: 259200 },
      { code: '1w', label: '1주', sec: 604800 },
      { code: '1M', label: '1개월', sec: 2592000 },
    ],
  },
];

export const ALL_INTERVALS: IntervalDef[] = INTERVAL_GROUPS.flatMap((g) => g.items);
export const intervalSec = (code: string) => ALL_INTERVALS.find((i) => i.code === code)?.sec ?? 60;
export const intervalLabel = (code: string) => ALL_INTERVALS.find((i) => i.code === code)?.label ?? code;

// KST(UTC+9) 고정 — 차트에 넣는 모든 시간값에 이 오프셋을 더해 라벨을 한국시간으로.
export const KST_OFFSET = 9 * 3600;
