-- ox64 D1 스키마 (서버 권위 백엔드)
-- 적용: wrangler d1 execute ox64 --remote --file=./schema.sql
--   (로컬 개발: --local)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  passcode_hash TEXT NOT NULL,
  balance       REAL NOT NULL DEFAULT 10000,
  created_at    INTEGER NOT NULL,
  refill_count  INTEGER NOT NULL DEFAULT 0,  -- 오늘(refill_date) 사용한 리필 횟수(최대 3)
  refill_date   TEXT,                         -- refill_count 가 적용되는 날짜(KST, YYYY-MM-DD). 날짜 바뀌면 0으로 취급
  ox_balance    REAL NOT NULL DEFAULT 100,   -- 가상 코인 OX 현물 보유량(가입 시 정해진 물량 지급, 유저간 매매로만 이동)
  total_volume  REAL NOT NULL DEFAULT 0,     -- 누적 거래대금(notional = 체결가 × 수량, 레버리지 포함) → VIP 등급 산정 기준
  total_fees    REAL NOT NULL DEFAULT 0      -- 이 유저가 지금까지 낸 거래 수수료 합계(표시용)
);

CREATE TABLE IF NOT EXISTS positions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,          -- 'long' | 'short'
  entry_price REAL NOT NULL,
  size        REAL NOT NULL,
  leverage    INTEGER NOT NULL,
  margin      REAL NOT NULL,          -- 차감된 증거금
  opened_at   INTEGER NOT NULL,
  stop_loss   REAL,                   -- 손절가 (미설정 시 NULL)
  take_profit REAL                    -- 익절가 (미설정 시 NULL)
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL,
  price      REAL NOT NULL,           -- 서버 체결가
  size       REAL NOT NULL,
  leverage   INTEGER NOT NULL,
  kind       TEXT NOT NULL,           -- 'open' | 'close'
  pnl        REAL,                    -- close 시 실현손익
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- 지정가(미체결) 주문. 생성 시 증거금(limit_price 기준)을 즉시 잠그고,
-- 체결 시 positions 로 이관된다(checkTriggers, functions/_trading.ts).
CREATE TABLE IF NOT EXISTS pending_orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,          -- 'long' | 'short' (주문 방향. reduce_only 면 청산 대상 포지션의 반대: 롱 청산=short)
  size        REAL NOT NULL,
  leverage    INTEGER NOT NULL,
  limit_price REAL NOT NULL,
  margin      REAL NOT NULL,          -- 생성 시 잠근 증거금 (limit_price 기준). reduce_only 는 증거금 안 잠금(=0)
  stop_loss   REAL,
  take_profit REAL,
  created_at  INTEGER NOT NULL,
  reduce_only INTEGER NOT NULL DEFAULT 0  -- 1이면 지정가 "청산"(체결 시 포지션을 열지 않고 반대 포지션을 줄인다), 증거금 안 잠금
);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_orders(user_id);
-- OX 호가창(loadSpotMarket UNION)·마켓메이커 sweep 이 매 폴링마다 symbol 로 조회하므로 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS idx_pending_symbol ON pending_orders(symbol);

-- 조건부(스탑) 주문. 지정가와 달리 증거금을 미리 잠그지 않는다(스탑 주문 관행) — 트리거 가격을
-- 넘어서면(trigger_dir='above' 면 mark>=trigger_price, 'below' 면 mark<=trigger_price) 그 자리에서
-- **시장가**로 size 만큼 진입한다(checkTriggers, functions/_trading.ts). 시장가라 OX 는 봇 호가창을
-- walking, 실제 코인은 mark 가에 즉시 체결하되 **가용 증거금만큼만** 체결하고 못 채운 잔량은 조건을
-- 그대로 유지한다(size 를 줄이고 살려둠) → "예약 수량이 다 체결 안 되면 계속 조건이 살아있음".
--
-- repeating=1 이면 **무한(반복) 조건부** — 체결돼도 주문이 사라지지 않는다. 두 가지 반복 방식이 있다:
--   repeat_mode='continuous' (기본) : 조건이 참인 **동안 계속** 실행한다(폴링마다 1회 = 유저 접속 중
--     최대 1초에 1회). "1.5 이하로 떨어져 있는 동안 계속 사 모은다"는 물타기/DCA 용도.
--     ⚠ 자동으로 안 멈춘다 — cooldown_ms(재실행 간격)·max_fills(최대 횟수)가 유일한 브레이크이고,
--     둘 다 안 걸면 조건이 참인 동안 잔고가 바닥날 때까지 계속 진입한다(의도된 동작).
--   repeat_mode='rearm' : 한 번 실행되면 armed=0 이 되고, 가격이 트리거 반대편(rearm_price,
--     기본=trigger_price)으로 돌아왔을 때만 다시 무장한다 → "내려갈 때마다 한 번씩".
CREATE TABLE IF NOT EXISTS conditional_orders (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,          -- 'long' | 'short' (진입 방향)
  size          REAL NOT NULL,          -- 1회성: 남은(미체결) 목표 수량(부분 체결 시 줄어듦) / 무한: 1회 실행 수량(고정)
  leverage      INTEGER NOT NULL,
  trigger_price REAL NOT NULL,
  trigger_dir   TEXT NOT NULL,          -- 'above'(가격이 이상이 되면) | 'below'(이하가 되면)
  created_at    INTEGER NOT NULL,
  repeating     INTEGER NOT NULL DEFAULT 0,  -- 1이면 무한(반복) 조건부 — 체결돼도 삭제하지 않는다
  armed         INTEGER NOT NULL DEFAULT 1,  -- (rearm 모드 전용) 1=트리거 대기 / 0=재무장 대기
  rearm_price   REAL,                        -- (rearm 모드 전용) 재무장 가격(NULL=trigger_price)
  fill_count    INTEGER NOT NULL DEFAULT 0,  -- 지금까지 실행된 횟수(표시용)
  max_fills     INTEGER,                     -- 최대 실행 횟수(NULL=무제한). 도달하면 주문 삭제
  repeat_mode   TEXT NOT NULL DEFAULT 'continuous', -- 'continuous'(조건 참인 동안 계속) | 'rearm'(되돌아와야 재실행)
  cooldown_ms   INTEGER NOT NULL DEFAULT 0,  -- (continuous 전용) 최소 재실행 간격 ms. 0=폴링마다
  last_fill_at  INTEGER                      -- 마지막 실행 시각(ms) — cooldown 판정 + 표시용
);
CREATE INDEX IF NOT EXISTS idx_conditional_user ON conditional_orders(user_id);

