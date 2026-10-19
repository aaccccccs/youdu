/**
 * 章节标题正则库和检测函数
 *
 * 从 file-parser.ts 拆分而来。
 */

/* ==================== chapter-patterns.ts（章节正则模式） ==================== */
/**
 * 章节标题正则库（通用化增强版）
 *
 * 设计理念：分层匹配策略，兼顾覆盖率和性能
 * 1. 第一层：行首字符白名单快速过滤（CHAPTER_LINE_FIRST_CHAR_RE）
 * 2. 第二层：通用包裹符匹配——任何包裹符对（【】[]『』《》「」（）()）包裹的"第X章"格式
 * 3. 第三层：通用装饰符匹配——任何装饰符（=―—*~○●□■★☆·）重复2+次包裹的"第X章"格式
 * 4. 第四层：具体正则匹配（下方 CHAPTER_PATTERNS）
 *
 * 覆盖中文小说常见章节命名格式，基于 80 个真实 TXT 文件语料分析。
 *
 * 正则说明：
 * 1. 第X章/回/节/卷/部/折/话/集/篇 —— 最常见中文格式（"第一章""第12回""第3节""第一集""第一篇"）
 * 2. ===第X章===/―第X章―    —— 等号/破折号包裹的章节标题
 * 3. Chapter X / SECTION X / Part X —— 英文格式
 * 4. 纯数字章节             —— 如 "1" "12"（易误判，调用方需结合上下文）
 * 5. 数字+标题              —— 如 "1、初入江湖" "12.觉醒" "01章 xxx"
 * 6. 【第X章】/[第X章]/（第X章）/《第X章》/『第X章』/「第X章」—— 包裹符号格式
 * 7. 0001 xxx               —— 数字+空格+标题（易误判，需 prevLineEmpty 约束）
 * 8. 通用装饰符包裹         —— ★第X章★ / ○第X章○ / ~~~~第X章~~~~ 等
 * 9. 单个破折号包裹         —— ―第X章 xxx―
 * 10. ·卷一 xxx·           —— 间隔号包裹的卷标记
 * 11. 来自=第X章 xxx       —— "来自=" 前缀的章节标记
 * 12. 正文 第X章           —— "正文"前缀的章节标记
 * 13. (1) xxx / （1）xxx   —— 括号数字标题
 */

/**
 * 中文数字字符集（含大小写汉字数字和阿拉伯数字）
 *
 * 覆盖：零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟 0-9
 * - 〇（U+3007 圆圈零）：见于部分小说的"第〇一章"等格式
 */
export const CN_NUM_CHARS = '零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9';

/**
 * 章节量词字符集
 *
 * 覆盖：章回节卷部折话篇幕
 * - 章/回/节/卷/部/折/话：传统中文小说章节量词
 * - 篇：如"第一篇"（见于部分小说）
 * - 幕：如"第一幕"（见于戏剧/剧本类小说）
 */
export const CHAPTER_MEASURE_CHARS = '章回节卷部折话集篇幕';

/**
 * 章节标题正则库（按匹配优先级排列）
 *
 * 注意：
 * - 纯数字正则（索引 PURE_NUMBER_PATTERN_INDEX）容易误判正文中的独立数字行，
 *   调用方应结合上下文（如前一行是否为空行）做额外过滤。
 * - 数字+空格+标题正则（索引 PURE_NUMBER_SPACE_PATTERN_INDEX）同样容易误判，
 *   调用方应结合上下文（前一行是否为空行）做额外过滤。
 *
 * 索引固定：
 * - PURE_NUMBER_PATTERN_INDEX = 6（纯数字章节）
 * - PURE_NUMBER_SPACE_PATTERN_INDEX = 9（数字+空格+标题）
 * - CN_NUMBER_DUNHAO_PATTERN_INDEX = 20（中文数字+顿号，需 prevLineEmpty 约束）
 * - ROMAN_NUMBER_PATTERN_INDEX = 21（罗马数字+点，需 prevLineEmpty 约束）
 * 新增正则只能追加到索引 10 之后，不能插入到 0-9 之间。
 *
 * 多语言正则（索引 23-28）：
 * - 23: 日文章节 第X話/章/節/項
 * - 24: 日文序言/尾声 プロローグ/エピローグ/序章/終章
 * - 25: 韩文章节 제X장/제X절/제X화
 * - 26: 韩文序论/结论 서론/결론/머리말/맺음말
 * - 27: 英文学术文献 Paper X / Subsection X
 * - 28: 英文论文结构 Abstract / References / Appendix / Acknowledgments
 *
 * 新增正则（索引 30-31）：
 * - 30: 章节目录 第X章 xxx（见于完美世界系列）
 * - 31: 英文 Act/Episode/Ep/Sec 缩写
 *
 * 新增正则（索引 32）：
 * - 32: 复合格式 第X章 章名，Y.第Z章 子章名（一行中同时包含主章节和子章节标记）
 *
 * 新增正则（索引 35-37，方括号包裹的数字/中文数字章节标记）：
 * - 35: [书名正文 N、标题] 方括号+数字+顿号（见于小说快捕制作的TXT）
 * - 36: [书名正文 NO.N 标题] 方括号+NO.数字（见于小说快捕制作的TXT）
 * - 37: [书名 中文数字、标题] 方括号+中文数字+顿号（见于小说快捕制作的TXT）
 *
 * 当前正则数量：38（索引 0-37）
 */
