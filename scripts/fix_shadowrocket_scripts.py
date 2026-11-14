#!/usr/bin/env python3
"""
Convert Shadowrocket/Loon [Script] lines to Surge syntax.

Script-Hub drops these modules because it rewrites whole files; here we only
touch the [Script] section, one line at a time, so nothing else can move.

  http-response <regex> k=v,k=v      → <name> = type=http-response, pattern=<regex>, k=v
  cron "<expr>" script-path=...,     → <name> = type=cron, cronexp="<expr>", script-path=...
  generic <name> script-path=...     → <name> = type=generic, script-path=...

Names are taken from an existing `tag=`, else derived from the script filename,
and de-duplicated inside the module.
"""
import os
import re
import sys

TYPES = ('http-request', 'http-response', 'cron', 'generic', 'dns', 'rule')
FLAG_MAP = {'requires-body': 'requires-body', 'max-size': 'max-size', 'timeout': 'timeout'}


def split_kv(rest):
    """Split `a=1,b=2` into ordered pairs, respecting quotes."""
    out, buf, quote = [], '', None
    for ch in rest:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
        elif ch in '"\'':
            quote = ch
            buf += ch
        elif ch == ',':
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return [p for p in out if p]


def norm_value(key, value):
    """Surge wants true/false; Shadowrocket writes 1/0."""
    if key == 'requires-body':
        return 'true' if value in ('1', 'true', 'yes') else 'false'
    return value


def derive_name(script_path, fallback_index):
    base = script_path.rsplit('/', 1)[-1]
    base = re.sub(r'\.(js|cjs|ts)$', '', base)
    base = re.sub(r'\.(min|prod|dist)$', '', base)
    base = base.replace('-', '_')
    return base or f'script_{fallback_index}'


def convert_line(line, used_names, counter):
    """Return the converted line, or None when it is not SR syntax."""
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        return None
    if re.match(r'^[^=\s][^=]*=\s*type=', stripped):
        return None  # already Surge syntax

    m = re.match(r'^(' + '|'.join(TYPES) + r')\s+(.*)$', stripped, re.I)
    if not m:
        return None
    kind = m.group(1).lower()
    rest = m.group(2).strip()

    # Quantumult X: `regex url script-response-body <url>,tag=...`
    qx = re.match(r'^(\S+)\s+url\s+script-(response-body|request-body|echo-response)\s+(\S+?)(?:,tag=(.+))?$', rest)
    if qx:
        pattern, mode, sp_url, tag = qx.group(1), qx.group(2), qx.group(3), qx.group(4)
        kind = 'http-response' if 'response' in mode else 'http-request'
        name = (tag or '').strip() or derive_name(sp_url, counter['i'])
        base, n = name, 2
        while name in used_names:
            name = f'{base}-{n}'
            n += 1
        used_names.add(name)
        return (f'{name} = type={kind}, pattern={pattern}, '
                f'requires-body=1, script-path={sp_url}')

    cronexp = None
    pattern = None

    if kind == 'cron':
        # cron "<expr>" script-path=...   or   cron "<expr>" <url>, tag=...
        sp = rest.find('script-path=')
        if sp >= 0:
            head = rest[:sp].strip().rstrip(',')
            cronexp = head.strip().strip('"').strip("'").strip()
            rest = rest[sp:]
        else:
            # No script-path key: the tail after the quoted expression is the URL.
            m2 = re.match(r'^("[^"]+"|\S+)\s+(\S+?)(?:,\s*tag=(.+))?$', rest, re.S)
            if not m2:
                return None
            cronexp = m2.group(1).strip().strip('"').strip("'").strip()
            sp_url = m2.group(2)
            tag_early = (m2.group(3) or '').strip() or None
            name = tag_early or derive_name(sp_url, counter['i'])
            base, n = name, 2
            while name in used_names:
                name = f'{base}-{n}'
                n += 1
            used_names.add(name)
            return (f'{name} = type=cron, cronexp="{cronexp}", wake-system=1, '
                    f'script-path={sp_url}')
    elif kind in ('http-request', 'http-response'):
        sp = rest.find('script-path=')
        head = (rest[:sp] if sp >= 0 else rest).strip().rstrip(',')
        # Shadowrocket writes `^regex requires-body=1,script-path=...` — the
        # flags after the regex are space separated, so split on the first
        # `key=` token rather than taking the whole head as the pattern.
        flag = re.search(r'\s+([A-Za-z-]+=)', head)
        if flag:
            pattern = head[:flag.start()].strip()
            rest = head[flag.start():].strip() + (',' + rest[sp:] if sp >= 0 else '')
        else:
            pattern = head or None
            rest = rest[sp:] if sp >= 0 else ''
    elif kind == 'generic':
        sp = rest.find('script-path=')
        if sp >= 0:
            head = rest[:sp].strip().rstrip(',')
            if head and '=' not in head and not head.startswith('script-path'):
                counter['name_hint'] = head
            rest = rest[sp:]

    pairs = split_kv(rest)
    kv, script_path, tag = {}, None, None
    for p in pairs:
        if '=' not in p:
            continue
        k, v = p.split('=', 1)
        k, v = k.strip(), v.strip()
        if k == 'script-path':
            script_path = v
        elif k == 'tag':
            tag = v.strip('"\'')
        else:
            kv[k] = norm_value(k, v)

    if not script_path:
        return None

    name = tag or counter.get('name_hint') or derive_name(script_path, counter['i'])
    counter['name_hint'] = None
    base, n = name, 2
    while name in used_names:
        name = f'{base}-{n}'
        n += 1
    used_names.add(name)

    parts = [f'type={kind}']
    if cronexp:
        parts.append(f'cronexp="{cronexp}"')
    if pattern:
        parts.append(f'pattern={pattern}')
    if kind == 'cron' and 'wake-system' not in kv:
        kv['wake-system'] = '1'
    for k, v in kv.items():
        parts.append(f'{k}={v}')
    parts.append(f'script-path={script_path}')

    return f'{name} = ' + ', '.join(parts)


