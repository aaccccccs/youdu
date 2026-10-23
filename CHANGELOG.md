# 更新日志

## [0.2.14] - 2026-10-21

汇总 0.2.1–0.2.13 内部迭代的全部变更（中间版本未单独发布，条目中 v40–v50 为代码内版本标记）。

### 新增

- 智能文档分类内核（v40）：三格式统一多级决策树替代 9 维加权评分，输出 文字/图文/扫描版/漫画 四形态并解耦分章方式，阈值经 7 本实测书校准
- 分类反馈闭环：书架右键"标记为 文字/图文/扫描版/漫画"落反馈样本（classification_feedback 表，DB v24），k-NN（K=5）加权投票修正后续导入决策
- 图片型统一渲染路由：ComicViewer 承接漫画/扫描版/图片型 PDF 渲染，书签/搜索/进度导航收口到统一代理层，图片按需加载
- 漫画滚动模式几何精确化（v49）：ChapterImage 携带真实宽高比精确占位，替代原 100vh 固定占位（低估真实页高约 2 倍，致滚动跳动/进度失真）
- image-size 模块：零依赖解析 PNG/JPEG/WebP 文件头获取宽高（只读 128KB 不解码像素），四路图片章节统一生效
- TXT 无章节大文件兜底分章（v41）：超过 30KB 无章节标记的 TXT 按 3000 字/块均分，恢复分章导航与进度条（仅影响新导入）
- GLIBC 2.28 兼容构建链：Debian 10 chroot 源码编译 better-sqlite3 修复 uosV20/deepinV20 启动即崩，afterPack 自动替换进打包产物

### 修复（P0 严重）

- SSRF 重定向逐跳校验：302 自动跟随可绕过校验直达内网元数据地址，改为 redirect: manual 手动循环（最多 5 跳），每跳重新执行 URL 与 DNS Rebinding 校验
- sharp 打包后加载失败（v50）：打包环境改从 app.asar.unpacked 绝对路径加载（createRequire），修复两条压缩链路静默回退写原始数据（.jpg 后缀实为 PNG）
- v25 数据迁移：清理 0.2.5 期间 textOnly 分类采样路径污染的图片型 PDF 章节缓存（仅置 NULL 待重新提取，不丢用户数据）
- 订阅超时竞态：checkUpdate 超时后经 AbortController 停止后台导入写库，超时取消时不再更新 lastGuid（原超时返回但后台继续写 DB）

### 修复（P1 重要）

- PDF worker 池故障退避：区分恢复性重启与真实故障，滑动窗口计数 + 指数退避 500ms→30s，修复失败无限快速重启持续占用 CPU
- 大文件图计数失真（v40）：按二进制扫描覆盖率线性外推图片总数，修复 20MB 扫描上限导致大书计数低估（670 页实测书原算出密度 0.29，真实≈1）
- PDF 图文书双阈值判定（v47）：采样章累计正常字符（CJK+ASCII）/页 ≥300 且乱码率 ≤25% 才走文字渲染，混合质量 OCR 书正确判扫描版走图片渲染
- 漫画滚动/翻页体验（v46-v49）：预加载扩展至 ±4 张/页与 6 屏视口、滚动 85% 提前预拼接下一章、手动跳章重置回新章顶部、空图片列表不再误触发翻章、滚回顶部更易触发上一章拼接
- 扫描页落盘 PNG → WebP（v50，quality 85）：缓存体积约为原 PNG 的 11%（实测 877KB → 100KB），失败回退原始 PNG
- asar 解包修复：asarUnpack 补充 detect-libc/semver（sharp 的 JS 依赖）与 7zip 相关包（CB7 解压需可执行 7za）
- sharp 打包替换时机（v50）：仅在存在 win32 残留时才用 tgz 覆盖，修复 Linux 本机打包双版本 .node 与 libvips 错位致 dlopen 失败、sharp 静默不可用
- pdfjs wasm 解码器兜底：getPdfWasmUrl 新增 app.asar.unpacked 路径，修复 worker CJS 环境 JBIG2/JPX 解码器缺失致扫描版白图

### 修复（其他）

- IPC 输入校验强化：GROUP_REORDER 数组校验、BOOKMARK_UPDATE/HIGHLIGHT_UPDATE 对象校验、SUBSCRIPTION_ADD/ADD_SMART url 校验
- schema.sql v22/v23 变更日志补录（旧书 content_type 修正 / FTS5 清理说明），v13/v15-v17 历史预留号注释澄清
- image-size 测试与 v50 WebP 落盘同步：「全书各页尺寸一致性」用例过滤器兼容 .png/.webp
- 近空白扫描页过滤（v39）：压缩后小于 8KB 的近空白页跳过落盘
- 导入文件过滤器移除 fb2（后端实际不支持该格式）
- sharp 锁定精确版本 0.35.5，避免 minor 漂移引入平台包错位

## [0.2.0] - 2026-09-27

