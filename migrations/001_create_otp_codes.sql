-- ============================================================
-- OTP Codes table — replaces the in-memory Map that was wiped
-- on every server restart.
--
-- Run this SQL in the Supabase Dashboard → SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  otp         text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Fast lookups by email (every verify / check hits this).
CREATE UNIQUE INDEX IF NOT EXISTS idx_otp_codes_email
  ON otp_codes (email);

-- Allow the cleanup cron to efficiently find expired rows.
CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at
  ON otp_codes (expires_at);

-- Enable Row Level Security (table is only accessed via the
-- service-role key from the backend, so we allow all for the
-- service role).
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON otp_codes
  FOR ALL
  USING (true)
  WITH CHECK (true);
