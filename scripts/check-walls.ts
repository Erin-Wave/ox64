/**
 * 유저 벽 관통 점검 — `npm run check:walls`.
 *
 * 걸려 있는 유저 지정가는 봇 가격의 경계다(§ spot.ts pickWalls, 2026-10-02): 유저 매수가 B 에 걸려 있으면 봇 체결·기준가·봇 매수호가는
 * B 아래로 내려가지 않고(봇 매도호가는 B 에만 — 흡수 호가), 매도 A 는 그 반대다. 예전엔 "현재가보다 위의 매수"를 벽에서 빼서, 0.7 에
 * 1조 개 매수를 걸어도 봇끼리 0.68 에 체결했다(제보). 이 스크립트는 `simulateTick` 을 여러 상황으로 수만 틱 돌려 그 불변식을 센다.
 * 위반이 하나라도 있으면 exit 1.
 */
import { simulateTick, type BotState, type BotBook, type TapeTrade } from '../functions/api/spot';

type Wall = { side: string; price: number; size: number; readyAt: number };
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const TICKS = Number(process.env.CHECK_TICKS) || 20000;

const state0 = (ref: number, sentiment: number, regime: string): BotState =>
  ({ ref, drift: 0, vol: 1, sentiment, anchor: ref, regime, regimeTicks: 0, peak: ref, trough: ref, interest: 1.5, hype: 0.5 }) as BotState;

interface Result {
  name: string;
  prints: number;
  through: number; // 벽 가격이나 그 너머에 찍힌 봇 체결
  refThrough: number; // 기준가가 벽 너머
  botQuoteThrough: number; // 봇 사다리(흡수 호가 제외)가 벽 가격이나 그 너머
  absorbTicks: number; // 벽 가격에 흡수 호가가 나온 틱
  absorbNotReady: number; // 체결할 수 없는 시각인데 흡수 호가가 나온 틱
  crossedBot: number; // 흡수 호가가 봇 자기 호가와 교차
  nan: number;
}

function run(name: string, ref0: number, sentiment: number, regime: string, walls: (ref: number, i: number) => Wall[]): Result {
  let st = state0(ref0, sentiment, regime);
  let book: BotBook = { owner: 'bot-mm-1', bids: [], asks: [] };
  const r: Result = { name, prints: 0, through: 0, refThrough: 0, botQuoteThrough: 0, absorbTicks: 0, absorbNotReady: 0, crossedBot: 0, nan: 0 };
  for (let i = 0; i < TICKS; i++) {
    const now = T0 + i * 1000;
    const w = walls(st.ref, i);
    const res = simulateTick(st, [] as TapeTrade[], book, w as never, now, 1);
    // 교차하는 유저 벽은 예전 규칙(기준가 너머만)으로 고른다 — 여기선 교차하지 않는 경우만 엄격히 센다.
    const bid = w.filter((x) => x.side === 'long').reduce<Wall | null>((m, x) => (!m || x.price > m.price ? x : m), null);
    const ask = w.filter((x) => x.side === 'short').reduce<Wall | null>((m, x) => (!m || x.price < m.price ? x : m), null);
    const crossedUsers = bid && ask && bid.price >= ask.price;
    for (const t of res.tape) {
      r.prints++;
      if (!isFinite(t.price) || !(t.price > 0)) r.nan++;
      if (!crossedUsers && ((bid && t.price <= bid.price) || (ask && t.price >= ask.price))) r.through++;
    }
    const ref = res.next.ref;
    if (!isFinite(ref)) r.nan++;
    if (!crossedUsers && ((bid && ref < bid.price - 1e-12) || (ask && ref > ask.price + 1e-12))) r.refThrough++;
    // 흡수 호가 = 벽 가격과 정확히 같은 반대편 봇 호가. 나머지 봇 호가는 유저 주문과 교차하면 안 된다 — 유저 매수 B 이하의 봇 매도,
    // 유저 매도 A 이상의 봇 매수(그 물량은 유저 주문이 받았어야 한다). B 보다 비싼 봇 매수·A 보다 싼 봇 매도는 더 좋은 호가라 괜찮다.
    const botBids = res.book.bids.filter((l) => !(ask && l.price === ask.price));
    const botAsks = res.book.asks.filter((l) => !(bid && l.price === bid.price));
    if (!crossedUsers) {
      if (bid && botAsks.some((l) => l.price <= bid.price)) r.botQuoteThrough++;
      if (ask && botBids.some((l) => l.price >= ask.price)) r.botQuoteThrough++;
    }
    const absorbAsk = bid ? res.book.asks.find((l) => l.price === bid.price) : undefined;
    const absorbBid = ask ? res.book.bids.find((l) => l.price === ask.price) : undefined;
    if (absorbAsk || absorbBid) r.absorbTicks++;
    if ((absorbAsk && bid && bid.readyAt > now) || (absorbBid && ask && ask.readyAt > now)) r.absorbNotReady++;
    if (absorbAsk && botBids.some((l) => l.price >= absorbAsk.price)) r.crossedBot++;
    if (absorbBid && botAsks.some((l) => l.price <= absorbBid.price)) r.crossedBot++;
    st = res.next;
    book = res.book;
  }
  return r;
}

