# 主题颜色令牌规范（Theme Tokens）

> 幽读渲染层（`src/renderer/src`）所有颜色必须走本规范定义的 CSS 变量，
> 禁止在组件样式中直接写颜色字面量（`#fff` / `rgba(0,0,0,x)` / `color: white` 等）。

---

## 1. 三层边界模型

渲染层颜色分三层，边界清晰、互不越界：

| 层 | 作用范围 | 数据源 | 是否随主题切换 |
|---|---|---|---|
| **应用层** | 书架 / 设置 / 详情 / 订阅等外部 UI | `settingsStore.appThemeColors`（非阅读器路由） | ✅ 跟随应用主题 |
| **阅读器层** | 阅读器内部（正文、富文本、工具栏） | `settingsStore.readerThemeColors`（含显式 `--reader-*`） | ✅ 跟随阅读器主题 |
| **跨主题固定层** | 叠加在不可控媒体之上的浮层 / 遮罩 / 阴影 | `main.css :root` 静态值 | ❌ 刻意固定 |

**路由切换机制**（`App.vue` → `applyThemeVarsToRoot`）：
阅读器路由下，`:root` 的应用层变量会被 **阅读器主题** 覆盖（`activeThemeColors`），
因此阅读器内的组件用 `var(--bg-card)` 等也能拿到阅读器主题色。
显式阅读器令牌（`--reader-*`）仅阅读器路由注入，非阅读器路由会 `removeProperty`。

```
非阅读器路由              阅读器路由
:root { appThemeColors }  :root { readerThemeColors + --reader-* }
```

---

## 2. 命名规则

| 前缀 | 语义 | 示例 |
|---|---|---|
| `--bg-*` | 应用层背景 / 面（surface） | `--bg-base` `--bg-card` `--bg-elevated` |
| `--text-*` | 应用层文字 | `--text-primary` `--text-secondary` |
| `--border-*` | 应用层边框 | `--border-subtle` `--border-default` |
| `--state-*` | 交互状态叠加 | `--state-hover` `--state-active` |
| `--primary*` / `--color-*` | 品牌主色 / 功能色 | `--primary` `--color-danger` |
| `--reader-*` | **阅读器专属**令牌 | `--reader-bg` `--reader-text` |
| `--overlay-*` | **跨主题固定**：叠加于媒体之上的浮层 | `--overlay-surface` `--overlay-text` |
| `--scrim-*` | **跨主题固定**：全屏遮罩 | `--scrim` `--scrim-opaque` |
| `--*-on-media` | **跨主题固定**：媒体叠加材质 | `--shadow-on-media` `--text-shadow-on-media` |

约定：
- 变量名一律小写、连字符分隔、语义化（描述“用途”而非“颜色值”）。
- 新增颜色令牌统一在 `styles/main.css` 的 `:root` 声明默认值（日间 fallback，避免首屏闪烁）；
  随主题变化的令牌再在 `App.vue` 的 `themeVars` 中按 `colors.*` 注入。

---

## 3. 令牌清单

### 3.1 应用层（随主题）

- **品牌**：`--primary` `--primary-hover` `--primary-pressed`
- **背景/面**：`--bg-base`(页面) `--bg-titlebar` `--bg-reader`(阅读底色)
  `--bg-card`(卡片/弹层) `--bg-elevated`(抬高面) `--bg-hover` `--bg-active`
- **主色衍生**：`--bg-primary-active` `--bg-primary-tag` `--bg-primary-overlay` `--bg-primary-badge` `--border-primary` `--shadow-primary`
- **文字**：`--text-primary` `--text-secondary` `--text-tertiary`
  `--text-on-primary`(主色底上的固定白字) `--text-on-color`
