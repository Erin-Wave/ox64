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
  ox_balance    REAL NOT NULL DEFAULT 100    -- 가상 코인 OX 현물 보유량(가입 시 정해진 물량 지급, 유저간 매매로만 이동)
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

-- ── 가상 코인 현물 거래(OX/USDT, 예시 1종) — 외부 시세 없이 유저 대 유저 주문매칭 ──────
-- 레버리지·마진 없음. 매수는 USDT(users.balance)를, 매도는 OX(users.ox_balance)를
-- 주문 시점에 즉시 잠그고(조건부 UPDATE), functions/api/spot.ts 가 주문 직후 그 자리에서
-- 반대편 최우선호가와 매칭(체결가=먼저 있던 주문의 가격, 시간우선)한다. 남은 수량은 호가로 대기.
CREATE TABLE IF NOT EXISTS spot_orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  pair       TEXT NOT NULL,          -- 'OXUSDT' (다른 페어 확장 대비 컬럼으로 둠)
  side       TEXT NOT NULL,          -- 'buy' | 'sell'
  price      REAL NOT NULL,
  size       REAL NOT NULL,          -- 남은(미체결) 수량
  orig_size  REAL NOT NULL,          -- 최초 주문 수량
  status     TEXT NOT NULL,          -- 'open' | 'filled' | 'cancelled'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spot_orders_book ON spot_orders(pair, status, side, price);
CREATE INDEX IF NOT EXISTS idx_spot_orders_user ON spot_orders(user_id);

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

CREATE TABLE IF NOT EXISTS spot_bot_state (
  id        TEXT PRIMARY KEY,   -- pair (예: 'OXUSDT')
  last_run  INTEGER NOT NULL,
  ref_price REAL NOT NULL
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
