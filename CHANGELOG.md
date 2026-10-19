# 更新日志

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