export const CHAPTER_PATTERNS = [
  // 0: 序章/楔子/番外/正文/外传等
  //    新增（相比旧版）：
  //    - "序" 单独一行（旧版要求"序章"，遗漏文件10/39 的单独"序"）
  //    - "正文卷" 和 "正文"（旧版无，遗漏文件7/8/17/26/32/36/56 的"正文卷"）
  //    - "外传N"（旧版无，遗漏文件27 的"外传1 柯父。"）
  //    修复： "序" → "序(?!列|号)" 排除正文中"序列号""序号"等误识别（96%误识别率）
  //    新增：终章/完本感言/作者的话（开源项目常见支持，遗漏完美世界等结尾章节）
  /^(序(?!列|号)|序章|楔子|番外篇?|尾声|前言|后记|引子|上篇|中篇|下篇|上卷|中卷|下卷|正文卷|正文(?![\u4e00-\u9fff])|外传\d*|终章|完本感言|作者的话).*$/m,
  // 1: 卷X（如"卷一""卷12"）
  /^卷[零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9]+.*$/m,
  // 2: 第X章/回/节/卷/部/折/话/篇/幕
  //    "集"已移至卷量词（VOLUME_MEASURE_CHARS），"第一集"由 isVolumeLine 识别为卷标记
  //    - "篇"：如"第一篇"（部分小说）
  //    - "幕"：如"第一幕"（戏剧/剧本类小说）
  new RegExp(`^第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*$`, 'm'),
  // 3: ===第X章=== 等号包裹（2+个等号）
  new RegExp(`^={2,}\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*={2,}`, 'm'),
  // 4: ―第X章― 破折号包裹（2+个破折号，支持 ― U+2015 / — U+2014 / - U+002D）
  new RegExp(`^[―—\\-]{2,}\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*[―—\\-]{2,}`, 'm'),
  // 5: Chapter X / Chapter1（英文，不区分大小写）
  //    支持 "Chapter 1"（空格分隔）和 "Chapter1"（无空格分隔）
  //    见于文件04a88200feb19c88.txt 的"chapter1 序章"和文件07903a4f8fc76ac4.txt 的"Chapter1　小舟"
  /^chapter\s*\d+/i,
  // 6: 纯数字章节（PURE_NUMBER_PATTERN_INDEX = 6，需上下文约束）
  /^\s*\d{1,6}\s*$/,
  // 7: 数字+标题（如 "1、初入江湖" "12.觉醒" "12．xxx"）
  /^\d{1,4}[、.．：:，,]\s*.+/,
  // 8: 包裹符+第X章+包裹符
  //    新增（相比旧版）：《》『』「」 三种包裹符
  //    - 旧版只支持 【[/（( 四种，遗漏 《》『』「」
  //    - 新增：《第X章》/『第X章』/「第X章」
  new RegExp(`^[【\\[『《「（(]第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*[】\\]』》」）)]`),
  // 9: 0001 xxx 数字+空格+标题（PURE_NUMBER_SPACE_PATTERN_INDEX = 9，需 prevLineEmpty 约束）
  /^\d{1,5}\s+\S.{0,80}$/,
  // === 以下为通用化新增正则（索引 10+） ===
  // 10: 通用装饰符包裹（2+次重复）
  //     覆盖：★第X章★ / ☆第X章☆ / ○第X章○ / ●第X章● / □第X章□ / ■第X章■
  //           ~~~~第X章~~~~ / ----第X章---- / ····第X章···· 等
  //     设计：不硬编码每种装饰符，用字符集 [=―—*~○●□■★☆\-·] 统一匹配
  new RegExp(`^[=―—*~○●□■★☆\\-·]{2,}\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*[=―—*~○●□■★☆\\-·]{2,}`, 'm'),
  // 11: 单个破折号包裹：―第X章 xxx―
  //     旧版正则4要求2+个破折号，遗漏文件72 的"―第一章 两个怪物―"（单个破折号）
  //     约束：要求中间有内容（.+），避免误判"―第X章―"（这种由正则4处理）
  new RegExp(`^[―—\\-]\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].+[―—\\-]$`),
  // 12: ·卷一 xxx· 间隔号包裹的卷标记
  //     见于文件72 的"·卷一 误入乱世·"
  /^·卷[零一二三四五六七八九十]+.*·$/,
  // 13: 来自=第X章 xxx / 来自＝第X章 xxx
  //     见于文件6 的"来自=第一章 祠堂挑战==="
  //     支持 = 和 ＝（全角等号）
  new RegExp(`^来自[=＝]\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*`),
  // 14: 数字+章（无分隔符）：01章 xxx / 001章 xxx
  //     旧版正则7要求数字后是、.．，遗漏"01章 xxx"格式
  /^\d{1,4}[章节回话部折篇]\s*.+/,
  // 15: 正文 第X章 / 正文第X章
  //     见于部分小说的"正文 第一章 xxx"格式
  new RegExp(`^正文\\s*第[${CN_NUM_CHARS}]+[章回节].*`),
  // 16: 括号数字：(1) xxx / （1）xxx
  //     见于部分小说的"(1) 章节标题"格式
  /^[（(]\d{1,4}[）)]\s*.+/,
  // 17: SECTION X / Part X（英文章节标记，不区分大小写）
  //     旧版正则5只支持 Chapter，遗漏 SECTION 和 Part
  /^(SECTION|Part)\s+\d+/i,
  // 18: 《书名》来自=第X章 xxx=== / 《书名》来自＝第X章 xxx===
  //     见于《万相天师》的"《万相天师》来自=第一章 祠堂挑战==="
  //     这是书名行+章节标记行的合并格式：书名号包裹书名后紧跟"来自="前缀的章节标记
  //     正则13只匹配行首"来自="，无法匹配行首是"《"的这种合并行
  //     支持 = 和 ＝（全角等号），尾部可能有 === 包裹也可能没有
  new RegExp(`^《.*》来自[=＝]\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*`),
  // === 以下为参考开源项目（legado/hectorqin/reader等）新增正则（索引 19+） ===
  // 19: 英文 Prologue/Epilogue/Foreword/Afterword/Preface/Postscript（序言/尾声/前言/后记）
  //     开源项目常见支持，翻译小说常用
  //     不区分大小写，匹配行首英文序言/尾声标记词
  //     见于英文小说和翻译小说的"Prologue"/"Epilogue"等格式
  /^(Prologue|Epilogue|Foreword|Afterword|Preface|Postscript)\b.*$/i,
  // 20: 中文数字+顿号：一、xxx / 二、xxx（CN_NUMBER_DUNHAO_PATTERN_INDEX = 20，需 prevLineEmpty 约束）
  //     开源项目常见支持，传统小说格式
  //     约束：中文数字1-3位 + 顿号 + 标题（2-30字，不含句号，避免匹配正文段落）
  //     容易误判正文中的"一、二、三、"列举，调用方应结合上下文（前一行是否为空行）做额外过滤
  /^[零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]{1,6}[、]\s*[^。]{2,30}$/,
  // 21: 罗马数字+点：I. xxx / II. xxx（ROMAN_NUMBER_PATTERN_INDEX = 21，需 prevLineEmpty 约束）
  //     开源项目常见支持，翻译小说格式
  //     约束：罗马数字1-5位 + 点/． + 标题（首字符为字母或中文，长度1-30）
  //     容易误判英文列举，调用方应结合上下文（前一行是否为空行）做额外过滤
  /^[IVXLC]{1,5}[.．]\s*[A-Za-z\u4e00-\u9fff].{1,30}$/,
  // 22: 英文章节变体：Book X / Vol. X / Volume X / Ch. X / Article X
  //     开源项目常见支持，补充 Chapter/SECTION/Part 之外的英文章节标记
  //     不区分大小写，匹配行首英文卷/章节标记+数字
  /^(Book|Vol\.?|Volume|Ch\.?|Article)\s+\d+/i,
  // === 以下为多语言正则（索引 23+），支持日文/韩文/英文文献/传统文学 ===
  // 23: 日文章节标记：第X話 / 第X章 / 第X節 / 第X項
  //     日文小说常用章节量词：話（U+8A71）/ 章（中日共用）/ 節（U+7BC0）/ 項（U+9805）
  //     数字支持：阿拉伯数字 0-9 + 汉字数字（中日共用，含日文"萬"）
  //     见于日文轻小说/传统文学的"第一話""第3章""第二節""第5項"等格式
  /^第[0-9一二三四五六七八九十百千萬零壹贰叁肆伍陆柒捌玖拾佰仟]+[話章节項].*$/m,
  // 24: 日文序言/尾声：プロローグ / エピローグ / 序章 / 終章
  //     プロローグ（prologue）/ エピローグ（epilogue）是日文音译外来语
  //     序章/終章 是日文原生序言/终章标记
  //     见于日文小说的"プロローグ""エピローグ""序章""終章"等格式
  /^(プロローグ|エピローグ|序章|終章).*$/m,
  // 25: 韩文章节标记：제X장 / 제X절 / 제X화
  //     韩文"제"=第，章节量词：장（章）/ 절（节）/ 화（话）
  //     数字支持：阿拉伯数字 0-9 + 韩文固有数字 일이삼사오육칠팔구십백천만
  //     见于韩文小说的"제1장""제일장""제2절""제3화"等格式
  /^제[0-9일이삼사오육칠팔구십백천만]+[장절화].*$/m,
  // 26: 韩文序论/结论：서론 / 결론 / 머리말 / 맺음말
  //     서론（绪论）/ 결론（结论）/ 머리말（前言）/ 맺음말（后记）
  //     见于韩文学术文献和小说的"서론""결론""머리말""맺음말"等格式
  /^(서론|결론|머리말|맺음말).*$/m,
  // 27: 英文学术文献：Paper X / Subsection X（Section 已由索引17覆盖）
  //     补充学术文献章节标记，Section 已在索引17（SECTION/Part，i 标志）覆盖
  //     不区分大小写，匹配行首学术文献标记+数字
  //     见于英文论文/学术文献的"Paper 1""Subsection 2.3"等格式
  /^(Paper|Subsection)\s+\d+/i,
  // 28: 英文论文结构：Abstract / References / Appendix / Acknowledgments
  //     学术论文常见结构标记，不区分大小写
  //     见于英文论文的"Abstract""References""Appendix A""Acknowledgments"等格式
  /^(Abstract|References|Appendix|Acknowledgments)\b.*$/i,
  // 29: 方括号包裹中文数字：【一】xxx / 【二】xxx / [一]xxx / [二]xxx / [一] / [终]
  //     见于文件a7328ca03387e4f7.txt 的"【一】【二】"格式
  //     见于文件dee6b88426046f73.txt 的"[一][二]"格式（方括号后无标题内容）
  //     支持：【】[] 两种方括号 + 中文数字1-6位或"终"字 + 可选标题内容
  //     约束：方括号内必须是中文/阿拉伯数字（1-6位）或"终"字，方括号后标题内容可选
  //     注意：单独的 [一] 行需要 prevLineEmpty 约束以减少误判（由调用方处理）
  new RegExp(`^[【\\[][${CN_NUM_CHARS}终]{1,6}[】\\]](?:.+)?$`),
  // 30: 章节目录 第X章 xxx / 章节目录第X章xxx（无空格）
  //     见于完美世界系列的"章节目录 第八百二十二章纷纷成神"格式
  //     "章节目录"是前缀，后跟标准"第X章"格式
  new RegExp(`^章节目录\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*`, 'm'),
  // 31: 英文 Act/Episode/Ep/Sec 缩写
  //     开源项目常见支持，翻译小说/剧本常用
  //     不区分大小写，匹配行首英文缩写+数字
  //     见于英文小说的"Act 1""Episode 2""Ep. 3""Sec 4"等格式
  /^(Act|Episode|Ep|Sec)\.?\s+\d+/i,
  // 32: 复合格式 第X章 章名，Y.第Z章 子章名
  //     一行中同时包含主章节标记和子章节标记，用逗号分隔
  //     如"第01章 章名，1.第1章 子章名" "第一章 xxx，2.第二节 yyy"
  //     正则2虽能匹配整行，但此正则专门识别复合格式以便 extractChapterTitle
  //     能正确拆分并只保留主章节部分作为标题
  //     约束：逗号后必须有"数字+分隔符+第X章/节/回"的子章节标记
  new RegExp(
    `^第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*[,，]\\s*\\d+[、.．：:]\\s*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*$`
  ),
  // 33: [正文 N xxx] / [正文 第X章 xxx] 方括号包裹的正文章节标记
  //     见于小说快捕制作的TXT：[正文 1 xxx]、[正文 3 末日？]、[正文 第一章 xxx] 等
  //     约束：方括号内必须以"正文"开头，后跟空格+内容，避免匹配[正文]无内容的情况
  /^\[正文\s+\S.*\]$/,
  // 34: [书名...第X章 xxx] 方括号包裹的含书名/卷名前缀的章节标记
  //     见于小说快捕制作的TXT：[仙魔变第一卷 帝国旅者 第一章 一路向北]
  //     [ 佣兵的战争正文 第一章 有准备的幸存者]
  //     约束：方括号内必须含"第X章/节/回"等章节标记，允许前面有书名/卷名/正文等前缀
  //     避免匹配纯书名方括号（如[阳神]）—— 要求方括号内有章节量词
  new RegExp(`^[【\\[]\\s*.*第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*[】\\]]$`),
  // 35: [书名正文 N、标题] / [书名 N、标题] 方括号包裹的数字+顿号章节标记
  //     见于小说快捕制作的TXT：[妖怪管理员正文 173、刀光剑影里品几分]
  //     约束：方括号内必须含中文书名（2+字）+可选"正文"+空格+数字+顿号+标题
  /^\[\s*[\u4e00-\u9fff]{2,}(正文)?\s+\d{1,4}、\s*\S.*\]$/,
  // 36: [书名正文 NO.N 标题] 方括号包裹的NO.数字章节标记
  //     见于小说快捕制作的TXT：[猛虎教师正文 NO.1 小霸王]
  //     约束：方括号内必须含中文书名（2+字）+可选"正文"+空格+NO.+数字+空格+标题
  /^\[\s*[\u4e00-\u9fff]{2,}(正文)?\s+NO\.\d{1,4}\s+\S.*\]$/,
  // 37: [书名 中文数字、标题] 方括号包裹的中文数字+顿号章节标记
  //     见于小说快捕制作的TXT：[特殊事件专案组 一、欢乐女神]
  //     约束：方括号内必须含中文书名（2+字）+空格+中文数字+顿号+标题
  /^\[\s*[\u4e00-\u9fff]{2,}\s+[零一二三四五六七八九十百千]{1,4}、\s*\S.*\]$/
] as const;