def convert_module(text):
    lines = text.split('\n')
    out, in_script, changed = [], False, False
    used = set()
    counter = {'i': 0, 'name_hint': None}

    for line in lines:
        st = line.strip()
        if re.match(r'^\[Script\]$', st, re.I):
            in_script = True
            out.append(line)
            continue
        if re.match(r'^\[[^\]]+\]$', st):
            in_script = False
            out.append(line)
            continue
        if in_script:
            counter['i'] += 1
            new = convert_line(line, used, counter)
            if new:
                out.append(new)
                changed = True
                continue
            m = re.match(r'^([^=\s][^=]*)=\s*type=', st)
            if m:
                used.add(m.group(1).strip())
        out.append(line)

    return '\n'.join(out), changed


def main():
    apply = '--apply' in sys.argv
    report = None
    for i, a in enumerate(sys.argv):
        if a == '--report' and i + 1 < len(sys.argv):
            report = sys.argv[i + 1]
    touched = []
    files = []
    skip = False
    for a in sys.argv[1:]:
        if skip:
            skip = False
            continue
        if a == '--report':
            skip = True
            continue
        if not a.startswith('--'):
            files.append(a)
    # Allow `fix_shadowrocket_scripts.py --apply raw` so CI does not have to
    # expand 1400 paths on the command line.
    expanded = []
    for f in files:
        if os.path.isdir(f):
            expanded += [os.path.join(f, x) for x in sorted(os.listdir(f))
                         if x.endswith('.sgmodule')]
        else:
            expanded.append(f)
    files = expanded
    total = 0
    for path in files:
        text = open(path, encoding='utf-8', errors='replace').read()
        new, changed = convert_module(text)
        if changed:
            total += 1
            touched.append(os.path.basename(path))
            if apply:
                open(path, 'w', encoding='utf-8').write(new)
            else:
                print('would convert:', os.path.basename(path))
    if report:
        open(report, 'w', encoding='utf-8').write(
            '\n'.join(f'{f}: script' for f in touched))
    print(f'{"已转换" if apply else "将转换"} {total} 个')


if __name__ == '__main__':
    main()