- **边框**：`--border-subtle` `--border-default` `--border-interactive`（别名 `--border-color`）
- **交互状态**：`--state-hover` `--state-active` `--state-primary-active`
- **功能色**：`--color-danger` `--color-danger-strong` `--color-success` `--bg-danger-hover`
- **特殊**：`--bg-bar` `--bg-highlight` `--bg-badge` `--bg-badge-hover`
  `--highlight-color-*`（6 种文本高亮）
- **阴影**：`--shadow-card` `--shadow-hover` `--shadow-elevated` `--shadow-menu` `--shadow-bar` `--shadow-card-extra`
- **滚动条**：`--scrollbar-thumb` `--scrollbar-thumb-hover`

### 3.2 阅读器层（随阅读器主题）

| 令牌 | 用途 |
|---|---|
| `--reader-bg` | 阅读器背景（正文底色） |
| `--reader-text` | 阅读器正文文字 |
| `--reader-primary` | 阅读器内链接 / 强调色 |
| `--reader-code-bg` | 富文本代码块 / 引用背景（由 `--reader-text` 派生 5%） |

阅读器内若需要“面 / 边框”语义，直接复用当前路由的应用层令牌
（`--bg-card` / `--border-subtle` 等，阅读器路由下自动为阅读器主题值），
**无需另建** `--reader-surface` / `--reader-border`（避免重复造轮子）。

### 3.3 跨主题固定层（刻意不随主题）⚠️

这些颜色用于**叠加在书封 / 漫画页 / 文章配图等不可控内容之上**。
由于底层内容明暗不可预知，浅色与深色主题都无法保证对比度，
统一采用「深底浅字」固定配色，由 `main.css :root` 静态提供（`themeVars` 不覆盖）。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--scrim` | `rgba(0,0,0,.85)` | 图片灯箱全屏遮罩 |
| `--scrim-opaque` | `rgba(0,0,0,.92)` | 漫画灯箱遮罩（Calibre 式深黑） |
| `--overlay-surface-soft` | `rgba(0,0,0,.45)` | 弱化提示条底 |
| `--overlay-surface` | `rgba(0,0,0,.6)` | 角标 / 页码·缩放指示器 / 悬浮按钮底 |
| `--overlay-surface-hover` | `rgba(0,0,0,.7)` | 悬浮按钮 hover |
| `--overlay-text` | `rgba(255,255,255,.9)` | 浮层主文字 |
| `--overlay-text-strong` | `rgba(255,255,255,1)` | 浮层高亮文字 |
| `--overlay-text-muted` | `rgba(255,255,255,.5)` | 浮层弱化文字 |
| `--overlay-border` | `rgba(255,255,255,.08)` | 浮层描边 |
| `--overlay-border-strong` | `rgba(255,255,255,.1)` | 悬浮按钮描边 |
| `--overlay-control` | `rgba(255,255,255,.15)` | 白色圆形控件底（灯箱关闭按钮） |
| `--overlay-control-hover` | `rgba(255,255,255,.3)` | 白色圆形控件 hover |
| `--overlay-ring` | `rgba(255,255,255,.3)` | 封面角标光圈 |
| `--overlay-ring-strong` | `rgba(255,255,255,.4)` | 封面角标光圈脉动峰值 |
| `--shadow-on-media` | `0 1px 3px rgba(0,0,0,.35)` | 封面角标投影 |
| `--shadow-lightbox` | `0 8px 32px rgba(0,0,0,.5)` | 灯箱图片投影 |
| `--text-shadow-on-media` | `0 1px 2px rgba(0,0,0,.2)` | 封面叠加文字描影 |

---

## 4. 使用示例

### ✅ 正确

```css
/* 应用层：卡片面 + 主文字 + 边框 */
.card { background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border-subtle); }

/* 阅读器层：正文 */
.chapter-end { color: var(--reader-text); }

/* 跨主题固定：浮层胶囊 */
.page-indicator { background: var(--overlay-surface); color: var(--overlay-text); border: 1px solid var(--overlay-border); }

