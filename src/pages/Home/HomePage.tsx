import { siteConfig } from '@/config/site';
import { useAsync } from '@/hooks/useAsync';
import { categoryService } from '@/services/categoryService';
import { moduleService } from '@/services/moduleService';
import { snapshots } from '@/lib/publicSnapshots';
import { Hero } from './Hero';
import { CategorySection } from './CategorySection';
import { FeaturedSection } from './FeaturedSection';
import { RecentUpdates } from './RecentUpdates';
import { LibraryPreview, PlatformIntro } from './LibraryPreview';
import { usePageMeta } from '@/hooks/usePageMeta';
import { StatSheets } from '@/components/home/StatSheets';
import { closeStatSheet, useStatSheet } from '@/stores/statSheet';
import { useI18n } from '@/i18n';

/**
 * Home page composition only — every block owns its own data needs and
 * loading state, so a slow section never blocks the hero from painting.
 *
 * Every read is bound to a public snapshot: coming back from the bottom tab bar
 * paints the real cards on the first frame instead of a grid of skeletons, and
 * the fetch that still runs behind it refreshes them.
 */
export function HomePage() {
  const { t } = useI18n();
  usePageMeta({
    title: t(siteConfig.tagline),
    description: t(siteConfig.description),
    path: '/',
  });

  const stats = useAsync(() => moduleService.getModuleStats(), [], snapshots.stats());
  const featured = useAsync(
    () => moduleService.getFeaturedModules(6),
    [],
    snapshots.featured(6),
  );
  const recent = useAsync(
    () => moduleService.getRecentlyUpdated(5),
    [],
    snapshots.recent(5),
  );
  const categories = useAsync(
    () => categoryService.getCategories(),
    [],
    snapshots.categories(),
  );
  // Full catalogue: stat sheets search/page locally, LibraryPreview takes
  // the first 6 — one fetch serves everything on the page, and the same
  // snapshot is shared with Discover and Collection.
  const library = useAsync(
    () => moduleService.getModules({ perPage: 9999 }),
    [],
    snapshots.catalogue(),
  );

  const topCategory = categories.data
    ? [...categories.data].sort((a, b) => b.moduleCount - a.moduleCount)[0]
    : undefined;

  // Stat sheets read the same catalogue as the library preview — one fetch
  // serves both, and opening a sheet costs nothing extra.
  const { kind } = useStatSheet();

  return (
    <>
      <Hero stats={stats.data} topCategory={topCategory} />

      {/* each block owns its own failure: one dead section must not blank the page */}
      <FeaturedSection
        modules={featured.data}
        loading={featured.status === 'loading' || featured.status === 'idle'}
        error={featured.error}
        onRetry={featured.reload}
      />
      <CategorySection
        categories={categories.data}
        loading={categories.status === 'loading' || categories.status === 'idle'}
        error={categories.error}
        onRetry={categories.reload}
      />
      <RecentUpdates
        modules={recent.data}
        loading={recent.status === 'loading' || recent.status === 'idle'}
        error={recent.error}
        onRetry={recent.reload}
      />
      <LibraryPreview
        modules={library.data?.items.slice(0, 6)}
        total={library.data?.total}
        loading={library.status === 'loading' || library.status === 'idle'}
        error={library.error}
        onRetry={library.reload}
      />
      <PlatformIntro />

      <StatSheets kind={kind} modules={library.data?.items} onClose={closeStatSheet} />
    </>
  );
}
