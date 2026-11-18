import { isRouteErrorResponse, useRouteError, Link } from 'react-router-dom';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Container } from '@/components/common/Container';
import { useI18n } from '@/i18n';

/**
 * Route-level error boundary.
 *
 * Without this, a render error dumps React Router's "Unexpected Application
 * Error / Hey developer 👋" screen on users. This keeps the failure readable,
 * offers a reload, and (in development) still shows the message so bugs are
 * diagnosable.
 */
export function ErrorPage() {
  const { t } = useI18n();
  const error = useRouteError();
  const isRoute = isRouteErrorResponse(error);
  const message = isRoute
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : t('未知错误');

  return (
    <Container size="wide" className="py-20">
      <div className="mx-auto max-w-md text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full border border-line bg-raised text-danger">
          <AlertTriangle className="size-5" strokeWidth={1.8} aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-[1.3rem] font-semibold tracking-[-0.02em]">{t('页面出错了')}</h1>
        <p className="mt-2 text-pretty text-[13px] leading-relaxed text-muted">
          {t('可能是数据加载失败，或者这一版的代码有问题。刷新一下通常能恢复。')}
        </p>
        <p className="mt-3 rounded-[var(--radius-md)] border border-line bg-inset px-3 py-2 font-mono text-[11px] leading-relaxed text-faint">
          {message}
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => location.reload()}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-4 text-[12.5px] font-semibold text-[#0b0d12]"
          >
            <RotateCcw className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
            {t('重新加载')}
          </button>
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg"
          >
            {t('回到首页')}
          </Link>
        </div>
      </div>
    </Container>
  );
}
