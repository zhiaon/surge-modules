#!/usr/bin/env python3
"""
One-shot D1 dump for the Pages migration.

Designed to run in a *single* management-API call per table so it survives a D1
budget that is nearly exhausted. Everything lands in /tmp/static_dump/ as JSON;
scripts/build_static.py turns that into the dist/data files.

Run: python3 scripts/dump_for_static.py
"""
import json
import os
import subprocess
import sys

WORKDIR = '/var/minis/workspace/surge-modules'
ACCOUNT = '7a89ed189beac8f21cb18dfed4e1668c'
DB = 'surge-modules'
OUT = '/tmp/static_dump'


def d1(sql):
    out = subprocess.run(
        ['node', 'node_modules/wrangler/wrangler-dist/cli.js', 'd1', 'execute',
         DB, '--remote', '--command', sql, '--json'],
        cwd=WORKDIR, capture_output=True, text=True,
        env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': ACCOUNT},
    )
    lines = out.stdout.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.strip() == '['), None)
    if start is None:
        raise RuntimeError((out.stdout or out.stderr)[:400])
    return json.loads('\n'.join(lines[start:]))[0]['results']


def save(name, rows):
    os.makedirs(OUT, exist_ok=True)
    json.dump(rows, open(f'{OUT}/{name}.json', 'w'), ensure_ascii=False)
    print(f'  {name}: {len(rows)} 行', flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)

    print('dump modules…', flush=True)
    save('modules', d1("""
        SELECT m.id, m.slug, m.name, m.description, m.author, m.version,
               m.updated_at, m.created_at, m.is_featured, m.repository_url,
               m.category_id, p.public_slug
          FROM modules m
          LEFT JOIN module_proxy_mappings p
                 ON p.module_id = m.id AND p.deleted_at IS NULL
         WHERE m.deleted_at IS NULL AND m.is_published = 1;
    """))

    print('dump categories…', flush=True)
    save('categories', d1("""
        SELECT id, name, slug, description, icon, sort_order
          FROM categories WHERE deleted_at IS NULL
         ORDER BY sort_order ASC, name ASC;
    """))

    print('dump settings…', flush=True)
    save('settings', d1('SELECT key, value FROM site_settings;'))

    print('dump tags…', flush=True)
    save('tags', d1("""
        SELECT mt.module_id, mt.tag FROM module_tags mt
          JOIN modules m ON m.id = mt.module_id
         WHERE m.deleted_at IS NULL AND m.is_published = 1;
    """))

    print('dump versions…', flush=True)
    save('versions', d1("""
        SELECT v.module_id, v.version, v.changelog, v.released_at
          FROM module_versions v JOIN modules m ON m.id = v.module_id
         WHERE m.deleted_at IS NULL AND m.is_published = 1
         ORDER BY v.released_at DESC;
    """))

    # sgmodule source paths — needed to copy the raw files into dist/m/
    print('dump source paths…', flush=True)
    save('sources', d1("""
        SELECT p.public_slug, p.file_path, p.third_party_repository_id,
               s.owner AS s_owner, s.repo AS s_repo, s.branch AS s_branch,
               t.owner AS t_owner, t.repository AS t_repo, t.default_branch AS t_branch
          FROM module_proxy_mappings p
          LEFT JOIN sources s ON s.id = p.source_id
          LEFT JOIN third_party_repositories t ON t.id = p.third_party_repository_id
         WHERE p.deleted_at IS NULL AND p.is_enabled = 1;
    """))

    print(f'完成 → {OUT}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
