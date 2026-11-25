import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { useMotionOff } from '@/hooks/useMotionOff';
import { detailViewport, detailViewportPadding, type DetailViewport } from '@/lib/detailViewport';

function useDetailViewport() {
  const [viewport, setViewport] = useState<DetailViewport | null>(null);
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    const update = () => setViewport(visual ? detailViewport(
      { width: window.innerWidth, height: window.innerHeight }, visual,
    ) : null);
    update();
    // Do not schedule with rAF: a frozen compositor must not hide the dialog.
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return viewport;
}

/** Dedicated to module details: does not change BottomSheet/Modal consumers. */
export function ModuleDetailDialog({ title, closeLabel, onClose, children }: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useFocusTrap<HTMLDivElement>(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewport = useDetailViewport();
  const reduce = useReducedMotion();
  const motionOff = useMotionOff();
  const still = reduce || motionOff;
  useLockBodyScroll(true);

  // The trap's effect records the opener before this effect moves focus.
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[80]" data-detail-overlay="">
      <div
        className="absolute inset-0 bg-[var(--color-scrim)] backdrop-blur-[2px]"
        data-detail-backdrop=""
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="pointer-events-none fixed flex items-center justify-center"
        data-detail-viewport=""
        style={{
          boxSizing: 'border-box',
          left: viewport?.left ?? 0,
          top: viewport?.top ?? 0,
          width: viewport?.width ?? '100%',
          // dvh is the no-visualViewport fallback; visualViewport is in CSS px
          // already, including pinch zoom, dynamic browser bars and keyboards.
          height: viewport?.height ?? '100dvh',
          ...detailViewportPadding,
        }}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          data-detail-panel=""
          initial={false}
          animate={{ scale: 1 }}
          transition={{ duration: still ? 0 : 0.16 }}
          className="pointer-events-auto relative flex w-full max-w-xl min-h-0 flex-col overflow-hidden border border-line-strong bg-surface shadow-[var(--shadow-pop)]"
          style={{ maxHeight: '100%', borderRadius: 20, minWidth: 0 }}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-1.5" data-detail-header="">
            <h2 className="min-w-0 truncate pl-2 text-[13px] font-medium text-muted">{title}</h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
              style={{ width: 44, height: 44, minWidth: 44, minHeight: 44 }}
            >
              <X className="size-5" strokeWidth={1.9} aria-hidden="true" />
            </button>
          </header>
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            data-detail-scroll=""
            style={{ overflowWrap: 'anywhere', WebkitOverflowScrolling: 'touch' }}
          >
            {children}
          </div>
        </motion.div>
      </div>
    </div>,
    document.body,
  );
}
