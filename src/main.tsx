import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './router';
import { ToastViewport } from './components/feedback/Toast';
import { initTheme } from './hooks/useTheme';
import { initLang } from './i18n';
import { initMotionPolicy } from './lib/motionPolicy';
import { installClickEffects } from './lib/clickEffects';
import './styles/index.css';
import './styles/visual-fx.css';

// apply the stored/system theme before first paint to avoid a flash
initTheme();
// same for the language: <html lang> decides font stacks and CJK line-breaking
initLang();
// decide whether motion can safely run (hidden docs freeze the clock)
initMotionPolicy();
// one delegated listener for every interactive element on the site
installClickEffects();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <AppRouter />
    <ToastViewport />
  </StrictMode>,
);
