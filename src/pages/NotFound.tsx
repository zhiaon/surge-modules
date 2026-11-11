import { Container } from '@/components/common/Container';
import { ButtonLink } from '@/components/common/Button';
import { usePageMeta } from '@/hooks/usePageMeta';

export function NotFoundPage() {
  usePageMeta({ title: '页面不存在', noIndex: true });
  return (
    <Container size="narrow" className="py-20 text-center sm:py-28">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">404</p>
      <h1 className="mt-3 text-[1.7rem] font-semibold tracking-[-0.022em] sm:text-[2.1rem]">
        这个页面不存在。
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-[13.5px] leading-relaxed text-muted">
        链接可能已经更改或被移除。可以从模块目录重新开始。
      </p>
      <div className="mt-7 flex justify-center gap-2.5">
        <ButtonLink to="/" variant="primary" size="md">
          返回首页
        </ButtonLink>
        <ButtonLink to="/discover" variant="outline" size="md">
          浏览模块
        </ButtonLink>
      </div>
    </Container>
  );
}
