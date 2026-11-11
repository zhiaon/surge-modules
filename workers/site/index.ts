import {
  guard,
  jsonError,
  jsonOk,
  methodNotAllowed,
  requestId,
} from '../../packages/shared/src/http';
import { clamp, parseModuleListQuery, validSlug } from '../../packages/shared/src/query';
import { ANALYTICS_LIMITS } from '../../packages/shared/src/contract';
import {
  getModuleBySlug,
  listAnnouncements,
  listCategories,
  listModules,
  listVersions,
  loadSettings,
  toPublicSettings,
} from './db';
import { checkRateLimit, insertEvents, parseEvents } from './analytics';
import { handleAdmin, decideFirstPartyReview } from './admin';
import { handleWebhook } from './webhook';
import { runCronSync } from './cron';
import { syncSource } from './sync';
import { handleRepoWebhook, runScheduler } from './admin-third-party';
import { handleTelegramWebhook, type TelegramUpdate } from './telegram';
import { decideTask } from './review';
import { resolveAll } from './credentials';
import { handleUserApi } from './user-api';

export interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  ENVIRONMENT?: string;
  /** secret: salt for the analytics rate-limit bucket, never returned */
  RATE_LIMIT_SALT?: string;
  /** secret: shared key for protected maintenance endpoints */
  ADMIN_API_KEY?: string;
  /** secret: GitHub webhook signing secret */
  GITHUB_WEBHOOK_SECRET?: string;
  /** secret: read token for the sync engine */
  GITHUB_READ_TOKEN?: string;
  /** plain var: minimum hours between cron syncs per source */
  SYNC_INTERVAL_HOURS?: string;
  /* ---- 第七阶段：第三方仓库 + Telegram ---- */
  /** secret: bot token for review notifications. Never returned by any route. */
  TELEGRAM_BOT_TOKEN?: string;
  /** secret: numeric Telegram user id allowed to approve reviews */
  TELEGRAM_ADMIN_ID?: string;
  /** secret: 32-byte key material used to encrypt per-repo webhook secrets */
  WEBHOOK_SECRET_KEY?: string;
  /**
   * secret: the value Telegram echoes back in X-Telegram-Bot-Api-Secret-Token.
   * Separate from WEBHOOK_SECRET_KEY because Telegram only allows
   * A-Za-z0-9_- in it, while that key is base64 and may contain +/.
   */
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const API_PREFIX = '/api/v1';

