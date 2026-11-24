import { useState } from 'react';
import type { ModuleWithMeta } from '@/types';
const shownAvatars = new Set<string>();
function rememberAvatar(src: string) {
  shownAvatars.delete(src);
  shownAvatars.add(src);
  if (shownAvatars.size > 128) shownAvatars.delete(shownAvatars.values().next().value!);
}

/**
 * GitHub avatar with a graceful fallback to the identicon-style default when
 * the avatar URL fails. Cached by the browser; nothing is re-fetched per open.
 */
export function GithubAvatar({
  owner,
  size = 36,
  priority = false,
  className,
}: {
  owner: string;
  size?: number;
  priority?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = `https://github.com/${owner}.png?size=${size * 2}`;

  if (failed) {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-inset text-muted',
          'border border-line',
          className,
        )}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 16 16" width={size * 0.6} height={size * 0.6} fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      loading={priority || shownAvatars.has(src) ? 'eager' : 'lazy'}
      onLoad={() => rememberAvatar(src)}
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-full border border-line bg-inset object-cover', className)}
      style={{ width: size, height: size }}
    />
  );
}

// cn helper needs an import at the top — handled by the bundler's hoisting? No:
import { cn } from '@/lib/cn';

interface RepoSource {
  owner: string;
  repo: string;
  count: number;
  modules: ModuleWithMeta[];
}

/** Group the catalogue by repositoryUrl — one row per upstream repo. */
export function groupBySource(modules: ModuleWithMeta[]): RepoSource[] {
  const map = new Map<string, RepoSource>();
  for (const m of modules) {
    const url = m.repositoryUrl;
    if (!url || !url.includes('github.com')) continue;
    const clean = url.replace(/\/$/, '').replace(/\.git$/, '');
    const parts = clean.replace(/^https?:\/\/github\.com\//i, '').split('/');
    if (parts.length < 2) continue;
    const [owner, repo] = parts;
    const key = `${owner}/${repo}`.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.modules.push(m);
    } else {
      map.set(key, { owner, repo, count: 1, modules: [m] });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
