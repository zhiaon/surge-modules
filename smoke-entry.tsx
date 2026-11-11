import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './src/pages/Home/HomePage';
import { DiscoverPage } from './src/pages/Discover/DiscoverPage';
import { FavoritesPage } from './src/pages/Favorites/FavoritesPage';
import { UpdatesPage } from './src/pages/Updates/UpdatesPage';
import { AboutPage } from './src/pages/About/AboutPage';
import { NotFoundPage } from './src/pages/NotFound';
import { SiteHeader } from './src/components/layout/SiteHeader';
import { SiteFooter } from './src/components/layout/SiteFooter';
import { AdminLogin } from './src/pages/Admin/AdminLogin';
import { ThemeToggle } from './src/components/common/ThemeToggle';

const targets: Array<[string, React.ReactElement]> = [
  ['Home', <HomePage />],
  ['Discover', <DiscoverPage />],
  ['Favorites', <FavoritesPage />],
  ['Updates', <UpdatesPage />],
  ['About', <AboutPage />],
  ['NotFound', <NotFoundPage />],
  ['Header', <SiteHeader onOpenSearch={() => {}} searchOpen={false} />],
  ['Footer', <SiteFooter />],
  ['AdminLogin', <AdminLogin onSuccess={() => {}} />],
  ['ThemeToggle', <ThemeToggle />],
];

let fail = 0;
for (const [name, el] of targets) {
  try {
    const html = renderToString(<MemoryRouter>{el}</MemoryRouter>);
    console.log(`OK   ${name.padEnd(12)} ${String(html.length).padStart(6)} chars`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}
console.log(fail ? `\n${fail} failed` : '\nall rendered');
process.exit(fail ? 1 : 0);