/** 纯数字章节正则在数组中的索引（需特殊处理以减少误判） */
export const PURE_NUMBER_PATTERN_INDEX = 6;

/** 数字+标点+标题正则在数组中的索引（需 prevLineEmpty 约束以减少误判）
 *  正则7匹配 "1、初入江湖" "12.觉醒" 等格式，但正文中编号列表也以此格式开头，
 *  误识别率99.5%（586误识别 vs 3真正章节标题），必须要求前一行是空行 */
export const NUMBER_PUNCTUATION_PATTERN_INDEX = 7;

/** 数字+章/节/回等正则在数组中的索引（需 prevLineEmpty 约束以减少误判）
 *  正则14匹配 "01章 xxx" 格式，但正文中 "10章=2万字" 等也会匹配，
 *  误识别率100%（2误识别 vs 0真正章节标题），要求前一行是空行 */
export const NUMBER_MEASURE_PATTERN_INDEX = 14;

/** 数字+空格+标题正则在数组中的索引（需 prevLineEmpty 约束以减少误判） */
export const PURE_NUMBER_SPACE_PATTERN_INDEX = 9;

/** 中文数字+顿号正则在数组中的索引（需 prevLineEmpty 约束以减少误判） */
export const CN_NUMBER_DUNHAO_PATTERN_INDEX = 20;

/** 罗马数字+点正则在数组中的索引（需 prevLineEmpty 约束以减少误判） */
export const ROMAN_NUMBER_PATTERN_INDEX = 21;

