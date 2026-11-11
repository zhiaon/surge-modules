-- 2026-11-10 D1 行读取限额事故的根治：
-- findExistingModule 的两条查询都是全表扫描（515 行 × 每文件 2 次 × 727 文件 × 多轮
-- 把 500 万行/日的免费额度打爆了）。
-- 1) source_path 单列索引：byPath 查询 WHERE source_path = ? 无法用 (source_id, source_path)
--    复合索引（缺左前缀）
-- 2) upstream_url 索引：byUrl 回退查询 WHERE upstream_url LIKE '/%xxx' 是全表扫描；
--    B-tree 前缀匹配帮不上 '%xxx'，但 repository_url = ? 分支可用索引，
--    且 LIKE '/%name' 在小结果集上仍需扫描——先用索引缩小到同一仓库的行再过滤
CREATE INDEX IF NOT EXISTS ix_modules_source_path ON modules(source_path) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_modules_upstream ON modules(upstream_url) WHERE deleted_at IS NULL;
