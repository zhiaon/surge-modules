import { useEffect } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useParams } from 'react-router-dom';
import { openModuleSheet } from '@/stores/moduleSheet';
import { RootLayout } from '@/components/layout/RootLayout';
import { HomePage } from '@/pages/Home/HomePage';
import { DiscoverPage } from '@/pages/Discover/DiscoverPage';
import { FavoritesPage } from '@/pages/Favorites/FavoritesPage';
import { UpdatesPage } from '@/pages/Updates/UpdatesPage';
import { CollectionPage } from '@/pages/Collection/CollectionPage';
import { NotFoundPage } from '@/pages/NotFound';
import { ErrorPage } from '@/pages/ErrorPage';

/**
 * Legacy /modules/:slug links open the detail sheet over the module list.
 * Kept as a redirect so shared URLs and search results never dead-end.
 */
function ModuleSlugRedirect() {
  const { slug } = useParams();
  useEffect(() => {
    if (slug) openModuleSheet(slug);
  }, [slug]);
  return <Navigate to="/discover" replace />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    // Any render error inside a page lands here instead of React Router's
    // developer error screen.
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'discover', element: <DiscoverPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'updates', element: <UpdatesPage /> },
      { path: 'collection', element: <CollectionPage /> },
      // The About page is gone; keep the URL working by sending people home.
      { path: 'about', element: <Navigate to="/" replace /> },
      // The full detail page is gone: modules open in the detail sheet. Old
      // shared links still land somewhere sensible instead of a 404 — the
      // sheet opens over the discover list.
      { path: 'modules/:slug', element: <ModuleSlugRedirect /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
