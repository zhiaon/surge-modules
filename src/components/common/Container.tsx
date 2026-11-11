import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export interface ContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'narrow' | 'default' | 'wide';
  as?: 'div' | 'section' | 'main' | 'header' | 'footer' | 'nav';
}

const SIZES: Record<NonNullable<ContainerProps['size']>, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-6xl',
  // 1600px at 2xl: on a 1920 screen that leaves a comfortable 160px gutter
  // instead of the previous 260px, which made the page look like a phone layout
  // stretched into the middle of a monitor.
  wide: 'max-w-[1540px] 2xl:max-w-[1680px]',
};

export const Container = forwardRef<HTMLDivElement, ContainerProps>(function Container(
  { size = 'default', as: Tag = 'div', className, children, ...rest },
  ref,
) {
  return (
    <Tag
      ref={ref as never}
      className={cn('mx-auto w-full px-5 sm:px-7 lg:px-10', SIZES[size], className)}
      {...rest}
    >
      {children}
    </Tag>
  );
});
