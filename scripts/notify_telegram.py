#!/usr/bin/env python3
"""
Telegram notification for the upstream sync.

Reads /tmp/sync-report.json (written by sync_upstream.py) and posts a summary
to the configured channel: what was added, what was updated, what was removed —
each line carrying the upstream repo so it is obvious where a module came from.

Only sends when something actually changed.

Env:
  TG_BOT_TOKEN   bot token
  TG_CHAT_ID     target chat/channel id

Usage:
  python3 scripts/notify_telegram.py            # sends if the report has changes
  python3 scripts/notify_telegram.py --dry-run  # prints the message only
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPORT = '/tmp/sync-report.json'
SITE = 'https://son.zhiaon.top'
MAX_LINES = 12  # keep the message readable; the rest is summarised


def build_message(report, total_modules=None):
    new = report.get('new', [])
    updated = report.get('updated', [])
    removed = report.get('removed', [])
    errors = report.get('errors', [])

    if not (new or updated or removed):
        return None

    lines = []

    if new:
        lines.append(f'🆕 <b>新增模块 {len(new)} 个</b>')
        for m in new[:MAX_LINES]:
            ver = str(m.get('version') or '').lstrip('vV')
            tail = f' · v{esc(ver)}' if ver else ''
            lines.append(f'· <b>{esc(m["name"])}</b>{tail}\n  <code>{esc(m["repo"])}</code>')
        if len(new) > MAX_LINES:
            lines.append(f'  …另有 {len(new) - MAX_LINES} 个')
        lines.append('')

    if updated:
        lines.append(f'🔄 <b>模块更新 {len(updated)} 个</b>')
        for m in updated[:MAX_LINES]:
            # 版本号只有部分上游会维护；不变时说明是内容变更，比谎报一个
            # 假的版本跃迁诚实，也不至于让人以为没更新。
            frm = str(m.get('from_version') or '').lstrip('vV')
            to = str(m.get('version') or '').lstrip('vV')
            if frm and to and frm != to:
                change = f'v{esc(frm)} → v{esc(to)}'
            elif to:
                change = f'v{esc(to)} · 内容变更'
            else:
                change = '内容变更'
            detail = format_diff(m.get('diff'))
            lines.append(
                f'· <b>{esc(m["name"])}</b> {change}\n'
                f'  <code>{esc(m["repo"])}</code>'
                + (f'\n  {detail}' if detail else '')
            )
        if len(updated) > MAX_LINES:
            lines.append(f'  …另有 {len(updated) - MAX_LINES} 个')
        lines.append('')

    if removed:
        lines.append(f'🗑 <b>已下架 {len(removed)} 个</b>')
        # 下架要能看出是「上游删了」还是「我们主动拉黑」：前者用户该去找替代，
        # 后者是我们自己的运营决定，混在一起会让人以为上游出了问题。
        REASON = {'upstream-removed': '上游已删除', 'denylisted': '站点黑名单'}
        for m in removed[:6]:
            why = REASON.get(m.get('reason'))
            repo = f' · <code>{esc(m["repo"])}</code>' if m.get('repo') else ''
            suffix = f' · {why}' if why else ''
            lines.append(f'· {esc(m.get("name") or m["slug"])}{suffix}{repo}')
        if len(removed) > 6:
            lines.append(f'  …另有 {len(removed) - 6} 个')
        lines.append('')

    fixed = report.get('fixed') or {}
    if fixed:
        label = {'append': '%APPEND%', 'case': '[MITM] 大小写',
                 'body': '[Body Rewrite]', 'script': '脚本语法'}
        parts = [f'{label.get(k, k)} {v}' for k, v in sorted(fixed.items(), key=lambda kv: -kv[1])]
        lines.append(f'🔧 格式修复 {len(parts)} 类：{" · ".join(parts)}')

    if total_modules:
        lines.append(f'📦 平台现有 <b>{total_modules}</b> 个模块')
    lines.append(f'🔗 <a href="{SITE}/discover">查看站点</a>')

    if errors:
        lines.append(f'⚠️ 同步异常 {len(errors)} 处（详见 Actions 日志）')

    return '\n'.join(lines).strip()


def format_diff(diff):
    """'+3 [Script], -1 [Rule]' — compact, only the sections that moved."""
    if not diff:
        return ''
    parts = []
    sections = diff.get('sections') or {}
    for name, d in sorted(sections.items(), key=lambda kv: -(kv[1]['added'] + kv[1]['removed']))[:3]:
        bits = []
        if d.get('added'):
            bits.append(f'+{d["added"]}')
        if d.get('removed'):
            bits.append(f'−{d["removed"]}')
        parts.append(f'{" ".join(bits)} [{name}]')
    if not parts:
        return ''
    changed = (diff.get('added') or 0) + (diff.get('removed') or 0)
    total = f'共 {changed} 行' if changed >= 3 else ''
    return ' · '.join(parts) + (f'（{total}）' if total else '')


def esc(s):
    return (
        str(s)
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
    )


def send(token, chat_id, text):
    data = urllib.parse.urlencode({
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': 'true',
    }).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage',
        data=data,
        headers={'content-type': 'application/x-www-form-urlencoded'},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
        return body.get('ok', False), body.get('description', '')
    except urllib.error.HTTPError as e:
        return False, e.read().decode('utf-8', 'replace')[:200]
    except Exception as e:
        return False, str(e)[:200]


def main():
    dry = '--dry-run' in sys.argv
    if not os.path.exists(REPORT):
        print('没有 sync-report.json，跳过')
        return 0

    report = json.load(open(REPORT))

    total = None
    dist_modules = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                'dist', 'data', 'modules.json')
    if os.path.exists(dist_modules):
        try:
            total = len(json.load(open(dist_modules)))
        except Exception:
            pass

    text = build_message(report, total)
    if not text:
        print('没有变化，不发送')
        return 0

    if dry:
        print(text)
        return 0

    token = os.environ.get('TG_BOT_TOKEN', '').strip()
    chat = os.environ.get('TG_CHAT_ID', '').strip()
    if not token or not chat:
        print('缺少 TG_BOT_TOKEN / TG_CHAT_ID，跳过发送')
        return 0

    ok, err = send(token, chat, text)
    print('已发送' if ok else f'发送失败: {err}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