### 修复（P0 严重）

- SVG 文件写入竞态条件：改用 writeFileSync 同步写入，消除 fsPromises.writeFile 未 await 导致的数据丢失风险
- replaceInlineImages XSS 漏洞：文字内容未转义直接拼接 HTML，改为分段 escapeHtml 转义
- 阅读器 loading 状态永久卡死：章节加载 seq 失效时 return 前未重置 loading，补充重置逻辑
- Reader.vue handleSearchJumpTo 未定义：搜索面板跳转事件无处理函数，新增函数复用 jumpToBookmark 时序模式
- onTouchStart.passive 与 preventDefault 冲突：移除 .passive 修饰符，恢复 preventDefault 能力

### 修复（P1 重要）

- 纯文字 PDF 每页截图：增加文本量检测，文本充足时跳过截图
- imageCount 重复计数：删除冗余累加逻辑
- parseMode 无效设置：删除 importer 中冗余的 parseMode 设置
- data URI 处理不一致：统一保留占位标记
- SOCKS5 代理 TCP 粘包：Buffer 累积 + 状态机解析，正确处理分包
- IPv6 SSRF 检查遗漏：补充 fe80::/10 链路本地地址范围检查
- HTTP Host 头错误：改用 targetUrl.host 构造正确 Host 头
- 取消任务时超时清除：保留超时不清除，避免取消后仍触发超时回调
- listBooks/getBooksByContentType 缺少字段：SELECT 补充 intro/custom_meta 字段
- diagnoseMigrations 缺少字段：补充 content_type 字段检查
- 预加载残留：新增 abortPreload 清理未完成的预加载请求
- loadBooks/loadDetail loading 未重置：改为无条件重置 loading
- TABLE 标签 XSS：引入 DOMPurify 消毒 HTML 表格内容
- 两步串行 IPC 调用：改为 Promise.all 并行执行
- onKeyDown 未过滤 input/textarea：键盘快捷键在输入框中误触发，添加焦点元素检查
- rtl 双页页码指示器反了：rtl 模式下调整显示顺序为右-左
- scrollToTop 误触发 request-prev-chapter：添加标志位 + 定时器，跳过滚动到顶部的连续阅读检测
- ArticleView bookId 不响应路由变化：改为 computed + watch 监听路由参数变化
- OpdsBrowser handleSearch 无竞争保护：引入 searchSeq 序号，丢弃过期搜索结果

### 修复（其他）

- schema.sql 版本注释更新为 23
- FILE_FILTERS 补充 fb2 格式支持

### 修复（P2 改进）

- SSRF 补充 224.0.0.0/4 组播、240.0.0.0/4 保留、TEST-NET 等保留地址段检查
- DNS 解析失败改为抛出错误阻止请求继续，消除 DNS Rebinding 风险
- HTTP 非幂等方法（POST/PUT/DELETE）默认不重试，避免重复操作
- IPC handler 补充输入参数校验（9 个关键 handler 涉及文件路径/数据库操作）
- collectExportData N+1 查询改为批量查询，O(N) 降为 O(1)
- ArticleView bindLinks 事件监听器在组件卸载时清理，修复内存泄漏
- useDebounce timer 在组件卸载时自动清理，修复内存泄漏
- 分类器单字关键词误匹配：单字要求右侧为边界，避免"传统"匹配"传"等
- detectLanguage 改为字符比例判断，中文字符占比≥20% 判为中文
- 繁简转换反向映射保留首次出现的常用义
- keydown passive:false 改为 passive:true，减少无谓开销
- Bookshelf onBookshelfRefresh 防御性去重注册
- CBZ 导出选项只在漫画类型书籍中显示
- AddSubscriptionDialog 添加 OPDS 目录后通知 OpdsBrowser 刷新
- Settings loadingMsg 移到 finally 块确保销毁
- customHeaders 用唯一 \_id 替代数组索引作 key
- OPDS facet active 改用属性判断而非 rel.includes
- resolveOpdsUrl 用 URL 构造函数正确处理 .. 路径
- OPDS 2.0 publishedDate 优先使用 published 字段

## [0.1.0] - 2026-09-26

### 新增

- 本地电子书阅读器，支持 TXT/EPUB/MOBI/PDF/CBZ/CBR 格式
- 三种阅读模式：按章显示、无限拼接、翻页模式
- 内容自动分类：小说、图文、漫画
- RSS 订阅功能（RSS 2.0 / Atom）
- OPDS 在线书库浏览
- 多主题、字体、排版自定义
- 繁简转换和智能排版
- 书签和高亮标记
- 全文搜索
- 阅读进度保存（段落索引归一化）

### 优化

- Worker 线程堆内存 1536MB，支持大 PDF 解析
- 任务超时机制（导入 180s / 阅读 60s）
- 图片渐进式加载，$1加载
- 分批渲染（前 30 段 + 滚动追加）
- Deepin 23/25 兼容适配
