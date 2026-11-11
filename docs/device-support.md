# 设备与浏览器适配

## 目标范围

| 设备 | 视口 | 验证方式 |
| --- | --- | --- |
| iPhone | 375 / 390 / 430 | 视口模拟 + CSS 特性检查 |
| iPad | 768 / 820 / 1024 | 视口模拟 |
| Windows | 1366 / 1920 | 视口模拟 |
| macOS | 1280 / 1440 | 视口模拟 |

| 浏览器 | 引擎 | 关键约束 |
| --- | --- | --- |
| Safari（iOS / macOS） | WebKit | `color-mix` 需 16.2+，`dvh` 需 15.4+ |
| Chrome | Blink | `color-mix` 需 111+ |
| Edge | Blink | 同 Chrome |

最低支持基线：**Safari 15 / Chrome 105 / Edge 105**。

---

## 断点策略

| 宽度 | 布局 |
| --- | --- |
| `< 768` | 单列；底部标签栏；Hero 统计 2×2；分类横向轨道 |
| `768–1023`（iPad 竖屏） | **顶部导航**（去掉次要项）；卡片 2 列；底栏隐藏 |
| `1024–1279` | 顶部导航全项；卡片 3 列；分类 3×2 网格 |
| `≥ 1280` | Hero 双栏 + 右侧统计轨 |
| `≥ 1536` | 容器加宽至 1680px |

### 为什么 iPad 用顶部导航

768px 宽时，底栏会遮住内容且浪费垂直空间。顶部导航在 768 能放下 4 个主要项（首页 / 发现 / 收藏 / 更新），分类与关于收进 `lg` 断点。

---

## 兼容处理

### `color-mix()`

用于所有半透明叠加色。需要 Safari 16.2 / Chrome 111。

处理方式：**每个色值声明两次**。

```css
--tint-accent-12: #c9915b1f;                                  /* 兜底 */
--tint-accent-12: color-mix(in oklab, var(--color-accent) 12%, transparent);
```

旧引擎读第一行，新引擎用第二行覆盖。构建产物已验证两行都在。

组件里**不再直接写 `color-mix()`**，全部走 `--tint-*` 变量。这样只需维护一处。

### `100dvh`

`min-h-dvh` 在 iOS 15.3 及更早不支持，用 `@supports not (height: 100dvh)` 回退到 `100vh`。

### `text-wrap: balance / pretty`

Safari 17.5 / Chrome 114+。旧引擎直接忽略，不影响布局；另加 `overflow-wrap: break-word` 保证长标题不溢出。

### `backdrop-filter`

Tailwind 自动输出 `-webkit-backdrop-filter` 前缀，Safari 15 可用。

### 触控目标

```css
@media (pointer: coarse), (any-pointer: coarse) {
  .btn-sm, nav a, nav button, button, .chip {
    min-height: 44px;
    min-width: 44px;
  }
}
```

`any-pointer` 覆盖触屏笔记本（Windows 平板模式）。文本链接通过 `.tap-target` 伪元素扩展命中区，不受 `min-width` 影响。

### 高对比度模式

`@media (forced-colors: active)` 下强制边框可见，因为整个视觉系统靠 1px 线条。

### 字体渲染

`-webkit-font-smoothing: antialiased` 让 Windows 的 ClearType 不过度加粗。

---

## 已验证项

在 iPhone（390）、iPad（820）、Windows（1920）、macOS（1440）四个视口实测：

| 项 | iPhone | iPad | Windows | macOS |
| --- | --- | --- | --- | --- |
| 横向溢出 | 0 | 0 | 0 | 0 |
| 非预期隐藏元素 | 0 | 0 | 0 | 0 |
| 底部栏显示 | 是 | 否 | 否 | 否 |
| 顶部导航 | 隐藏 | 显示 | 显示 | 显示 |
| 区块数 | 6 | 6 | 6 | 6 |

iPad 修复前后对比：

- 修复前：底栏遮挡内容、导航文字换行成两行
- 修复后：底栏消失、导航单行、内容完整

---

## 未验证项（诚实标注）

1. **真实 Safari 16.1 及更早版本**：本环境只有 WebKit（现代版本），只能通过 `@supports` 逻辑推断，未在真实旧引擎上跑过。
2. **Windows 高对比度模式**：写了 `forced-colors` 规则，未在真实系统上验证。
3. **iPad 横屏（1024×768）**：只验证了竖屏 820×1180。
4. **Firefox**：不在目标清单内，未做专门适配（`scrollbar-width` 等标准属性可用）。
5. **IE / 旧 Edge（EdgeHTML）**：不支持，`color-mix` 与 CSS 变量大量使用。

---

## 回归检查清单

改动布局或颜色后，至少确认：

```bash
npm run typecheck
npm test
npm run build
```

然后手动核对：

- [ ] 320px 宽（iPhone SE 旧机型）无横向滚动
- [ ] 768px 下顶部导航不换行
- [ ] 1024px 下从 2 列变 3 列
- [ ] 1920px 下内容不满屏铺开
- [ ] 深色 / 浅色主题下所有半透明色可见
- [ ] 键盘 Tab 能走完所有交互元素
