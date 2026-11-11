# 设计系统

本文件是视觉决策的唯一说明。任何新组件都应先在这里找到对应规则，而不是自行发挥。

## 1. 依据

参考 Nyora 的设计气质：**编辑部排版、大量留白、克制强调色、以文字层级而不是装饰制造层次**。
不复制其代码、图片或具体布局；只继承四条原则：

1. 排版优先 —— 尺寸、字重、行高与字距构成层级，卡片只是容器。
2. 留白是结构 —— 区块之间用间距和分割线分隔，而不是靠背景块堆叠。
3. 少量强调 —— 全站只有一个暖铜色强调（`--color-accent`），只出现在精选、当前状态和关键动作上。
4. 动效可忽略 —— 动效只服务于"内容已到达"的感知，不用来表演。

## 2. 颜色

全部定义在 `src/styles/index.css` 的 `@theme` 中，浅色主题通过 `html[data-theme='light']` 重映射同名 token。组件中**只允许**使用语义 token 或 Tailwind 映射类（`bg-raised`、`text-muted`、`border-line`），不允许出现裸十六进制值。

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--color-canvas` | `#08090B` | `#F6F5F2` | 页面底色 |
| `--color-surface` | `#101216` | `#EFEEEA` | 次级区块背景 |
| `--color-raised` | `#14171B` | `#FFFFFF` | 卡片 / 输入框 |
| `--color-raised-hover` | `#1B1F25` | `#F4F2EE` | 卡片悬停 |
| `--color-inset` | `#0C0E11` | `#ECEAE5` | 代码块等凹陷面 |
| `--color-fg` | `#F4F5F6` | `#14161A` | 主文字 |
| `--color-muted` | `#9299A3` | `#5C636D` | 次级文字 |
| `--color-faint` | `#626A75` | `#686F78` | 弱化文字 / 说明 |
| `--color-line` | `#25292F` | `#E0DED7` | 分割线 / 边框 |
| `--color-line-strong` | `#363C45` | `#CBC8BF` | 强调边框 / 悬停 |
| `--color-accent` | `#C9915B` | `#8F5A28` | 强调（唯一） |
| `--color-accent-soft` | `#E3C3A1` | `#8E5622` | 强调文字 |
| `--color-accent-dim` | `#A67A4E` | `#9C6538` | 强调线 / 小号强调文字 |
| `--color-ok` / `--color-warn` / `--color-danger` | 各自一组 | 各自一组 | 状态 |

对比度（实测，WCAG 相对亮度）：

| Token | 深色 on canvas | 浅色 on canvas | 浅色 on 白卡 |
| --- | --- | --- | --- |
| `--color-fg` | 18.25 | 16.61 | — |
| `--color-muted` | 6.93 | 5.57 | — |
| `--color-faint` | 3.64 | 4.66 | 5.08 |
| `--color-accent` | 7.29 | 5.26 | — |
| `--color-accent-soft` | 10.78 (on raised) | 5.50 | 5.99 |
| `--color-accent-dim` | 5.23 | 4.45 | 4.85 |

规则：正文与所有承载信息的文字 ≥ 4.5:1；`--color-faint` 在深色下为 3.64，仅可用于非关键辅助说明，不得承载唯一信息。浅色主题原先的 `#8B929B`(2.88) 与 `#C78D55`(2.85) 已判定不合格并替换。

禁止：紫色渐变、大面积发光、玻璃拟态堆叠、SaaS 后台蓝、纯黑 `#000` 大面积背景。

## 3. 字体

- 西文/数字：`Inter Variable`（`@fontsource-variable/inter`，随包发布，不依赖外部 CDN）。
- 中文：`-apple-system` → `PingFang SC` → `Hiragino Sans GB` → `Noto Sans SC`。
- 等宽：`ui-monospace / SF Mono`，用于版本号、日期、计数、代码块。
- 所有数字使用 `tabular-nums`，避免列表抖动。

字阶（编辑式，非线性）：

| 角色 | 规格 |
| --- | --- |
| Hero 主标题 | `clamp(2.45rem, ~7vw, 4.35rem)` / `leading-[1.02]` / `tracking-[-0.038em]` |
| 区块标题 | `1.6rem → 2rem` / `leading-[1.1]` / `tracking-[-0.02em]` |
| 卡片标题 | `15.5px`（精选 `19–21px`） / `leading-snug` |
| 正文 | `13.5–14.5px` / `leading-[1.7]` |
| 说明、元信息 | `11–12.5px` |
| eyebrow | `11px` / `uppercase` / `tracking-[0.16em]` |

