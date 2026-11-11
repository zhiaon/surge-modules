import { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { cn } from '@/lib/cn';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  /** footer actions */
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** hide the default header (caller renders its own) */
  bare?: boolean;
  className?: string;
  /** top-aligned on desktop, used for the command palette */
  align?: 'center' | 'top';
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  bare = false,
  className,
  align = 'center',
}: ModalProps) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const descId = useId();
  const panelRef = useFocusTrap<HTMLDivElement>(open);
  useLockBodyScroll(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className={cn(
            'fixed inset-0 z-[80] flex justify-center px-4',
            align === 'top'
              ? 'items-start pt-[8vh] sm:pt-[12vh]'
              : 'items-end sm:items-center pb-0 sm:pb-0',
          )}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={description ? descId : undefined}
        >
          <motion.div
            className="absolute inset-0 bg-[var(--color-scrim)] backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'relative z-10 flex w-full flex-col overflow-hidden border border-line-strong bg-surface',
              'max-h-[88vh] rounded-t-[var(--radius-xl)] sm:max-h-[82vh] sm:rounded-[var(--radius-xl)]',
              'shadow-[var(--shadow-pop)]',
              SIZES[size],
              className,
            )}
          >
            {!bare && (
              <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                <div className="min-w-0">
                  {title && (
                    <h2 id={titleId} className="text-[15px] font-medium leading-tight">
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p id={descId} className="mt-1 text-[12.5px] leading-relaxed text-faint">
                      {description}
                    </p>
                  )}
                </div>
                <IconButton label="关闭" onClick={onClose} size="sm" className="-mr-1 -mt-0.5">
                  <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
                </IconButton>
              </header>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
            {footer && <footer className="border-t border-line px-5 py-3.5">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