const BIG = 1e12;
const results: Result[] = [
  // ① 제보 재현 — 현재가 바로 위(marketable)의 거대 매수, 하락 심리. 예전엔 여기서 봇끼리 벽 아래에 체결했다.
  run('marketable 매수벽(현재가 +0.5%)·패닉', 1, -0.9, 'panic', (_r, i) => [{ side: 'long', price: 1.005, size: BIG - i * 1e6, readyAt: 0 }]),
  // ② 현재가 아래 매수벽(예전에도 벽이던 경우) — 가격이 내려와 닿는다.
  run('현재가 아래 매수벽(-0.3%)·하락', 1, -0.6, 'pullback', () => [{ side: 'long', price: 0.997, size: BIG, readyAt: 0 }]),
  // ③ 매도 쪽 대칭 — 현재가 아래(marketable) 거대 매도, 광기.
  run('marketable 매도벽(현재가 -0.5%)·광기', 1, 0.9, 'euphoria', () => [{ side: 'short', price: 0.995, size: BIG, readyAt: 0 }]),
  // ④ 재체결 간격 — 벽은 지키되, 체결 못 하는 동안엔 흡수 호가를 내지 않는다(5초 중 4초).
  run('재체결 대기(5초 주기)', 1, -0.9, 'panic', (_r, i) => [{ side: 'long', price: 1.005, size: BIG, readyAt: i % 5 === 0 ? 0 : T0 + (i + 1) * 1000 }]),
  // ⑤ 양쪽 벽 + 같은 가격대 여러 주문.
  run('양쪽 벽', 1, 0, 'calm', () => [
    { side: 'long', price: 0.998, size: 5e5, readyAt: 0 },
    { side: 'long', price: 0.998, size: 7e5, readyAt: 0 },
    { side: 'short', price: 1.002, size: 3e5, readyAt: 0 },
  ]),
  // ⑥ 유저 주문끼리 교차(같은 계정의 양방향 등) — 예전 규칙으로 물러난다. 터지지 않는지만 본다.
  run('유저끼리 교차', 1, 0, 'rally', () => [
    { side: 'long', price: 1.01, size: BIG, readyAt: 0 },
    { side: 'short', price: 0.99, size: BIG, readyAt: 0 },
  ]),
  // ⑦ 벽 없음 — 예전과 같아야 한다(흡수 0).
  run('벽 없음', 1, 0, 'calm', () => []),
];

let bad = 0;
for (const r of results) {
  const ok = r.through === 0 && r.refThrough === 0 && r.botQuoteThrough === 0 && r.absorbNotReady === 0 && r.crossedBot === 0 && r.nan === 0;
  if (!ok) bad++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(28)} 체결 ${String(r.prints).padStart(6)} · 관통 ${r.through} · 기준가 관통 ${r.refThrough} · 봇호가 관통 ${r.botQuoteThrough} · 흡수 틱 ${r.absorbTicks} · 대기 중 흡수 ${r.absorbNotReady} · 봇과 교차 ${r.crossedBot} · NaN ${r.nan}`,
  );
}
if (bad) {
  console.error(`\n${bad} 개 상황에서 위반`);
  process.exit(1);
}
