/**
 * 文件名系列信息提取（通用，格式无关）
 *
 * 背景（用户投诉：comic 的提取分析遗漏，54 本"哆啦A梦[大长篇][台版]"重名无法区分）：
 * 无内嵌元数据（ComicInfo.xml / PDF Info / EPUB OPF）的系列书——尤其是 PDF 漫画——
 * 在书架内 title 完全相同无法区分。文件名中普遍携带卷号模式，是唯一可靠的区分线索。
 *
 * 实测模式（来自 data/youdu.db custom_meta.original_filename）：
 * - `哆啦A梦[大长篇][台版]_01 大雄的恐龙.pdf` → series=`哆啦A梦[大长篇][台版]`, number=1
 * - `21世纪小福星_01.pdf`                        → series=`21世纪小福星`, number=1
 * - `SF短篇集_01.mobi`                          → series=`SF短篇集`, number=1
 * - `藤子F不二雄大全集-哆啦A梦大长篇_01.pdf`     → series=`藤子F不二雄大全集-哆啦A梦大长篇`, number=1
 *
 * 设计原则：
 * - 通用文件名解析，非 comic 专属——txt/epub/mobi/pdf 系列书同样受益
 * - 所有模式锚定**尾部**（卷号在文件名尾部），避免书名中间数字（如"三体3：死神永生"）误判
 * - 分隔符数字（_01/-01）后允许"空格+副标题"（如"…_01 大雄的恐龙"）
 * - 4 位数字落在 1900-2099 视为年份排除（`xxx_2008` 不当卷号）
 * - 未命中任何模式返回 null（不强行拆分单行本）
 *
 * 导出：
 * - extractSeriesFromFilename(fileName): ExtractedSeries | null
 * - parseChineseVolumeNumber(s): number | null（中文数字卷号，一~九十九）
 */

/** 文件名提取的系列信息 */
export interface ExtractedSeries {
  /** 系列名（已去除卷号与尾部分隔符，如"哆啦A梦[大长篇][台版]"） */
  series: string;
  /** 系列内序号（卷号，1 起始） */
  number: number;
}

/** 卷号数字上限（4 位；超过视为异常编号不识别） */
const MAX_VOLUME_NUMBER = 9999;

/** 年份区间（4 位数字落在此区间视为出版年份而非卷号） */
const YEAR_RANGE = { min: 1900, max: 2099 };

/**
 * 中文数字卷号解析（支持 零/一~九十九，含"两""十""百"以内的常见组合）
 *
 * 覆盖"第一卷"~"第九十九卷"等绝大多数实体书卷号；超范围（如"一百零三"）
 * 返回 null，调用方按未识别处理（不误判优于漏判）。
 *
 * @param s 中文数字串（如"十二"）
 * @returns 对应数值，超范围返回 null
 */
export function parseChineseVolumeNumber(s: string): number | null {
  const digits: Record<string, number> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s in digits) return digits[s];
  // 十位组合："十"/"十X"/"X十"/"X十Y"
  const m = s.match(/^([一二两三四五六七八九]?)十([一二两三四五六七八九]?)$/);
  if (m) {
    const tens = m[1] ? digits[m[1]] : 1;
    const ones = m[2] ? digits[m[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

/**
 * 校验卷号数字的合理性
 *
 * @param n 待校验数字
 * @returns 合理（≥1 且非年份形态）返回 true
 */
function isValidVolumeNumber(n: number): boolean {
  if (!Number.isFinite(n) || n < 1 || n > MAX_VOLUME_NUMBER) return false;
  // 4 位数字落在年份区间视为出版年份（如 xxx_2008），排除
  if (n >= YEAR_RANGE.min && n <= YEAR_RANGE.max) return false;
  return true;
}

/** 中文数字字符类（卷号用） */
const CN_NUM_CLASS = '0-9一二三四五六七八九十百零两';

/**
 * 尾部卷号模式库（按信号强度排序，逐个尝试，首个命中即返回）
 *
 * 每个模式捕获两段：第 1 组 = 系列名前缀，第 2 组 = 卷号数字（或中文数字，flag 标记）。
 * 约定：卷号数字后必须紧跟空白（副标题）或结尾，防止截断多位数字。
 */
const VOLUME_PATTERNS: Array<{ re: RegExp; chinese: boolean }> = [
  // A. 分隔符 + 数字：xxx_01 / xxx-01 / xxx·01（数字后可跟"空格+副标题"，分隔符前可有空格）
  { re: /^(\S.*?)[\s]*[_\-–—·][\s]*(\d{1,4})(?=\s|$)/, chinese: false },
  // B. 中文卷号：第1卷/第一卷/第 2 册（数字或中文数字，可后跟副标题）
  { re: new RegExp(`^(\\S.*?)[\\s]*第[\\s]*([${CN_NUM_CLASS}]{1,8})[\\s]*[卷册](?=[\\s（(·:：]|$)`), chinese: true },
  // C. 卷/册 + 数字（无"第"）：xxx - 卷01 / xxx卷12
  { re: /^(\S.*?)[\s]*[卷册][\s]*(\d{1,4})(?=\s|$)/, chinese: false },
  // D. 英文卷号：xxx vol1 / xxx vol.1 / xxx v01（vol/v 前必须有分隔符或空白，防止"Dev 2"误判）
  { re: /^(\S.*?)[\s_\-·]+(?:vol\.?|v)[\s]*(\d{1,4})(?=\s|$)/i, chinese: false },
  // E. 括号卷号：xxx（1）/ xxx(2)（全角/半角，括号后可跟内容）
  { re: /^(\S.*?)[\s]*[（(][\s]*(\d{1,4})[\s]*[)）]/, chinese: false },
  // F. 尾部紧贴裸数字：大长篇全集01 / 三体2（数字严格在结尾且与系列名间无空白，
  //    series 末字符须非数字——防"Dev 2"/"Windows 11"空格形态误判；含空格的裸数字不识别）
  { re: /^(\D.*[^\d\s])(\d{1,4})$/, chinese: false }
];

/**
 * 从文件名提取系列名与卷号
 *
 * @param fileName 文件名（含或不含扩展名均可，内部先剥离扩展名）
 * @returns 命中模式返回 { series, number }，否则 null
 */
export function extractSeriesFromFilename(fileName: string): ExtractedSeries | null {
  if (!fileName || typeof fileName !== 'string') return null;

  // 剥离扩展名与首尾空白（支持 .tar.gz 类双扩展名的常规场景取最后一段）
  const name = fileName.replace(/\.[^./\\]+$/, '').trim();
  if (!name) return null;

  for (const { re, chinese } of VOLUME_PATTERNS) {
    const m = name.match(re);
    if (!m) continue;

    // 解析卷号数字（阿拉伯或中文）
    let number: number;
    if (chinese) {
      const parsed = parseChineseVolumeNumber(m[2]) ?? (Number.isFinite(Number(m[2])) ? Number(m[2]) : NaN);
      if (!Number.isFinite(parsed)) continue;
      number = parsed;
    } else {
      number = Number(m[2]);
    }
    if (!isValidVolumeNumber(number)) continue;

    // 系列名：剥离尾部分隔符/空白后须非空
    const series = m[1]
      .replace(/[\s_\-–—·（(]+$/, '')
      .trim();
    if (!series) continue;

    return { series, number };
  }

  return null;
}