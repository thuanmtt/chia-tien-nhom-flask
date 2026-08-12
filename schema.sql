-- Schema quan hệ (v2) cho Supabase Postgres. Idempotent — chạy lại nhiều lần không sao:
--   psql "$DATABASE_URL" -f schema.sql
-- KHÔNG chạy file này lên DB cũ (Neon) — DB cũ giữ nguyên để migrate_to_supabase.py đọc.
-- Thành viên được định danh bằng TÊN trong toàn bộ document model, nên các bảng con
-- tham chiếu member_name (text) thay vì FK id — giữ đúng ngữ nghĩa client hiện tại.

CREATE TABLE IF NOT EXISTS events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_code text UNIQUE NOT NULL,
    title      text NOT NULL,
    edit_key   text,
    -- id user Supabase Auth; NULL = event legacy/migrate. Không FK sang auth.users
    -- để schema chạy được trên Postgres thường khi dev/test.
    owner_id   uuid,
    -- Chia sẻ kiểu Google Docs: 'restricted' (chỉ owner/người có edit_key)
    -- hoặc 'link' (bất kỳ ai có đường liên kết) với vai trò 'viewer'/'editor'.
    -- Mặc định: ai có link đều xem được (đúng hành vi trước đây).
    share_access text NOT NULL DEFAULT 'link',
    share_role   text NOT NULL DEFAULT 'viewer',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Migration an toàn cho DB đã deploy trước khi có cột chia sẻ (chạy lại vô hại)
ALTER TABLE events ADD COLUMN IF NOT EXISTS share_access text NOT NULL DEFAULT 'link';
ALTER TABLE events ADD COLUMN IF NOT EXISTS share_role   text NOT NULL DEFAULT 'viewer';

CREATE TABLE IF NOT EXISTS members (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name     text NOT NULL,
    position int  NOT NULL,
    UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title        text NOT NULL DEFAULT '',
    amount       numeric NOT NULL DEFAULT 0,
    currency     text NOT NULL DEFAULT 'VND',
    payer_name   text NOT NULL DEFAULT '',
    benefit_type text NOT NULL DEFAULT 'all',
    expense_date text NOT NULL DEFAULT '',
    created_time text NOT NULL DEFAULT '',
    updated_time text NOT NULL DEFAULT '',
    position     int  NOT NULL
);

CREATE TABLE IF NOT EXISTS expense_beneficiaries (
    expense_id  uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_name text NOT NULL,
    position    int  NOT NULL,
    PRIMARY KEY (expense_id, member_name)
);

CREATE TABLE IF NOT EXISTS member_bank_info (
    event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    member_name text NOT NULL,
    bank        text NOT NULL DEFAULT '',
    account     text NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, member_name)
);

CREATE TABLE IF NOT EXISTS couples (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    client_id    text NOT NULL DEFAULT '',
    label        text NOT NULL DEFAULT '',
    primary_name text NOT NULL DEFAULT '',
    position     int  NOT NULL
);

CREATE TABLE IF NOT EXISTS couple_members (
    couple_id   uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    member_name text NOT NULL,
    position    int  NOT NULL,
    PRIMARY KEY (couple_id, member_name)
);

CREATE TABLE IF NOT EXISTS event_rates (
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    currency_code text NOT NULL,
    rate          numeric,            -- NULL = thiếu tỷ giá (client hiện cảnh báo)
    source        text NOT NULL DEFAULT '',
    rate_date     text,
    rate_type     text,
    currency_name text NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, currency_code)
);

-- Hồ sơ người dùng: username (duy nhất, lowercase) dùng thay email khi đăng
-- nhập. Không FK sang auth.users (giống owner_id) để chạy được trên Postgres
-- thường; user_id là id của Supabase Auth.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id    uuid PRIMARY KEY,
    username   text UNIQUE,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Lịch sử chỉnh sửa: mỗi lần ghi (tạo/sửa/khôi phục/đổi chia sẻ) một dòng.
-- snapshot = CẢ document (title + members + expenses + bankInfo + couples +
-- rates) SAU hành động → "khôi phục về bản này" = ghi lại snapshot của dòng đó.
-- actor_id là user Supabase Auth (mọi thao tác ghi giờ bắt buộc đăng nhập);
-- actor_name denormalize (username/email tại thời điểm đó) để đọc không phải
-- join auth.users và tên còn nguyên nếu tài khoản đổi/xóa.
CREATE TABLE IF NOT EXISTS event_revisions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    actor_id   uuid NOT NULL,
    actor_name text NOT NULL DEFAULT '',
    kind       text NOT NULL DEFAULT 'edit', -- 'create' | 'edit' | 'restore' | 'share'
    summary    jsonb NOT NULL DEFAULT '[]',
    snapshot   jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Người được mời đích danh (kiểu "Những người có quyền truy cập" của Google Docs).
-- Quyền CỘNG DỒN với quyền chung theo link + edit_key; chỉ owner quản lý danh sách.
-- user_id/added_by là user Supabase Auth — không FK auth.users (giống owner_id)
-- để schema chạy được trên Postgres thường khi dev/test.
CREATE TABLE IF NOT EXISTS event_collaborators (
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL,
    role       text NOT NULL DEFAULT 'viewer', -- 'viewer' | 'editor'
    added_by   uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_events_event_code ON events (event_code);
CREATE INDEX IF NOT EXISTS idx_events_owner_id   ON events (owner_id);
CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_event_id          ON members (event_id);
CREATE INDEX IF NOT EXISTS idx_expenses_event_id         ON expenses (event_id);
CREATE INDEX IF NOT EXISTS idx_member_bank_info_event_id ON member_bank_info (event_id);
CREATE INDEX IF NOT EXISTS idx_couples_event_id          ON couples (event_id);
CREATE INDEX IF NOT EXISTS idx_event_rates_event_id      ON event_rates (event_id);
CREATE INDEX IF NOT EXISTS idx_event_revisions_event_created
    ON event_revisions (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_collaborators_user ON event_collaborators (user_id);

-- Supabase expose PostgREST công khai với anon key → bật RLS, KHÔNG tạo policy
-- (deny-all cho anon/authenticated). Flask kết nối bằng role postgres (owner của
-- bảng) nên không bị chặn.
ALTER TABLE events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE members               ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_bank_info      ENABLE ROW LEVEL SECURITY;
ALTER TABLE couples               ENABLE ROW LEVEL SECURITY;
ALTER TABLE couple_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_rates           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_revisions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_collaborators   ENABLE ROW LEVEL SECURITY;