/**
 * 章节标题行首字符白名单正则（前置快速过滤）
 *
 * 性能优化：TXT 流式分章时对每行调用 isChapterLine / matchChapterTitle，
 * 原实现每行都跑 18 个正则，但正文段落占 95%+，且行首字符不在章节标题
 * 可能字符集内 → 先用单次正则检查行首字符，不在白名单则直接返回 false，
 * 跳过 18 次正则匹配，大幅降低 CPU 占用。
 *
 * 白名单推导：遍历 CHAPTER_PATTERNS 所有正则的 ^ 后第一个字符集合并集：
 * - 正则0（序/序章/.../正文卷?/外传）：序/楔/番/尾/前/后/引/上/中/下/正/外
 * - 正则1（卷X）：卷
 * - 正则2（第X章）：第
 * - 正则3（===第X章===）：=
 * - 正则4（―第X章― 破折号包裹）：―(U+2015) / —(U+2014 em dash) / -(U+002D)
 * - 正则5（Chapter X，i 标志）：C / c
 * - 正则6（纯数字，trim 后）：0-9
 * - 正则7（数字+标题）：0-9
 * - 正则8（【第X章】等包裹）：【 / [ / 『 / 《 / 「 / （ / (
 * - 正则9（0001 xxx 数字+空格）：0-9
 * - 正则10（通用装饰符包裹）：= / ― / — / * / ~ / ○ / ● / □ / ■ / ★ / ☆ / - / ·
 * - 正则11（单个破折号包裹）：― / — / -
 * - 正则12（·卷一）：·
 * - 正则13（来自=第X章）：来
 * - 正则14（数字+章）：0-9
 * - 正则15（正文 第X章）：正
 * - 正则16（括号数字）：（ / (
 * - 正则17（SECTION/Part，i 标志）：S / s / P / p
 * - 正则18（《书名》来自=第X章）：《
 * - 正则19（Prologue/Epilogue/...，i 标志）：P / p / E / e / F / f / A / a
 * - 正则20（中文数字+顿号）：一 / 二 / 三 / 四 / 五 / 六 / 七 / 八 / 九 / 十
 * - 正则21（罗马数字+点）：I / i / V / v / X / x / L / l / C / c
 * - 正则22（Book/Vol/Volume/Ch/Article，i 标志）：B / b / V / v / C / c / A / a
 * - 正则23（日文 第X話/章/節/項）：第（已含）
 * - 正则24（日文 プロローグ/エピローグ/序章/終章）：プ / エ / 序（已含） / 終
 * - 正则25（韩文 제X장/제X절/제X화）：제
 * - 正则26（韩文 서론/결론/머리말/맺음말）：서 / 결 / 머 / 맺
 * - 正则27（英文 Paper/Subsection，i 标志）：P / p / S / s
 * - 正则28（英文 Abstract/References/Appendix/Acknowledgments，i 标志）：A / a / R / r
 * - 正则29（方括号包裹中文数字）：【 / [（已含）
 * - 正则30（章节目录 第X章）：章
 * - 正则31（Act/Episode/Ep/Sec，i 标志）：A / a / E / e / S / s（已含）
 * - 正则32（复合格式 第X章...，Y.第Z章...）：第（已含）
 * 另含全角数字 ０-９(U+FF10..U+FF19)。
 *
 * 注意：调用方应传入已 trim 的行；若行首有前导空格，此过滤会跳过纯数字行
 * （正则6 /^\s*\d/ 可匹配前导空格），但当前所有调用方均传入 trim 后的行。
 */
