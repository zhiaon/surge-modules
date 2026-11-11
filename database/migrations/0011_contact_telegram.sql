-- 0011 — public contact entry
--
-- The footer's "项目" block used to hard-code a GitHub link that never pointed
-- anywhere real. It is replaced by a single configurable contact row, whose
-- URL lives in site_settings (scope=public) so it can be edited in the admin
-- panel and read by /api/v1/settings without a redeploy.
--
-- Empty = not configured: the frontend renders plain text instead of a dead
-- link, exactly like every other optional field.

INSERT OR IGNORE INTO site_settings (key, value, value_type, scope) VALUES
  ('contact.telegram', '', 'string', 'public');
