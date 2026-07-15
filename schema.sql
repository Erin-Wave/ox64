-- ox64 D1 스키마 (서버 권위 백엔드)
-- 적용: wrangler d1 execute ox64 --remote --file=./schema.sql
--   (로컬 개발: --local)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  passcode_hash TEXT NOT NULL,
  balance       REAL NOT NULL DEFAULT 10000,
  created_at    INTEGER NOT NULL
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
