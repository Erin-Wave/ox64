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
  side        TEXT NOT NULL,          -- 'long' | 'short'
  size        REAL NOT NULL,
  leverage    INTEGER NOT NULL,
  limit_price REAL NOT NULL,
  margin      REAL NOT NULL,          -- 생성 시 잠근 증거금 (limit_price 기준)
  stop_loss   REAL,
  take_profit REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_orders(user_id);

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
