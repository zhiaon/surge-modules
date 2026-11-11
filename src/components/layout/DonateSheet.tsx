import { Heart } from 'lucide-react';
import { BottomSheet } from '@/components/common/BottomSheet';
import { useDonateSheet, closeDonateSheet } from '@/stores/donateSheet';

/**
 * WeChat donation QR sheet.
 *
 * The QR lives at /wechat-qr.jpg in the static bundle. Rendered large enough
 * that the WeChat in-app scanner and long-press recognition both work
 * comfortably; long-press-to-save also works since it is a plain <img>.
 */
export function DonateSheet() {
  const open = useDonateSheet();

  return (
    <BottomSheet
      open={open}
      onClose={closeDonateSheet}
      height="auto"
      bare
      className="sm:max-w-sm"
    >
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2.5">
        <span className="w-9" aria-hidden="true" />
        <span className="h-1 w-9 rounded-full bg-line-strong sm:hidden" aria-hidden="true" />
        <button
          type="button"
          onClick={closeDonateSheet}
          aria-label="关闭"
          className="-mr-1 inline-flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <Heart
            className="size-4 text-danger/70"
            strokeWidth={1.9}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="px-6 pb-8 pt-1 text-center">
        <h2 className="text-[1.05rem] font-semibold tracking-[-0.02em]">感谢支持 ❤️</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          模块完全免费，扫码请作者喝杯咖啡
        </p>

        <div className="mx-auto mt-5 w-full max-w-[280px] rounded-[var(--radius-xl)] border border-line bg-white p-3 shadow-[var(--shadow-card)]">
          <img
            src="/wechat-qr.jpg"
            alt="微信收款码"
            className="block w-full rounded-[var(--radius-md)]"
            width={480}
            height={480}
          />
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-[12px] text-faint">
          <Heart className="size-3 text-danger/60" strokeWidth={2} aria-hidden="true" />
          微信「扫一扫」识别，或长按保存
        </p>
      </div>
    </BottomSheet>
  );
}