/* 半透明面：保留 alpha 比例 + 跟随主题 */
.overlay { --n-color: color-mix(in srgb, var(--bg-card) 75%, transparent); }

/* 阅读器派生色：由阅读器文字色派生透明度 */
.rich-code { background: var(--reader-code-bg); }
```

### ❌ 禁止

```css
color: #fff;                          /* → var(--text-on-primary) */
background: rgba(0,0,0,.6);           /* → var(--overlay-surface) */
border: 1px solid rgba(255,255,255,.08); /* → var(--overlay-border) */
background: rgba(0,0,0,.85);          /* → var(--scrim) */
box-shadow: 0 1px 3px rgba(0,0,0,.35);   /* → var(--shadow-on-media) */
```

### 透明度写法

需要按主题色计算透明度时，优先使用 `color-mix()`（Electron 44 = Chromium 140+ 已支持）：

```css
/* 保留 15% 不透明度 */
background: color-mix(in srgb, var(--primary) 15%, transparent);
/* 或直接引用已有令牌 */
background: var(--bg-primary-overlay);
```

---

## 5. 允许的例外（必须加注释说明理由）

以下情况可保留颜色字面量，但**必须就近加注释**，避免后人误改：

1. **变量定义处**：`:root` / `themeVars` 中令牌的赋值本身（如 `--text-on-primary: #ffffff`）。
2. **变量 fallback 兜底**：`var(--x, #fff)` 的兜底值，属于防御性默认。
3. **有意的固定色**：如漫画背景三选一（`ComicViewer` 的 `#000` / `#fff`，用户可选）、
   深色灯箱遮罩。**必须写明“有意固定色 / 非主题漂移”**。
4. **中性灰**：`rgba(128,128,128,x)` 等中性灰（Markdown 内容、占位底），
   在深浅主题下均可用，视为跨主题中性材质（保留并注释）。

---

## 6. 硬编码复查

提交前运行：

```bash
rg -n "rgba?\(\s*255\s*,\s*255\s*,\s*255|rgba?\(\s*0\s*,\s*0\s*,\s*0|#fff\b|#000\b" \
  src/renderer/src -g '*.vue' -g '*.css'
```

残留项应仅为：注释文字 / 变量定义 / 变量 fallback / 已注释的有意固定色。
出现其他纯硬编码使用即视为违规。

---

## 7. 回归清单（目视验证）

改色后需在 **浅色主题（day）** 与 **深色主题（night）** 下分别验证：

- [ ] **书架**：封面角标（在读/已读/想读、漫画/图文/小说）、更新红点光圈、失效角标投影
- [ ] **阅读器正文**：文字色、代码块/引用背景（`--reader-code-bg`）
- [ ] **阅读器图片灯箱**：遮罩、关闭按钮、图片投影（ScrollView / PageView）
- [ ] **阅读器富文本**：Markdown 表格/代码块/引用在浅深主题下的对比度
- [ ] **章节目录条（ChapterBar）**：缩略图页码角标
- [ ] **漫画阅读器**：页码/缩放指示器、回到顶部按钮、灯箱信息胶囊（ComicLightbox）
- [ ] **漫画背景三选一**：dark/light/theme 各自的浮层与文字可读性
- [ ] **设置页 / 书籍详情 / 订阅**：主色标签（`--text-on-primary`）、卡片面、边框
- [ ] **模态 / 弹层 / 抽屉**：半透明玻璃质感（`color-mix` + `backdrop-filter`）

---

## 8. 相关源码

| 文件 | 职责 |
|---|---|
| `styles/main.css` | `:root` 默认令牌（含跨主题固定层） |
| `App.vue` | 按路由注入 `themeVars` / `readerVars` |
| `../shared.ts` | `ThemeColors` 类型 + `deriveThemeColors()` 派生 22 个语义令牌 |
| `stores/settings.ts` | `appThemeColors` / `readerThemeColors` 响应式数据源 |