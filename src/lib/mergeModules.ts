/**
 * Merge several .sgmodule files into one.
 *
 * Users often want "去广告全家桶" rather than ten separate installs. Since the
 * site is static, the merge happens in the browser: fetch each module's raw
 * text, combine the sections, de-duplicate the lines, and hand back a single
 * .sgmodule the user can import once.
 *
 * Rules that matter:
 *  - [MITM] hostnames are unioned into a single `hostname = %APPEND% …` line,
 *    otherwise only the last module's list would survive.
 *  - Every other section keeps its lines verbatim, de-duplicated by their
 *    left-hand side (rule name / pattern), first occurrence wins.
 *  - `#!` headers are dropped: the merged file gets its own.
 */

export interface MergeSource {
  slug: string;
  name: string;
  text: string;
}

export interface MergeResult {
  text: string;
  count: number;
  sections: string[];
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;

interface Chunk {
  headers: string[];
  body: Map<string, string[]>; // section name → raw lines
}

function parse(text: string): Chunk {
  const body = new Map<string, string[]>();
  const headers: string[] = [];
  let current: string | null = null;

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = SECTION_RE.exec(line);
    if (m) {
      current = m[1].trim();
      if (!body.has(current)) body.set(current, []);
      continue;
    }
    if (line.startsWith('#!')) {
      headers.push(line);
      continue;
    }
    if (current === null) continue;
    body.get(current)!.push(line);
  }
  return { headers, body };
}

/** Identity of a line for de-duplication purposes. */
function keyOf(section: string, line: string): string {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith(';')) return `#${s}`;
  if (section.toLowerCase() === 'mitm') {
    const eq = s.indexOf('=');
    return eq >= 0 ? `mitm:${s.slice(0, eq).trim()}` : `mitm:${s}`;
  }
  const eq = s.indexOf('=');
  return eq >= 0 ? s.slice(0, eq).trim() : s;
}

function splitHostnames(lines: string[]): string[] {
  const hosts: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim().toLowerCase();
    if (key !== 'hostname') continue;
    const value = s.slice(eq + 1).replace(/%APPEND%/gi, '');
    for (const h of value.split(',')) {
      const host = h.trim();
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

export function mergeModules(
  sources: MergeSource[],
  options: { name?: string; author?: string } = {},
): MergeResult {
  const merged = new Map<string, string[]>();
  const mitmHosts = new Set<string>();
  const seen = new Map<string, Set<string>>();

  for (const src of sources) {
    if (/^\s*<(!doctype|html)/i.test(src.text)) {
      // Pages' SPA fallback hands back index.html for a missing file; merging
      // that would silently produce a broken module.
      throw new Error(`${src.name} 的模块文件缺失`);
    }
    const chunk = parse(src.text);
    for (const [section, lines] of chunk.body) {
      if (section.toLowerCase() === 'mitm') {
        for (const h of splitHostnames(lines)) mitmHosts.add(h);
        continue;
      }
      if (!merged.has(section)) merged.set(section, []);
      if (!seen.has(section)) seen.set(section, new Set());
      const target = merged.get(section)!;
      const keys = seen.get(section)!;

      for (const line of lines) {
        const k = keyOf(section, line);
        if (!k.trim()) continue;
        if (k.startsWith('#')) continue; // drop comments from the body
        if (keys.has(k)) continue;
        keys.add(k);
        target.push(line);
      }
    }
  }

  // Section order follows Surge's own convention so the file reads naturally.
  const ORDER = [
    'General', 'Panel', 'Script', 'URL Rewrite', 'Header Rewrite',
    'Body Rewrite', 'Map Local', 'Host', 'Rule', 'MITM',
  ];
  const names = [...merged.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const title = options.name?.trim() || 'Surge 模块合集';
  const lines: string[] = [
    `#!name=${title}`,
    `#!desc=由 Surge Modules 生成的合集，包含 ${sources.length} 个模块：${sources
      .map((s) => s.name)
      .join('、')
      .slice(0, 200)}`,
    `#!author=${options.author?.trim() || 'Surge Modules 合集'}`,
    '',
  ];

  for (const section of names) {
    const body = merged.get(section)!;
    if (!body.length) continue;
    lines.push(`[${section}]`);
    lines.push(...body);
    lines.push('');
  }

  if (mitmHosts.size) {
    lines.push('[MITM]');
    lines.push(`hostname = %APPEND% ${[...mitmHosts].sort().join(', ')}`);
    lines.push('');
  }

  return {
    text: lines.join('\n'),
    count: sources.length,
    sections: [...names, ...(mitmHosts.size ? ['MITM'] : [])],
  };
}
