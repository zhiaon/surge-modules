# 动效实现与一个必须知道的浏览器行为

## 结论先行

**当文档处于隐藏状态（`document.visibilityState === 'hidden'`）时，动画时钟是冻结的。**
不只是 `requestAnimationFrame` 停止，**CSS transition / animation 也不再推进**。

这带来一个真实故障：一个用 `opacity: 0 → 1` 做入场的元素，如果在隐藏时挂载，它的过渡永远不会前进，元素会**永久停在 `opacity: 0`** —— 页面看起来是空的。这在以下场景都会发生：

- 浏览器后台标签页
- 部分 App 内的 WebView / 离屏渲染
- iOS 预渲染、省电模式
- 截图、自动化预览、SSR 后接管

本项目第一版用 framer-motion 做 Hero 入场，实际就是在这个环境里变成全黑的，因此整套入场机制被重写。

## 现在的机制

### 1. 全局动效开关 —— `src/lib/motionPolicy.ts`

`initMotionPolicy()` 在 `main.tsx` 里、渲染前调用：

```
document.documentElement.dataset.motion = 'off' | 'on'
```

判据：`visibilityState === 'hidden'` **或** `prefers-reduced-motion: reduce`。
监听 `visibilitychange` 与媒体查询变化，实时切换。

### 2. CSS 坍缩 —— `src/styles/index.css`

```
html[data-motion='off'] [data-reveal],
html[data-motion='off'] .enter,
html[data-motion='off'] .enter-hold   →  直接终态（opacity:1, transform:none）

html[data-motion='off'] *               →  transition/animation 时长压到 0.001ms
```

第一条保证内容可见；第二条保证**任意**依赖过渡的属性（导航栏滚动后的背景、配色切换）不会卡在起始帧。

### 3. 滚动入场 —— `src/components/motion/Reveal.tsx`

- 时机：`IntersectionObserver`，`rootMargin: 0px 0px -6% 0px`，只触发一次。
- 表现：CSS `transition`（`--dur-reveal` + `--ease-out-soft`），`data-reveal="out|in"`。
- 兜底 1：`IntersectionObserver` 不存在 → 立即显示。
- 兜底 2：1200ms 后若元素已进入视口仍未触发 → 强制显示（防止观察器被节流饿死）。
- 兜底 3：文档隐藏 / reduced-motion → 挂载即终态，不产生任何过渡。

### 4. Hero 入场 —— `src/hooks/useEnter.ts`

三段状态机：`hidden`（挂载时为 `enter-hold`，仅两帧）→ `playing`（加 `enter`）→ `done`（无类，纯终态）。

若挂载时文档不可见或用户偏好减弱动效，**直接从 `done` 开始**，页面第一帧就是完成态。

### 5. 允许使用 framer-motion 的地方

只有三处，且都是"用户主动触发的浮层"：

| 组件 | 用法 |
| --- | --- |
| `Toast` | 进出场 + `layout` 排队 |
| `Modal` / `BottomSheet` | 面板位移与遮罩淡入，BottomSheet 支持拖拽关闭 |
| `SearchPanel` | 面板位移与遮罩淡入 |

理由：这些只在用户操作后出现，不会造成首屏空白；且组件内部都读取 `useReducedMotion()`，在减弱动效时退化为淡入。

### 6. 已移除的反模式

- Hero 的 `animate-ping` 循环光点（持续动画，无信息量，耗电）。
- 底部导航的 `layoutId` 共享布局指示器（每次切换都触发一次布局动画，收益极低）。
- 逐卡片 `whileInView`（几十个 observer，滚动抖动）。

## 自测清单

1. 打开页面 → 首屏文字必须在第一帧可见（不是淡入后才可见）。
2. 后台切到别的 App 再切回 → 内容不应消失。
3. 系统开启"减弱动态效果" → 无位移动画，内容直接呈现。
4. 滚动到新区域 → 区块轻微上浮，仅一次。
5. 主题切换 → 立刻变色，无卡在中间态。
