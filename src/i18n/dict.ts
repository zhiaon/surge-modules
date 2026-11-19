/**
 * English copy for the interface.
 *
 * Keys are the Chinese source strings themselves. That keeps the JSX readable
 * (nothing looks like `t('nav.home')`) and makes a missing translation fall
 * back to exactly the text the author already wrote, instead of a raw key.
 *
 * Interpolation uses `{name}` placeholders. A value may be `{one, many}` when
 * English needs a plural form and Chinese does not.
 *
 * Only interface chrome belongs here. Module names, descriptions and authors are
 * upstream content and are shown as the author wrote them.
 */

export type DictValue = string | { one: string; many: string };

export const EN: Record<string, DictValue> = {
  // ---- navigation / header ---------------------------------------------
  '首页': 'Home',
  '发现模块': 'Discover',
  '发现': 'Discover',
  '分类': 'Categories',
  '合集': 'Collection',
  '收藏': 'Favorites',
  '更新日志': 'Changelog',
  '更新': 'Updates',
  '主导航': 'Main navigation',
  '底部导航': 'Bottom navigation',
  '页脚导航': 'Footer navigation',
  '导航': 'Navigation',
  '{name} 首页': '{name} home',
  'GitHub 仓库': 'GitHub repository',
  '跳到主要内容': 'Skip to main content',
  '有 {n} 个收藏': { one: '{n} favorite', many: '{n} favorites' },

  // ---- theme -----------------------------------------------------------
  '深色': 'Dark',
  '浅色': 'Light',
  '跟随系统': 'System',
  '始终使用深色': 'Always dark',
  '始终使用浅色': 'Always light',
  '随设备外观自动切换': 'Follow the device',
  '外观': 'Appearance',
  '选择外观': 'Choose appearance',
  '主题：跟随系统（当前{dark}）': 'Theme: system ({dark} now)',
  '主题：{mode}': 'Theme: {mode}',

  // ---- language --------------------------------------------------------
  '语言': 'Language',
  '跟随系统语言': 'Follow device',
  '选择语言': 'Choose language',
  '简体中文': '简体中文',
  English: 'English',
  '切换语言，当前{lang}': 'Switch language, currently {lang}',

  // ---- common ----------------------------------------------------------
  '关闭': 'Close',
  '清空': 'Clear',
  '清空搜索': 'Clear search',
  '返回': 'Back',
  '重试': 'Retry',
  '重新加载': 'Reload',
  '加载中…': 'Loading…',
  '上一页': 'Previous',
  '下一页': 'Next',
  '返回首页': 'Back to home',
  '返回分类': 'Back to categories',
  '返回来源': 'Back to sources',
  '返回模块目录': 'Back to the catalogue',
  '暂无内容': 'Nothing here yet',
  '已复制': 'Copied',
  '复制失败': 'Copy failed',
  '已复制配置': 'Config copied',
  '这是模块的完整 .sgmodule 文本': 'This is the module’s full .sgmodule text',
  '剪贴板不可用，请长按原始链接手动复制': 'Clipboard unavailable — long-press the raw link to copy it manually',

  // ---- home: hero ------------------------------------------------------
  '模块总数': 'Modules',
  '模块分类': 'Categories',
  '已收录并公开': 'Indexed and public',
  '按用途划分': 'Grouped by purpose',
  '模块来源': 'Sources',
  '已接入的上游仓库': 'Upstream repositories',
  '最近更新': 'Latest updates',
  '按发布倒序': 'Newest first',
  '最多：{name}': 'Largest: {name}',
  '{n} 个版本记录': { one: '{n} version record', many: '{n} version records' },
  '独立 Surge 模块索引': 'An independent Surge module index',
  '让 Surge 模块': 'Finding Surge',
  '发现更简单': 'modules, made simple',
  '浏览、搜索与收藏优质 Surge 模块，查看原始配置、复制安装链接，一次找到需要的规则与脚本。':
    'Browse, search and save good Surge modules — read the raw config, copy an install link, and get the rules and scripts you need in one pass.',
  '探索模块': 'Explore modules',
  '浏览分类': 'Browse categories',
  '查看{label}': 'View {label}',
  '数据随构建更新。': 'Counts update with every build.',
  '共 {n} 个模块': { one: '{n} module', many: '{n} modules' },
  '查看全部模块': 'View all modules',

  // ---- home: sections --------------------------------------------------
  '精选': 'Featured',
  '本期推荐': 'This week’s picks',
  '由维护者手动标记的模块，按最近更新时间排序。': 'Hand-picked by the maintainer, newest first.',
  '全部模块': 'All modules',
  '精选模块加载失败': 'Could not load featured modules',
  '暂无精选模块': 'No featured modules yet',
  '精选由维护者标记，标记后会自动出现在这里。': 'Featured modules are marked by the maintainer and appear here automatically.',
  '浏览全部模块': 'Browse all modules',
  '按用途浏览': 'Browse by purpose',
  '从拦截规则到脚本增强，按实际用途归类的模块目录。': 'From blocking rules to script enhancements, grouped by what they actually do.',
  '参与筛选': 'Filter the catalogue',
  '分类加载失败': 'Could not load categories',
  '按发布倒序排列的模块版本记录。': 'Module version history, newest first.',
  '查看全部更新': 'See all updates',
  '更新记录加载失败': 'Could not load update history',
  '暂无版本记录': 'No version records yet',
  '暂无版本记录。模块导入并同步后，更新会按时间倒序出现在这里。':
    'No version records yet. Once modules are imported and synced, releases appear here newest first.',
  '模块库': 'Library',
  '按更新时间倒序展示最新收录的模块。': 'The newest modules, sorted by update time.',
  '模块库尚未导入内容。': 'Nothing has been imported into the library yet.',
  '当前索引 1 个演示模块，用于验证列表结构。': 'Indexing a single demo module to exercise the list layout.',
  '当前索引 {n} 个已发布模块，按更新时间倒序展示。': 'Indexing {n} published modules, newest first.',
  '探索全部模块': 'Explore all modules',
  '模块库加载失败': 'Could not load the library',
  '模块库为空': 'The library is empty',
  '导入模块后，最新收录的内容会出现在这里。': 'Once modules are imported, the newest ones show up here.',
  '了解导入计划': 'Read about the import plan',
  '展示的是索引内的全部内容，不含安装量或热度排序 —— 这些统计尚未接入。':
    'Everything indexed is listed here — install counts and popularity are not tracked yet.',
  '进入发现页': 'Open the discover page',
  '关于平台': 'About',
  '独立索引': 'Independent index',
  '由维护者整理的 Surge 模块目录，与 Surge 官方无隶属关系。': 'A Surge module catalogue maintained independently, not affiliated with Surge.',
  '原始配置': 'Raw config',
  '在详情页直接查看模块的 .sgmodule 原文，复制原始链接。': 'Read a module’s .sgmodule source in its detail sheet and copy the raw link.',
  '版本记录': 'Version history',
  '记录每个模块的版本号、发布时间与更新说明。': 'Every module’s version number, release date and changelog.',
  '本地收藏': 'Local favorites',
  '收藏保存在本机浏览器，无需账号，清除站点数据会一并清空。':
    'Favorites live in this browser — no account needed, and clearing site data clears them too.',
  '一个专注的模块索引。': 'One focused index.',
  '不做社区，不做商店。只负责把模块整理清楚，让你更快找到需要的那一个。':
    'No community, no store. Just modules kept tidy so you find the one you need faster.',
  '了解平台范围': 'What this site covers',

  // ---- module card -----------------------------------------------------
  '已复制安装链接': 'Install link copied',
  '导入Surge': 'Install in Surge',
  '导入 Surge': 'Install in Surge',
  '复制链接': 'Copy link',
  '详情配置': 'Details',
  '另有 {n} 个同名模块，可在详情里对比': {
    one: '{n} other module with the same name — compare them in the details',
    many: '{n} other modules with the same name — compare them in the details',
  },
  '同名 {n}': 'Same name {n}',
  '模块引用的脚本已失效：{hint}': 'The scripts this module points at are gone: {hint}',
  '更新于 {date}': 'Updated {date}',

  // ---- module detail sheet --------------------------------------------
  '模块详情加载失败': 'Could not load module details',
  '找不到这个模块': 'That module does not exist',
  '已复制分享链接': 'Share link copied',
  '分享链接': 'Share link',
  '对方会看到模块预览卡片': 'They will see a preview card for the module',
  '模块名称、作者或描述': 'Module name, author or description',
  '搜索模块名称、作者或描述': 'Search by module name, author or description',
  '搜索模块、作者或标签…': 'Search modules, authors or tags…',
  '搜索模块、描述、作者或标签': 'Search modules, descriptions, authors or tags',
  '搜索要加入合集的模块': 'Search for modules to add',
  '搜索该来源的模块': 'Search modules from this source',
  '类别': 'Category',
  '版本': 'Version',
  '更新于': 'Updated',
  '技术清单': 'Technical details',
  '{n} 条规则': { one: '{n} rule', many: '{n} rules' },
  '{n} 域名': { one: '{n} domain', many: '{n} domains' },
  '{n} 条重写': { one: '{n} rewrite', many: '{n} rewrites' },
  '{n} 个脚本': { one: '{n} script', many: '{n} scripts' },
  '面板': 'Panels',
  '{n} 个 [Panel] 卡片': { one: '{n} [Panel] card', many: '{n} [Panel] cards' },
  '定时': 'Schedule',
  '…等 {n} 个': '…and {n} more',
  '脚本': 'Scripts',
  '无脚本、无 MITM、无定时任务。': 'No scripts, no MITM, no scheduled tasks.',
  '同名模块': 'Same-name modules',
  '同名模块 {n} 个，选哪个？': { one: '{n} module shares this name — which one?', many: '{n} modules share this name — which one?' },
  '来源': 'Source',
  '规则': 'Rules',
  '重写': 'Rewrites',
  '域名': 'Domains',
  '状态': 'Status',
  '推荐': 'Recommended',
  '失效': 'Broken',
  '正常': 'Working',
  '按「脚本是否可用 → 拦截面大小 → 更新时间」排序，推荐项可直接安装。':
    'Sorted by script health, then coverage, then update time — the recommended pick is ready to install.',
  '变更记录': 'Change log',
  '收录': 'Added',
  '下架': 'Removed',
  '内容变更': 'Content changed',
  '收起': 'Collapse',
  '展开': 'Expand',
  '{n} 行': { one: '{n} line', many: '{n} lines' },
  '复制配置': 'Copy config',
  '版本记录（{n}）': 'Version history ({n})',
  '当前': 'Current',
  '安装链接需要 Surge 已安装并登录；未登录时链接不含访问凭证。':
    'The install link needs Surge installed and signed in; unsigned links carry no access credential.',
  '模块最后更新 {when}。': 'Module last updated {when}.',
  '模块著作权归原作者 {author} 所有，本站仅做索引与格式规范化，不对模块内容主张任何权利。如有异议可联系下架。':
    'Copyright belongs to the original author {author}. This site only indexes and normalises formatting and claims no rights over module contents. Contact us to have an entry removed.',
  '所有作者': 'the original author',

  // ---- favorites -------------------------------------------------------
  '我的收藏': 'My favorites',
  '保存在本机的 Surge 模块收藏。': 'Surge modules saved on this device.',
  '收藏保存在这台设备的浏览器中，刷新或重新打开都不会丢失。':
    'Favorites are stored in this browser; reloading or reopening keeps them.',
  '收藏加载失败': 'Could not load favorites',
  '还没有收藏任何模块': 'No favorites yet',
  '在模块卡片或详情页点击收藏，之后可以在这里集中查看。收藏只保存在本机，不会上传。':
    'Tap the bookmark on a card or in the details to save it here. Favorites stay on this device and are never uploaded.',
  '去发现模块': 'Discover modules',
  '{n} 个收藏 · 按添加时间倒序': { one: '{n} favorite · newest first', many: '{n} favorites · newest first' },
  '收藏于': 'Saved',
  '账号体系与云端同步尚未实现；当前收藏不会跨设备同步，清除站点数据会一并清空。':
    'Accounts and cloud sync are not implemented yet: favorites do not sync across devices and clearing site data removes them.',
  '取消收藏': 'Remove from favorites',
  '已取消收藏': 'Removed from favorites',
  '已加入收藏': 'Saved to favorites',
  '已收藏': 'Saved',
  '收藏 {name}': 'Save {name}',
  '取消收藏 {name}': 'Remove {name} from favorites',

  // ---- updates ---------------------------------------------------------
  '平台公告与模块版本更新记录。': 'Site announcements and module release history.',
  '平台公告与模块版本记录。当前版本 v{version}。': 'Announcements and module version history. Current version v{version}.',
  '模块更新': 'Module updates',
  '{n} 条': { one: '{n} entry', many: '{n} entries' },
  '暂无模块更新': 'No module updates yet',
  '模块同步并发布新版本后，记录会出现在这里。': 'Once modules sync and publish a new version, it shows up here.',
  '最新': 'Newest',
  '平台公告': 'Announcements',
  '公告加载失败': 'Could not load announcements',
  '暂无公告': 'No announcements',
  '置顶': 'Pinned',
  '按更新时间倒序': 'Newest first',

  // ---- discover --------------------------------------------------------
  '按分类、标签与关键词筛选 Surge 模块。': 'Filter Surge modules by category, tag and keyword.',
  '模块目录': 'Module catalogue',
  '按分类、标签与关键词筛选。所有条件都会写进地址栏，可直接分享。':
    'Filter by category, tag and keyword. Every filter goes into the URL, so links are shareable.',
  '筛选模块': 'Filter modules',
  '筛选': 'Filters',
  '排序方式': 'Sort order',
  '资源筛选': 'Filters',
  '收起筛选': 'Collapse filters',
  '来源（{n}）': 'Sources ({n})',
  '全部': 'All',
  '分类（{n}）': 'Categories ({n})',
  '功能': 'Features',
  '含面板': 'Has panels',
  '含面板 [Panel]': 'Has [Panel]',
  '重置筛选': 'Reset filters',
  '当前筛选': 'Active filters',
  '来源：{owner}': 'Source: {owner}',
  '排序：{label}': 'Sort: {label}',
  '清除全部': 'Clear all',
  '清除筛选': 'Clear filters',
  '模块列表加载失败': 'Could not load the module list',
  '没有符合条件的模块': 'No modules match',
  '换一个关键词，或清除筛选条件重新浏览。': 'Try another keyword, or clear the filters and browse again.',
  '选择一个分类快速缩小范围。': 'Pick a category to narrow things down.',
  '移除这个筛选条件': 'Remove this filter',
  '名称': 'Name',
  '排序': 'Sort',

  // ---- collection ------------------------------------------------------
  '挑选多个模块，一键生成合并后的单个模块。': 'Pick several modules and merge them into one.',
  '读取 {name} 失败': 'Could not read {name}',
  '{n} 个模块 · {m} 个段落': '{n} modules · {m} sections',
  '生成失败': 'Generation failed',
  '请稍后重试': 'Please try again',
  '在 Surge 里粘贴这个链接即可安装': ' Paste this link into Surge to install',
  '分享后对方打开就能看到同样选择': 'Anyone opening the share link sees the same selection',
  '模块合集': 'Module collection',
  '挑选任意模块，生成一个合并后的 .sgmodule，一次导入全部生效。':
    'Pick any modules and generate one merged .sgmodule — install them all at once.',
  '选择会写进地址栏，可以直接分享给别人。': 'The selection is kept in the URL, so you can share it.',
  '已选': 'Selected',
  '还没有选择模块。在下面搜索并点击添加。': 'Nothing selected yet. Search below and tap to add.',
  '生成中…': 'Generating…',
  '生成合集': 'Generate collection',
  '下载 .sgmodule': 'Download .sgmodule',
  '复制安装链接': 'Copy install link',
  '分享此页': 'Share this page',
  '「安装链接」是真正的模块地址，可直接粘进 Surge；「分享此页」是网页，':
    '“Install link” is the real module URL — paste it straight into Surge. “Share this page” is a web page,',
  '对方打开后能自己查看并下载，不能直接导入。': 'which the recipient can view and download from, but cannot import directly.',
  'Surge 合集（{n} 个模块）': 'Surge collection ({n} modules)',
  'Surge 模块合集': 'Surge module collection',
  'Surge Modules 合集': 'Surge Modules collection',
  '由 Surge Modules 生成的合集，包含 {n} 个模块：{list}': 'Collected by Surge Modules: {n} modules — {list}',
  '的模块文件缺失': '’s module file is missing',

  // ---- errors / 404 ----------------------------------------------------
  '页面不存在': 'Page not found',
  '浏览模块': 'Browse modules',
  '回到首页': 'Back to home',

  '这个页面不存在。': 'This page does not exist.',
  '链接可能已经更改或被移除。可以从模块目录重新开始。':
    'The link may have changed or been removed. Start again from the catalogue.',
  '页面出错了': 'Something went wrong',
  '可能是数据加载失败，或者这一版的代码有问题。刷新一下通常能恢复。':
    'A data load may have failed, or this build has a bug. Reloading usually fixes it.',
  '加载失败': 'Could not load',
  '数据没有加载成功。可以重试一次；如果仍然失败，稍后再回来看看。':
    'The data did not load. Try once more; if it still fails, come back later.',
  '未知错误': 'Unknown error',

  // ---- footer ----------------------------------------------------------
  '独立维护的 Surge 模块索引，非 Surge 官方产品。': 'An independently maintained Surge module index. Not an official Surge product.',
  '本站与 Surge 官方无隶属关系；模块由各作者独立提供与维护，本站仅做索引与格式规范化，不对模块内容主张权利。使用前请自行确认模块内容与来源。':
    'This site is not affiliated with Surge. Modules are provided and maintained by their own authors; we only index them and normalise formatting, and claim no rights over their contents. Check what a module does before you use it.',
  '模块内容版权归原作者所有': 'Module content © the respective authors',
  '保留所有权利': 'All rights reserved',
  '许舟': 'Xu Zhou',
  '联系作者': 'Contact',
  '通过Telegram频道私信反馈问题或提出建议': 'Send feedback or suggestions via the Telegram channel',
  '通过 Telegram 频道私信反馈问题或提出建议': 'Send feedback or suggestions via the Telegram channel',
  '示例数据': 'Sample data',
  '当前内容为界面演示数据。': 'This content is demo data for the interface.',
  '当前展示的模块、作者与版本均为界面演示用的示例数据，未接入真实仓库；原始链接同样不可安装。':
    'The modules, authors and versions shown are demo data; no real repository is connected and the raw links are not installable.',

  // ---- stat sheets -----------------------------------------------------
  '个模块': 'modules',
  '{n} 个': '{n}',
  '已收录': 'Indexed',
  '已接入': 'Connected',
  '最近扫描': 'Last scanned',
  '接入时间': 'Added',
  '个已接入的上游仓库': 'upstream repositories connected',
  '共 {n} 个已接入的上游仓库': '{n} upstream repositories connected',
  '在 GitHub 打开 {name}': 'Open {name} on GitHub',
  '按更新时间倒序 · 共 {n} 个模块 · 第 {page}/{pages} 页':
    'Newest first · {n} modules · page {page} of {pages}',
  '共 {n} 个模块 · 第 {page}/{pages} 页': '{n} modules · page {page} of {pages}',
  '未分类': 'Uncategorised',

  // ---- health ----------------------------------------------------------
  '仓库已删除': 'Repository deleted',
  '外部脚本失效': 'External script gone',
  '相对路径失效': 'Relative path broken',
  '脚本失效': 'Script gone',
  '该模块引用的脚本已被上游作者删除，安装后不会生效。可以继续使用，但不会有任何效果；建议选择其他同类模块。':
    'The scripts this module points at were deleted upstream. It installs but does nothing — pick another module of the same kind.',
  '该模块引用的脚本所在仓库已不存在，作者已停止维护。安装后不会生效，建议选择其他同类模块。':
    'The repository holding this module’s scripts no longer exists and its author has stopped maintaining it. It will not work — pick another module.',
  '该模块的脚本放在 GitHub 以外的自建站，地址已无法访问，且无法核实是否只是换了位置。安装后可能不生效。':
    'The scripts live on a self-hosted site outside GitHub that no longer responds, and it cannot be verified whether they simply moved. It may not work.',
  '该模块用相对路径引用脚本，安装后 Surge 无法解析到文件，脚本不会运行。':
    'This module references its scripts by relative path, which Surge cannot resolve after install — the scripts never run.',
  '该模块引用的部分脚本已失效，安装后可能只有部分功能生效，建议选择其他同类模块。':
    'Some of the scripts this module points at are gone; only part of it will work. Pick another module of the same kind.',

  // ---- services / misc -------------------------------------------------
  '无法连接服务器': 'Cannot reach the server',
  '接口未就绪': 'Interface not ready',
  '网络异常，请检查连接': 'Network error — check your connection',
  '服务暂时不可用': 'Service temporarily unavailable',
  '数据文件缺失': 'Data file missing',
  '数据文件格式异常': 'Malformed data file',
  '后端接口未启动：请用 npm run dev:site，或部署后访问。':
    'The backend is not running: use npm run dev:site, or visit the deployed site.',
  '未配置模块反代地址，无法读取原始配置。': 'No module proxy URL is configured, so the raw config cannot be read.',
  '读取原始配置失败（HTTP {status}）': 'Could not read the raw config (HTTP {status})',
  '这是多余的': 'redundant',

  // ---- leftovers ------------------------------------------------------
  '分享链接已复制': 'Share link copied',
  '脚本：': 'Scripts:',
  '定时：': 'Schedule:',
  '面板：': 'Panels:',
  '一个独立的 Surge 模块索引平台：浏览、搜索、收藏与分发模块，查看原始配置与版本记录。':
    'An independent Surge module index: browse, search, save and distribute modules, and read the raw config and version history.',
  '让 Surge 模块发现更简单。': 'Finding Surge modules, made simple.',
  '模块索引': 'Module index',
  '网络工具': 'Network tools',
  '代理规则': 'Proxy rules',
  'Surge 模块': 'Surge modules',
  广告拦截: 'Ad blocking',
  应用净化: 'App cleanup',
  应用解锁: 'App unlocking',
  流媒体: 'Streaming',
  脚本增强: 'Script enhancements',
  'Apple 服务': 'Apple services',
  字幕翻译: 'Subtitles',
  规则分流: 'Rule routing',
  隐私防护: 'Privacy',
  '在请求层拦截网页与 App 内的广告、统计与追踪域名。':
    'Block ads, analytics and trackers inside web pages and apps at the request layer.',
  '移除开屏广告、信息流推荐与多余的运营弹窗。': 'Remove splash ads, feed recommendations and surplus promo pop-ups.',
  '解锁会员功能、去除功能限制。': 'Unlock membership features and lift functional limits.',
  '流媒体平台的解锁、增强与广告清理。': 'Region unlocking, enhancements and ad cleanup for streaming platforms.',
  '定时任务、自动签到与基于 HTTP 的轻量自动化。': 'Scheduled tasks, automatic check-ins and light HTTP automation.',
  '改写 Apple 网络请求：Siri、地图、天气、News、TestFlight 等区域与功能开放。':
    'Rewrite Apple network requests to open up regions and features in Siri, Maps, Weather, News and TestFlight.',
  '为流媒体自动挂载双语字幕，或翻译页面内容。': 'Attach bilingual subtitles to streaming video automatically, or translate page content.',
  '补充域名规则、策略组与更细粒度的分流判断。': 'Extra domain rules, policy groups and finer-grained routing.',
  '阻断设备指纹、追踪像素与遥测上报。': 'Block device fingerprinting, tracking pixels and telemetry.',
  'IP 信息、流媒体解锁与网络诊断类模块。': 'IP lookups, streaming unlock checks and network diagnostics.',

};
