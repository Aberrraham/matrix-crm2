-- Matrix CRM tables for PostgreSQL (Supabase).
-- The server runs this file every time it starts. It is safe to run again and again:
-- it only creates what is missing and never deletes customer data.
-- All tables start with crm_ so they can never clash with other tables, such as your booking site.

/* ---------------- customers ---------------- */

CREATE TABLE IF NOT EXISTS crm_users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT UNIQUE,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE crm_users DROP COLUMN IF EXISTS is_staff;   -- staff now have their own accounts (crm_staff)

CREATE TABLE IF NOT EXISTS crm_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL            -- milliseconds since 1970
);
CREATE INDEX IF NOT EXISTS idx_crm_sessions_user ON crm_sessions(user_id);

CREATE TABLE IF NOT EXISTS crm_otps (
  phone        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   BIGINT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_sent    BIGINT NOT NULL,
  sends        INTEGER NOT NULL DEFAULT 1,
  window_start BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_phone_verifications (
  user_id     BIGINT NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);

CREATE TABLE IF NOT EXISTS crm_profiles (
  user_id         BIGINT PRIMARY KEY REFERENCES crm_users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL UNIQUE,
  dob             DATE NOT NULL,
  travelling_from TEXT NOT NULL,
  occupation      TEXT NOT NULL,
  heard_from      TEXT NOT NULL,
  referral_code   TEXT NOT NULL UNIQUE,
  referred_by     BIGINT REFERENCES crm_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_profiles_referred_by ON crm_profiles(referred_by);

-- One waiver per person per game. Everyone whose waiver has the same play_date + slot + theme
-- is one TEAM. team_access = false means staff removed that person from the team.
CREATE TABLE IF NOT EXISTS crm_waivers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  version     TEXT NOT NULL,
  ip          TEXT,
  play_date   DATE NOT NULL,
  slot        TEXT NOT NULL,
  theme       TEXT NOT NULL,
  team_access BOOLEAN NOT NULL DEFAULT true,
  signed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Upgrade from the earlier version of this file (safe to repeat):
ALTER TABLE crm_waivers ADD COLUMN IF NOT EXISTS play_date   DATE;
ALTER TABLE crm_waivers ADD COLUMN IF NOT EXISTS slot        TEXT;
ALTER TABLE crm_waivers ADD COLUMN IF NOT EXISTS theme       TEXT;
ALTER TABLE crm_waivers ADD COLUMN IF NOT EXISTS team_access BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE crm_waivers DROP CONSTRAINT IF EXISTS crm_waivers_user_id_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_waivers_game ON crm_waivers(user_id, play_date, slot, theme);
CREATE INDEX IF NOT EXISTS idx_crm_waivers_team ON crm_waivers(play_date, slot, theme);
CREATE INDEX IF NOT EXISTS idx_crm_waivers_signed ON crm_waivers(signed_at DESC);

CREATE TABLE IF NOT EXISTS crm_vouchers (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  expires_on  DATE,                      -- valid through this day (India time)
  redeemed_by BIGINT REFERENCES crm_users(id),
  redeemed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE crm_vouchers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- A coupon made by staff for one customer. That customer can see it (until it expires) but cannot make or enter codes.
ALTER TABLE crm_vouchers ADD COLUMN IF NOT EXISTS assigned_to BIGINT REFERENCES crm_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_crm_vouchers_assigned_to ON crm_vouchers(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_vouchers_redeemed_by ON crm_vouchers(redeemed_by);

-- Staff (or a sync from your Google Sheet) add rows here.
-- A customer sees the rows whose phone matches their verified phone.
CREATE TABLE IF NOT EXISTS crm_bookings (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone      TEXT NOT NULL,
  booked_on  DATE NOT NULL,
  room       TEXT NOT NULL,
  players    INTEGER,
  amount     NUMERIC(10, 2),
  status     TEXT NOT NULL DEFAULT 'Completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_bookings_phone ON crm_bookings(phone);

/* ---------------- staff dashboard ---------------- */

-- Staff have their own accounts, completely separate from customers.
CREATE TABLE IF NOT EXISTS crm_staff (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  active               BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_by           BIGINT REFERENCES crm_staff(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_staff_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id   BIGINT NOT NULL REFERENCES crm_staff(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_staff_sessions_staff ON crm_staff_sessions(staff_id);

-- A record of who did what in the dashboard.
CREATE TABLE IF NOT EXISTS crm_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id   BIGINT REFERENCES crm_staff(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_audit_created ON crm_audit(created_at DESC);

-- Photos and videos belong to a TEAM (play_date + slot + theme), not to one person.
-- Anyone in that team sees them. The files themselves live in private file storage.
-- The earlier version tied each file to one person. If that table exists and is empty, replace it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'crm_media' AND column_name = 'user_id') THEN
    IF NOT EXISTS (SELECT 1 FROM crm_media) THEN
      DROP TABLE crm_media;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS crm_media (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  play_date    DATE NOT NULL,
  slot         TEXT NOT NULL,
  theme        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  object_key   TEXT NOT NULL UNIQUE,
  thumb_key    TEXT,
  content_type TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  uploaded_by  BIGINT REFERENCES crm_staff(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_media_team ON crm_media(play_date, slot, theme, created_at DESC);

-- Coupon created_by is added here because crm_staff must exist first.
ALTER TABLE crm_vouchers ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES crm_staff(id) ON DELETE SET NULL;

-- Referral points. Balance = the sum of delta for a customer. Positive = earned, negative = deducted.
CREATE TABLE IF NOT EXISTS crm_points (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL CHECK (delta <> 0),
  reason     TEXT NOT NULL,
  ref        TEXT,                                    -- optional id from the other website, so one use is never counted twice
  created_by BIGINT REFERENCES crm_staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_points_user ON crm_points(user_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_points_ref ON crm_points(user_id, ref) WHERE ref IS NOT NULL AND delta > 0;

/* ---------------- security ---------------- */
-- Supabase publishes every table in the public schema through its web API.
-- Turning on row level security with no policies means that API (and the public "anon" key)
-- can read and write NOTHING here. Only this server, using the database password, can.
ALTER TABLE crm_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_otps                ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_phone_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_waivers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_vouchers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_bookings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_staff               ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_staff_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_audit               ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_media               ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_points              ENABLE ROW LEVEL SECURITY;
