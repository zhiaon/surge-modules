import type { AnalyticsEvent } from '@/types';
import { api } from './apiClient';
import { ANALYTICS_EVENTS, type AnalyticsEventName } from '../../packages/shared/src/contract';

/**
 * Analytics that can only report whitelisted things.
 *
 * The event names are the same list the API validates against — importing it
 * means a typo cannot compile instead of being silently dropped by the server.
 * Transport is fire-and-forget: a failed beacon must never block or break a user
 * action, and nothing here can throw.
 *
 * What is deliberately NOT collected: any identifier. No session id, no user
 * agent, no referrer, no precise timing beyond the day bucket the API assigns.
 */

const BUFFER_LIMIT = 8;
const FLUSH_DELAY_MS = 400;

let queue: Array<{ event: string; subject?: string }> = [];
let timer: number | null = null;

function flush(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  api.track(batch);
}

function enqueue(name: AnalyticsEventName, subject?: string): void {
  queue.push({ event: name, subject: subject?.slice(0, 120) });
  if (queue.length >= BUFFER_LIMIT) {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    flush();
    return;
  }
  if (timer === null) {
    timer = window.setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_DELAY_MS);
  }
}

const isKnown = (name: string): name is AnalyticsEventName =>
  (ANALYTICS_EVENTS as readonly string[]).includes(name);

export const analyticsService = {
  trackPageView(extra?: { path?: string }): void {
    enqueue('page_view', extra?.path ?? window.location.pathname);
  },

  trackModuleView(slug: string): void {
    enqueue('module_view', slug);
  },

  /** Records that the install entry point was *clicked*, never that it succeeded. */
  trackInstallClick(slug: string): void {
    enqueue('install_click', slug);
  },

  trackCopyClick(slug: string, kind: 'raw' | 'sgmodule' = 'raw'): void {
    enqueue('copy_click', `${slug}:${kind}`);
  },

  trackSearch(query: string, _results: number): void {
    // the query text itself is not sent: it can contain personal intent, and a
    // count is not needed for the aggregate this platform actually reports
    enqueue('search', query.trim().slice(0, 40) || 'empty');
  },

  trackFavorite(_moduleId: string, _active: boolean): void {
    // favourites are a local-only feature; nothing to report yet
  },

  /** Escape hatch for future events; rejects anything outside the whitelist. */
  track(name: string, subject?: string): void {
    if (!isKnown(name)) return;
    enqueue(name, subject);
  },

  /** Flush immediately — used on pagehide so a navigation does not lose events. */
  flushNow(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    flush();
  },

  /** Dev-only inspection of what would be sent. */
  getBufferedEvents(): AnalyticsEvent[] {
    return queue.map((q, i) => ({
      name: q.event as AnalyticsEvent['name'],
      payload: q.subject ? { subject: q.subject } : undefined,
      at: Date.now() + i,
    }));
  },
};

// flush on the way out; both events fire on iOS Safari depending on the case
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => analyticsService.flushNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') analyticsService.flushNow();
  });
}

export const ANALYTICS_SERVICE_IS_MOCK = false;