-- ── 가상 코인 현물 거래(OX/USDT, 예시 1종) — 외부 시세 없이 유저 대 유저 주문매칭 ──────
-- 레버리지·마진 없음. 매수는 USDT(users.balance)를, 매도는 OX(users.ox_balance)를
-- 주문 시점에 즉시 잠그고(조건부 UPDATE), functions/api/spot.ts 가 주문 직후 그 자리에서
-- 반대편 최우선호가와 매칭(체결가=먼저 있던 주문의 가격, 시간우선)한다. 남은 수량은 호가로 대기.
-- ⚠⚠ **레거시 — 더 이상 아무도 읽지도 쓰지도 않는다**(2026-07-31). 봇 호가 사다리는 이제
-- spot_bot_state.book_json 한 칸에 들어간다(§ BotBook, functions/api/spot.ts). 이 테이블은 예전에
-- 재호가 때마다 44행을 INSERT 하고 취소 마킹만 해서 **1,358만 행 / DB 3.38GB** 까지 부풀었던 주범이고,
-- 틱당 45문장을 먹어 cron 1회가 D1 쿼리 한도(1,000)의 950 을 쓰게 만든 원인이기도 하다.
-- 롤백 여지를 남기려고 정의만 남겨두며, 확인 후 `DROP TABLE spot_orders` 로 지우면 된다.
CREATE TABLE IF NOT EXISTS spot_orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  pair       TEXT NOT NULL,          -- 'OXUSDT' (다른 페어 확장 대비 컬럼으로 둠)
  side       TEXT NOT NULL,          -- 'buy' | 'sell'
  price      REAL NOT NULL,
  size       REAL NOT NULL,          -- 남은(미체결) 수량
  orig_size  REAL NOT NULL,          -- 최초 주문 수량
  status     TEXT NOT NULL,          -- 'open' | 'filled' (재호가 때 행 자체가 지워지므로 'cancelled' 는 이제 안 쓴다)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spot_orders_book ON spot_orders(pair, status, side, price);
CREATE INDEX IF NOT EXISTS idx_spot_orders_user ON spot_orders(user_id);