/** Size-capped JSON reader for webhook bodies. Returns null when unusable. */
async function readJsonSafe(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > maxBytes) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Public site API.
 *
 * Everything is mounted under /api/v1. Routes are matched exactly (no prefix
 * matching on user input) so an unexpected path can only ever reach the 404
 * branch, never a handler with partially-parsed segments.
 *
 * CORS: the site is same-origin, so no CORS headers are emitted at all. A
 * wildcard would only widen the attack surface.
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const id = requestId();

    if (!url.pathname.startsWith(API_PREFIX)) {
      // Static assets win for every non-API path (SPA fallback is configured
      // in wrangler.toml via not_found_handling).
      return env.ASSETS.fetch(request);
    }

    return guard(id, async () => {
      const path = url.pathname.slice(API_PREFIX.length) || '/';

      // ---- health: no DB touch, no version leak beyond a coarse label
      if (path === '/health') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return jsonOk({
          status: 'ok',
          env: env.ENVIRONMENT === 'production' ? 'production' : 'non-production',
          db: Boolean(env.DB),
        });
      }

      if (!env.DB) {
        return jsonError('internal_error', '数据库未配置');
      }
      const db = env.DB;

      /**
       * Credentials can come from the admin panel (encrypted in D1) or from a
       * Worker Secret. Resolving them once per request keeps every downstream
       * handler consistent and means the panel takes effect without a redeploy.
       * Resolved lazily: the public read endpoints never need them.
       */
      let credentialCache: Awaited<ReturnType<typeof resolveAll>> | null = null;
      const creds = async () =>
        (credentialCache ??= await resolveAll({
          DB: db,
          GITHUB_READ_TOKEN: env.GITHUB_READ_TOKEN,
          TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
          TELEGRAM_ADMIN_ID: env.TELEGRAM_ADMIN_ID,
          WEBHOOK_SECRET_KEY: env.WEBHOOK_SECRET_KEY,
        }));

      // ---- GitHub webhook (HMAC verified inside)
      if (path === '/webhook/github') {
        return handleWebhook(
          request,
          {
            DB: db,
            GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
            GITHUB_READ_TOKEN: (await creds()).githubReadToken,
          },
          {
            sync: async (database, sourceId, trigger) => {
              await syncSource(
                {
                  DB: database,
                  GITHUB_READ_TOKEN: (await creds()).githubReadToken,
                  TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
                  TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
                },
                sourceId,
                trigger,
              );
            },
            // keeps the isolate alive after the 202 is returned; GitHub aborts at
            // 10s and a full scan takes longer than that
            waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
          },
        );
      }

      // ---- public user API: register / login / profile / credential
      if (path === '/user' || path.startsWith('/user/')) {
        return handleUserApi(
          request,
          {
            DB: db,
            RESEND_API_KEY: env.RESEND_API_KEY,
            EMAIL_FROM: env.EMAIL_FROM,
            RATE_LIMIT_SALT: env.RATE_LIMIT_SALT,
            ENVIRONMENT: env.ENVIRONMENT,
            SITE_NAME: env.SITE_NAME,
          },
          path.slice('/user'.length) || '/',
        );
      }

      // ---- third-party GitHub webhook: /webhook/github/:repositoryId
      const repoHook = path.match(/^\/webhook\/github\/([\w-]+)$/);
      if (repoHook) {
        return handleRepoWebhook(
          request,
          {
            DB: db,
            GITHUB_READ_TOKEN: (await creds()).githubReadToken,
            TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
            TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
            WEBHOOK_SECRET_KEY: (await creds()).encryptionKey,
            ENVIRONMENT: env.ENVIRONMENT,
          },
          repoHook[1],
          {
            // keep the isolate alive while the check runs; GitHub gives up at 10s
            waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,
          },
        );
      }

      // ---- Telegram webhook: bot updates + inline-keyboard reviews
      if (path === '/webhook/telegram') {
        if (request.method !== 'POST') return methodNotAllowed(['POST']);

        // Telegram echoes the secret_token set at registration in this header.
        // Without the check, anyone who learns the URL could forge an update and
        // drive reviews. Refuse when the secret is configured but absent/wrong.
        const expected = env.TELEGRAM_WEBHOOK_SECRET;
        if (expected) {
          const got = request.headers.get('x-telegram-bot-api-secret-token');
          if (got !== expected) {
            return jsonError('unauthorized', 'Telegram 校验失败');
          }
        }

        const body = await readJsonSafe(request, 256 * 1024);
        if (!body) return jsonError('bad_request', '请求体不合法');

        const result = await handleTelegramWebhook(
          {
            DB: db,
            TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
            TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
          },
          body as TelegramUpdate,
          {
            decideFirstParty: (reviewId: string) =>
              decideFirstPartyReview(db, reviewId, 'approve', 'telegram:batch'),
            decide: async (input) => {
              const res = await decideTask(
                {
                  DB: db,
                  TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
                  TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
                  GITHUB_READ_TOKEN: (await creds()).githubReadToken,
                },
                input,
              );
              return res.ok
                ? { ok: true, status: res.status }
                : { ok: false, message: res.message };
            },
          },
        );
        return jsonOk(result.body, { status: result.status });
      }

      // ---- admin (all auth handled inside)
      if (path === '/admin' || path.startsWith('/admin/')) {
        return handleAdmin(
          request,
          {
            DB: db,
            ENVIRONMENT: env.ENVIRONMENT,
            // the hook manager needs the token to create registrations; without
            // this the panel reports "未配置 GitHub Token" even when the secret
            // exists, because the value never reached the handler
            GITHUB_READ_TOKEN: (await creds()).githubReadToken,
            // 第七阶段：third-party panels need these to talk to Telegram and to
            // encrypt per-repo secrets. None of them is ever echoed back.
            TELEGRAM_BOT_TOKEN: (await creds()).telegramBotToken,
            TELEGRAM_ADMIN_ID: (await creds()).telegramAdminId,
            WEBHOOK_SECRET_KEY: (await creds()).encryptionKey,
          },
          path.slice('/admin'.length) || '/',
        );
      }

      // ---- modules list
      if (path === '/modules') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        const settings = await loadSettings(db);
        const query = parseModuleListQuery(url.searchParams);
        query.perPage = clamp(query.perPage, 1, settings.perPageMax);
        const { items, meta } = await listModules(db, settings, query);
        return jsonOk(items, { meta });
      }

      // ---- module detail / versions
      const detailMatch = path.match(/^\/modules\/([^/]+)$/);
      if (detailMatch) {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        const slug = validSlug(detailMatch[1]);
        if (!slug) return jsonError('bad_request', 'slug 格式不合法');
        const settings = await loadSettings(db);
        const module = await getModuleBySlug(db, settings, slug);
        if (!module) return jsonError('not_found', '模块不存在或未发布');
        return jsonOk(module);
      }

      const versionsMatch = path.match(/^\/modules\/([^/]+)\/versions$/);
      if (versionsMatch) {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        const slug = validSlug(versionsMatch[1]);
        if (!slug) return jsonError('bad_request', 'slug 格式不合法');
        const limit = clamp(
          Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20,
          1,
          50,
        );
        const versions = await listVersions(db, slug, limit);
        if (versions === null) return jsonError('not_found', '模块不存在或未发布');
        return jsonOk(versions);
      }

      // ---- categories
      if (path === '/categories') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return jsonOk(await listCategories(db));
      }

      // ---- announcements
      if (path === '/announcements') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return jsonOk(await listAnnouncements(db));
      }

      // ---- public settings (scope='public' only, enforced in the query)
      if (path === '/settings') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return jsonOk(toPublicSettings(await loadSettings(db)));
      }

      // ---- anonymous analytics
      if (path === '/analytics') {
        if (request.method !== 'POST') return methodNotAllowed(['POST']);

        const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
        if (declared > ANALYTICS_LIMITS.maxBodyBytes) {
          return jsonError('payload_too_large', '请求体过大');
        }
        const text = await request.text();
        if (text.length > ANALYTICS_LIMITS.maxBodyBytes) {
          return jsonError('payload_too_large', '请求体过大');
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return jsonError('bad_request', '请求体不是合法 JSON');
        }

        const events = parseEvents(parsed);
        if (events === null) {
          return jsonError('bad_request', '事件格式不合法或包含未允许的事件类型');
        }

        const salt = env.RATE_LIMIT_SALT ?? 'dev-salt';
        const clientKey =
          request.headers.get('cf-connecting-ip') ??
          request.headers.get('x-forwarded-for') ??
          'unknown';

        const allowed = await checkRateLimit(
          db,
          salt,
          clientKey,
          ANALYTICS_LIMITS.maxEventsPerWindow,
          ANALYTICS_LIMITS.windowSeconds,
        );
        if (!allowed) {
          return jsonError('too_many_requests', '上报过于频繁');
        }

        const accepted = await insertEvents(db, events);
        return jsonOk({ accepted }, { status: 202 });
      }

      return jsonError('not_found', '接口不存在');
    });
  },

  /**
   * Cron entrypoint. Runs on the schedule in wrangler.toml.
   *
   * No request context is available here, so the work is driven entirely by
   * `sources`: every enabled source whose last sync is older than the interval
   * is re-scanned. Failures are recorded by `syncSource` in sync_jobs, which the
   * admin UI surfaces.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.DB) {
      console.error('[cron] no DB binding');
      return;
    }
    // Scheduled runs have no request context, so credentials are resolved here.
    const credentialSet = await resolveAll({
      DB: env.DB,
      GITHUB_READ_TOKEN: env.GITHUB_READ_TOKEN,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_ADMIN_ID: env.TELEGRAM_ADMIN_ID,
      WEBHOOK_SECRET_KEY: env.WEBHOOK_SECRET_KEY,
    });

    const result = await runCronSync(
      {
        DB: env.DB,
        GITHUB_READ_TOKEN: credentialSet.githubReadToken,
        SYNC_INTERVAL_HOURS: env.SYNC_INTERVAL_HOURS,
      },
      async (db, sourceId, trigger) =>
        syncSource(
          {
            DB: db,
            GITHUB_READ_TOKEN: credentialSet.githubReadToken,
            TELEGRAM_BOT_TOKEN: credentialSet.telegramBotToken,
            TELEGRAM_ADMIN_ID: credentialSet.telegramAdminId,
          },
          sourceId,
          trigger,
        ),
    );
    console.log('[cron]', JSON.stringify(result));

    // ---- 第七阶段：第三方仓库定时检测
    // Runs on the SAME trigger as the first-party sync. It is independent: a
    // failure here must not stop the sync that already completed, hence the
    // separate try/catch.
    try {
      const third = await runScheduler(
        {
          DB: env.DB,
          GITHUB_READ_TOKEN: credentialSet.githubReadToken,
          TELEGRAM_BOT_TOKEN: credentialSet.telegramBotToken,
          TELEGRAM_ADMIN_ID: credentialSet.telegramAdminId,
          WEBHOOK_SECRET_KEY: credentialSet.encryptionKey,
          ENVIRONMENT: env.ENVIRONMENT,
        },
        { trigger: 'cron' },
      );
      console.log('[cron:third-party]', JSON.stringify(third));
    } catch (err) {
      console.error(
        '[cron:third-party] failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  },
} satisfies ExportedHandler<Env>;
