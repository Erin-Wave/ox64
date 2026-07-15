// 거래 가능 심볼 — 전부 바이낸스 스팟(차트 WS) ∩ OKX 스팟(서버 체결가) 교집합.
// 새 심볼 추가 시 두 거래소 모두에 USDT 페어가 있어야 함(없으면 차트/체결 중 하나가 깨짐).
export const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT',
  'TRXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT',
  'XLMUSDT', 'SUIUSDT', 'ARBUSDT', 'POLUSDT', 'HBARUSDT', 'INJUSDT', 'CRVUSDT', 'ENAUSDT',
  'WLDUSDT', 'TAOUSDT', 'PEPEUSDT', 'FETUSDT', 'ONDOUSDT', 'JTOUSDT', 'ZECUSDT', 'KAITOUSDT',
  'PUMPUSDT', 'XPLUSDT', 'GRAMUSDT', 'KITEUSDT', 'SENTUSDT', 'ALLOUSDT',
];

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
