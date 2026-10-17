-- ============================================================================
-- Bin Media — PostgreSQL schema
-- Chạy tự động khi STORE_AUTO_MIGRATE=1 (mặc định), hoặc chạy tay:
--   psql "$DATABASE_URL" -f schema.sql
--
-- Nguyên tắc:
--   - Mỗi thiết bị chỉ đăng ký được MỘT tài khoản Free  → UNIQUE(device_id)
--     (đăng ký + ghi nhận thiết bị là thao tác nguyên tử trong 1 transaction).
--   - Session chỉ lưu token HASH, không bao giờ lưu token thô.
--   - Bộ đếm đăng nhập sai / thời gian khóa lưu ở server, sống qua restart.
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    name_key            TEXT NOT NULL UNIQUE,
    type                TEXT NOT NULL CHECK (type IN ('free', 'vip')),
    device_id           TEXT UNIQUE,              -- chỉ tài khoản Free gắn thiết bị
    last_device_id      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    free_expires_at     TIMESTAMPTZ,              -- NULL với VIP (không giới hạn khi còn quyền)
    history_consent     BOOLEAN NOT NULL DEFAULT FALSE,
    history_consent_at  TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'active',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS free_devices (
    device_id       TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,            -- SHA-256 của session token
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,                     -- Free: = free_expires_at; VIP: NULL
    revoked_at   TIMESTAMPTZ,                     -- trạng thái thu hồi
    last_seen_at TIMESTAMPTZ,
    ip           TEXT,
    ua           TEXT
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);

-- Bộ đếm đăng nhập sai + khóa: theo IP / thiết bị / tên tài khoản
CREATE TABLE IF NOT EXISTS login_attempts (
    key           TEXT PRIMARY KEY,               -- ví dụ 'vipfail:ip:1.2.3.4'
    fails         INTEGER NOT NULL DEFAULT 0,
    count         INTEGER NOT NULL DEFAULT 0,
    window_start  TIMESTAMPTZ,
    locked_until  TIMESTAMPTZ,
    last_fail_at  TIMESTAMPTZ
);

-- ---- Metadata video: danh mục, phim, tập, trạng thái liên kết ---------------
CREATE TABLE IF NOT EXISTS categories (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    slug      TEXT NOT NULL UNIQUE,
    position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS movies (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    description  TEXT,
    poster_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS movie_categories (
    movie_id    TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (movie_id, category_id)
);

CREATE TABLE IF NOT EXISTS episodes (
    id                TEXT PRIMARY KEY,
    movie_id          TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    ep_number         DOUBLE PRECISION NOT NULL DEFAULT 0,
    source_type       TEXT NOT NULL DEFAULT 'facebook',
    source_ref        TEXT NOT NULL,              -- tham chiếu nguồn (URL/ID được phép)
    link_status       TEXT NOT NULL DEFAULT 'unlinked'
                      CHECK (link_status IN ('linked', 'unlinked', 'broken')),
    access_status     TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (access_status IN ('unknown', 'verified', 'unavailable')),
    access_checked_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episodes_movie_idx ON episodes (movie_id);

-- Lịch sử xem: chỉ ghi khi người dùng đã được thông báo và đồng ý
CREATE TABLE IF NOT EXISTS watch_history (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    movie_id    TEXT NOT NULL,
    episode_id  TEXT NOT NULL,
    position_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, episode_id)
);