export const CHAPTER_LINE_FIRST_CHAR_RE =
  /^[第章卷序楔番尾前后引上中下正外来·来★☆○●□■~《『「SsPpCcEeFfAaIiVvXxLlBbRr一二三四五六七八九十【\[（(\-―—=0-9０-９プエサコ終제서결머맺]/;

/* ==================== 预编译正则常量（性能优化：避免在流式分章循环内重复 new RegExp） ==================== */

/** 卷层级量词字符集（卷/篇/部/折/集/幕）——含多个章节的卷级标记 */
const VOLUME_MEASURE_CHARS = '卷篇部折集幕';

/** "书名+第X章"合并行检测：行首2+中文字符后跟"第X章"+空格+标题 */
const BOOK_PREFIX_CHAPTER_RE = new RegExp(`^[\\u4e00-\\u9fff]{2,}第[${CN_NUM_CHARS}]+[章回节]\\s+\\S`);
/** "第X章到"格式检测（作者的话"写到这了"，非章节标题） */
const CHAPTER_DAO_RE = new RegExp(`^第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}]到`);
/** "第X节课"格式检测（正文叙述"第一节课是..."，非章节标题） */
const CHAPTER_KE_RE = new RegExp(`^第[${CN_NUM_CHARS}]+节课`);
/** "书名+第X章"标题提取：提取"第X章..."部分，去除书名前缀 */
const BOOK_PREFIX_EXTRACT_RE = new RegExp(`^[\\u4e00-\\u9fff]{2,}(第[${CN_NUM_CHARS}]+[章回节].*)$`);
/** "书名/卷名+第X章"标题提取（含空格分隔，非贪婪匹配4+字前缀） */
const BOOK_PREFIX_SPACES_RE = new RegExp(
  `^[\\u4e00-\\u9fff\\s]{4,}?(第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}].*)$`
);
/** 纯卷标记："第X卷/篇/部/折/幕" 后无实质内容 */
const VOLUME_ONLY_RE1 = new RegExp(`^第[${CN_NUM_CHARS}]+[${VOLUME_MEASURE_CHARS}][\\s。·]*$`);
/** 纯卷标记："卷X/篇X/部X/折X/幕X" 后无实质内容 */
const VOLUME_ONLY_RE2 = new RegExp(`^[${VOLUME_MEASURE_CHARS}][${CN_NUM_CHARS}]+[\\s。·]*$`);
/** 卷标记带短副标题："第X卷/篇/部/折/幕" + 可选短副标题(≤50字) */
const VOLUME_WITH_SUBTITLE_RE = new RegExp(`^第[${CN_NUM_CHARS}]+[${VOLUME_MEASURE_CHARS}]([\\s。·]+.{0,50})?$`);
/** 卷标记前缀提取（用于 replace 去除"第X卷"前缀，提取副标题） */
const VOLUME_PREFIX_RE = new RegExp(`^第[${CN_NUM_CHARS}]+[${VOLUME_MEASURE_CHARS}]`);
/** "卷X/篇X" 格式（纯或带短副标题） */
const VOLUME_CJ_RE = new RegExp(`^[卷篇][${CN_NUM_CHARS}]+([\\s。·]+.{0,50})?$`);
/** "第X部分" 排除（"部分"中的"部"不是卷量词） */
const VOLUME_PART_RE = new RegExp(`^第[${CN_NUM_CHARS}]+部分`);
/** 超长行内嵌章节标记扫描（全局匹配，使用前需重置 lastIndex） */
export const EMBEDDED_CHAPTER_RE = new RegExp(
  `第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE_CHARS}][：:\\s\\u4e00-\\u9fff“”‘']`,
  'g'
);

/**
 * 判断一行是否是章节标题
 *
 * 按正则库顺序匹配，任一匹配则返回 true。
 * 注意：纯数字正则容易误判，此函数不做上下文过滤，
 * 调用方如需更精确的判断应使用内部 isChapterLine（含上下文）。
 *
 * 性能优化：先用 CHAPTER_LINE_FIRST_CHAR_RE 做行首字符白名单前置过滤，
 * 不在白名单的行（95%+ 正文段落）直接返回 false，跳过 18 次正则匹配。
 *
 * @param line 单行文本（建议已 trim）
 * @returns 是否为章节标题
 */
export function matchChapterTitle(line: string): boolean {
  // "书名+第X章"合并行：如"神级万界外卖员第一章 系统激活 天下在手"
  //   行首是中文字符（书名），不在 CHAPTER_LINE_FIRST_CHAR_RE 白名单中，
  //   需在白名单过滤之前检查，否则会被直接跳过
  //   约束：第X章前至少2个中文字符（书名），后面有空格+标题，整行<60字
  if (BOOK_PREFIX_CHAPTER_RE.test(line.trim())) {
    return true;
  }

  // 前置快速过滤：行首字符不在白名单中，直接返回 false
  if (!CHAPTER_LINE_FIRST_CHAR_RE.test(line)) return false;

  for (const pattern of CHAPTER_PATTERNS) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * 提取干净的章节标题
 *
 * 处理步骤：
 * - 去除行首尾空白
 * - 去除包裹符号（【】[]（）()《》『』「」 等）
 * - 去除等号包裹（===第X章 xxx=== → 第X章 xxx）
 * - 去除破折号包裹（―第X章 xxx― → 第X章 xxx）
 * - 去除通用装饰符包裹（★第X章★ / ○第X章○ / ~~~~第X章~~~~ → 第X章）
 * - 去除"来自="前缀（来自=第X章 xxx → 第X章 xxx）
 * - 去除复合格式子章节部分（第X章 章名，Y.第Z章 子章名 → 第X章 章名）
 * - 限制标题长度（避免超长行被误判时影响显示）
 *
 * @param line 原始章节标题行
 * @returns 干净的章节标题
 */
export function extractChapterTitle(line: string): string {
  let title = line.trim();

  // 去除"章节目录"前缀：章节目录 第X章 xxx → 第X章 xxx
  //    见于完美世界系列等小说的"章节目录 第八百二十二章纷纷成神"格式
  //    正则30匹配该格式为章节标题，但标题中不应保留"章节目录"前缀
  title = title.replace(/^章节目录\s*/, '');

  // 清理HTML标签（TXT中可能混入 </div> <br> <p> 等标签）
  //    见于部分TXT文件章节标题行尾混入HTML标签
  title = title.replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
  if (!title) return title;

  // 去除包裹符号：【...】[...](...)（...）《...》『...』「...」
  //    新增（相比旧版）：《》『』「」 三种包裹符
  const wrapMatch = title.match(/^[【\[『《「（(](.+)[】\]』》」）)]$/);
  if (wrapMatch) {
    title = wrapMatch[1].trim();
  }

  // 去除"正文 "前缀：[正文 3 末日？] → 3 末日？ / 正文 第一章 xxx → 第一章 xxx
  //    见于小说快捕TXT的[正文 N xxx]格式，剥掉[]后保留"正文 N xxx"
  //    "正文"是标记词不是章节标题的一部分，应去除
  title = title.replace(/^正文\s+/, '');

  // 去除等号包裹：===第X章 xxx=== → 第X章 xxx
  const eqWrapMatch = title.match(/^={2,}\s*(.+?)\s*={2,}$/);
  if (eqWrapMatch) {
    title = eqWrapMatch[1].trim();
  }

  // 去除破折号包裹：―第X章 xxx― → 第X章 xxx
  //    支持 1+ 个破折号（单个和多个都处理）
  const dashWrapMatch = title.match(/^[―—\-]{1,}\s*(.+?)\s*[―—\-]{1,}$/);
  if (dashWrapMatch) {
    title = dashWrapMatch[1].trim();
  }

  // 去除通用装饰符包裹：★第X章★ / ○第X章○ / ~~~~第X章~~~~ → 第X章
  //    覆盖：= ― — * ~ ○ ● □ ■ ★ ☆ - · 等2+次重复
  const decorWrapMatch = title.match(/^[=―—*~○●□■★☆\-·]{2,}\s*(.+?)\s*[=―—*~○●□■★☆\-·]{2,}$/);
  if (decorWrapMatch) {
    title = decorWrapMatch[1].trim();
  }

  // 去除"来自="前缀：来自=第X章 xxx → 第X章 xxx
  //    支持 = 和 ＝（全角等号）
  const fromPrefixMatch = title.match(/^来自[=＝]\s*(.+)$/);
  if (fromPrefixMatch) {
    title = fromPrefixMatch[1].trim();
  }

  // 去除"《书名》来自="前缀：《书名》来自=第X章 xxx=== → 第X章 xxx===
  //    见于《万相天师》的"《万相天师》来自=第一章 祠堂挑战==="
  //    先剥掉"《书名》来自="前缀，剩余的尾部 === 由下方等号包裹逻辑处理
  //    支持 = 和 ＝（全角等号）
  const bookFromPrefixMatch = title.match(/^《.*》来自[=＝]\s*(.+)$/);
  if (bookFromPrefixMatch) {
    title = bookFromPrefixMatch[1].trim();
    // 前缀剥离后可能残留尾部装饰符（如 ===），此时上方等号/装饰符包裹逻辑
    // 已执行过（要求行首行尾都是装饰符），无法匹配单边尾部装饰符
    // 这里单独清理尾部 2+ 个等号/破折号/装饰符
    title = title.replace(/[=＝―—\-~*○●□■★☆·]{2,}$/, '').trim();
  }

  // 去除"正文"前缀：正文 第X章 xxx → 第X章 xxx
  //    仅当"正文"后紧跟"第"时处理，避免误删"正文"开头的正常标题
  const contentPrefixMatch = title.match(/^正文\s*(第.+)$/);
  if (contentPrefixMatch) {
    title = contentPrefixMatch[1].trim();
  }

  // 去除"书名+第X章"中的书名前缀：神级万界外卖员第一章 xxx → 第一章 xxx
  //    见于神级万界外卖员等小说，章节标题行首紧跟书名+第X章无空格分隔
  //    约束：第X章前至少2个中文字符（书名），避免误删"第X章"本身
  const bookPrefixMatch = title.match(BOOK_PREFIX_EXTRACT_RE);
  if (bookPrefixMatch) {
    title = bookPrefixMatch[1].trim();
  }

  // 去除"书名+卷名+第X章"中的书名/卷名前缀（含空格分隔）
  //    见于小说快捕TXT：仙魔变第一卷 帝国旅者 第一章 一路向北 → 第一章 一路向北
  //    佣兵的战争正文 第一章 有准备的幸存者 → 第一章 有准备的幸存者
  //    约束：字符串中必须含"第X章/节/回"章节标记，且标记前有2+字中文前缀
  const bookPrefixWithSpacesMatch = title.match(BOOK_PREFIX_SPACES_RE);
  if (bookPrefixWithSpacesMatch) {
    title = bookPrefixWithSpacesMatch[1].trim();
  }

  // 去除复合格式子章节部分：第X章 章名，Y.第Z章 子章名 → 第X章 章名
  //    见于部分小说的"第01章 章名，1.第1章 子章名"格式
  //    正则32匹配该格式为章节标题，但标题中不应保留子章节部分
  //    约束：逗号后必须有"数字+分隔符+第X章/节/回"的子章节标记才清理
  const compositeMatch = title.match(
    /^(第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9]+[章回节卷部折话集篇幕].*?)[,，]\s*\d+[、.．：:]\s*第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9]+[章回节卷部折话集篇幕]/
  );
  if (compositeMatch) {
    title = compositeMatch[1].trim();
  }

  // 去除英文序言/尾声标记的行首装饰（Prologue: xxx → Prologue / Epilogue. xxx → Epilogue）
  //    保留标记词本身作为标题，去除尾部冒号/点+内容
  //    见于翻译小说的"Prologue: xxx"格式
  const prologueMatch = title.match(/^(Prologue|Epilogue|Foreword|Afterword|Preface|Postscript)\b[:：.]?\s*(.*)$/i);
  if (prologueMatch && prologueMatch[2]) {
    // 如果标记词后有内容，保留"标记词: 内容"格式（去掉多余空格）
    title = `${prologueMatch[1]}: ${prologueMatch[2].trim()}`;
  }

  // 去除数字前缀：章节标题中的数字序号前缀应去除，避免与目录侧边栏自动序号重复
  //    "1. 第一章 远古神墓" → "第一章 远古神墓"
  //    "1、初入江湖" → "初入江湖"
  //    "12.觉醒" → "觉醒"
  //    "01章 xxx" → "xxx"
  //    "0001 鸙山余魂" → "鸙山余魂"
  //    但 "第一章 远古神墓" 不受影响（"第" 开头）
  //    顺序：先匹配更具体的（数字+标点、数字+量词），再匹配更通用的（数字+空格）
  // P0-4修复：改用 while 循环反复去除前缀，处理 "1. 1.第一章" 这类双重/多重前缀
  //    原代码只执行一次 replace，"1. 1.第一章" 只去掉第一个 "1. "，结果仍为 "1.第一章"
  //    循环直到标题不再变化，确保所有前缀都被去除
  let prevTitle = '';
  while (prevTitle !== title) {
    prevTitle = title;
    title = title.replace(/^\d{1,4}[、.．：:，,]\s*/, '');
    title = title.replace(/^\d{1,4}[章节回话部折篇]\s*/, '');
    title = title.replace(/^\d{1,5}\s+/, '');
  }
  title = title.trim();
  if (!title) return title;

  // 限制标题长度（避免超长行被误判为章节标题时影响显示）
  const MAX_TITLE_LENGTH = 100;
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH);
  }

  return title;
}
/**
 * 判断一行是否是纯卷级标记（不含章/回/节/话/集/篇）
 *
 * 纯卷级标记示例：
 * - "第一卷" "第二卷" "卷一" "卷二"
 * - "上卷" "中卷" "下卷"
 * - "第一卷 " (带尾随空格)
 *
 * 非纯卷级标记（不匹配，应作为章节标题）：
 * - "第一卷 初入江湖" (卷标记后有标题内容)
 * - "第一章 XXX" (含"章")
 * - "卷一 楔子" (卷标记后有标题内容)
 *
 * 用途：当小说存在"第一卷 → 第一章"层级时，"第一卷"本身只是卷分隔标记，
 * 不应作为独立章节（否则会生成只有标题没有正文的空章节）。
 * 在 txt-parser.ts 分章逻辑中，对匹配到章节标题的行额外调用本函数，
 * 若返回 true 则跳过该行，不作为独立章节创建。
 *
 * @param line 单行文本（建议已 trim）
 * @returns 是否为纯卷级标记
 */
