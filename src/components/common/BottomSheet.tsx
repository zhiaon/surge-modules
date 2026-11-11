import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { cn } from '@/lib/cn';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useMotionOff } from '@/hooks/useMotionOff';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** fraction of viewport height the sheet may occupy */
  height?: 'auto' | 'tall';
  className?: string;
  /** render without the grabber/header */
  bare?: boolean;
}

/**
 * iOS-style sheet that only renders on small screens; on ≥lg it falls back to
 * a centered panel so desktop users never see a phone-shaped drawer.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
  height = 'auto',
  className,
  bare = false,
}: BottomSheetProps) {
  const reduce = useReducedMotion();
  // A frozen compositor clock (doc hidden) leaves a y:'100%' entrance parked
  // off-screen, so the sheet looks like it never opened. When motion is off we
  // mount at the final position with no animation at all.
  const motionOff = useMotionOff();
  const still = reduce || motionOff;
  const [mounted, setMounted] = useState(false);
  const startY = useRef<number | null>(null);
  const [drag, setDrag] = useState(0);
  useLockBodyScroll(open);
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center">
          <motion.div
            className="absolute inset-0 bg-[var(--color-scrim)] backdrop-blur-[2px]"
            initial={still ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={still ? undefined : { opacity: 0 }}
            transition={still ? { duration: 0 } : { duration: 0.2 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={still ? false : { y: '100%' }}
            animate={{ y: 0 }}
            exit={still ? { y: 0 } : { y: '100%' }}
            transition={still ? { duration: 0 } : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            drag={still ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragStart={() => (startY.current = 0)}
            onDrag={(_, info) => setDrag(Math.max(0, info.offset.y))}
            onDragEnd={(_, info) => {
              setDrag(0);
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
            }}
            style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
            className={cn(
              'relative z-10 flex w-full max-w-lg flex-col overflow-hidden border-t border-line-strong',
              'bg-surface sm:rounded-[var(--radius-xl)] sm:border',
              'pb-[env(safe-area-inset-bottom)] sm:pb-0',
              'shadow-[var(--shadow-sheet)]',
              height === 'tall' ? 'max-h-[88vh]' : 'max-h-[80vh]',
              'rounded-t-[var(--radius-2xl)]',
              className,
            )}
          >
            {!bare && (
              <div className="shrink-0">
                <div className="flex justify-center pt-2.5 pb-1 sm:hidden" aria-hidden="true">
                  <span className="h-1 w-9 rounded-full bg-line-strong" />
                </div>
                <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-1.5">
                  <h2 className="text-[14.5px] font-medium">{title}</h2>
                  <IconButton label="关闭" onClick={onClose} size="sm" className="-mr-1">
                    <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </IconButton>
                </header>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
            {footer && (
              <footer className="shrink-0 border-t border-line px-5 py-3">{footer}</footer>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
