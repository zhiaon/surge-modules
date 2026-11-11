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
            lines.append(f'· <b>{esc(m["name"])}</b>\n  <code>{esc(m["repo"])}</code>')
        if len(new) > MAX_LINES:
            lines.append(f'  …另有 {len(new) - MAX_LINES} 个')
        lines.append('')

    if updated:
        lines.append(f'🔄 <b>模块更新 {len(updated)} 个</b>')
        for m in updated[:MAX_LINES]:
            lines.append(
                f'· <b>{esc(m["name"])}</b> → v{esc(str(m["version"]))}\n'
                f'  <code>{esc(m["repo"])}</code>'
            )
        if len(updated) > MAX_LINES:
            lines.append(f'  …另有 {len(updated) - MAX_LINES} 个')
        lines.append('')

    if removed:
        lines.append(f'🗑 <b>已下架 {len(removed)} 个</b>')
        for m in removed[:6]:
            lines.append(f'· {esc(m.get("name") or m["slug"])}')
        if len(removed) > 6:
            lines.append(f'  …另有 {len(removed) - 6} 个')
        lines.append('')

    if total_modules:
        lines.append(f'📦 平台现有 <b>{total_modules}</b> 个模块')
    lines.append(f'🔗 <a href="{SITE}/discover">查看站点</a>')

    if errors:
        lines.append(f'⚠️ 同步异常 {len(errors)} 处（详见 Actions 日志）')

    return '\n'.join(lines).strip()


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