中文标题不额外加字距（中文加字距会松散），仅西文与数字使用负字距。

## 4. 间距 / 圆角 / 边框

- 间距：4px 基数（`4/8/12/16/20/24/32/40/56/64/96`），Tailwind 默认刻度即可，不引入新刻度。
- 区块垂直节奏：移动 `py-16`、`sm:py-20`、桌面 `lg:py-24`。
- 圆角：`4px`（小徽章）/ `6px`（按钮、输入）/ `10px`（卡片，**默认**）/ `20px`（仅移动端底部抽屉顶部）。
- 边框：恒为 `1px`。分割线优先用 `Divider` 的渐变淡出，而不是贯穿全宽的实线。
- 阴影：仅两处 —— 移动端底部导航、弹层。都是"向下压"的暗影，不做发光。

## 5. 组件契约

| 组件 | 职责 | 关键约束 |
| --- | --- | --- |
| `Container` | 统一左右留白与最大宽度 | `narrow`/`default`/`wide` 三档；页面不得自带 `px-*` |
| `Button` | 四种变体 × 三种尺寸 | 触控高度 ≥ 36px（`sm` 在移动端由 `min-h-9` 保证），主按钮唯一 |
| `IconButton` | 纯图标操作 | **必须**传 `label`（生成 `aria-label` + `title`）；伪元素把命中区扩到 44px |
| `Badge` / `VersionBadge` | 元信息 | 版本号永远等宽 |
| `Card` | 基础面 | 默认 `rounded-[10px]` + `border-line`；`interactive` 才加悬停 |
| `SearchInput` | 搜索输入 | 受控；`Esc` 清空；`type="search"` 但隐藏原生清除键 |
| `ModuleCard` | 模块展示 | 4 种变体；整卡一个 tab stop（`after:absolute` 拉伸链接），收藏键 `z-10` 独立可点 |
| `CategoryCard` | 分类 | 两种变体（`tile` 网格 / `rail` 横滑） |
| `Modal` | 桌面弹层 | 焦点陷阱 + Esc + 滚动锁 |
| `BottomSheet` | 移动抽屉 | 可下拉关闭；`safe-area-inset-bottom` |
| `Toast` | 操作反馈 | 视觉反馈，不宣称震动 |
| `Skeleton` / `EmptyState` | 加载与空态 | 骨架尺寸必须贴近真实内容，避免抖动 |
| `Reveal` | 滚动入场 | 只包裹区块级元素，禁止逐项 |

## 6. 动效

- 时长 token：`--dur-fast 120ms` / `--dur-base 200ms` / `--dur-slow 420ms` / `--dur-reveal 620ms`。
- 缓动：`cubic-bezier(0.22, 1, 0.36, 1)`（出场减速），不使用弹簧。
- 入场位移：`10–14px`，绝不超过 24px。
- **不使用持续循环动画**（无 ping、无呼吸光、无自动轮播）。
- 只允许三处 framer-motion：Toast、Modal/BottomSheet、SearchPanel。其余全部 CSS。
- 关键正确性约束见 `docs/motion.md`：文档隐藏时动画时钟会冻结，因此所有入场动画必须在 `html[data-motion='off']` 下坍缩为终态，否则页面会永久空白。

## 7. 响应式

| 断点 | 用途 |
| --- | --- |
| `< 640` | 单列；底部 tab bar；横滑分类轨道；卡片单列；详情页吸底操作栏 |
| `640–767` | 两列卡片；Hero 统计区 4 列横排 |
| `768–1023`（iPad 竖屏） | 两列卡片；Hero 统计区 4 列横排；详情页改用行内操作按钮（不再吸底）；顶栏导航仍收起 |
| `≥ 1024` | 顶栏导航出现、底栏隐藏；三列卡片；分类 3×2 网格 |
| `≥ 1280` | Hero 变为双栏 + 右侧统计轨（`xl:`） |
| `≥ 1400` | 容器封顶 1400px，不再拉宽 |

断点职责说明：
- 拖底操作栏只在 `< md (768)` 出现，因为 768 宽度已能放下三个行内按钮而不挤压。
- 顶栏 6 项导航在 768 下会被挤成两行（实测），因此仍在 `lg (1024)` 展开，平板继续使用底栏 + 汉堡式紧凑头部。

规则：移动端不得横向溢出（`overflow-x: clip` + 所有横滑容器自带 `overflow-x-auto`）；所有可点元素 ≥ 44×44px 命中区；底部导航占位由 `main` 的 `pb-14` + `env(safe-area-inset-bottom)` 处理。