-- ⚠ 체결 테이프는 **최근 6시간만 보존**한다(spot.ts TRADE_RETENTION_MS, 재호가 틱이 가끔 잘라냄).
-- 읽는 곳이 최근 30건(호가창 체결내역)·5,000건(1s 캔들 버킷팅)·1건(기준가 폴백)뿐이고, 차트 히스토리는
-- spot_candles 가 영구 보관하므로 오래된 체결은 지워도 잃는 게 없다(예전엔 영구 보존 → 157만 행).
CREATE TABLE IF NOT EXISTS spot_trades (
  id         TEXT PRIMARY KEY,
  pair       TEXT NOT NULL,
  buyer_id   TEXT NOT NULL,
  seller_id  TEXT NOT NULL,
  price      REAL NOT NULL,
  size       REAL NOT NULL,
  taker_side TEXT,                    -- 'buy' | 'sell' — 이 체결을 발생시킨(나중에 낸) 주문 방향, 체결가 색상 표시용
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spot_trades_pair ON spot_trades(pair, created_at);

-- ── 가상 코인 마켓메이커 봇(OX/USDT 유동성 공급용) ──────────────────────
-- 예약된 봇 유저 2개(서로 매칭 상대가 되어줌, 실유저와도 매칭됨) — 폴링 시점마다
-- functions/api/spot.ts runMarketMaker() 가 랜덤워크로 기준가를 움직이며 호가를 깐다.
-- passcode_hash 의 scheme 이 'pbkdf2' 가 아니므로 verifyPasscode 가 항상 false → 로그인 불가.
-- name 이 유니크 제약으로 이미 선점되어 실유저가 같은 이름으로 가입할 수도 없다.
INSERT OR IGNORE INTO users (id, name, passcode_hash, balance, created_at, ox_balance) VALUES
  ('bot-mm-1', 'MarketMaker1', 'disabled$$bot-account-no-login', 100000000, 0, 100000000),
  ('bot-mm-2', 'MarketMaker2', 'disabled$$bot-account-no-login', 100000000, 0, 100000000);

-- ⚠ 이 행(pair 당 1개)은 시세뿐 아니라 봇의 "심리 상태"를 담는다. 예전엔 ref_price 하나로 IID 랜덤워크만
-- 돌려서 추세도 변동성 뭉침도 없는 무특징 노이즈였다(사람이 읽을 구조가 없어 재미가 없었다). 지금은
-- 추세(drift)·변동성(vol)·군중심리(sentiment)·적정가 앵커(anchor)·시장 국면(regime)을 지속시켜
-- functions/api/spot.ts nextMarketState() 가 틱마다 이어받아 갱신한다(§ "봇 매매 심리 모델").
CREATE TABLE IF NOT EXISTS spot_bot_state (
  id           TEXT PRIMARY KEY,   -- pair (예: 'OXUSDT')
  last_run     INTEGER NOT NULL,
  ref_price    REAL NOT NULL,
  drift        REAL NOT NULL DEFAULT 0,       -- 추세 강도(틱당 기대수익률), AR(1) 로 몇 틱 지속
  vol          REAL NOT NULL DEFAULT 1,       -- 변동성 배수(클러스터링 — 잔잔한 구간/거친 구간이 뭉침)
  sentiment    REAL NOT NULL DEFAULT 0,       -- 군중 심리 -1(공포) ~ +1(탐욕)
  anchor       REAL NOT NULL DEFAULT 0,       -- 완만히 따라오는 "적정가"(과열/과매도 판정 기준, 0=미초기화)
  regime       TEXT NOT NULL DEFAULT 'calm',  -- calm|rally|euphoria|pullback|panic
  regime_ticks INTEGER NOT NULL DEFAULT 0,    -- 현재 국면이 지속된 틱 수(최소 지속시간 보장용)
  -- ⚠ 봇 호가 사다리 전체가 이 한 칸이다(예전엔 spot_orders 44행). {"o":액터봇,"b":[[가격,수량]..],"a":[..]}
  -- 매 재호가마다 통째로 교체되고, 유저 체결이 물량을 깎으면 book_version 가드로 되쓴다(§ BotBook).
  book_json    TEXT,
  book_version INTEGER NOT NULL DEFAULT 0     -- 낙관적 동시성 — 재호가와 소비가 서로를 덮어쓰지 않게
);

-- 가상 코인 시작가 — 이 행이 있어야 그 페어의 봇이 돈다(functions/api/spot.ts VIRTUAL_PAIRS 와 짝).
-- ⚠ 새 가상 코인을 추가할 때 손댈 곳은 (1) VIRTUAL_PAIRS (2) src/symbols.ts VIRTUAL_SYMBOLS (3) 이 INSERT
-- 셋뿐이다. last_run=0 이면 다음 cron/폴링이 곧바로 첫 사다리를 깐다.
INSERT OR IGNORE INTO spot_bot_state (id, last_run, ref_price, anchor) VALUES
  ('OXUSDT', 0, 1, 1),
  ('EWUSDT', 0, 1, 1);

-- ── 봇 재고(가상 코인별) ──────────────────────────────────────────────
-- 봇이 유저 상대로 체결하면 현금(users.balance)과 함께 이 재고가 움직인다(functions/api/spot.ts
-- botFillStmts). 값의 의미는 "유저 전체 순포지션의 거울" — 유저가 순매수면 봇 재고는 마이너스로 간다.
-- ⚠ 예전엔 `users.ox_balance` 단일 컬럼이었는데, 가상 코인이 둘 이상이면 한 컬럼에 섞여 어느 코인
-- 재고인지 구분이 사라진다(그러면 이 값의 유일한 의미가 없어진다) → 페어별 행으로 분리(2026-07-31).
-- ⚠ 잔고 가드는 절대 붙이지 않는다 — 봇은 설계상 무한 유동성 공급자라 음수가 정상이다.
CREATE TABLE IF NOT EXISTS bot_inventory (
  pair     TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  qty      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (pair, user_id)
);

-- ── OX 영속 캔들(차트 히스토리 영구 보존) ─────────────────────────────
-- 예전엔 캔들을 매 요청마다 "최신 spot_trades 5000건"을 버킷팅해 만들어서, 총 거래가 5000건을 넘으면
-- 오래된 캔들이 창 밖으로 밀려 차트 데이터가 시간이 지나면 사라졌다(특히 큰 인터벌은 몇 봉만 남음).
-- 이제 모든 체결(functions/api/spot.ts candleUpsertStmts)이 인터벌별 OHLCV 를 여기에 누적 upsert 하고,
-- loadSpotCandles 가 이 테이블에서 읽어 히스토리를 영구 보존한다(1s 만 예외로 최신 거래 버킷팅).
CREATE TABLE IF NOT EXISTS spot_candles (
  pair     TEXT NOT NULL,      -- 'OXUSDT'
  interval TEXT NOT NULL,      -- 인터벌 코드('1m','5m','1h','1d' 등, functions/api/spot.ts CANDLE_INTERVALS)
  bucket   INTEGER NOT NULL,   -- 버킷 시작 시각(ms, epoch) = floor(체결시각 / 인터벌ms) * 인터벌ms
  open     REAL NOT NULL,
  high     REAL NOT NULL,
  low      REAL NOT NULL,
  close    REAL NOT NULL,
  volume   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (pair, interval, bucket)   -- (pair,interval) 로 조회 + bucket 정렬을 이 인덱스로 커버
);

-- ── 거래 수수료 원장(플랫폼이 벌어들인 수수료) ────────────────────────────
-- 체결 1건마다 1행. 유저별/심볼별/기간별로 SUM 해서 수수료 수익을 집계한다(users.total_fees 는
-- 유저 표시용 캐시일 뿐, 수익의 진실원본은 이 테이블이다). VIP 등급은 users.total_volume 에서
-- 파생하므로 별도 컬럼으로 저장하지 않는다(functions/_shared.ts vipOf).
CREATE TABLE IF NOT EXISTS fee_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  kind       TEXT NOT NULL,       -- 'open' | 'close' (강제청산은 수수료를 걷지 않음 — 잔고가 0으로 리셋되므로)
  notional   REAL NOT NULL,       -- 체결 명목금액 = 체결가 × 수량 (레버리지 포함)
  rate       REAL NOT NULL,       -- 그 체결에 적용된 수수료율(체결 시점의 VIP 등급)
  fee        REAL NOT NULL,       -- notional × rate
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_user ON fee_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_time ON fee_ledger(created_at);

-- ⚠ 일회성 마이그레이션 (2026-07-15 추가, SL/TP 지원): 이미 스키마가 적용된 기존
-- prod DB 의 positions 테이블에 컬럼을 추가한다. CREATE TABLE IF NOT EXISTS 는
-- 기존 테이블에 컬럼을 더해주지 않으므로 별도 ALTER 필요. 최초 1회
-- (`wrangler d1 execute ox64 --remote --file=./schema.sql`) 적용 후에는
-- 재실행 시 "duplicate column name" 에러로 전체 파일 적용이 중단되니 이 블록을
-- 지울 것. 신규 DB(스키마를 처음 적용하는 경우)는 위 CREATE TABLE 에 이미
-- stop_loss/take_profit 이 포함돼 있으므로 이 블록이 필요 없다 — 실행 전에
-- 지워도 무방하다.
-- ALTER TABLE positions ADD COLUMN stop_loss REAL;
-- ALTER TABLE positions ADD COLUMN take_profit REAL;

-- ⚠ 일회성 마이그레이션 (2026-07-15 추가, 강제청산 리필 지원): 기존 prod DB 의
-- users 테이블에 컬럼을 추가한다. 위와 동일한 이유로 최초 1회만 실행할 것.
-- ALTER TABLE users ADD COLUMN refill_count INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE users ADD COLUMN refill_date TEXT;

-- ⚠ 일회성 마이그레이션 (2026-07-15 추가, OX 현물 거래 지원): 기존 prod DB 의
-- users 테이블에 컬럼을 추가한다. 위와 동일한 이유로 최초 1회만 실행할 것.
-- ALTER TABLE users ADD COLUMN ox_balance REAL NOT NULL DEFAULT 100;

-- ⚠ 일회성 마이그레이션 (2026-07-15 추가, 체결 탭 매수/매도 색상 구분): 이미 spot_trades 가
-- 생성된 prod DB 에 컬럼을 추가한다. 위와 동일한 이유로 최초 1회만 실행할 것.
-- ALTER TABLE spot_trades ADD COLUMN taker_side TEXT;

-- ⚠ 마이그레이션 (2026-07-18 추가, OX 호가/sweep symbol 인덱스): CREATE INDEX IF NOT EXISTS 라
-- 멱등이므로 `wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용만으로 자동 생성된다
-- (별도 ALTER 불필요). 위 idx_pending_symbol 참고.

-- ⚠ 마이그레이션 (2026-07-19 추가, OX 영속 캔들): 위 spot_candles 는 CREATE TABLE IF NOT EXISTS 라
-- `wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용만으로 자동 생성된다(ALTER 불필요).
-- 신규 배포 직후엔 비어 있으므로 loadSpotCandles 가 잠시 거래 버킷팅으로 폴백하다가, 봇/유저 체결이
-- 쌓이면서 자연히 이 테이블이 채워져 이후 히스토리가 영구 보존된다(백필 스크립트 불필요).

-- ⚠ 일회성 마이그레이션 (2026-07-19 추가, 지정가 청산=reduce-only 주문): 기존 prod DB 의 pending_orders
-- 에 컬럼을 추가한다. CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 더해주지 않으므로 최초 1회만
-- 아래를 직접 실행할 것(코드가 이 컬럼을 참조하므로 코드 배포 전에 먼저 적용돼 있어야 한다 — limitClose
-- INSERT 가 실패하지 않게). 이미 실행했다면 재실행 시 "duplicate column name" 에러(무시 가능).
-- ALTER TABLE pending_orders ADD COLUMN reduce_only INTEGER NOT NULL DEFAULT 0;

-- ⚠ 일회성 마이그레이션 (2026-07-20 추가, 봇 매매 심리 모델): 기존 prod DB 의 spot_bot_state 에 봇의
-- 심리/국면 상태 컬럼을 추가한다. CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 더해주지 않으므로
-- 최초 1회만 아래를 직접 실행할 것 — 코드(nextMarketState)가 이 컬럼들을 SELECT/UPDATE 하므로 **코드
-- 배포 전에 먼저 적용돼 있어야 한다**. 전부 DEFAULT 가 있어 기존 행도 그대로 동작하며(anchor=0 은
-- "미초기화"라 첫 틱에 현재가로 자동 세팅), 이미 실행했다면 "duplicate column name" 에러(무시 가능).
-- ALTER TABLE spot_bot_state ADD COLUMN drift REAL NOT NULL DEFAULT 0;
-- ALTER TABLE spot_bot_state ADD COLUMN vol REAL NOT NULL DEFAULT 1;
-- ALTER TABLE spot_bot_state ADD COLUMN sentiment REAL NOT NULL DEFAULT 0;
-- ALTER TABLE spot_bot_state ADD COLUMN anchor REAL NOT NULL DEFAULT 0;
-- ALTER TABLE spot_bot_state ADD COLUMN regime TEXT NOT NULL DEFAULT 'calm';
-- ALTER TABLE spot_bot_state ADD COLUMN regime_ticks INTEGER NOT NULL DEFAULT 0;

-- ⚠ 일회성 마이그레이션 (2026-07-20 추가, 거래 수수료 + VIP 등급): 기존 prod DB 의 users 에 누적
-- 거래대금/수수료 컬럼을 추가한다. CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 더해주지
-- 않으므로 최초 1회만 아래를 직접 실행할 것 — 코드(loadState/feeAccrualStmts)가 참조하므로 **코드
-- 배포 전에 먼저 적용돼 있어야 한다**. fee_ledger 는 신규 테이블이라 --file=./schema.sql 재적용만으로
-- 생성된다(ALTER 불필요). 이미 실행했다면 "duplicate column name" 에러(무시 가능).
-- ALTER TABLE users ADD COLUMN total_volume REAL NOT NULL DEFAULT 0;
-- ALTER TABLE users ADD COLUMN total_fees REAL NOT NULL DEFAULT 0;

-- ⚠ 마이그레이션 (2026-07-24 추가, 조건부(스탑) 주문): 위 conditional_orders 는 CREATE TABLE IF NOT
-- EXISTS 라 `wrangler d1 execute ox64 --remote --file=./schema.sql` 재적용만으로 자동 생성된다(ALTER
-- 불필요). ⚠ **코드(loadState/checkTriggers)가 이 테이블을 SELECT 하므로 코드 배포 전에 먼저 생성돼
-- 있어야 한다** — 없으면 /api/state 가 통째로 500 이 된다(loadState 는 방어적으로 try/catch 로 감싸
-- 두긴 했으나, 그래도 배포 전에 테이블을 만들어 두는 게 원칙).

-- ⚠ 일회성 마이그레이션 (2026-07-28 추가, 무한(반복) 조건부 주문): 위 CREATE TABLE 에는 이미 포함돼
-- 있지만, conditional_orders 가 이미 만들어진 기존 DB(=prod)에는 CREATE TABLE IF NOT EXISTS 가 컬럼을
-- 더해주지 않으므로 최초 1회만 아래를 직접 실행할 것. **코드(loadState/checkTriggers/conditionalOpen)가
-- 이 컬럼들을 SELECT/INSERT/UPDATE 하므로 코드 배포 전에 먼저 적용돼 있어야 한다** — 읽기 경로는 값이
-- 없어도 기본값(?? 0/1)으로 방어하지만, conditionalOpen 의 INSERT 는 컬럼이 없으면 그대로 실패한다.
-- 이미 실행했다면 재실행 시 "duplicate column name" 에러(무시 가능).
-- ALTER TABLE conditional_orders ADD COLUMN repeating INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE conditional_orders ADD COLUMN armed INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE conditional_orders ADD COLUMN rearm_price REAL;
-- ALTER TABLE conditional_orders ADD COLUMN fill_count INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE conditional_orders ADD COLUMN max_fills INTEGER;
-- (같은 날 추가 — 반복 방식/재실행 간격)
-- ALTER TABLE conditional_orders ADD COLUMN repeat_mode TEXT NOT NULL DEFAULT 'continuous';
-- ALTER TABLE conditional_orders ADD COLUMN cooldown_ms INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE conditional_orders ADD COLUMN last_fill_at INTEGER;

-- ⚠⚠ 일회성 정리 (2026-07-31 추가, "죽은 봇 호가/옛 체결" 청소): 스키마 변경이 아니라 **데이터 청소**다.
-- 배경 — 마켓메이커는 매 틱 봇 호가 사다리(44개)를 새로 깔면서 직전 호가를 status='cancelled' 로 "마킹만"
-- 하고 지우지 않았고, 체결 테이프(spot_trades)도 영구 보존이었다. prod 실측(2026-07-31):
--   spot_orders  13,584,823 행 (살아있는 호가는 항상 ~45개 — 나머지 전부 시체), 하루 +86만 행
--   spot_trades   1,571,784 행 (실제로 읽는 건 최근 30건/5,000건뿐), 하루 +10만 행
--   → DB 3.38GB / 하루 +200MB. D1 의 DB당 한도 10GB 까지 약 한 달 남은 상태였다(도달하면 쓰기가 거부되어
--     가상코인뿐 아니라 트레이딩 전체가 정지한다).
-- 코드 수정(spot.ts)으로 이제 재호가 때 DELETE 하고 체결도 6시간만 보존하므로 **더는 쌓이지 않는다**.
-- 아래는 이미 쌓인 과거분을 한 번에 비우는 명령이다(최초 1회).
--   ⚠ spot_orders 는 DELETE 대신 DROP+재생성을 쓴다 — 1,358만 행 DELETE 는 30초 쿼리 한도를 넘기고
--     rows written 과금도 크게 붙는다. 이 테이블엔 봇 호가만 있고(유일한 INSERT 경로가 botQuoteStmt)
--     모든 SELECT 가 status='open' 만 읽으므로 통째로 비워도 잃는 정보가 없다. 비운 직후 다음 봇 틱이
--     사다리를 다시 깐다(<1초).
--   ⚠ SQLite 는 VACUUM 없이는 파일이 줄지 않는다(D1 은 VACUUM 미지원). 지운 페이지는 freelist 로 가서
--     이후 새 데이터가 재사용하므로, **파일 크기는 3.4GB 근처에 머물되 더 이상 커지지 않는다** — 10GB
--     한도 문제는 이것으로 해소된다(Paid 플랜 storage 포함분 5GB 안이라 과금도 0).
-- DROP TABLE IF EXISTS spot_orders;
-- CREATE TABLE IF NOT EXISTS spot_orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pair TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, size REAL NOT NULL, orig_size REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
-- CREATE INDEX IF NOT EXISTS idx_spot_orders_book ON spot_orders(pair, status, side, price);
-- CREATE INDEX IF NOT EXISTS idx_spot_orders_user ON spot_orders(user_id);
-- (체결 테이프는 행 수가 적어 그냥 잘라낸다 — 6시간치만 남긴다. 차트 히스토리는 spot_candles 가 보관.)
-- DELETE FROM spot_trades WHERE created_at < (strftime('%s','now') - 6*3600) * 1000;
--   ⚠ 실전 기록: `DROP TABLE spot_orders` 는 3GB 짜리 테이블에선 D1 의 storage operation timeout 에 걸려
--     7429/7500 에러를 뱉는다(그 사이 DB 가 잠겨 다른 쿼리도 같이 실패한다). 그래도 DDL 자체는 커밋되므로
--     에러 메시지만 보고 "실패했다"고 판단하지 말고 실제 행 수를 다시 확인할 것.

-- ⚠ 일회성 마이그레이션 (2026-07-31 추가, 봇 사다리를 JSON 한 칸으로): 기존 prod DB 의 spot_bot_state 에
-- 컬럼을 추가한다. CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 더해주지 않으므로 최초 1회만 아래를
-- 직접 실행할 것 — **코드(marketMakerTick/매칭 전 경로)가 이 컬럼을 SELECT/UPDATE 하므로 코드 배포 전에
-- 먼저 적용돼 있어야 한다**. 이미 실행했다면 "duplicate column name" 에러(무시 가능). prod 적용 완료.
-- ALTER TABLE spot_bot_state ADD COLUMN book_json TEXT;
-- ALTER TABLE spot_bot_state ADD COLUMN book_version INTEGER NOT NULL DEFAULT 0;

-- ⚠ 마이그레이션 (2026-07-31 추가, 가상 코인 2종 = OX/USDT + EW/USDT): `bot_inventory` 는 신규 테이블이라
-- `--file=./schema.sql` 재적용만으로 생성되지만, **기존 봇 재고(users.ox_balance)를 OXUSDT 행으로 옮기는
-- 백필**과 **EWUSDT 시작가 행**은 아래를 한 번 실행해야 한다. 셋 다 멱등(IGNORE)이라 재실행해도 안전하다.
-- ⚠ 코드가 bot_inventory 에 INSERT 하므로 **코드 배포 전에 테이블이 있어야 한다**. prod 적용 완료.
-- CREATE TABLE IF NOT EXISTS bot_inventory (pair TEXT NOT NULL, user_id TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (pair, user_id));
-- INSERT OR IGNORE INTO bot_inventory (pair, user_id, qty) SELECT 'OXUSDT', id, ox_balance FROM users WHERE id IN ('bot-mm-1','bot-mm-2');
-- INSERT OR IGNORE INTO spot_bot_state (id, last_run, ref_price, anchor) VALUES ('EWUSDT', 0, 1, 1);
--   (users.ox_balance 는 이제 아무도 안 쓴다 — 레거시 컬럼으로 남겨둔다.)

-- ── 퍼즐게임(ox64.app/b, "스핑크스 보석찾기" 확장) — 코인 트레이딩과 완전히 분리된 별도 재화 ──────
-- 격자 보드에 여러 칸을 차지하는 보석(모양별로 다름)이 숨겨져 있고, 칸을 하나씩 열 때마다(코스트 1
-- 소모) 그 칸이 보석 조각인지 빈 땅인지 알려준다. 한 보석의 모든 칸을 다 열어야 그 보석을 "획득"한
-- 것으로 치고, 목표 보석을 전부 획득하면 클리어(재화 보상). 재화가 0이 되면 게임오버. 트레이딩과
-- 동일하게 **서버 권위** — 보드의 정답 배치는 서버(D1)만 알고, 클라이언트는 칸을 열 때마다 서버에
-- 물어 결과만 받는다(개발자도구로 미리 볼 수 없게). 계정은 기존 users 테이블(이름+패스코드 로그인)을
-- 그대로 재사용하고, 재화(puzzle_stats.currency)만 완전히 새로운 컬럼/테이블로 분리한다.
CREATE TABLE IF NOT EXISTS puzzle_stats (
  user_id      TEXT PRIMARY KEY,
  currency     INTEGER NOT NULL DEFAULT 60,  -- 보석 재화(영구 누적). 칸 열 때마다 차감, 클리어 시 보상으로 증가
  best_level   INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  games_won    INTEGER NOT NULL DEFAULT 0,
  refill_count INTEGER NOT NULL DEFAULT 0,   -- 오늘(refill_date) 사용한 리필 횟수(재화 0일 때만 가능)
  refill_date  TEXT,
  created_at   INTEGER NOT NULL
);

-- 진행 중/완료된 게임 1판당 1행. board/gems 는 서버만 사용하는 정답 배치라 클라 응답에 절대 포함하지
-- 않는다(publicGame() 이 revealed 된 칸만 걸러 내려줌). status: active|won|lost|abandoned.
CREATE TABLE IF NOT EXISTS puzzle_games (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  level      INTEGER NOT NULL,
  size       INTEGER NOT NULL,          -- 보드 한 변 길이(NxN)
  board      TEXT NOT NULL,             -- JSON: {"x,y": gemInstanceId, ...} (빈 칸은 키 자체가 없음) — 정답, 비공개
  gems       TEXT NOT NULL,             -- JSON: gemInstanceId -> {typeKey,label,color,size,revealedCount}
  revealed   TEXT NOT NULL,             -- JSON: 이미 연 좌표 배열 ["x,y", ...]
  spent      INTEGER NOT NULL DEFAULT 0,-- 이 판에서 쓴 코스트 합계(표시용)
  status     TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_puzzle_games_user ON puzzle_games(user_id, status);

-- ── "5분 던전"(ox64.app/5m) — 실시간 협동 카드게임, 트레이딩·퍼즐 어느 쪽과도 완전히 분리 ──────
-- 원작 "5-Minute Dungeon" 의 핵심 루프(아이콘 매칭으로 몬스터 격파, 개인 덱 히든드로우, 손패 공개,
-- 실제 5분 벽시계 타이머, 함정/포션/보스)를 재현했다(아이콘 5종·영웅 6종·몬스터 24종·던전 4개).
-- 새 인프라(Durable Objects/WebSocket) 없이 기존 D1 + 짧은 폴링(OX 마켓메이커와 동일 패턴)으로
-- 동기화한다. 재화 없음 — 승패 통계만 기록. 계정은 기존 users 테이블(이름+패스코드)을 재사용한다.
CREATE TABLE IF NOT EXISTS dungeon_stats (
  user_id      TEXT PRIMARY KEY,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  best_clear_ms INTEGER,                  -- 클리어까지 걸린 시간(ms) 중 최단 기록, 없으면 NULL
  created_at   INTEGER NOT NULL
);

-- 방 1개당 1행. deck_json(남은 몬스터/이벤트 덱 순서)은 서버만 알고 클라 응답엔 절대 포함하지
-- 않는다(현재 공개 카드만 current_json 으로 내려줌). version 은 낙관적 동시성 카운터 —
-- 여러 플레이어가 동시에 카드를 내도 `UPDATE ... WHERE code=? AND version=?` 조건부 갱신으로
-- 경합을 원자적으로 막는다(0행이면 재조회 후 재시도, 트레이딩의 "조건부 UPDATE" 관용구와 동일 사상).
CREATE TABLE IF NOT EXISTS dungeon_rooms (
  code         TEXT PRIMARY KEY,        -- 6자 방 코드
  host_user_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'lobby',  -- lobby|active|won|lost
  hp           INTEGER NOT NULL DEFAULT 5,      -- 파티 공용 체력(함정으로만 감소, 포션으로 회복)
  ends_at      INTEGER,                          -- 5분 타이머 만료 시각(ms epoch), start 시점에 설정
  deck_json    TEXT,                             -- JSON: 남은 몬스터/이벤트 카드 배열(비공개, 서버 전용)
  current_json TEXT,                             -- JSON: 현재 공개된 카드 + 요구치 진행도
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  dungeon_id   TEXT,                             -- 선택한 던전(_dungeonData.ts DUNGEONS), 로비에서 방장이 고름
  log_json     TEXT,                             -- JSON: 최근 이벤트 로그(함정 발동/격파/페이즈…) — 폴링이라
                                                 --       놓친 사건을 파티원이 따라잡을 수 있게 방에 남긴다
  total_events INTEGER,                          -- 시작 시점 덱 길이(진행도 "X/Y" 표시용)
  ward         INTEGER NOT NULL DEFAULT 0        -- 남은 함정 무효화 횟수(팔라딘 "수호의 방벽")
);

-- 방(room_code) x 유저 1행. hand_json(손패)은 파티 전원에게 공개되지만, deck_json(남은 개인 덱
-- 순서)은 응답에서 절대 내려주지 않는다(개수만) — 진짜 카드게임처럼 다음에 뭘 뽑을지 본인도 모름.
CREATE TABLE IF NOT EXISTS dungeon_players (
  room_code    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  hero_id      TEXT NOT NULL,
  hand_json    TEXT NOT NULL DEFAULT '[]',
  deck_json    TEXT NOT NULL DEFAULT '[]',     -- 남은 덱(비공개, 서버 전용)
  discard_json TEXT NOT NULL DEFAULT '[]',     -- 버림더미(덱 소진 시 재셔플 원본)
  exhausted    INTEGER NOT NULL DEFAULT 0,     -- 1이면 드로우 불가(지친 상태)
  used_special INTEGER NOT NULL DEFAULT 0,     -- 런당 1회 고유 특수카드 사용 여부
  version      INTEGER NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  contributed  REAL NOT NULL DEFAULT 0,        -- 이번 판에서 요구치에 기여한 총량(종료 화면 통계용)
  PRIMARY KEY (room_code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dungeon_players_room ON dungeon_players(room_code);

-- ⚠ 일회성 마이그레이션 (2026-07-27 추가, 5분 던전 콘텐츠 확장): 위 CREATE TABLE 에는 이미 포함돼
-- 있지만, 이미 테이블이 만들어진 기존 DB(=prod)에는 CREATE TABLE IF NOT EXISTS 가 컬럼을 더해주지
-- 않으므로 최초 1회만 아래를 직접 실행할 것. **코드(loadDungeonState/start/applyContribution)가 이
-- 컬럼들을 SELECT/UPDATE 하므로 코드 배포 전에 먼저 적용돼 있어야 한다.** 이미 실행했다면 재실행 시
-- "duplicate column name" 에러(무시 가능).
-- ALTER TABLE dungeon_rooms ADD COLUMN dungeon_id TEXT;
-- ALTER TABLE dungeon_rooms ADD COLUMN log_json TEXT;
-- ALTER TABLE dungeon_rooms ADD COLUMN total_events INTEGER;
-- ALTER TABLE dungeon_rooms ADD COLUMN ward INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE dungeon_players ADD COLUMN contributed REAL NOT NULL DEFAULT 0;
