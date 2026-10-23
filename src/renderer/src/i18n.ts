/**
 * 渲染进程国际化模块（基于 vue-i18n）
 *
 * 导出接口：
 *   - i18n                vue-i18n 实例，由 app.use(i18n) 安装
 *   - setAppLocale(locale) 切换语言并持久化到 localStorage
 *   - getSavedLocale()     读取已保存语言
 *
 * 翻译策略：
 *   - 中文（zh-CN）：894 个键已根据键名推断合理中文
 *   - 英文（en）：894 个键全部翻译完成，与 zh-CN 键结构完全一致
 *   - missingWarn / fallbackWarn 已关闭，缺失键不报警
 *
 * 共 894 个消息键，覆盖书架、书籍详情、阅读器、设置、来源、订阅、OPDS 等全部视图。
 */
import { createI18n } from 'vue-i18n';

/** 受支持的语言 */
type Locale = 'zh-CN' | 'en';

/** localStorage 存储键 */
const STORAGE_KEY = 'youdu-locale';

/** 消息表（嵌套结构，键路径与 t('a.b.c') 对应） */
const messages = {
  'zh-CN': {
    article: {
      actions: {
        openOriginal: '打开原文',
        readSettings: '阅读设置'
      },
      empty: {
        contentPending: '内容加载中…'
      },
      title: '文章'
    },
    bookDetail: {
      chapterFallback: '第 {n} 章',
      chaptersCount: '{n} 章',
      chaptersRatio: '{read}/{total}',
      continueReading: '继续阅读',
      cover: {
        alt: '封面',
        change: '更换封面',
        changeFailed: '更换封面失败：{msg}',
        reset: '重置封面',
        resetDone: '已重置封面',
        resetFailed: '重置封面失败：{msg}',
        updated: '封面已更新'
      },
      deleteBook: {
        confirm: '确定删除「{title}」吗？',
        failed: '删除失败',
        title: '删除书籍'
      },
      errors: {
        invalidId: '无效的书籍 ID',
        loadFailed: '加载失败：{msg}',
        notFound: '书籍不存在',
        partialFailed: '部分数据加载失败：{items}',
        stateHint: '状态异常',
        stateTitle: '状态异常',
        unknownError: '未知错误'
      },
      export: {
        canceled: '导出已取消',
        cbzComic: 'CBZ 漫画',
        done: '{format} 已导出到 {path}',
        failed: '{format} 导出失败：{msg}',
        imageBookHint: '该书为图片型（漫画/扫描版），文字导出内容为空，建议导出源文件或 CBZ',
        label: '导出为 {format}',
        source: '导出源文件',
        sourceDone: '源文件已导出到 {path}',
        sourceFailed: '源文件导出失败：{msg}'
      },
      fields: {
        chapters: '章节',
        intro: '简介',
        introPlaceholder: '暂无简介',
        rating: '评分',
        readingDuration: '阅读时长',
        series: '系列'
      },
      intro: {
        collapse: '收起',
        expand: '展开'
      },
      itemCount: '{n} 项',
      messages: {
        saveFailed: '保存失败'
      },
      noChapters: '无章节',
      noIntro: '暂无简介',
      notRead: '未读',
      rating: {
        setFailed: '评分失败',
        starsTitle: '评 {n} 星'
      },
      series: {
        volumeCount: '第 {n} 卷 / 共 {total} 卷'
      },
      relations: {
        readingHistory: '阅读历史',
        sameAuthor: '同作者作品',
        similarTitle: '相似书目'
      },
      reparse: {
        confirm: '确定重新解析？',
        done: '解析完成，共 {n} 章',
        failed: '解析失败',
        failedWith: '解析失败：{msg}',
        title: '重新解析'
      },
      relocate: {
        body: '原文件已失联。可能是文件被移动/重命名或存储设备未连接',
        failed: '重新定位失败：{msg}',
        fileNotFound: '所选文件不存在或为空',
        mismatch: '所选文件与原书不一致（内容已变化）',
        pathLabel: '原路径：',
        recovered: '已恢复，正在重新打开…',
        select: '选择文件',
        title: '重新定位'
      },
      /** 深度搜索（P2 导入三模式：目录递归按哈希找回原文件） */
      search: {
        failed: '深度搜索失败：{msg}',
        found: '已在 {path} 找到原文件',
        invalidDir: '所选目录不存在或不是文件夹',
        noHash: '本书无内容哈希记录，无法深度搜索',
        notFound: '未在所选目录中找到与本书内容一致的文件',
        timeout: '搜索超时（30 秒），请尝试更小的目录范围',
        title: '在目录中搜索'
      },
      /** 存储模式区（P2 导入三模式：copy↔link 转换工具） */
      storage: {
        convertFailed: '模式转换失败：{msg}',
        convertedLink: '已转为引用模式',
        copied: '已转为复制模式，文件大小 {size}',
        copyDesc: '副本保存在应用数据目录，删除或移动原文件不受影响',
        fileMissing: '原文件已失联，可重新定位或在目录中搜索恢复',
        freed: '已转为引用模式，释放空间 {size}',
        linkDesc: '文件保持在原位置，移动或删除原文件会导致书籍失效（可重新定位恢复）',
        moveDesc: '文件已移入应用数据目录，原目录不再保留此文件',
        title: '存储模式',
        toCopy: '转为复制',
        toLink: '转为引用'
      },
      sections: {
        bookmarks: '书签',
        chapterList: '章节列表',
        chapterPreview: '章节预览',
        daily: '每日阅读',
        progress: '阅读进度',
        recommendations: '推荐',
        related: '相关推荐',
        stats: '阅读统计'
      },
      startReading: '开始阅读',
      stats: {
        chaptersRead: '已读章节',
        completion: '完成度',
        lastPosition: '上次位置',
        notes: '笔记数',
        speed: '阅读速度',
        totalChapters: '总章节',
        totalTime: '总时长',
        wordsPerMinute: '{n} 字/分钟'
      },
      status: {
        setFailed: '状态设置失败'
      },
      title: '书籍详情',
      trend: {
        barTitle: '{date}：{duration}',
        charsBasic: '{n} 字',
        charsThousand: '{n} 千字',
        charsTotal: '共 {chars} 字',
        charsWan: '{n} 万字',
        empty: '暂无阅读记录',
        title: '阅读趋势',
        total: '总计 {duration}'
      },
      validation: {
        titleRequired: '标题不能为空'
      },
      viewAll: '查看全部',
      viewAllN: '查看全部（{n}）'
    },
    bookshelf: {
      batchDeleteConfirm: '确定删除选中的 {n} 本书籍吗？',
      batchDeleteFailed: '批量删除失败',
      batchManage: '批量管理',
      bookDetail: '详情',
      classifiedAs: '已标记为 {type}',
      classify: {
        menu: '标记状态'
      },
      classifyFailed: '标记失败',
      confirmDeleteN: '确定删除选中的 {n} 本书吗？',
      deleteBook: {
        cleanupList: '将删除：书架记录与阅读进度、封面、解析缓存',
        confirm: '确定删除「{title}」吗？',
        deleteSource: '同时删除引用的原文件',
        deleteSourceN: '同时删除引用的原文件（{n} 本）',
        failed: '删除失败',
        linkTitle: '《{title}》（引用模式）',
        title: '删除书籍'
      },
      deletedN: '已删除 {n} 本书',
      deselectAll: '取消全选',
      empty: {
        hint: '拖入文件或点击导入，开始你的阅读之旅',
        importLocal: '导入本地书籍',
        title: '书架空空如也'
      },
      exitBatch: '退出批量',
      export: {
        batchExporting: '正在批量导出 {n} 本…',
        batchSuccess: '批量导出完成（{n} 本）',
        batchWarning: '批量导出完成：成功 {success} 本，失败 {failed} 本。{detail}',
        cbzFailed: 'CBZ 导出失败：{message}',
        epubFailed: 'EPUB 导出失败：{message}',
        exportedTo: '已导出到 {path}',
        exportingCbz: '正在导出 CBZ…',
        exportingEpub: '正在导出 EPUB…',
        exportingSource: '正在导出源文件…',
        exportingTxt: '正在导出 TXT…',
        failedList: '失败：{titles}',
        imageBookHint: '该书为图片型（漫画/扫描版），文字导出内容为空，建议导出源文件或 CBZ',
        sourceFailed: '源文件导出失败：{message}',
        txtFailed: 'TXT 导出失败：{message}'
      },
      exportAs: {
        cbz: '导出为 CBZ',
        epub: '导出为 EPUB',
        source: '导出源文件',
        txt: '导出为 TXT'
      },
      exportBook: '导出',
      foundN: '找到 {n} 本',
      gridView: '网格视图',
      group: {
        createFailed: '创建分组失败',
        created: '分组已创建',
        deleteConfirm: '确定删除分组「{name}」吗？',
        deleteFailed: '删除分组失败',
        deleteTitle: '删除分组',
        deleted: '分组已删除',
        renameFailed: '重命名失败',
        renamed: '已重命名'
      },
      importResult: {
        complete: '导入完成：成功 {success} 本',
        failedN: '{n} 本导入失败',
        failedPart: '，失败 {n} 本',
        skippedDuplicate: '未导入新书：检测到 {n} 本均为书库中已有的重复书籍',
        skippedPart: '，跳过 {n} 本'
      },
      listSeparator: '、',
      listView: '列表视图',
      /** link 书失效角标 title（P2 导入三模式：封面右上角 ⚠ 提示） */
      missingBadge: '原文件已失联，点击查看详情',
      markAs: '标记为',
      markStatusFailed: '标记状态失败',
      markedAs: '已标记为 {status}',
      move: {
        failed: '移动失败',
        orderFailed: '排序失败',
        success: '已移动'
      },
      moveToGroup: '移动到分组',
      noResultsFor: '没有找到「{keyword}」的相关结果',
      removeFromGroup: '移出分组',
      reparse: {
        done: '重新解析完成',
        failed: '重新解析失败',
        failedWith: '解析失败：{msg}',
        loading: '正在重新解析…'
      },
      searchPlaceholder: '搜索书名、作者…',
      selectedPrefix: '已选 ',
      selectedSuffix: ' 本',
      sort: {
        addedAt: '按添加时间',
        ascTitle: '升序',
        descTitle: '降序',
        lastReadAt: '按最近阅读',
        manual: '手动排序',
        updatedAt: '按更新时间'
      },
      title: '书架',
      toggleSidebar: '切换侧栏',
      unknownError: '发生未知错误'
    },
    comic: {
      backToTop: '回到顶部',
      imageLoadError: '图片加载失败',
      noContent: '无内容',
      page: {
        ofTotal: '{current}/{total}',
        short: '{n}'
      },
      transition: {
        chapterEnd: '上一章完',
        nextChapter: '下一章：{title}',
        keepReading: '继续向下滚动阅读',
        lastChapter: '已是最后一章',
        tapToNext: '点击进入下一章'
      },
      thumbnail: {
        generating: '正在生成缩略图…',
        noPages: '无页面',
        pendingPage: '未渲染',
        tabChapters: '章节',
        tabPages: '页'
      },
      viewer: {
        fullscreenImage: '全屏图片',
        hint: '双击缩放 · Ctrl+滚轮缩放 · 拖拽平移 · Esc 关闭',
        saveFailed: '保存失败',
        savePage: '保存当前页',
        saveSuccess: '已保存到 {path}',
        viewFullscreen: '全屏查看原图'
      }
    },
    common: {
      actions: {
        add: '添加',
        all: '全部',
        back: '返回',
        cancel: '取消',
        clearSelection: '清除选择',
        close: '关闭',
        confirm: '确认',
        copy: '复制',
        delete: '删除',
        detail: '详情',
        disable: '禁用',
        download: '下载',
        edit: '编辑',
        enable: '启用',
        export: '导出',
        import: '导入',
        loading: '加载中…',
        loadingMore: '加载更多…',
        more: '更多',
        next: '下一页',
        none: '无',
        open: '打开',
        previous: '上一页',
        rename: '重命名',
        retry: '重试',
        save: '保存',
        saved: '已保存',
        selectAll: '全选'
      },
      appName: '幽读',
      bookType: {
        comic: '漫画',
        illustrated: '图文',
        scan: '扫描版',
        text: '文字'
      },
      duration: {
        days: '{n} 天',
        daysHours: '{d} 天 {h} 小时',
        hours: '{n} 小时',
        hoursMinutes: '{h} 小时 {m} 分',
        minutes: '{n} 分钟',
        seconds: '{n} 秒',
        unread: '未读'
      },
      empty: {
        noData: '暂无数据'
      },
      feedback: {
        deleted: '已删除'
      },
      lang: {
        en: 'English',
        'zh-CN': '简体中文'
      },
      series: {
        volumeOnly: '第 {n} 卷',
        volumeWithSeries: '{series} · 第 {n} 卷'
      },
      status: {
        completed: '已读完',
        dropped: '已弃读',
        reading: '阅读中',
        wantToRead: '想读'
      },
      time: {
        daysAgo: '{n} 天前',
        hoursAgo: '{n} 小时前',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        monthsAgo: '{n} 个月前',
        unread: '未读',
        weeksAgo: '{n} 周前'
      },
      words: {
        article: '文章',
        author: '作者',
        bookFallbackChar: '书',
        group: '分组',
        illustration: '插图',
        status: '状态',
        title: '标题',
        unknown: '未知',
        unknownAuthor: '佚名',
        unknownBook: '未知书籍'
      }
    },
    group: {
      actions: {
        deleteGroup: '删除分组',
        moveDown: '下移',
        moveUp: '上移',
        newGroup: '新建分组'
      },
      aria: {
        group: '分组：{name}',
        groupWithCount: '分组：{name}（{count} 本）'
      },
      createModal: {
        namePlaceholder: '分组名称',
        title: '新建分组'
      },
      filters: {
        allBooks: '全部书籍'
      },
      groups: {
        empty: '暂无分组'
      },
      messages: {
        nameRequired: '名称不能为空'
      },
      renameModal: {
        namePlaceholder: '分组名称',
        title: '重命名分组'
      },
      stats: {
        title: '分组统计',
        totalBooks: '本'
      }
    },
    import: {
      /** 删除确认对话框（批次 v54：link 书删除分流） */
      delete: {
        cleanupList: '将删除：书架记录与阅读进度、封面、解析缓存',
        deleteSource: '同时删除引用的原文件（{n} 本）'
      },
      /** 导入模式确认相（批次 v54 导入三模式：选定即执行，无二次确认） */
      mode: {
        confirm: '开始导入',
        copy: '复制',
        copyDesc: '文件复制到应用数据目录，原文件保留（占用双倍空间）',
        link: '引用',
        linkDesc: '文件保持原位，仅解析目录与图片。移动/删除原文件会导致书籍失效（可重新定位恢复）',
        move: '移动',
        moveDesc: '文件移入应用数据目录（同盘瞬间完成），原目录文件将移走',

        title: '选择导入模式'
      }
    },
    importDlg: {
      backgroundHint: '导入在后台进行',
      backgroundInfo: '你可以继续使用应用，导入完成后会通知你',
      currentFile: '当前文件 {current}/{total}：{name}',
      done: {
        /** 全部跳过专属展示（问题2修复）：successCount=0 且 skippedCount>0 时替代"成功导入 0 本" */
        allSkippedDesc: '检测到 {n} 本均为书库中已有的重复书籍，未重复导入',
        allSkippedTitle: '全部书籍已跳过',
        failed: '{n} 本失败',
        skipped: '{n} 本跳过',
        success: '成功导入 {n} 本'
      },
      doneTitle: '导入完成',
      failedDetails: '失败详情',
      hideToBackground: '转入后台',
      hint: '正在导入书籍…',
      messages: {
        importFailed: '导入失败：{message}',
        selectDirectoryFailed: '选择目录失败：{message}',
        selectFilesFailed: '选择文件失败：{message}'
      },
      moreFailed: '等 {n} 个失败',
      moreSkipped: '等 {n} 个跳过',
      selectDirectory: '选择目录',
      selectFiles: '选择文件',
      skippedDetails: '跳过详情',
      status: {
        failed: '失败',
        hashing: '计算哈希',
        parsing: '解析中',
        skipped: '跳过',
        success: '成功'
      },
      tags: {
        failed: '失败 {n}',
        skipped: '跳过 {n}',
        success: '成功 {n}'
      },
      title: '导入书籍',
      /** 进度相提示（问题3修复）：因"跳过导入方式选择"设置直接使用默认模式时展示 */
      usingDefaultMode: '已使用默认导入模式（{mode}），可在设置中更改'
    },
    item: {
      aria: {
        gridBook: '书籍：{title}，作者：{author}，{time}',
        listBook: '书籍：{title}，作者：{author}，{chapters}，{time}'
      },
      chapters: '{n} 章',
      coverAlt: '封面',
      hasUpdate: '有更新',
      type: {
        novel: '小说'
      },
      unknownChapters: '未知章数'
    },
    opds: {
      builtin: {
        chinaBook: {
          description: '中文电子书书库',
          name: '中书库'
        },
        gutenbergAll: {
          description: 'Project Gutenberg 全部书籍',
          name: '古登堡全部'
        },
        gutenbergChina: {
          description: '古登堡中国相关书籍',
          name: '古登堡中国'
        },
        gutenbergChinese: {
          description: '古登堡中文书籍',
          name: '古登堡中文'
        },
        gutenbergClassical: {
          description: '古典文学作品',
          name: '古登堡古典'
        },
        gutenbergHistory: {
          description: '历史书籍',
          name: '古登堡历史'
        },
        gutenbergPhilosophy: {
          description: '哲学书籍',
          name: '古登堡哲学'
        },
        gutenbergPoetry: {
          description: '诗歌作品',
          name: '古登堡诗歌'
        },
        gutenbergSciFi: {
          description: '科幻小说',
          name: '古登堡科幻'
        },
        wikisourceZh: {
          description: '维基文库中文版',
          name: '维基文库中文'
        }
      },
      dialog: {
        addTitle: '添加书库',
        deleteContent: '确定删除书库「{name}」吗？',
        deleteTitle: '删除书库',
        nameLabel: '名称',
        namePlaceholder: '书库名称',
        passwordLabel: '密码',
        passwordPlaceholder: '可选',
        quickAddTitle: '快速添加',
        urlLabel: '地址',
        urlPlaceholder: 'https://example.com/opds',
        usernameLabel: '用户名',
        usernamePlaceholder: '可选'
      },
      empty: {
        addFirst: '添加书库',
        hint: '添加 OPDS 书库以浏览在线书籍',
        noCatalogs: '暂无书库',
        noContent: '暂无内容',
        recommendedSources: '推荐书库'
      },
      entry: {
        noDownload: '无下载链接',
        unknownAuthor: '佚名'
      },
      messages: {
        addBuiltinFailed: '添加内置书库失败：{msg}',
        addFailed: '添加失败：{msg}',
        browseFailed: '浏览失败：{msg}',
        builtinAdded: '内置书库「{name}」已添加',
        builtinExists: '书库「{name}」已存在',
        catalogAdded: '书库已添加',
        catalogDeleted: '书库已删除',
        deleteFailed: '删除失败：{msg}',
        downloadFailed: '下载失败：{msg}',
        importFailed: '导入失败：{msg}',
        loadFailed: '加载失败：{msg}',
        nameRequired: '名称不能为空',
        noDownloadLink: '无下载链接',
        searchFailed: '搜索失败：{msg}',
        unknownError: '未知错误',
        urlExists: '该地址已存在'
      },
      notify: {
        goToLibrary: '前往书架',
        importedToGroup: '「{name}」已导入到分组「{group}」',
        importedToLibrary: '「{name}」已导入到书架'
      },
      pagination: {
        next: '下一页',
        previous: '上一页'
      },
      searching: '搜索中…',
      sidebar: {
        catalogList: '书库列表',
        deleteCatalog: '删除书库'
      },
      title: 'OPDS 书库'
    },
    readSettings: {
      actions: {
        restoreDefaults: '恢复默认'
      },
      colors: {
        bg: '背景色',
        primary: '主题色',
        text: '文字色'
      },
      comicReadDirection: {
        ltr: '从左到右',
        rtl: '从右到左'
      },
      comicScale: {
        custom: '自定义',
        fitHeight: '适应高度',
        fitScreen: '适应屏幕',
        fitWidth: '适应宽度',
        original: '原始大小',
        smartFit: '智能适应'
      },
      fonts: {
        hei: '黑体',
        kai: '楷体',
        serif: '宋体',
        system: '系统默认'
      },
      groups: {
        comic: '漫画',
        general: '通用',
        text: '文本'
      },
      hints: {
        comicBackground: '默认跟随阅读主题（与主题设置联动）；深黑为竞品黑底范式',
        comicDirection: '漫画阅读方向',
        comicScale: '漫画缩放方式',
        comicCustomScale: '图片宽度占阅读区的百分比，100% 即适应宽度',
        followSystem: '跟随系统主题',
        lineHeight: '行间距',
        noVoice: '无可用语音',
        paragraphSpacing: '段间距',
        smartFormat: '智能排版'
      },
      pageTurnAnimation: {
        curl: '仿真翻页',
        fade: '淡入淡出',
        flip: '翻页',
        none: '无',
        slide: '滑动'
      },
      presets: {
        applied: '已应用预设「{name}」',
        comfortable: '舒适',
        compact: '紧凑',
        eye: '护眼',
        night: '夜间',
        research: '研究'
      },
      px: '{n} px',
      percent: '{n}%',
      sections: {
        comicCustomScale: '自定义缩放',
        customColors: '自定义颜色',
        followSystem: '跟随系统',
        fontFamily: '字体',
        fontSize: '字号',
        lineHeight: '行间距',
        margin: '页边距',
        comicBackground: '背景色',
        pageScale: '页面缩放',
        pageTurnAnimation: '翻页动画',
        pageWidth: '页面宽度',
        paragraphSpacing: '段间距',
        readDirection: '阅读方向',
        smartFormat: '智能排版',
        textConvert: '简繁转换',
        ttsPitch: '语音音调',
        ttsRate: '语音语速',
        voice: '语音'
      },
      textConvert: {
        off: '关闭',
        s2t: '简转繁',
        t2s: '繁转简'
      },
      themes: {
        custom: '自定义',
        day: '日间',
        eye: '护眼',
        night: '夜间',
        parchment: '羊皮纸',
        research: '研究'
      },
      title: '阅读设置',
      tts: {
        autoSelect: '自动选择'
      }
    },
    reader: {
      actions: {
        backToShelf: '返回书架',
        update: '更新'
      },
      autoScroll: {
        speed: '滚动速度',
        start: '开始自动滚动',
        stop: '停止自动滚动'
      },
      bookmark: {
        addFailed: '添加书签失败',
        addSuccess: '已添加书签',
        existsContent: '该书签已存在',
        existsTitle: '书签已存在',
        // A7：图片型书签无可提取文本，content 回填页码预览（Reader.imageBookmarkPreview 消费）
        imagePagePreview: '第 {n} 页（共 {m} 页）',
        updateFailed: '更新书签失败',
        updateSuccess: '书签已更新'
      },
      chapterN: '第 {n} 章',
      chapterProgress: '章节进度 {current}/{total}',
      contextMenu: {
        addBookmark: '添加书签',
        addNote: '添加笔记',
        bookmarkNote: '书签笔记',
        enterFullscreen: '进入全屏',
        exitFullscreen: '退出全屏',
        hideToolbar: '隐藏工具栏',
        highlight: '高亮',
        imageScale: '图片适配',
        readSettings: '阅读设置',
        replaceRule: '替换规则',
        showToolbar: '显示工具栏',
        startAutoScroll: '开始自动滚动',
        stopAutoScroll: '停止自动滚动',
        switchReadMode: '切换为{mode}',
        toc: '目录',
        ttsFromHere: '从此处朗读'
      },
      errors: {
        bookNotFound: '书籍不存在',
        loadBookFailed: '加载书籍失败：{msg}',
        loadChapterFailed: '加载章节失败：{msg}'
      },
      // C-6：link 书失效常驻警示条（RelocateDialog 取消后的重试入口提示）
      fileMissingBanner: '原文件失联，点击重新定位',
      highlight: {
        addFailed: '添加高亮失败',
        addSuccess: '已添加高亮',
        existsContent: '该高亮已存在',
        existsTitle: '高亮已存在',
        updateFailed: '更新高亮失败',
        updateSuccess: '高亮已更新'
      },
      invalidBookId: '无效的书籍 ID',
      loadingChapter: '正在加载章节…',
      noChapters: '无章节内容',
      note: {
        addFailed: '添加笔记失败',
        addSuccess: '已添加笔记',
        colorLabel: '颜色',
        contentLabel: '内容',
        emptyContent: '笔记内容不能为空',
        existsContent: '该笔记已存在',
        existsTitle: '笔记已存在',
        noHighlight: '请先选择文本',
        placeholder: '写下你的笔记…',
        quoteLabel: '原文',
        save: '保存',
        selectFirst: '请先选择文本',
        title: '笔记',
        updateFailed: '更新笔记失败',
        updateSuccess: '笔记已更新'
      },
      progressClickHint: '点击跳转',
      readMode: {
        all: '全书',
        chapter: '按章',
        page: '翻页',
        scroll: '滚动'
      },
      remainingTime: {
        hours: '约 {hours} 小时',
        hoursMinutes: '约 {hours} 时 {minutes} 分',
        lessThanMinute: '不足 1 分钟',
        minutes: '约 {minutes} 分钟'
      },
      replace: {
        addFailed: '添加替换规则失败',
        addSuccess: '已添加替换规则',
        bookMissing: '书籍不存在',
        placeholder: '替换为…',
        quoteLabel: '原文',
        regex: '正则',
        replacementLabel: '替换为',
        save: '保存',
        scopeBook: '本书',
        scopeGlobal: '全局',
        scopeLabel: '范围',
        selectFirst: '请先选择文本',
        title: '替换',
        tooLong: '内容过长',
        varBackslash: '\\\\',
        varCarriageReturn: '\\r',
        varHint: '可用变量',
        varNewline: '\\n',
        varSpace: '\\s',
        varTab: '\\t'
      },
      search: {
        title: '搜索'
      },
      toolbar: {
        addBookmark: '添加书签',
        bookmarkNote: '书签笔记',
        decreaseFont: '缩小字体',
        enterFullscreen: '进入全屏',
        exitFullscreen: '退出全屏',
        hideToolbar: '隐藏工具栏',
        increaseFont: '放大字体',
        readSettings: '阅读设置',
        search: '搜索',
        toc: '目录'
      },
      tts: {
        advanceFailed: '朗读推进失败',
        engineError: '语音引擎错误',
        finishedLastChapter: '已读完最后一章',
        noEngine: '无可用语音引擎',
        notSupported: '不支持语音朗读',
        nothingToRead: '没有可朗读的内容',
        pause: '暂停',
        reachedLastChapter: '已到最后一章',
        progress: '正在朗读 {current}/{total}',
        progressPaused: '已暂停 {current}/{total}',
        resume: '继续',
        selectFirst: '请先选择文本',
        speakingTitle: '正在朗读…',
        start: '开始朗读',
        stop: '停止朗读'
      }
    },
    readerBars: {
      bookmark: {
        ariaExcerpt: '摘录：{text}',
        ariaLabel: '书签：{title} {excerpt} {note} {time}',
        ariaNote: '笔记：{text}',
        confirmDelete: '确定删除吗？',
        confirmDeleteBookmark: '确定删除该书签吗？',
        confirmDeleteHighlight: '确定删除该高亮吗？',
        confirmDeleteNote: '确定删除该笔记吗？',
        deleteFailed: '删除失败',
        editNote: '编辑笔记',
        editTitle: '编辑',
        emptyBookmark: '暂无书签',
        emptyBookmarkHint1: '在阅读时点击工具栏',
        emptyBookmarkHint2: '即可添加书签',
        emptyHighlight: '暂无高亮',
        emptyHighlightHint1: '选中文本后右键',
        emptyHighlightHint2: '即可添加高亮',
        emptyNote: '暂无笔记',
        emptyNoteHint1: '选中文本后右键',
        emptyNoteHint2: '即可添加笔记',
        excerptPlaceholder: '摘录内容',
        fieldExcerpt: '摘录',
        fieldHighlight: '高亮',
        fieldNote: '笔记',
        headerTitle: '书签',
        noExcerpt: '无摘录',
        noHighlight: '无高亮',
        noMatchHint: '未匹配高亮',
        noMatchNote: '未匹配笔记',
        notePlaceholder: '笔记内容',
        panelTitle: '书签面板',
        saveFailed: '保存失败',
        searchPlaceholder: '搜索…',
        tabBookmark: '书签（{n}）',
        tabHighlight: '高亮（{n}）',
        tabNote: '笔记（{n}）'
      },
      chapter: {
        chapterAria: '第 {index} 章：{title}',
        chapterCount: '共 {n} 章',
        chapterN: '第 {n} 章',
        collapseAll: '全部收起',
        collapseDisabledHint: '当前卷保持展开以定位阅读位置',
        comicEpisode: '第 {n} 话',
        expandAll: '全部展开',
        footerProgress: '已读 {current}/{total}',
        noMatch: '无匹配章节',
        normalOrder: '正序',
        reverseOrder: '倒序',
        searchPlaceholder: '搜索章节…',
        title: '目录',
        totalChapters: '共 {n} 章',
        volumeAria: '卷：{title}',
        wordCount: {
          tenThousand: '{n} 万字',
          thousand: '{n} 千字'
        }
      },
      search: {
        clear: '清除',
        hint: '在本书中搜索',
        noResult: '无结果',
        placeholder: '搜索…',
        progress: '已搜索 {done}/{total}',
        summary: '{count} 个结果'
      }
    },
    readerViews: {
      chapterFallback: '第 {n} 章',
      finishedLastChapter: '已读完最后一章',
      lightbox: {
        zoomAlt: '图片'
      },
      page: {
        indicatorLabel: '页'
      },
      scroll: {
        loadingAll: '加载全部…',
        loadingNext: '加载下一批…',
        loadingPrev: '加载上一批…'
      }
    },
    settings: {
      about: {
        authorLabel: '作者',
        copyright: '{app} 版权所有',
        feature1: '支持多种格式',
        feature10: '漫画阅读',
        feature11: 'OPDS 书库',
        feature12: '快捷键',
        feature2: '阅读统计',
        feature3: '自定义主题',
        feature4: '语音朗读',
        feature5: 'RSS 订阅',
        feature6: '笔记高亮',
        feature7: '书签管理',
        feature8: '智能排版',
        feature9: '简繁转换',
        featuresTitle: '特性',
        intro: '幽读是一款轻量级电子书阅读器',
        philosophy: '简洁、专注、可定制',
        philosophyTitle: '设计理念',
        techStackLabel: '技术栈',
        title: '关于 {app}'
      },
      advanced: {
        dataRoot: {
          changeButton: '更改数据目录',
          confirmContent:
            '将把全部书籍数据（书籍文件、封面、数据库）移动到新目录。这是剪切操作：原目录数据会被自动删除，全部转到新目录统一管理。数据量较大（如 30GB）时耗时较长，过程中请勿关闭应用。',
          confirmTitle: '更改数据目录',
          currentDir: '当前数据目录',
          currentDirHint: '书籍、封面与数据库的存储位置',
          doneContent: '数据已迁移到：{path}。\n旧目录数据已自动清理。',
          doneTitle: '迁移完成',
          migrateFailed: '数据迁移失败：{message}',
          migrateHint:
            '更改数据目录会把全部书籍数据移动到新位置（剪切语义，旧目录数据自动删除，全部统一到新目录）。数据量较大时耗时较长，完成后所有页面自动刷新。',
          migrating: '正在迁移数据，请勿关闭应用…',
          restarting: '迁移完成，即将自动重启...',
          title: '数据目录'
        },
        disabled: '已禁用',
        enabled: '已启用',
        network: {
          addHeader: '添加请求头',

          customHeaders: '自定义请求头',
          headerName: '名称',
          headerValue: '值',
          proxy: '代理',
          proxyHost: '代理主机',
          proxyPort: '代理端口',
          retryCount: '重试次数',
          retryCountHint: '失败后重试次数',
          retryDelay: '重试延迟',
          retryDelayHint: '重试间隔（毫秒）',
          saveFailed: '保存失败：{message}',
          timeout: '超时',
          timeoutHint: '请求超时时间（毫秒）',
          timeoutRetry: '超时重试',
          times: '次',
          title: '网络',
          uaPlaceholder: 'User-Agent'
        },
        rules: {
          batchDelete: '批量删除',
          batchDeleteFailed: '批量删除失败',
          batchDeleted: '已删除 {n} 条规则',
          batchDisable: '批量禁用',
          batchDisabled: '已禁用 {n} 条规则',
          batchEnable: '批量启用',
          batchEnabled: '已启用 {n} 条规则',
          batchOpFailed: '批量操作失败',
          confirmDelete: '确定删除该规则吗？',
          confirmDeleteContent: '将删除 {n} 条规则，删除后不可恢复',
          confirmDeleteTitle: '删除规则',
          count: '共 {n} 条',
          deleteFailed: '删除失败',
          deleteMark: '删除标记',
          deleted: '已删除',
          empty: '暂无规则',
          emptyHint: '添加替换规则以批量替换文本',
          hint: '规则用于在阅读时替换文本',
          loadFailed: '加载规则失败',
          mergedNote: '已合并全局与本书规则',
          plainText: '纯文本',
          regex: '正则',
          scopeBook: '本书（#{id}）',
          scopeGlobal: '全局',
          selectedCount: '已选 {n} 条',
          title: '替换规则',
          toggleFailed: '切换失败',
          varBackslash: '\\\\',
          varCarriageReturn: '\\r',
          varHintTail: '等变量',
          varNewline: '\\n',
          varSpace: '\\s',
          varSupport: '支持变量',
          varTab: '\\t'
        }
      },
      appearance: {
        appFollowSystemHint: '应用主题跟随系统',
        appTheme: '应用主题',
        appThemeHint: '选择应用界面主题',
        bgColor: '背景色',
        customColors: '自定义颜色',
        customColorsHint: '「{custom}」主题下可自定义界面颜色',
        followSystem: '跟随系统',
        presets: '预设',
        primaryColor: '主题色',
        readerFollowSystemHint: '阅读主题跟随系统',
        readerTheme: '阅读主题',
        readerThemeHint: '选择阅读界面主题',
        textColor: '文字色'
      },
      data: {
        booksDir: '书籍目录',
        cacheClearFailed: '清除缓存失败',
        cacheClearFailedLog: '清除缓存失败（详见日志）',
        cacheCleared: '已清除 {n} 项缓存',
        cacheDir: '缓存目录',
        clearCache: '清除缓存',
        clearCacheHint: '清除临时缓存',
        coversDir: '封面目录',
        dataDir: '数据目录',
        dataDirHint: '数据存储位置',
        defaultImportMode: '默认导入模式',
        defaultImportModeHint: '导入书籍时的默认存储模式（弹窗确认前仍可临时切换）',
        importModeCopy: '复制（双倍空间）',
        importModeLink: '引用（原文件保持原位）',
        importModeMove: '移动（原目录文件移走）',
        management: '数据管理',

        openDir: '打开',
        openDirFailed: '打开目录失败',
        redetect: '重新检测',
        redetectButton: '重新检测书籍',
        redetectDone: '重新检测完成：共 {total} 本，识别出漫画 {comic} 本',
        redetectDonePartial: '重新检测完成（部分失败）：成功 {success} 本，失败 {fail} 本，识别出漫画 {comic} 本',
        redetectFailed: '重新检测失败',
        redetectHint: '重新检测所有书籍的元数据',
        redetectLoading: '正在重新检测 {current}/{total}…',
        redetectNone: '没有需要重新检测的书籍',
        redetectProgress: '正在检测 {current}/{total}：{title}',
        /** 跳过导入方式选择开关（问题3修复） */
        skipImportModeDialog: '跳过导入方式选择',
        skipImportModeDialogHint: '开启后导入直接使用默认模式，不再弹出方式选择'
      },
      reclassify: {
        /** 批量重新分类（任务40）：全库 PDF 多维信号重判分类标签 */
        cancelButton: '取消',
        changesTitle: '变更明细（{n} 本）',
        cancelled: '已取消重新分类：完成 {processed} 本，变更 {changed} 本',
        done: '重新分类完成：共处理 {processed} 本，变更 {changed} 本',
        donePartial: '重新分类完成（部分失败）：变更 {changed} 本，失败 {failed} 本',
        failed: '批量重新分类失败：{message}',
        hint: '使用多维特征（元数据/书签/图片颜色）重新判定全部 PDF 书籍的分类标签；不会重新分章、不影响阅读进度',
        label: '重新判定全部 PDF 书籍分类',
        noBooks: '没有可重检的 PDF 书籍',
        progressText: '正在重检 {current}/{total}',
        startButton: '开始重新分类',
        summary: '处理 {processed} 本，变更 {changed} 本，跳过 {skipped} 本，失败 {failed} 本',
        title: '批量重新分类'
      },
      fonts: {
        hei: '黑体',
        kai: '楷体',
        serif: '宋体',
        system: '系统默认'
      },
      general: {
        language: '语言',
        languageHint: '切换界面语言',
        notifications: '通知',
        readingReminder: '阅读提醒',
        readingReminderHint: '定时提醒你读书',
        reminderTime: '提醒时间',
        reminderTimeHint: '每天此时提醒',
        rssUpdate: 'RSS 更新通知',
        rssUpdateHint: 'RSS 有新文章时通知',
        saveFailed: '保存失败',
        shortcutHint: '快捷键说明',
        shortcutSettings: '快捷键设置'
      },
      loadSettingsFailed: '加载设置失败',
      localeSwitched: '语言已切换',
      reading: {
        autoScroll: '自动滚动',
        autoScrollSpeed: '滚动速度',
        autoScrollSpeedHint: '自动滚动速度',
        comicBgDark: '深黑',
        comicBgLight: '浅白',
        comicBgTheme: '跟随阅读主题',
        comicBackground: '漫画背景色',
        comicBackgroundHint: '深黑为竞品通用黑底；浅白与白页融合更整体，但页边界可能模糊',
        comicSection: '漫画阅读',
        convertOff: '关闭',
        convertS2T: '简体 → 繁体',
        convertT2S: '繁体 → 简体',
        directionLtr: '从左到右',
        directionRtl: '从右到左',
        fontFamily: '字体',
        fontFamilyHint: '阅读字体',
        fontSize: '字号',
        fontSizeHint: '字体大小',
        layout: '版式',
        lineHeight: '行间距',
        lineHeightHint: '行间距倍数',
        pageTurn: '翻页',
        pageTurnDirection: '翻页方向',
        pageTurnDirectionHint: '翻页方向',
        pageWidth: '页面宽度',
        pageWidthHint: '页面宽度比例',
        reset: '恢复默认',
        resetDone: '已恢复默认',
        smartFormat: '智能排版',
        smartFormatHint: '自动清理排版',
        tapTurn: '点击翻页',
        tapTurnHint: '点击屏幕翻页',
        tapTurnZone: '翻页区域',
        tapTurnZoneHint: '点击翻页的触发区域',
        textConvert: '简繁转换',
        textConvertHint: '简体与繁体转换',
        zoneBottom: '底部',
        zoneFull: '全屏',
        zoneLeftRight: '左右两侧'
      },
      shortcuts: {
        clear: '清除',
        cleared: '已清除',
        closeReader: '关闭阅读',
        modalHint: '点击下方按键重新绑定',
        modalTitle: '快捷键设置',
        nextChapter: '下一章',
        nextPage: '下一页',
        notSet: '未设置',
        pressKey: '请按键',
        prevChapter: '上一章',
        prevPage: '上一页',
        resetDone: '已恢复默认',
        resetToDefault: '恢复默认',
        spaceHint:
          '提示：翻页等动作可直接绑定为空格键（如将“下一页”设为 Space）；RTL 漫画中方向键按物理方向反转（Mihon 惯例），空格恒为阅读前进。',
        spaceKey: '空格',
        toggleBookmark: '添加/移除书签',
        toggleFullscreen: '全屏切换',
        toggleSearch: '搜索',
        toggleTTS: '语音朗读',
        updated: '快捷键已更新'
      },
      stats: {
        cellTitle: '{date}：{duration}',
        charsValue: '{n} 字',
        daysValue: '{n} 天',
        duration: {
          days: '{n} 天',
          daysHours: '{d} 天 {h} 小时',
          hours: '{n} 小时',
          hoursMinutes: '{h} 时 {m} 分',
          minutes: '{n} 分钟',
          zero: '0 分钟'
        },
        empty: '暂无阅读记录',
        emptyHint: '开始阅读后这里会显示统计',
        heatmapLess: '少',
        heatmapMore: '多',
        heatmapTitle: '近 {n} 天阅读热力图',
        loadFailed: '加载统计失败',
        sessionsValue: '{n} 次',
        speed: '阅读速度',
        speedValue: '{n} 字/分',
        streak: '连续阅读',
        thisMonth: '本月',
        thisWeek: '本周',
        today: '今天',
        topBooks: '常读书目',
        totalChars: '总字数',
        totalDuration: '总时长',
        totalSessions: '总次数'
      },
      tabs: {
        about: '关于',
        advanced: '高级',
        appearance: '外观',
        data: '数据',
        general: '通用',
        reading: '阅读',
        stats: '统计'
      },
      themes: {
        custom: '自定义',
        day: '日间',
        eye: '护眼',
        night: '夜间',
        parchment: '羊皮纸',
        research: '研究'
      },
      title: '设置'
    },
    shell: {
      dropZone: {
        andMore: ' 等 {count} 个',
        listSeparator: '、',
        releaseToImport: '释放以导入',
        supportedFormats: '支持的格式',
        unsupportedSkipped: '已跳过不支持的文件：{names}{suffix}'
      },
      nav: {
        library: '书架',
        settings: '设置',
        sources: '来源'
      },
      titleBar: {
        backToLibrary: '返回书架',
        maximize: '最大化',
        minimize: '最小化',
        restore: '还原'
      }
    },
    sources: {
      addCatalog: '添加书库',
      addSubscription: '添加订阅',
      bookCount: '{n} 本书',
      checkAll: '全部检查',
      checkAllFailed: '全部检查失败：{message}',
      checkDoneBooks: '检查完成：{n} 本有更新',
      checkDoneNone: '没有新更新',
      checkFailed: '检查失败：{error}',
      checkUpdateFailed: '检查更新失败：{message}',
      checkingAll: '正在检查…',
      clearMarkFailed: '清除标记失败：{message}',
      clearedAllMarks: '已清除全部标记',
      confirmDelete: '确定删除吗？',
      coverAlt: '封面',
      deleteConfirmContent: '删除后不可恢复',
      deleteConfirmTitle: '删除',
      deleteFailed: '删除失败：{message}',
      deleteSuccess: '已删除',
      empty: {
        addFirst: '添加一个',
        hint: '添加 RSS 订阅或 OPDS 书库',
        title: '暂无来源'
      },
      foundNewItems: '「{name}」发现 {n} 条新内容',
      markAllRead: '全部标记已读',
      markRead: '标记已读',
      markedRead: '已标记已读',
      noNewItems: '「{name}」没有新内容',
      searchPlaceholder: '搜索…',
      tabs: {
        opds: 'OPDS',
        rss: 'RSS'
      },
      toggleFailed: '切换失败：{message}',
      unknownAuthor: '佚名',
      unknownError: '未知错误',
      updatedBooksTitle: '有更新的书籍'
    },
    subscription: {
      actionFailed: '操作失败：{message}',
      addTitle: '添加订阅',
      added: '已添加',
      autoImportHint: '有新内容时自动导入',
      autoImportLabel: '自动导入',
      bookCount: '{n} 本',
      browse: '浏览',
      browseTitle: '浏览内容',
      checkUpdate: '检查更新',
      contentAdded: '「{name}」内容已添加{suffix}',
      contentBook: '书籍',
      contentNovel: '小说',
      contentSuffix: '（{type}）',
      daysAgo: '{n} 天前',
      defaultFolderName: '文件夹',
      defaultName: '订阅',
      disabled: '已禁用',
      editTitle: '编辑订阅',
      enabled: '已启用',
      hoursAgo: '{n} 小时前',
      intervalLabel: '更新间隔',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      nameLabel: '名称',
      namePlaceholderAuto: 'RSS 订阅名称',
      namePlaceholderFolder: '文件夹订阅名称',
      neverChecked: '从未检查',
      opdsAdded: 'OPDS「{name}」已添加',
      opdsCatalog: 'OPDS 书库',
      presets: {
        categories: {
          literature: '文学',
          news: '新闻',
          science: '科学',
          techBlogs: '技术博客'
        },
        names: {
          bbcChinese: 'BBC 中文',
          coolshell: '酷壳',
          doubanReviews: '豆瓣书评',
          guokr: '果壳',
          hackerNews: 'Hacker News',
          qianxin: '奇安信',
          quanta: '量子位',
          reutersWorld: '路透社',
          ruanyifeng: '阮一峰',
          singleReading: '单向阅读',
          solidot: 'Solidot',
          techCrunch: 'TechCrunch',
          zhihuDaily: '知乎日报'
        }
      },
      presetsTitle: '推荐订阅',
      selectFolderFailed: '选择文件夹失败：{message}',
      typeAuto: '自动',
      typeFolder: '文件夹',
      typeLabel: '类型',
      updated: '已更新',
      updatesBadge: '{n} 条更新',
      updatesInline: '{n} 条新内容',
      urlLabel: '地址',
      urlPlaceholderAuto: 'https://example.com/rss',
      urlPlaceholderFolder: 'https://example.com/feed',
      urlPlaceholderRss: 'RSS 地址'
    }
  },
  en: {
    article: {
      actions: {
        openOriginal: 'Open original',
        readSettings: 'Reading settings'
      },
      empty: {
        contentPending: 'Loading content…'
      },
      title: 'Article'
    },
    bookDetail: {
      chapterFallback: 'Chapter {n}',
      chaptersCount: '{n} chapters',
      chaptersRatio: '{read}/{total}',
      continueReading: 'Continue reading',
      cover: {
        alt: 'Cover',
        change: 'Change cover',
        changeFailed: 'Failed to change cover: {msg}',
        reset: 'Reset cover',
        resetDone: 'Cover reset',
        resetFailed: 'Failed to reset cover: {msg}',
        updated: 'Cover updated'
      },
      deleteBook: {
        confirm: 'Delete "{title}"?',
        failed: 'Delete failed',
        title: 'Delete book'
      },
      errors: {
        invalidId: 'Invalid book ID',
        loadFailed: 'Failed to load: {msg}',
        notFound: 'Book not found',
        partialFailed: 'Some data failed to load: {items}',
        stateHint: 'Abnormal status',
        stateTitle: 'Abnormal status',
        unknownError: 'Unknown error'
      },
      export: {
        canceled: 'Export canceled',
        cbzComic: 'CBZ comic',
        done: '{format} exported to {path}',
        failed: '{format} export failed: {msg}',
        imageBookHint:
          'This book is image-based (comic/scan); text export would be empty. Export the source file or CBZ instead.',
        label: 'Export as {format}',
        source: 'Export source file',
        sourceDone: 'Source file exported to {path}',
        sourceFailed: 'Source file export failed: {msg}'
      },
      fields: {
        chapters: 'Chapters',
        intro: 'Introduction',
        introPlaceholder: 'No introduction yet',
        rating: 'Rating',
        readingDuration: 'Reading time',
        series: 'Series'
      },
      intro: {
        collapse: 'Collapse',
        expand: 'Expand'
      },
      itemCount: '{n} items',
      messages: {
        saveFailed: 'Save failed'
      },
      noChapters: 'No chapters',
      noIntro: 'No introduction yet',
      notRead: 'Unread',
      rating: {
        setFailed: 'Failed to rate',
        starsTitle: 'Rate {n} stars'
      },
      series: {
        volumeCount: 'Vol. {n} of {total}'
      },
      relations: {
        readingHistory: 'Reading history',
        sameAuthor: 'More from this author',
        similarTitle: 'Similar books'
      },
      reparse: {
        confirm: 'Reparse this book?',
        done: 'Parsing complete: {n} chapters',
        failed: 'Parsing failed',
        failedWith: 'Parsing failed: {msg}',
        title: 'Reparse'
      },
      relocate: {
        body: 'The original file is missing — it may have been moved/renamed, or the storage device is disconnected. Select the book file to recover (content must match).',
        failed: 'Relocation failed: {msg}',
        fileNotFound: 'The selected file does not exist',
        mismatch: 'The selected file does not match the original book (content differs)',
        pathLabel: 'Original path',
        recovered: 'Recovered, reopening the book',
        select: 'Select File',
        title: 'Relocate'
      },
      search: {
        failed: 'Deep search failed: {msg}',
        found: 'Original file found at {path}',
        invalidDir: 'The selected directory does not exist or is not a folder',
        noHash: 'This book has no content hash, deep search is unavailable',
        notFound: 'No file matching this book was found in the selected directory',
        timeout: 'Search timed out (30s) — try a narrower directory',
        title: 'Search in Directory'
      },
      storage: {
        convertFailed: 'Mode conversion failed: {msg}',
        convertedLink: 'Converted to link mode',
        copied: 'Converted to copy mode, file size {size}',
        copyDesc: 'A copy is stored in the app data directory; deleting or moving the original has no effect',
        fileMissing: 'The original file is missing — relocate or search a directory to recover',
        freed: 'Converted to link mode, freed {size}',
        linkDesc:
          'The file stays in its original location; moving or deleting it makes the book unavailable (recoverable by relocating)',
        moveDesc: 'The file has been moved into the app data directory; no copy remains in the original folder',
        title: 'Storage Mode',
        toCopy: 'Convert to Copy',
        toLink: 'Convert to Link'
      },
      sections: {
        bookmarks: 'Bookmarks',
        chapterList: 'Chapter list',
        chapterPreview: 'Chapter preview',
        daily: 'Daily reading',
        progress: 'Reading progress',
        recommendations: 'Recommendations',
        related: 'Related recommendations',
        stats: 'Reading statistics'
      },
      startReading: 'Start reading',
      stats: {
        chaptersRead: 'Chapters read',
        completion: 'Completion',
        lastPosition: 'Last position',
        notes: 'Notes',
        speed: 'Reading speed',
        totalChapters: 'Total chapters',
        totalTime: 'Total time',
        wordsPerMinute: '{n} chars/min'
      },
      status: {
        setFailed: 'Failed to set status'
      },
      title: 'Book details',
      trend: {
        barTitle: '{date}: {duration}',
        charsBasic: '{n} chars',
        charsThousand: '{n}k chars',
        charsTotal: '{chars} in total',
        charsWan: '{k}k chars',
        empty: 'No reading records yet',
        title: 'Reading trend',
        total: 'Total: {duration}'
      },
      validation: {
        titleRequired: 'Title cannot be empty'
      },
      viewAll: 'View all',
      viewAllN: 'View all ({n})'
    },
    bookshelf: {
      batchDeleteConfirm: 'Delete the {n} selected books?',
      batchDeleteFailed: 'Batch delete failed',
      batchManage: 'Batch manage',
      bookDetail: 'Details',
      classifiedAs: 'Marked as {type}',
      classify: {
        menu: 'Mark status'
      },
      classifyFailed: 'Failed to mark',
      confirmDeleteN: 'Delete the {n} selected books?',
      deleteBook: {
        cleanupList: 'Will remove: bookshelf record with reading progress, cover, parse cache',
        confirm: 'Delete "{title}"?',
        deleteSource: 'Also delete the referenced original file',
        deleteSourceN: 'Also delete the referenced original file(s) ({n})',
        failed: 'Delete failed',
        linkTitle: '"{title}" (linked)',
        title: 'Delete book'
      },
      deletedN: 'Deleted {n} books',
      deselectAll: 'Deselect all',
      empty: {
        hint: 'Drag in files or click to import, and start your reading journey',
        importLocal: 'Import local books',
        title: 'Your bookshelf is empty'
      },
      exitBatch: 'Exit batch mode',
      export: {
        batchExporting: 'Batch exporting {n} books…',
        batchSuccess: 'Batch export complete ({n} books)',
        batchWarning: 'Batch export complete: {success} succeeded, {failed} failed. {detail}',
        cbzFailed: 'CBZ export failed: {message}',
        epubFailed: 'EPUB export failed: {message}',
        exportedTo: 'Exported to {path}',
        exportingCbz: 'Exporting CBZ…',
        exportingEpub: 'Exporting EPUB…',
        exportingSource: 'Exporting source file…',
        exportingTxt: 'Exporting TXT…',
        failedList: 'Failed: {titles}',
        imageBookHint:
          'This book is image-based (comic/scan); text export would be empty. Export the source file or CBZ instead.',
        sourceFailed: 'Source file export failed: {message}',
        txtFailed: 'TXT export failed: {message}'
      },
      exportAs: {
        cbz: 'Export as CBZ',
        epub: 'Export as EPUB',
        source: 'Export source file',
        txt: 'Export as TXT'
      },
      exportBook: 'Export',
      foundN: '{n} books found',
      gridView: 'Grid view',
      group: {
        createFailed: 'Failed to create group',
        created: 'Group created',
        deleteConfirm: 'Delete the group "{name}"?',
        deleteFailed: 'Failed to delete group',
        deleteTitle: 'Delete group',
        deleted: 'Group deleted',
        renameFailed: 'Rename failed',
        renamed: 'Renamed'
      },
      importResult: {
        complete: 'Import complete: {success} succeeded',
        failedN: '{n} books failed to import',
        failedPart: ', {n} failed',
        skippedDuplicate: 'No new books imported: {n} duplicate book(s) already in your library',
        skippedPart: ', {n} skipped'
      },
      listSeparator: ', ',
      listView: 'List view',
      /** link 书失效角标 title（P2 导入三模式：封面右上角 ⚠ 提示） */
      missingBadge: 'Original file is missing — click for details',
      markAs: 'Mark as',
      markStatusFailed: 'Failed to mark status',
      markedAs: 'Marked as {status}',
      move: {
        failed: 'Move failed',
        orderFailed: 'Failed to reorder',
        success: 'Moved'
      },
      moveToGroup: 'Move to group',
      noResultsFor: 'No results found for "{keyword}"',
      removeFromGroup: 'Remove from group',
      reparse: {
        done: 'Reparse complete',
        failed: 'Reparse failed',
        failedWith: 'Parsing failed: {msg}',
        loading: 'Reparsing…'
      },
      searchPlaceholder: 'Search by title or author…',
      selectedPrefix: 'Selected',
      selectedSuffix: 'books',
      sort: {
        addedAt: 'By date added',
        ascTitle: 'Ascending',
        descTitle: 'Descending',
        lastReadAt: 'By last read',
        manual: 'Manual order',
        updatedAt: 'By date updated'
      },
      title: 'Bookshelf',
      toggleSidebar: 'Toggle sidebar',
      unknownError: 'An unknown error occurred'
    },
    comic: {
      backToTop: 'Back to top',
      imageLoadError: 'Failed to load image',
      noContent: 'No content',
      page: {
        ofTotal: '{current}/{total}',
        short: '{n}'
      },
      transition: {
        chapterEnd: 'End of chapter',
        nextChapter: 'Next: {title}',
        keepReading: 'Keep scrolling to continue',
        lastChapter: 'No more chapters',
        tapToNext: 'Tap to enter the next chapter'
      },
      thumbnail: {
        generating: 'Generating thumbnails…',
        noPages: 'No pages',
        pendingPage: 'Not rendered',
        tabChapters: 'Chapters',
        tabPages: 'Pages'
      },
      viewer: {
        fullscreenImage: 'Fullscreen image',
        hint: 'Double-click to zoom · Ctrl+Wheel to zoom · Drag to pan · Esc to close',
        saveFailed: 'Save failed',
        savePage: 'Save this page',
        saveSuccess: 'Saved to {path}',
        viewFullscreen: 'View full-size image'
      }
    },
    common: {
      actions: {
        add: 'Add',
        all: 'All',
        back: 'Back',
        cancel: 'Cancel',
        clearSelection: 'Clear selection',
        close: 'Close',
        confirm: 'Confirm',
        copy: 'Copy',
        delete: 'Delete',
        detail: 'Details',
        disable: 'Disable',
        download: 'Download',
        edit: 'Edit',
        enable: 'Enable',
        export: 'Export',
        import: 'Import',
        loading: 'Loading…',
        loadingMore: 'Loading more…',
        more: 'More',
        next: 'Next page',
        none: 'None',
        open: 'Open',
        previous: 'Previous page',
        rename: 'Rename',
        retry: 'Retry',
        save: 'Save',
        saved: 'Saved',
        selectAll: 'Select all'
      },
      appName: 'Youdu',
      bookType: {
        comic: 'Comic',
        illustrated: 'Illustrated book',
        scan: 'Scanned book',
        text: 'Plain text'
      },
      duration: {
        days: '{n} days',
        daysHours: '{d} days {h} hours',
        hours: '{n} hours',
        hoursMinutes: '{h} hours {m} min',
        minutes: '{n} minutes',
        seconds: '{n} seconds',
        unread: 'Unread'
      },
      empty: {
        noData: 'No data yet'
      },
      feedback: {
        deleted: 'Deleted'
      },
      lang: {
        en: 'English',
        'zh-CN': 'Simplified Chinese'
      },
      series: {
        volumeOnly: 'Vol. {n}',
        volumeWithSeries: '{series} · Vol. {n}'
      },
      status: {
        completed: 'Completed',
        dropped: 'Dropped',
        reading: 'Reading',
        wantToRead: 'Want to read'
      },
      time: {
        daysAgo: '{n} days ago',
        hoursAgo: '{n} hours ago',
        justNow: 'Just now',
        minutesAgo: '{n} minutes ago',
        monthsAgo: '{n} months ago',
        unread: 'Unread',
        weeksAgo: '{n} weeks ago'
      },
      words: {
        article: 'Article',
        author: 'Author',
        bookFallbackChar: 'Book',
        group: 'Group',
        illustration: 'Illustration',
        status: 'Status',
        title: 'Title',
        unknown: 'Unknown',
        unknownAuthor: 'Anonymous',
        unknownBook: 'Unknown book'
      }
    },
    group: {
      actions: {
        deleteGroup: 'Delete group',
        moveDown: 'Move down',
        moveUp: 'Move up',
        newGroup: 'New group'
      },
      aria: {
        group: 'Group: {name}',
        groupWithCount: 'Group: {name} ({count} books)'
      },
      createModal: {
        namePlaceholder: 'Group name',
        title: 'New group'
      },
      filters: {
        allBooks: 'All books'
      },
      groups: {
        empty: 'No groups yet'
      },
      messages: {
        nameRequired: 'Name cannot be empty'
      },
      renameModal: {
        namePlaceholder: 'Group name',
        title: 'Rename group'
      },
      stats: {
        title: 'Group statistics',
        totalBooks: 'books'
      }
    },
    import: {
      delete: {
        cleanupList: 'Will remove: bookshelf record with reading progress, cover, parse cache',
        deleteSource: 'Also delete the referenced original file(s) ({n})'
      },
      mode: {
        confirm: 'Start Import',
        copy: 'Copy',
        copyDesc: 'Copy files into the app data directory; originals kept (uses double disk space)',
        link: 'Link',
        linkDesc:
          'Keep files in place; only catalog and images are parsed. Moving/deleting the source makes the book unavailable (recoverable by relocating)',
        move: 'Move',
        moveDesc: 'Move files into the app data directory (instant on same drive); originals will be moved away',

        title: 'Choose Import Mode'
      }
    },
    importDlg: {
      backgroundHint: 'Importing in the background',
      backgroundInfo: 'You can keep using the app; you will be notified when the import completes',
      currentFile: 'Current file {current}/{total}: {name}',
      done: {
        allSkippedDesc: 'All {n} book(s) detected are duplicates already in your library; nothing was imported again',
        allSkippedTitle: 'All books skipped',
        failed: '{n} failed',
        skipped: '{n} skipped',
        success: '{n} books imported successfully'
      },
      doneTitle: 'Import complete',
      failedDetails: 'Failure details',
      hideToBackground: 'Move to background',
      hint: 'Importing books…',
      messages: {
        importFailed: 'Import failed: {message}',
        selectDirectoryFailed: 'Failed to select directory: {message}',
        selectFilesFailed: 'Failed to select files: {message}'
      },
      moreFailed: 'and {n} more failed',
      moreSkipped: 'and {n} more skipped',
      selectDirectory: 'Select directory',
      selectFiles: 'Select files',
      skippedDetails: 'Skipped details',
      status: {
        failed: 'Failed',
        hashing: 'Hashing',
        parsing: 'Parsing',
        skipped: 'Skipped',
        success: 'Success'
      },
      tags: {
        failed: 'Failed {n}',
        skipped: 'Skipped {n}',
        success: 'Success {n}'
      },
      title: 'Import books',
      usingDefaultMode: 'Using default import mode ({mode}). Change it in Settings.'
    },
    item: {
      aria: {
        gridBook: 'Book: {title}, by {author}, {time}',
        listBook: 'Book: {title}, by {author}, {chapters}, {time}'
      },
      chapters: '{n} chapters',
      coverAlt: 'Cover',
      hasUpdate: 'Update available',
      type: {
        novel: 'Novel'
      },
      unknownChapters: 'Unknown number of chapters'
    },
    opds: {
      builtin: {
        chinaBook: {
          description: 'Library of Chinese e-books',
          name: 'China Library'
        },
        gutenbergAll: {
          description: 'All books from Project Gutenberg',
          name: 'Gutenberg All'
        },
        gutenbergChina: {
          description: 'Project Gutenberg books about China',
          name: 'Gutenberg China'
        },
        gutenbergChinese: {
          description: 'Project Gutenberg books in Chinese',
          name: 'Gutenberg Chinese'
        },
        gutenbergClassical: {
          description: 'Classic literature',
          name: 'Gutenberg Classics'
        },
        gutenbergHistory: {
          description: 'History books',
          name: 'Gutenberg History'
        },
        gutenbergPhilosophy: {
          description: 'Philosophy books',
          name: 'Gutenberg Philosophy'
        },
        gutenbergPoetry: {
          description: 'Poetry works',
          name: 'Gutenberg Poetry'
        },
        gutenbergSciFi: {
          description: 'Science fiction',
          name: 'Gutenberg Sci-Fi'
        },
        wikisourceZh: {
          description: 'Chinese edition of Wikisource',
          name: 'Chinese Wikisource'
        }
      },
      dialog: {
        addTitle: 'Add catalog',
        deleteContent: 'Delete the catalog "{name}"?',
        deleteTitle: 'Delete catalog',
        nameLabel: 'Name',
        namePlaceholder: 'Catalog name',
        passwordLabel: 'Password',
        passwordPlaceholder: 'Optional',
        quickAddTitle: 'Quick add',
        urlLabel: 'URL',
        urlPlaceholder: 'https://example.com/opds',
        usernameLabel: 'Username',
        usernamePlaceholder: 'Optional'
      },
      empty: {
        addFirst: 'Add a catalog',
        hint: 'Add an OPDS catalog to browse online books',
        noCatalogs: 'No catalogs yet',
        noContent: 'No content',
        recommendedSources: 'Recommended catalogs'
      },
      entry: {
        noDownload: 'No download link',
        unknownAuthor: 'Anonymous'
      },
      messages: {
        addBuiltinFailed: 'Failed to add built-in catalog: {msg}',
        addFailed: 'Add failed: {msg}',
        browseFailed: 'Failed to browse: {msg}',
        builtinAdded: 'Built-in catalog "{name}" added',
        builtinExists: 'Catalog "{name}" already exists',
        catalogAdded: 'Catalog added',
        catalogDeleted: 'Catalog deleted',
        deleteFailed: 'Delete failed: {msg}',
        downloadFailed: 'Download failed: {msg}',
        importFailed: 'Import failed: {msg}',
        loadFailed: 'Failed to load: {msg}',
        nameRequired: 'Name cannot be empty',
        noDownloadLink: 'No download link',
        searchFailed: 'Search failed: {msg}',
        unknownError: 'Unknown error',
        urlExists: 'This URL already exists'
      },
      notify: {
        goToLibrary: 'Go to bookshelf',
        importedToGroup: '"{name}" imported to group "{group}"',
        importedToLibrary: '"{name}" imported to bookshelf'
      },
      pagination: {
        next: 'Next page',
        previous: 'Previous page'
      },
      searching: 'Searching…',
      sidebar: {
        catalogList: 'Catalog list',
        deleteCatalog: 'Delete catalog'
      },
      title: 'OPDS catalogs'
    },
    readSettings: {
      actions: {
        restoreDefaults: 'Restore defaults'
      },
      colors: {
        bg: 'Background color',
        primary: 'Primary color',
        text: 'Text color'
      },
      comicReadDirection: {
        ltr: 'Left to right',
        rtl: 'Right to left'
      },
      comicScale: {
        custom: 'Custom',
        fitHeight: 'Fit height',
        fitScreen: 'Fit screen',
        fitWidth: 'Fit width',
        original: 'Original size',
        smartFit: 'Smart fit'
      },
      fonts: {
        hei: 'Sans-serif',
        kai: 'Kaiti',
        serif: 'Serif',
        system: 'System default'
      },
      groups: {
        comic: 'Comic',
        general: 'General',
        text: 'Text'
      },
      hints: {
        comicBackground:
          'Follows the reading theme by default (linked to theme settings); dark is the comic-reader black convention',
        comicDirection: 'Comic reading direction',
        comicScale: 'Comic scaling mode',
        comicCustomScale: 'Image width as a percentage of the reading area; 100% equals fit width',
        followSystem: 'Follow system theme',
        lineHeight: 'Line height',
        noVoice: 'No voices available',
        paragraphSpacing: 'Paragraph spacing',
        smartFormat: 'Smart formatting'
      },
      pageTurnAnimation: {
        curl: 'Page curl',
        fade: 'Fade',
        flip: 'Flip',
        none: 'None',
        slide: 'Slide'
      },
      presets: {
        applied: 'Preset "{name}" applied',
        comfortable: 'Comfortable',
        compact: 'Compact',
        eye: 'Eye care',
        night: 'Night',
        research: 'Research'
      },
      px: '{n} px',
      percent: '{n}%',
      sections: {
        comicCustomScale: 'Custom scale',
        customColors: 'Custom colors',
        followSystem: 'Follow system',
        fontFamily: 'Font',
        fontSize: 'Font size',
        lineHeight: 'Line height',
        margin: 'Page margins',
        pageScale: 'Page zoom',
        pageTurnAnimation: 'Page turn animation',
        comicBackground: 'Background',
        pageWidth: 'Page width',
        paragraphSpacing: 'Paragraph spacing',
        readDirection: 'Reading direction',
        smartFormat: 'Smart formatting',
        textConvert: 'Simplified/Traditional conversion',
        ttsPitch: 'TTS pitch',
        ttsRate: 'TTS rate',
        voice: 'Voice'
      },
      textConvert: {
        off: 'Off',
        s2t: 'Simplified → Traditional',
        t2s: 'Traditional → Simplified'
      },
      themes: {
        custom: 'Custom',
        day: 'Day',
        eye: 'Eye care',
        night: 'Night',
        parchment: 'Parchment',
        research: 'Research'
      },
      title: 'Reading settings',
      tts: {
        autoSelect: 'Auto select'
      }
    },
    reader: {
      actions: {
        backToShelf: 'Back to bookshelf',
        update: 'Update'
      },
      autoScroll: {
        speed: 'Scroll speed',
        start: 'Start auto-scrolling',
        stop: 'Stop auto-scrolling'
      },
      bookmark: {
        addFailed: 'Failed to add bookmark',
        addSuccess: 'Bookmark added',
        existsContent: 'This bookmark already exists',
        existsTitle: 'Bookmark already exists',
        // A7: image-based bookmarks have no extractable text; content falls back to page preview
        imagePagePreview: 'Page {n} of {m}',
        updateFailed: 'Failed to update bookmark',
        updateSuccess: 'Bookmark updated'
      },
      chapterN: 'Chapter {n}',
      chapterProgress: 'Chapter progress {current}/{total}',
      contextMenu: {
        addBookmark: 'Add bookmark',
        addNote: 'Add note',
        bookmarkNote: 'Bookmark note',
        enterFullscreen: 'Enter fullscreen',
        exitFullscreen: 'Exit fullscreen',
        hideToolbar: 'Hide toolbar',
        highlight: 'Highlight',
        imageScale: 'Image fit',
        readSettings: 'Reading settings',
        replaceRule: 'Replacement rule',
        showToolbar: 'Show toolbar',
        startAutoScroll: 'Start auto-scrolling',
        stopAutoScroll: 'Stop auto-scrolling',
        switchReadMode: 'Switch to {mode}',
        toc: 'Table of contents',
        ttsFromHere: 'Read aloud from here'
      },
      errors: {
        bookNotFound: 'Book not found',
        loadBookFailed: 'Failed to load book: {msg}',
        loadChapterFailed: 'Failed to load chapter: {msg}'
      },
      // C-6: Persistent banner for missing linked file (retry entry after canceling RelocateDialog)
      fileMissingBanner: 'The original file is missing — click to relocate',
      highlight: {
        addFailed: 'Failed to add highlight',
        addSuccess: 'Highlight added',
        existsContent: 'This highlight already exists',
        existsTitle: 'Highlight already exists',
        updateFailed: 'Failed to update highlight',
        updateSuccess: 'Highlight updated'
      },
      invalidBookId: 'Invalid book ID',
      loadingChapter: 'Loading chapter…',
      noChapters: 'No chapter content',
      note: {
        addFailed: 'Failed to add note',
        addSuccess: 'Note added',
        colorLabel: 'Color',
        contentLabel: 'Content',
        emptyContent: 'Note content cannot be empty',
        existsContent: 'This note already exists',
        existsTitle: 'Note already exists',
        noHighlight: 'Select some text first',
        placeholder: 'Write your note…',
        quoteLabel: 'Original text',
        save: 'Save',
        selectFirst: 'Select some text first',
        title: 'Note',
        updateFailed: 'Failed to update note',
        updateSuccess: 'Note updated'
      },
      progressClickHint: 'Click to jump',
      readMode: {
        all: 'Whole book',
        chapter: 'By chapter',
        page: 'Page turn',
        scroll: 'Scroll'
      },
      remainingTime: {
        hours: 'About {hours} hours',
        hoursMinutes: 'About {hours}h {minutes}m',
        lessThanMinute: 'Less than 1 minute',
        minutes: 'About {minutes} minutes'
      },
      replace: {
        addFailed: 'Failed to add replacement rule',
        addSuccess: 'Replacement rule added',
        bookMissing: 'Book not found',
        placeholder: 'Replace with…',
        quoteLabel: 'Original text',
        regex: 'Regex',
        replacementLabel: 'Replace with',
        save: 'Save',
        scopeBook: 'This book',
        scopeGlobal: 'Global',
        scopeLabel: 'Scope',
        selectFirst: 'Select some text first',
        title: 'Replace',
        tooLong: 'Content too long',
        varBackslash: '\\\\',
        varCarriageReturn: '\\r',
        varHint: 'Available variables',
        varNewline: '\\n',
        varSpace: '\\s',
        varTab: '\\t'
      },
      search: {
        title: 'Search'
      },
      toolbar: {
        addBookmark: 'Add bookmark',
        bookmarkNote: 'Bookmark note',
        decreaseFont: 'Decrease font size',
        enterFullscreen: 'Enter fullscreen',
        exitFullscreen: 'Exit fullscreen',
        hideToolbar: 'Hide toolbar',
        increaseFont: 'Increase font size',
        readSettings: 'Reading settings',
        search: 'Search',
        toc: 'Table of contents'
      },
      tts: {
        advanceFailed: 'Failed to advance reading',
        engineError: 'Speech engine error',
        finishedLastChapter: 'Finished the last chapter',
        noEngine: 'No speech engine available',
        notSupported: 'Speech not supported',
        nothingToRead: 'Nothing to read',
        pause: 'Pause',
        reachedLastChapter: 'Reached the last chapter',
        progress: 'Reading {current}/{total}',
        progressPaused: 'Paused at {current}/{total}',
        resume: 'Resume',
        selectFirst: 'Select some text first',
        speakingTitle: 'Reading aloud…',
        start: 'Start reading',
        stop: 'Stop reading'
      }
    },
    readerBars: {
      bookmark: {
        ariaExcerpt: 'Excerpt: {text}',
        ariaLabel: 'Bookmark: {title} {excerpt} {note} {time}',
        ariaNote: 'Note: {text}',
        confirmDelete: 'Delete?',
        confirmDeleteBookmark: 'Delete this bookmark?',
        confirmDeleteHighlight: 'Delete this highlight?',
        confirmDeleteNote: 'Delete this note?',
        deleteFailed: 'Delete failed',
        editNote: 'Edit note',
        editTitle: 'Edit',
        emptyBookmark: 'No bookmarks yet',
        emptyBookmarkHint1: 'Click the toolbar while reading',
        emptyBookmarkHint2: 'to add a bookmark',
        emptyHighlight: 'No highlights yet',
        emptyHighlightHint1: 'Select text and right-click',
        emptyHighlightHint2: 'to add a highlight',
        emptyNote: 'No notes yet',
        emptyNoteHint1: 'Select text and right-click',
        emptyNoteHint2: 'to add a note',
        excerptPlaceholder: 'Excerpt',
        fieldExcerpt: 'Excerpt',
        fieldHighlight: 'Highlight',
        fieldNote: 'Note',
        headerTitle: 'Bookmarks',
        noExcerpt: 'No excerpt',
        noHighlight: 'No highlight',
        noMatchHint: 'No matching highlights',
        noMatchNote: 'No matching notes',
        notePlaceholder: 'Note content',
        panelTitle: 'Bookmark panel',
        saveFailed: 'Save failed',
        searchPlaceholder: 'Search…',
        tabBookmark: 'Bookmarks ({n})',
        tabHighlight: 'Highlights ({n})',
        tabNote: 'Notes ({n})'
      },
      chapter: {
        chapterAria: 'Chapter {index}: {title}',
        chapterCount: '{n} chapters',
        chapterN: 'Chapter {n}',
        collapseAll: 'Collapse all',
        collapseDisabledHint: 'The current volume stays expanded to locate your reading position',
        comicEpisode: 'Episode {n}',
        expandAll: 'Expand all',
        footerProgress: '{current}/{total} read',
        noMatch: 'No matching chapters',
        normalOrder: 'Ascending',
        reverseOrder: 'Descending',
        searchPlaceholder: 'Search chapters…',
        title: 'Table of contents',
        totalChapters: '{n} chapters',
        volumeAria: 'Volume: {title}',
        wordCount: {
          tenThousand: '{n}k words',
          thousand: '{n}k words'
        }
      },
      search: {
        clear: 'Clear',
        hint: 'Search in this book',
        noResult: 'No results',
        placeholder: 'Search…',
        progress: 'Searched {done}/{total}',
        summary: '{count} results'
      }
    },
    readerViews: {
      chapterFallback: 'Chapter {n}',
      finishedLastChapter: 'Finished the last chapter',
      lightbox: {
        zoomAlt: 'Image'
      },
      page: {
        indicatorLabel: 'pages'
      },
      scroll: {
        loadingAll: 'Loading all…',
        loadingNext: 'Loading next batch…',
        loadingPrev: 'Loading previous batch…'
      }
    },
    settings: {
      about: {
        authorLabel: 'Author',
        copyright: '{app} All rights reserved',
        feature1: 'Multiple format support',
        feature10: 'Comic reading',
        feature11: 'OPDS catalogs',
        feature12: 'Keyboard shortcuts',
        feature2: 'Reading statistics',
        feature3: 'Custom themes',
        feature4: 'Text-to-speech',
        feature5: 'RSS subscriptions',
        feature6: 'Notes and highlights',
        feature7: 'Bookmark management',
        feature8: 'Smart formatting',
        feature9: 'Simplified/Traditional conversion',
        featuresTitle: 'Features',
        intro: 'Youdu is a lightweight e-book reader',
        philosophy: 'Simple, focused, customizable',
        philosophyTitle: 'Design philosophy',
        techStackLabel: 'Tech stack',
        title: 'About {app}'
      },
      advanced: {
        dataRoot: {
          changeButton: 'Change Data Directory',
          confirmContent:
            'All book data (book files, covers, database) will be moved to the new directory. This is a move (cut) operation: data in the original directory will be automatically deleted and unified into the new directory. Large libraries (e.g. 30GB) may take a long time; do not close the app during migration.',
          confirmTitle: 'Change Data Directory',
          currentDir: 'Current data directory',
          currentDirHint: 'Where books, covers and the database are stored',
          doneContent: 'Data has been migrated to: {path}.\nThe old directory data has been automatically cleaned up.',
          doneTitle: 'Migration Complete',
          migrateFailed: 'Migration failed: {message}',
          migrateHint:
            'Changing the data directory moves all book data to the new location (cut semantics, old directory data is automatically deleted, unified into the new directory). This may take a while for large libraries. All pages refresh automatically after completion.',
          migrating: 'Migrating data, please do not close the app…',
          restarting: 'Migration complete, restarting automatically...',
          title: 'Data Directory'
        },
        disabled: 'Disabled',
        enabled: 'Enabled',
        network: {
          addHeader: 'Add header',

          customHeaders: 'Custom headers',
          headerName: 'Name',
          headerValue: 'Value',
          proxy: 'Proxy',
          proxyHost: 'Proxy host',
          proxyPort: 'Proxy port',
          retryCount: 'Retry count',
          retryCountHint: 'Number of retries after failure',
          retryDelay: 'Retry delay',
          retryDelayHint: 'Retry interval (ms)',
          saveFailed: 'Save failed: {message}',
          timeout: 'Timeout',
          timeoutHint: 'Request timeout (ms)',
          timeoutRetry: 'Retry on timeout',
          times: 'times',
          title: 'Network',
          uaPlaceholder: 'User-Agent'
        },
        rules: {
          batchDelete: 'Batch delete',
          batchDeleteFailed: 'Batch delete failed',
          batchDeleted: 'Deleted {n} rule(s)',
          batchDisable: 'Batch disable',
          batchDisabled: 'Disabled {n} rule(s)',
          batchEnable: 'Batch enable',
          batchEnabled: 'Enabled {n} rule(s)',
          batchOpFailed: 'Batch operation failed',
          confirmDelete: 'Delete this rule?',
          confirmDeleteContent: 'This will delete {n} rule(s) and cannot be undone',
          confirmDeleteTitle: 'Delete rule',
          count: '{n} rules in total',
          deleteFailed: 'Delete failed',
          deleteMark: 'Delete mark',
          deleted: 'Deleted',
          empty: 'No rules yet',
          emptyHint: 'Add replacement rules to replace text in bulk',
          hint: 'Rules replace text while reading',
          loadFailed: 'Failed to load rules',
          mergedNote: 'Global and book rules merged',
          plainText: 'Plain text',
          regex: 'Regex',
          scopeBook: 'This book (#{id})',
          scopeGlobal: 'Global',
          selectedCount: '{n} selected',
          title: 'Replacement rules',
          toggleFailed: 'Toggle failed',
          varBackslash: '\\\\',
          varCarriageReturn: '\\r',
          varHintTail: 'and more',
          varNewline: '\\n',
          varSpace: '\\s',
          varSupport: 'Supported variables:',
          varTab: '\\t'
        }
      },
      appearance: {
        appFollowSystemHint: 'App theme follows the system',
        appTheme: 'App theme',
        appThemeHint: 'Choose the app interface theme',
        bgColor: 'Background color',
        customColors: 'Custom colors',
        customColorsHint: 'Customize interface colors with the "{custom}" theme',
        followSystem: 'Follow system',
        presets: 'Presets',
        primaryColor: 'Primary color',
        readerFollowSystemHint: 'Reader theme follows the system',
        readerTheme: 'Reader theme',
        readerThemeHint: 'Choose the reading interface theme',
        textColor: 'Text color'
      },
      data: {
        booksDir: 'Books',
        cacheClearFailed: 'Failed to clear cache',
        cacheClearFailedLog: 'Failed to clear cache (see logs)',
        cacheCleared: 'Cleared {n} cache item(s)',
        cacheDir: 'Cache',
        clearCache: 'Clear cache',
        clearCacheHint: 'Clear temporary cache',
        coversDir: 'Covers',
        dataDir: 'Data directory',
        dataDirHint: 'Where data is stored',
        defaultImportMode: 'Default import mode',
        defaultImportModeHint: 'Default storage mode when importing (still switchable in the dialog)',
        importModeCopy: 'Copy (double disk space)',
        importModeLink: 'Link (keep files in place)',
        importModeMove: 'Move (originals moved away)',
        management: 'Data management',

        openDir: 'Open',
        openDirFailed: 'Failed to open directory',
        redetect: 'Redetect',
        redetectButton: 'Redetect books',
        redetectDone: 'Redetection complete: {total} books, {comic} comics detected',
        redetectDonePartial:
          'Redetection complete (some failed): {success} succeeded, {fail} failed, {comic} comics detected',
        redetectFailed: 'Redetection failed',
        redetectHint: 'Redetect metadata for all books',
        redetectLoading: 'Redetecting {current}/{total}…',
        redetectNone: 'No books need redetection',
        redetectProgress: 'Detecting {current}/{total}: {title}',
        skipImportModeDialog: 'Skip import mode dialog',
        skipImportModeDialogHint: 'Import directly with the default mode without asking'
      },
      reclassify: {
        /** Batch reclassify (task 40): re-judge classification labels of all PDF books with multi-dimensional signals */
        cancelButton: 'Cancel',
        changesTitle: 'Changes ({n} books)',
        cancelled: 'Reclassification cancelled: {processed} processed, {changed} changed',
        done: 'Reclassification complete: {processed} processed, {changed} changed',
        donePartial: 'Reclassification complete (some failed): {changed} changed, {failed} failed',
        failed: 'Batch reclassification failed: {message}',
        hint: 'Re-judge classification labels of all PDF books with multi-dimensional signals (metadata/bookmarks/image colors); chapters are NOT rebuilt and reading progress is untouched',
        label: 'Re-classify all PDF books',
        noBooks: 'No PDF books to recheck',
        progressText: 'Rechecking {current}/{total}',
        startButton: 'Start Reclassification',
        summary: 'Processed {processed}, changed {changed}, skipped {skipped}, failed {failed}',
        title: 'Batch Reclassify'
      },
      fonts: {
        hei: 'Sans-serif',
        kai: 'Kaiti',
        serif: 'Serif',
        system: 'System default'
      },
      general: {
        language: 'Language',
        languageHint: 'Switch interface language',
        notifications: 'Notifications',
        readingReminder: 'Reading reminder',
        readingReminderHint: 'Remind you to read regularly',
        reminderTime: 'Reminder time',
        reminderTimeHint: 'Remind daily at this time',
        rssUpdate: 'RSS update notifications',
        rssUpdateHint: 'Notify when RSS has new articles',
        saveFailed: 'Save failed',
        shortcutHint: 'Shortcut guide',
        shortcutSettings: 'Shortcut settings'
      },

      loadSettingsFailed: 'Failed to load settings',
      localeSwitched: 'Language switched',
      reading: {
        autoScroll: 'Auto-scroll',
        autoScrollSpeed: 'Scroll speed',
        autoScrollSpeedHint: 'Auto-scroll speed',
        comicBgDark: 'Dark',
        comicBgLight: 'Light',
        comicBgTheme: 'Follow reading theme',
        comicBackground: 'Comic background',
        comicBackgroundHint:
          'Dark matches the common black background; light blends better with white pages but page edges may blur',
        comicSection: 'Comic reading',
        convertOff: 'Off',
        convertS2T: 'Simplified → Traditional',
        convertT2S: 'Traditional → Simplified',
        directionLtr: 'Left to right',
        directionRtl: 'Right to left',
        fontFamily: 'Font',
        fontFamilyHint: 'Reading font',
        fontSize: 'Font size',
        fontSizeHint: 'Font size',
        layout: 'Layout',
        lineHeight: 'Line height',
        lineHeightHint: 'Line height multiplier',
        pageTurn: 'Page turn',
        pageTurnDirection: 'Page turn direction',
        pageTurnDirectionHint: 'Page turn direction',
        pageWidth: 'Page width',
        pageWidthHint: 'Page width ratio',
        reset: 'Restore defaults',
        resetDone: 'Defaults restored',
        smartFormat: 'Smart formatting',
        smartFormatHint: 'Automatically clean up formatting',
        tapTurn: 'Tap to turn',
        tapTurnHint: 'Turn pages by tapping the screen',
        tapTurnZone: 'Tap zones',
        tapTurnZoneHint: 'Screen area that triggers page turns',
        textConvert: 'Simplified/Traditional conversion',
        textConvertHint: 'Convert between Simplified and Traditional Chinese',
        zoneBottom: 'Bottom',
        zoneFull: 'Full screen',
        zoneLeftRight: 'Left and right edges'
      },
      shortcuts: {
        clear: 'Clear',
        cleared: 'Cleared',
        closeReader: 'Close reader',
        modalHint: 'Click a key below to rebind',
        modalTitle: 'Shortcut settings',
        nextChapter: 'Next chapter',
        nextPage: 'Next page',
        notSet: 'Not set',
        pressKey: 'Press a key',
        prevChapter: 'Previous chapter',
        prevPage: 'Previous page',
        resetDone: 'Defaults restored',
        resetToDefault: 'Restore defaults',
        spaceHint:
          'Tip: actions such as page turning can be bound to the Space key directly. In RTL comics, arrow keys follow physical direction (reversed, Mihon convention), while Space always means reading forward.',
        spaceKey: 'Space',
        toggleBookmark: 'Toggle bookmark',
        toggleFullscreen: 'Toggle fullscreen',
        toggleSearch: 'Search',
        toggleTTS: 'Text-to-speech',
        updated: 'Shortcut updated'
      },
      stats: {
        cellTitle: '{date}: {duration}',
        charsValue: '{n} chars',
        daysValue: '{n} days',
        duration: {
          days: '{n} days',
          daysHours: '{d} days {h} hours',
          hours: '{n} hours',
          hoursMinutes: '{h}h {m}m',
          minutes: '{n} minutes',
          zero: '0 minutes'
        },
        empty: 'No reading records yet',
        emptyHint: 'Statistics will appear here once you start reading',
        heatmapLess: 'Less',
        heatmapMore: 'More',
        heatmapTitle: 'Reading heatmap (last {n} days)',
        loadFailed: 'Failed to load statistics',
        sessionsValue: '{n} sessions',
        speed: 'Reading speed',
        speedValue: '{n} chars/min',
        streak: 'Reading streak',
        thisMonth: 'This month',
        thisWeek: 'This week',
        today: 'Today',
        topBooks: 'Most read books',
        totalChars: 'Total characters',
        totalDuration: 'Total time',
        totalSessions: 'Total sessions'
      },
      tabs: {
        about: 'About',
        advanced: 'Advanced',
        appearance: 'Appearance',
        data: 'Data',
        general: 'General',
        reading: 'Reading',
        stats: 'Statistics'
      },
      themes: {
        custom: 'Custom',
        day: 'Day',
        eye: 'Eye care',
        night: 'Night',
        parchment: 'Parchment',
        research: 'Research'
      },
      title: 'Settings'
    },
    shell: {
      dropZone: {
        andMore: ' and {count} more',
        listSeparator: ', ',
        releaseToImport: 'Release to import',
        supportedFormats: 'Supported formats',
        unsupportedSkipped: 'Skipped unsupported files: {names}{suffix}'
      },
      nav: {
        library: 'Bookshelf',
        settings: 'Settings',
        sources: 'Sources'
      },
      titleBar: {
        backToLibrary: 'Back to bookshelf',
        maximize: 'Maximize',
        minimize: 'Minimize',
        restore: 'Restore'
      }
    },
    sources: {
      addCatalog: 'Add catalog',
      addSubscription: 'Add subscription',
      bookCount: '{n} books',
      checkAll: 'Check all',
      checkAllFailed: 'Failed to check all: {message}',
      checkDoneBooks: 'Check complete: {n} books with updates',
      checkDoneNone: 'No new updates',
      checkFailed: 'Check failed: {error}',
      checkUpdateFailed: 'Failed to check for updates: {message}',
      checkingAll: 'Checking…',
      clearMarkFailed: 'Failed to clear marks: {message}',
      clearedAllMarks: 'All marks cleared',
      confirmDelete: 'Delete?',
      coverAlt: 'Cover',
      deleteConfirmContent: 'This cannot be undone',
      deleteConfirmTitle: 'Delete',
      deleteFailed: 'Delete failed: {message}',
      deleteSuccess: 'Deleted',
      empty: {
        addFirst: 'Add one',
        hint: 'Add an RSS subscription or OPDS catalog',
        title: 'No sources yet'
      },
      foundNewItems: '{n} new items found in "{name}"',
      markAllRead: 'Mark all as read',
      markRead: 'Mark as read',
      markedRead: 'Marked as read',
      noNewItems: 'No new content in "{name}"',
      searchPlaceholder: 'Search…',
      tabs: {
        opds: 'OPDS',
        rss: 'RSS'
      },
      toggleFailed: 'Toggle failed: {message}',
      unknownAuthor: 'Anonymous',
      unknownError: 'Unknown error',
      updatedBooksTitle: 'Books with updates'
    },
    subscription: {
      actionFailed: 'Action failed: {message}',
      addTitle: 'Add subscription',
      added: 'Added',
      autoImportHint: 'Automatically import new content',
      autoImportLabel: 'Auto import',
      bookCount: '{n} books',
      browse: 'Browse',
      browseTitle: 'Browse content',
      checkUpdate: 'Check for updates',
      contentAdded: 'Content added for "{name}"{suffix}',
      contentBook: 'Book',
      contentNovel: 'Novel',
      contentSuffix: ' ({type})',
      daysAgo: '{n} days ago',
      defaultFolderName: 'Folder',
      defaultName: 'Subscription',
      disabled: 'Disabled',
      editTitle: 'Edit subscription',
      enabled: 'Enabled',
      hoursAgo: '{n} hours ago',
      intervalLabel: 'Update interval',
      justNow: 'Just now',
      minutesAgo: '{n} minutes ago',
      nameLabel: 'Name',
      namePlaceholderAuto: 'RSS subscription name',
      namePlaceholderFolder: 'Folder subscription name',
      neverChecked: 'Never checked',
      opdsAdded: 'OPDS "{name}" added',
      opdsCatalog: 'OPDS catalog',
      presets: {
        categories: {
          literature: 'Literature',
          news: 'News',
          science: 'Science',
          techBlogs: 'Tech blogs'
        },
        names: {
          bbcChinese: 'BBC Chinese',
          coolshell: 'CoolShell',
          doubanReviews: 'Douban Book Reviews',
          guokr: 'Guokr',
          hackerNews: 'Hacker News',
          qianxin: 'Qianxin',
          quanta: 'QbitAI',
          reutersWorld: 'Reuters',
          ruanyifeng: 'Ruan Yifeng',
          singleReading: 'Single Reading',
          solidot: 'Solidot',
          techCrunch: 'TechCrunch',
          zhihuDaily: 'Zhihu Daily'
        }
      },
      presetsTitle: 'Recommended subscriptions',
      selectFolderFailed: 'Failed to select folder: {message}',
      typeAuto: 'Auto',
      typeFolder: 'Folder',
      typeLabel: 'Type',
      updated: 'Updated',
      updatesBadge: '{n} updates',
      updatesInline: '{n} new items',
      urlLabel: 'URL',
      urlPlaceholderAuto: 'https://example.com/rss',
      urlPlaceholderFolder: 'https://example.com/feed',
      urlPlaceholderRss: 'RSS URL'
    }
  }
};

/** 已保存语言（localStorage），默认 zh-CN */
const saved = (localStorage.getItem(STORAGE_KEY) as Locale | null) ?? 'zh-CN';

/** vue-i18n 实例（Composition 模式） */
export const i18n = createI18n({
  legacy: false,
  locale: saved,
  fallbackLocale: 'zh-CN',
  messages,
  missingWarn: false,
  fallbackWarn: false
});

/**
 * 切换应用语言并持久化
 *
 * @param locale 目标语言，仅接受 'zh-CN' 与 'en'
 */
export function setAppLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale);
  i18n.global.locale.value = locale;
}

/**
 * 读取已保存语言
 *
 * @returns localStorage 中的语言标识，未设置时返回 'zh-CN'
 */
export function getSavedLocale(): string {
  return localStorage.getItem(STORAGE_KEY) ?? 'zh-CN';
}