export function isVolumeOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 匹配 "第X卷/篇/部/折/幕" 格式（X 为中文数字或阿拉伯数字），且后面没有实质性内容
  // "第一卷" → true, "第一篇" → true, "第一部" → true, "第一折" → true, "第一幕" → true
  // "第一卷 " → true, "第一卷 初入江湖" → false
  if (VOLUME_ONLY_RE1.test(trimmed)) return true;

  // 匹配 "卷X/篇X/部X/折X/幕X" 格式（如 "卷一" "篇二" "部12"），且后面没有实质性内容
  if (VOLUME_ONLY_RE2.test(trimmed)) return true;

  // 匹配 "上卷/中卷/下卷" "上部/中部/下部" "上篇/中篇/下篇" 等单独的卷标记
  if (/^[上中下][卷部篇][\s。·]*$/.test(trimmed)) return true;

  return false;
}
/**
 * 判断一行是否是卷级标记（含纯卷标记和带副标题的卷标记）
 *
 * 与 isVolumeOnlyLine 的区别：
 * - isVolumeOnlyLine 只匹配纯卷标记（如"第一卷"），不含带副标题的行
 * - isVolumeLine 额外匹配带短副标题的卷标记（如"第一卷 初入江湖"），副标题≤50字
 *
 * 卷级标记示例（返回 true）：
 * - "第一卷" "第二卷" "卷一" "卷二" "上卷" "中卷" "下卷"
 * - "第一卷 初入江湖" "卷一 楔子" "上卷 风起"
 * - "正文卷" "正文卷 楔子"
 * - "===第一卷===" "·卷一 误入乱世·"（装饰符包裹的卷标记）
 *
 * 非卷级标记（返回 false）：
 * - "第一章 XXX" "第二节 XXX"（量词是章/节，不是卷）
 * - "第一卷 这是一个非常长的段落..."（副标题超过50字，更可能是章节标题）
 *
 * @param line 单行文本（建议已 trim）
 * @returns 是否为卷级标记
 */
export function isVolumeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 去除行首行尾装饰符（等号、破折号、星号、间隔号等），以识别装饰符包裹的卷标记
  const stripped = trimmed
    .replace(/^[=―—\-~*○●□■★☆·\s]+/, '')
    .replace(/[=―—\-~*○●□■★☆·\s]+$/, '')
    .trim();

  if (!stripped) return false;

  // 排除：行中同时包含章节量词（章/回/节/话）时，不视为卷标记
  //   "第一卷 第一章 祖训" → false（卷+章合并行，应作为章节标题处理）
  //   "第十卷 百圣大战 第八章 道非道" → false（同上）
  //   "第一篇 第一章" → false（同上）
  //   "第一卷 初入江湖" → true（副标题不含章节量词，是卷标记）
  //   注意：篇/部/折/幕本身是卷层级量词，不排除
  if (/[章回节话]/.test(stripped)) return false;

  // 排除 "第X部分" 格式（"部分"中的"部"不是卷量词）
  //   "第三部分是另一段诡异的舞蹈..." → false（正文，非卷标记）
  if (VOLUME_PART_RE.test(stripped)) return false;

  // 1. 匹配 "第X卷/篇/部/折/幕" 格式（纯卷标记或带短副标题，副标题≤50字）
  //    "第一卷" → true, "第一篇 狼" → true, "第一部 初入江湖" → true
  //    "第一折" → true, "第一幕" → true
  //    "第一卷 这是一个非常长的段落..." → false（副标题过长）
  if (VOLUME_WITH_SUBTITLE_RE.test(stripped)) {
    // 排除副标题包含句号（"第一卷终。第二卷：..." 非卷标记）
    //   合法卷标记副标题不包含句号
    const afterMeasure = stripped.replace(VOLUME_PREFIX_RE, '');
    if (afterMeasure.includes('。')) return false;
    // 排除副标题以"是"开头（"第一卷是京察风云！" 非卷标记）
    if (/^是/.test(afterMeasure)) return false;
    return true;
  }

  // 2. 匹配 "卷X/篇X" 格式（如 "卷一" "篇二"），纯或带短副标题
  //    只允许"卷""篇"开头，不匹配"部X""折X""幕X"（易与正文量词混淆）
  if (VOLUME_CJ_RE.test(stripped)) return true;

  // 3. 匹配 "上卷/中卷/下卷" "上部/中部/下部" "上篇/中篇/下篇" 等卷标记（纯或带短副标题）
  //    副标题前必须有分隔符（空格/装饰符），避免 "下部天神！" 等误匹配
  if (/^[上中下][卷部篇]([\s。·]+.{0,50})?$/.test(stripped)) return true;

  // 4. 匹配 "正文卷" 格式（纯或带短副标题）
  if (/^正文卷[\s。·]*.{0,50}$/.test(stripped)) return true;

  return false;
}

