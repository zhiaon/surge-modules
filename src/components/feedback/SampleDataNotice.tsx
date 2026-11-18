import { Info } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { useI18n } from '@/i18n';

/**
 * Honest banner: the catalogue is fixture data, so say so where the data is
 * shown rather than only in the README.
 */
export function SampleDataNotice({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  if (!siteConfig.usesSampleData) return null;
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-line bg-surface/60 px-3.5 py-2.5"
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-faint" strokeWidth={1.75} aria-hidden="true" />
      <p className="text-[11.5px] leading-relaxed text-faint">
        <span className="text-muted">{t('示例数据')}</span>
        {' · '}
        {compact
          ? t('当前内容为界面演示数据。')
          : t('当前展示的模块、作者与版本均为界面演示用的示例数据，未接入真实仓库；原始链接同样不可安装。')}
      </p>
    </div>
  );
}
