import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

/**
 * Minimal toast queue. Visual feedback only — no vibration claims, since
 * iOS Safari does not expose a reliable haptics API.
 */

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone?: 'default' | 'success';
}

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l([...items]));
}

export const toast = {
  show(title: string, description?: string, tone: ToastItem['tone'] = 'default') {
    const item: ToastItem = { id: ++seq, title, description, tone };
    items = [...items.slice(-2), item];
    emit();
    window.setTimeout(() => {
      items = items.filter((i) => i.id !== item.id);
      emit();
    }, 2600);
  },
  dismiss(id: number) {
    items = items.filter((i) => i.id !== id);
    emit();
  },
};

export function ToastViewport() {
  const [list, setList] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);
  const reduce = useReducedMotion();
  const regionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] flex flex-col items-center gap-2 px-4
                 pb-[calc(env(safe-area-inset-bottom)+var(--tabbar-h)+1rem)] md:pb-6"
    >
      <AnimatePresence initial={false}>
        {list.map((item) => (
          <motion.div
            key={item.id}
            layout={!reduce}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-[var(--radius-sm)]
                       border border-line-strong bg-raised px-3.5 py-2.5 shadow-[var(--shadow-toast)]"
          >
            <span
              className={
                item.tone === 'success'
                  ? 'size-1.5 shrink-0 rounded-full bg-ok'
                  : 'size-1.5 shrink-0 rounded-full bg-accent'
              }
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[13px] font-medium leading-tight">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 text-[11.5px] leading-tight text-faint">{item.description}</p>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