/**
 * 从卷级标记行中提取卷标题
 *
 * 处理步骤：
 * - 去除行首尾装饰符（等号、破折号、间隔号等）
 * - 返回剩余的文本作为卷标题
 *
 * 示例：
 * - "第一卷" → "第一卷"
 * - "第一卷 初入江湖" → "第一卷 初入江湖"
 * - "===第一卷===" → "第一卷"
 * - "·卷一 误入乱世·" → "卷一 误入乱世"
 * - "第一章 xxx" → null（不是卷标记）
 *
 * @param line 原始行文本
 * @returns 卷标题，或 null（如果不是卷标记）
 */
export function extractVolumeTitle(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (!isVolumeLine(trimmed)) return null;

  // 去除行首行尾装饰符
  const stripped = trimmed
    .replace(/^[=―—\-~*○●□■★☆·\s]+/, '')
    .replace(/[=―—\-~*○●□■★☆·\s]+$/, '')
    .trim();

  if (!stripped) return null;

  // 限制卷标题长度
  const MAX_VOLUME_TITLE_LENGTH = 50;
  if (stripped.length > MAX_VOLUME_TITLE_LENGTH) {
    return stripped.slice(0, MAX_VOLUME_TITLE_LENGTH);
  }

  return stripped;
}

/**
 * 从章节标题中提取卷/篇信息
 *
 * 当章节标题包含卷信息时（如"第一卷 走出神墓 第一章 远古神墓"），
 * 将卷信息和章节标题分离，使卷信息存入 volume 字段而非混在标题中。
 *
 * @returns { volume, remainingTitle } 或 null（标题中无卷信息）
 */
export function extractVolumeFromTitle(title: string): { volume: string; remainingTitle: string } | null {
  const VOLUME_MEASURE = '卷篇部折集幕';
  const CHAPTER_MEASURE = '章回节话';

  // 匹配 "第X卷/篇/部/折/集/幕 ... 第Y章/回/节/话 ..." 格式
  //   卷信息 = 从开头到"第Y章"之前
  //   剩余标题 = "第Y章..."部分
  const volPattern = new RegExp(`^第[${CN_NUM_CHARS}]+[${VOLUME_MEASURE}].*?第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE}]`);
  if (!volPattern.test(title)) return null;

  // 找到第二个"第...章/回/节"的位置（即章节标记的起始）
  const chapterMarkPattern = new RegExp(`第[${CN_NUM_CHARS}]+[${CHAPTER_MEASURE}]`, 'g');
  chapterMarkPattern.lastIndex = 0;
  // 跳过第一个匹配（卷标记中的"第X卷"不会被匹配，因为它用的是卷量词）
  // 实际上"第X卷"不会被 chapterMarkPattern 匹配（卷量词不在 CHAPTER_MEASURE 中）
  // 所以第一个匹配就是章节标记
  const match = chapterMarkPattern.exec(title);
  if (!match || match.index === 0) return null;

  const volume = title.slice(0, match.index).trim();
  const remainingTitle = title.slice(match.index).trim();

  // 卷信息太短或太长都不合理
  if (volume.length < 2 || volume.length > 50) return null;

  return { volume, remainingTitle };
}

/* ==================== 智能章节判断 ==================== */

/**
 * 结合上下文判断一行是否为章节标题
 *
 * 对纯数字正则和数字+空格+标题正则加 prevLineEmpty 约束以减少误判
 * （正文中独立的数字行前后通常是空行，且数字范围限制在 1~9999）
 *
 * @param line 行内容
 * @param prevLineEmpty 前一行是否为空行（文件开头视为 true）
 */
