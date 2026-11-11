import { useEffect } from 'react';
import { siteConfig } from '@/config/site';

export interface PageMeta {
  title?: string;
  description?: string;
  path?: string;
  noIndex?: boolean;
}

function upsertMeta(selector: string, attrs: Record<string, string>): void {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    document.head.appendChild(el);
  }
  Object.entries(attrs).forEach(([k, v]) => el!.setAttribute(k, v));
}

/** Keeps <title> and social meta in sync per route. */
export function usePageMeta({ title, description, path, noIndex }: PageMeta): void {
  useEffect(() => {
    const fullTitle = title
      ? siteConfig.seo.titleTemplate.replace('%s', title)
      : siteConfig.name;

    document.title = fullTitle;

    if (description) {
      upsertMeta('meta[name="description"]', { name: 'description', content: description });
      upsertMeta('meta[property="og:description"]', {
        property: 'og:description',
        content: description,
      });
    }
    upsertMeta('meta[property="og:title"]', { property: 'og:title', content: fullTitle });
    upsertMeta('meta[property="og:type"]', { property: 'og:type', content: 'website' });
    upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card', content: 'summary' });

    if (path) {
      const url = `${siteConfig.name}${path}`;
      upsertMeta('meta[property="og:url"]', { property: 'og:url', content: url });
    }
    if (noIndex) {
      upsertMeta('meta[name="robots"]', { name: 'robots', content: 'noindex,nofollow' });
    }
  }, [title, description, path, noIndex]);
}
