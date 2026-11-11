-- ===========================================================================
-- 0016 — UA blocking switch + rule management
--
-- `ua_blocking` is the master switch for the client-policy gate in the proxy
-- worker. It is separate from `require_credential` on purpose:
--
--   ua_blocking = 0   everything public (original behaviour)
--   ua_blocking = 1   browsers/scripts get 403, Surge clients pass through;
--                     whether a credential is also required is decided by
--                     require_credential
--
-- Keeping them independent means an operator can block source-scraping in a
-- browser without breaking every existing install link, and later add the
-- credential requirement once users have keys.
--
-- The rules themselves already live in `client_access_policies` (0015), seeded
-- with the Surge whitelist and the browser/script blacklists.
-- ===========================================================================

ALTER TABLE user_settings ADD COLUMN ua_blocking INTEGER NOT NULL DEFAULT 0;
