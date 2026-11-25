/**
 * Single source of truth for anything that identifies the platform.
 *
 * Empty string = "not configured". Components must degrade gracefully
 * (render the element as plain text, or omit the link) instead of inventing
 * a placeholder URL.
 */

export interface NavItem {
  label: string;
  to: string;
  /** show in the mobile bottom tab bar */
  primary?: boolean;
  /**
   * Show in the mobile drawer menu. Defaults to true — set false for entries
   * that are redundant on a phone (e.g. 分类, which the discover page already
   * exposes as a filter rail). The desktop nav reads the same list, so this
   * flag keeps the two from drifting apart.
   */
  inMenu?: boolean;
}

export interface SiteConfig {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  keywords: string[];
  locale: string;
  logo: {
    /** path under /public */
    src: string;
    alt: string;
  };
  /** empty until the repository is actually public */
  githubUrl: string;
  issuesUrl: string;
  footer: {
    tagline: string;
    /** Affiliation disclaimer. Copyright notices live in the two fields below
        so the same fact is never stated twice. */
    disclaimer: string;
    /** Who owns the module content — the upstream authors, not this site. */
    contentLicense: string;
  };
  seo: {
    titleTemplate: string;
    ogImage: string;
  };
  defaultTheme: 'dark' | 'light' | 'system';
  nav: NavItem[];
  /** shown in the "更新日志" page header */
  version: string;
  /** true only when the services are backed by fixtures instead of the API */
  usesSampleData: boolean;
}

export const siteConfig: SiteConfig = {
  name: 'Surge Modules',
  shortName: 'Modules',
  tagline: '让 Surge 模块发现更简单。',
  description:
    '一个独立的 Surge 模块索引平台：浏览、搜索、收藏与分发模块，查看版本记录与更新说明。',
  keywords: ['Surge', 'Surge 模块', 'sgmodule', '模块索引', '网络工具', '代理规则'],
  locale: 'zh-CN',
  logo: {
    src: '/favicon.svg',
    alt: 'Surge Modules',
  },
  // 未配置：仓库尚未公开，留空而不是编造地址
  githubUrl: '',
  issuesUrl: '',
  footer: {
    tagline: '独立维护的 Surge 模块索引，非 Surge 官方产品。',
    // 三段式：关系澄清 → 模块内容归属 → 使用提示。用分号连成两句，
    // 比原来一句到底的长句好读。
    disclaimer:
      '本站与 Surge 官方无隶属关系；模块由各作者独立提供与维护，本站仅做索引与格式规范化，不对模块内容主张权利。使用前请自行确认模块内容与来源。',
    contentLicense: '模块内容版权归原作者所有',
  },
  seo: {
    titleTemplate: '%s · Surge Modules',
    ogImage: '',
  },
  // Dark is the product default: a first-time visitor on a light-mode device
  // still lands on the dark UI. All three modes exist ('system' included) and
  // an explicit choice always wins and persists.
  // Must match the pre-paint script in index.html, or the first frame flashes.
  defaultTheme: 'dark',
  version: '2.0.0',
  nav: [
    { label: '首页', to: '/', primary: true },
    { label: '发现模块', to: '/discover', primary: true },
    { label: '分类', to: '/discover#categories', inMenu: false },
    { label: '合集', to: '/collection', primary: true },
    { label: '收藏', to: '/favorites', primary: true },
    { label: '更新日志', to: '/updates', primary: true },
  ],
  usesSampleData: false,
};

/** Links that are allowed to render as anchors — everything else is text. */
export const hasLink = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;
