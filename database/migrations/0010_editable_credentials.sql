-- ===========================================================================
-- 0010 — credentials editable from the admin panel
--
-- Three values used to live only in Worker Secrets, which means changing them
-- required a `wrangler secret put` from a terminal. The panel now accepts them
-- too, so they can be updated from a phone.
--
-- They are NOT stored in plaintext: `value` holds
--   enc:v1:<base64(iv + AES-GCM ciphertext)>
-- encrypted with WEBHOOK_SECRET_KEY (the same Worker Secret that already
-- protects per-repository webhook secrets). `value_type` records that so the
-- reader can refuse to treat a plaintext row as a credential.
--
-- Precedence when resolving a credential:
--   1. the encrypted D1 row written from the panel (newest, explicit intent)
--   2. the Worker Secret (deployment-time default)
-- This way an existing deployment keeps working untouched, and a value saved in
-- the UI takes over immediately without a redeploy.
-- ===========================================================================

INSERT INTO site_settings (key, value, value_type, scope) VALUES
  ('secret.github_read_token',  '', 'encrypted', 'admin'),
  ('secret.telegram_bot_token', '', 'encrypted', 'admin'),
  ('secret.webhook_secret_key', '', 'encrypted', 'admin')
ON CONFLICT(key) DO NOTHING;