export function isChapterLine(line: string, prevLineEmpty: boolean): boolean {
  // 先 trim 行内容再匹配（章节标题行首可能有空格）
  let trimmed = line.trim();
  if (!trimmed) return false;

  // 清理行首不可见字符（零宽空格 U+200B-U+200F、BOM U+FEFF 等，trim() 不去除）
  //    见于部分 TXT 文件行首混入零宽字符导致行首字符不在白名单→漏判
  trimmed = trimmed.replace(/^[\u200B-\u200F\uFEFF\u200C]+/, '');

  // 全角数字转半角（０-９ U+FF10-U+FF19 → 0-9）
  //    \d 只匹配 ASCII 数字，全角数字通过白名单但正则不匹配→漏判
  //    统一转换为半角后所有正则都能正确匹配
  trimmed = trimmed.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

  // 清理HTML标签（TXT中可能混入 </div> <br> <p> 等标签）
  //    见于部分TXT文件章节标题行尾混入HTML标签，如"第四章到，请允许这章字数少一点吧，太晚了。</div>"
  trimmed = trimmed.replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
  if (!trimmed) return false;

  // "书名/篇名+第X章"合并行：如"蝴蝶之翼 第一章 夜瞳" "无奈的穿越篇 第一章 非常俗烂的死掉吧"
  //   行首是中文字符（书名/篇名），不在 CHAPTER_LINE_FIRST_CHAR_RE 白名单中，
  //   需在白名单过滤之前检查，否则会被直接跳过
  //   约束：第X章前至少2个中文字符（书名/篇名），后面有空格+标题，整行<60字
  //   书名与"第X章"之间可有可无空格（"蝴蝶之翼 第一章" / "神级万界外卖员第一章"）
  //   长度限制≤60字避免匹配超长行（如异界之板砖横行375523字行以"第一卷 第一章"开头）
  if (
    trimmed.length <= 60 &&
    new RegExp(`^[\\u4e00-\\u9fff]{2,}\\s*第[${CN_NUM_CHARS}]+[章回节]\\s+\\S`).test(trimmed)
  ) {
    return true;
  }

  // 全局标题长度限制：超过60字的行几乎不可能是章节标题
  //    见于长生界/吞噬星空/七界传说等小说正文中以"第X卷"开头的长段落被误判
  //    原100字限制仍会让正文段落通过（如"第二十七篇 第四绝地　　'燃烧神力秘术？'..."）
  if (trimmed.length > 60) return false;

  // 正文特征排除：含句号且不是标准"第X章"格式 → 排除
  //    正文章节标题不会含句号（。），含句号说明是正文段落
  //    但"序章。""终章。"等短标题例外（≤6字且以句号结尾）
  if (trimmed.includes('。') && trimmed.length > 6) return false;

  // 作者话标记检测：包含这些标记的行不是章节标题
  //    "(未完待续" "(~^~)" "补更" 等是作者更新提示的常见标记
  //    见于"第二章还是放在白天。(未完待续~^~)" "第二章中午更新。(未完待续~^~)"等
  //    这些行虽然以"第X章"开头，但实际是作者的更新提示，不是章节标题
  if (/\(未完待续|未完待续|\(~\^~\)|~\^~|补更/.test(trimmed)) return false;

  // 前置快速过滤：行首字符不在白名单中，直接返回 false
  // 性能优化：正文段落占 95%+，行首字符不在章节标题可能字符集内 →
  // 跳过 10 次正则匹配，大幅降低流式分章 CPU 占用
  if (!CHAPTER_LINE_FIRST_CHAR_RE.test(trimmed)) return false;

  // "第X章到"格式检测：拒绝作者的话被误判为章节标题
  //    "第一章到，今天我会一直努力..." 被正则2匹配为章节标题，
  //    但"到"表示"写到这了"，后面是作者求月票的话，不是真正的章节标题
  //    实际上"第X章到"格式几乎100%是作者的话（"写到这了"的意思），
  //    真正的章节标题不会在量词后紧跟"到"字。
  //    只要匹配到"第X[量词]到"格式且"到"后面有内容，直接视为作者的话
  if (CHAPTER_DAO_RE.test(trimmed)) {
    const daoIdx = trimmed.indexOf('到');
    const afterDao = trimmed.substring(daoIdx + 1);
    // "到"后面有任意内容（哪怕只有1个字），都视为作者的话
    if (afterDao.length > 0) return false;
  }

  // "第X节课"格式检测：拒绝正文中的"第几节课"被误判为章节标题
  //    "第一节课是八点上课..." 被正则2匹配为章节标题（"第一" + "节" + "课"），
  //    但这是正文中的叙述，不是章节标题
  //    真正的章节标题不会在"节"量词后紧跟"课"字
  //    见于星戒.txt的"第一节课是八点上课"误判
  if (CHAPTER_KE_RE.test(trimmed)) {
    return false;
  }

  // 需要上下文约束的正则索引集合
  //   纯数字 + 数字标点标题 + 数字章量词 + 数字空格标题 + 中文数字顿号 + 罗马数字点
  //   这些正则容易误判正文中的数字行/编号列表，需要前一行是空行作为额外约束
  const contextDependentIndexes = new Set([
    PURE_NUMBER_PATTERN_INDEX,
    NUMBER_PUNCTUATION_PATTERN_INDEX,
    NUMBER_MEASURE_PATTERN_INDEX,
    PURE_NUMBER_SPACE_PATTERN_INDEX,
    CN_NUMBER_DUNHAO_PATTERN_INDEX,
    ROMAN_NUMBER_PATTERN_INDEX
  ]);

  // 非上下文依赖正则：直接匹配
  for (let i = 0; i < CHAPTER_PATTERNS.length; i++) {
    if (contextDependentIndexes.has(i)) continue;
    if (CHAPTER_PATTERNS[i].test(trimmed)) return true;
  }
  // 纯数字正则：需要前一行是空行（减少误判）
  if (prevLineEmpty && CHAPTER_PATTERNS[PURE_NUMBER_PATTERN_INDEX].test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= 9999) return true;
  }
  // 数字+标点+标题正则（如"1、初入江湖" "12.觉醒"）：需要前一行是空行
  //   误识别率99.5%（586误识别 vs 3真正章节标题），正文编号列表几乎总是紧跟上行
  //   要求前一行是空行可有效区分：章节标题前通常有空行，编号列表前通常是正文
  if (prevLineEmpty && CHAPTER_PATTERNS[NUMBER_PUNCTUATION_PATTERN_INDEX].test(trimmed)) {
    // 标题长度限制：数字+标点后的标题内容不超过50字
    //   "1.萧晨马上将回返长生大陆，那么回返肯定会有千般的错综复杂的是来等着他..."
    //   是正文编号列表不是章节标题（长生界97个误判）
    const titleContent = trimmed.replace(/^\d{1,4}[、.．：:，,]\s*/, '');
    if (titleContent.length <= 50) {
      // Q&A列表特征检测：番外篇中的问答列表不是章节标题
      //   "1.古石碑之谜：石碑上的功法为何人所创？为什么要把功法留在石碑上？剩余石碑在那？"
      //   是Q&A列表项不是章节标题（长生界76个误判）
      // 特征1：标题以问号结尾（Q&A列表项通常以问号结尾）
      // 特征2：标题包含2个以上问号（Q&A列表项通常有多个问号）
      const questionMarkCount = (titleContent.match(/[？?]/g) || []).length;
      if (questionMarkCount >= 2) return false; // 多个问号是Q&A列表
      if (/[？?]$/.test(titleContent)) return false; // 以问号结尾是Q&A列表项
      return true;
    }
    // 超过50字的可能是正文编号列表，不视为章节标题
  }
  // 数字+章/节/回等正则（如"01章 xxx"）：需要前一行是空行
  //   误识别率100%（2误识别 vs 0真正章节标题），正文中"10章=2万字"等也会匹配
  if (prevLineEmpty && CHAPTER_PATTERNS[NUMBER_MEASURE_PATTERN_INDEX].test(trimmed)) {
    return true;
  }
  // 数字+空格+标题正则
  // 分层判断：
  // - "3位以上数字+空格+中文标题"：误判概率极低，不需要 prevLineEmpty 约束
  //   见于《北朝帝业》"0001 鸙山余魂"格式（1385章全部前一行非空行，prevLineEmpty 约束导致全部漏判）
  // - "1-2位数字+空格+任意标题"：保留 prevLineEmpty 约束（防止误判正文中的数字列表行）
  if (CHAPTER_PATTERNS[PURE_NUMBER_SPACE_PATTERN_INDEX].test(trimmed)) {
    // 检查是否是"3位以上数字+空格+中文标题"格式
    const numSpaceMatch = trimmed.match(/^(\d{3,5})\s+([\u4e00-\u9fff])/);
    if (numSpaceMatch) {
      // 3位以上数字+中文标题：误判概率极低，直接返回 true
      return true;
    }
    // 其他情况（1-2位数字或非中文标题）：需要前一行是空行
    if (prevLineEmpty) {
      return true;
    }
  }
  // 中文数字+顿号正则：需要前一行是空行（减少误判）
  if (prevLineEmpty && CHAPTER_PATTERNS[CN_NUMBER_DUNHAO_PATTERN_INDEX].test(trimmed)) {
    return true;
  }
  // 罗马数字+点正则：需要前一行是空行（减少误判）
  if (prevLineEmpty && CHAPTER_PATTERNS[ROMAN_NUMBER_PATTERN_INDEX].test(trimmed)) {
    return true;
  }

  // "书名+第X章"合并行：如"神级万界外卖员第一章 系统激活 天下在手"
  //   见于神级万界外卖员L6，书名紧跟"第X章"无空格分隔
  //   约束：第X章前至少2个中文字符（书名），后面有空格+标题，整行<60字
  if (BOOK_PREFIX_CHAPTER_RE.test(trimmed)) {
    return true;
  }

  return false;
}
