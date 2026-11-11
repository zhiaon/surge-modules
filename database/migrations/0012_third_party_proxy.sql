-- 0012 — proxy mappings for third-party modules
--
-- approveNew created `modules` rows but never `module_proxy_mappings`, so every
-- third-party module published through the review centre returned 404 from the
-- proxy worker: install links and copy-raw-URL were both dead.
--
-- The proxy resolves a slug through `JOIN sources`, which third-party content
-- cannot satisfy (it has no `sources` row). This migration widens the mapping
-- table with the third-party identity; the proxy query switches to LEFT JOIN
-- and picks owner/repo/branch from whichever side is populated.

ALTER TABLE module_proxy_mappings ADD COLUMN third_party_repository_id TEXT
  REFERENCES third_party_repositories(id) ON DELETE SET NULL;
