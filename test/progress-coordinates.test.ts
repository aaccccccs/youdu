/**
 * 阅读进度坐标换算单元测试（任务23：进度保存/恢复五项修复）
 *
 * 覆盖根因①（scrollToPosition 两套分母+坐标语义不一致）与根因④
 * （图片模式 chapter_offset 持久化）的纯函数部分：
 *
 * - paragraphIndexToPosition / positionToParagraphIndex：
 *   保存/恢复统一"全章段落数"分母坐标系的往返一致性
 *   （验收标准：保存 → 恢复 → 再保存，position 差 < 0.02）
 * - clampChapterOffset：持久化页码恢复的边界防御
 */
import { describe, it, expect } from 'vitest';
import {
  paragraphIndexToPosition,
  positionToParagraphIndex,
  clampChapterOffset,
  computeChapterCharOffset,
  computeParagraphIndexByCharOffset,
  charOffsetToInParaRatio
} from '../src/renderer/src/utils';

/* ==================== 根因①：段落归一化坐标往返一致性 ==================== */

describe('paragraphIndexToPosition', () => {
  it('全章段落数分母：段落索引 → 归一位置', () => {
    // 全章 66 段，视口顶在第 27 段内部（复现实测场景：livePos=0.818 保存时）
    expect(paragraphIndexToPosition(27, 66)).toBeCloseTo(27 / 65, 12);
    expect(paragraphIndexToPosition(0, 66)).toBe(0);
    expect(paragraphIndexToPosition(65, 66)).toBeCloseTo(1, 12);
  });

  it('索引越界被 clamp 到 [0,1]', () => {
    expect(paragraphIndexToPosition(-3, 10)).toBe(0);
    expect(paragraphIndexToPosition(99, 10)).toBe(1);
  });

  it('单段/空章返回 0（无进度意义）', () => {
    expect(paragraphIndexToPosition(0, 1)).toBe(0);
    expect(paragraphIndexToPosition(0, 0)).toBe(0);
  });
});

describe('positionToParagraphIndex', () => {
  it('全章段落数分母：归一位置 → 目标段落索引', () => {
    expect(positionToParagraphIndex(0.818, 66)).toBe(53); // round(0.818×65)
    expect(positionToParagraphIndex(0, 66)).toBe(0);
    expect(positionToParagraphIndex(1, 66)).toBe(65);
  });

  it('位置越界/非法被 clamp', () => {
    expect(positionToParagraphIndex(-0.5, 10)).toBe(0);
    expect(positionToParagraphIndex(1.5, 10)).toBe(9);
    expect(positionToParagraphIndex(NaN, 10)).toBe(0);
  });

  it('单段章节返回 0', () => {
    expect(positionToParagraphIndex(0.5, 1)).toBe(0);
    expect(positionToParagraphIndex(0.5, 0)).toBe(0);
  });
});

describe('根因① 往返一致性（保存 → 恢复 → 再保存）', () => {
  it.each([
    { total: 66, idx: 27 }, // 复现实测深位置场景（81.8%）
    { total: 66, idx: 12 }, // 浅位置场景（约 40%）
    { total: 34, idx: 27 }, // 全章恰好 34 段（旧分母=全章数时也自洽）
    { total: 100, idx: 0 }, // 章首
    { total: 100, idx: 99 } // 章末
  ])('全章 $total 段、视口段 $idx：往返 position 严格一致（差 < 0.02）', ({ total, idx }) => {
    // 保存：视口在第 idx 段内部 → position = idx/(total-1)
    const saved = paragraphIndexToPosition(idx, total);
    // 恢复：position → 目标段落（分母同为全章段落数）
    const restoredIdx = positionToParagraphIndex(saved, total);
    // 再保存：恢复定位到段落中部后，第一个"底过视口顶"的段落仍是同一索引
    const resaved = paragraphIndexToPosition(restoredIdx, total);
    expect(Math.abs(resaved - saved)).toBeLessThan(0.02);
    expect(restoredIdx).toBe(idx);
  });

  it('全量扫描：任意段落索引往返不丢段（差 < 0.02）', () => {
    for (const total of [2, 3, 5, 30, 34, 66, 100, 500]) {
      for (let idx = 0; idx < total; idx++) {
        const saved = paragraphIndexToPosition(idx, total);
        const restored = positionToParagraphIndex(saved, total);
        const resaved = paragraphIndexToPosition(restored, total);
        expect(restored).toBe(idx);
        expect(Math.abs(resaved - saved)).toBeLessThan(0.02);
      }
    }
  });

  it('对照旧缺陷：分批渲染分母（已渲染数）≠ 全章分母时产生系统性漂移', () => {
    // 旧行为：保存用已渲染 34 段做分母（滚动到 85% 时 renderedCount=34，全章 66 段）
    const renderedCount = 34;
    const total = 66;
    const viewportIdx = 27;
    const legacySaved = viewportIdx / (renderedCount - 1); // ≈0.818（复现实测值）
    // 旧行为的恢复：按全章分母换算目标段 → round(0.818×65)=53，跳到更深的段落
    const legacyRestoredIdx = positionToParagraphIndex(legacySaved, total);
    expect(legacyRestoredIdx).not.toBe(viewportIdx);
    // 新行为：保存分母=全章数，往返严格回到原段
    const fixedSaved = paragraphIndexToPosition(viewportIdx, total);
    expect(positionToParagraphIndex(fixedSaved, total)).toBe(viewportIdx);
  });
});

/* ==================== 根因④：chapter_offset 恢复 clamp ==================== */

describe('clampChapterOffset', () => {
  it('合法页码原样保留（1-based）', () => {
    // 复现 F-1 场景：翻页模式第 5/30 页退出，重进恢复到第 5 页（不再漂移到第 2 页）
    expect(clampChapterOffset(5, 30)).toBe(5);
    expect(clampChapterOffset(1, 30)).toBe(1);
    expect(clampChapterOffset(30, 30)).toBe(30);
  });

  it('页码超出当章页数（重新分章/数据变更）clamp 到末页', () => {
    expect(clampChapterOffset(45, 30)).toBe(30);
  });

  it('非法值（0/负数/NaN/Infinity/小数）防御', () => {
    expect(clampChapterOffset(0, 30)).toBe(1);
    expect(clampChapterOffset(-5, 30)).toBe(1);
    expect(clampChapterOffset(NaN, 30)).toBe(1);
    expect(clampChapterOffset(Infinity, 30)).toBe(30);
    expect(clampChapterOffset(5.7, 30)).toBe(5); // 向下取整（页码是整数语义）
  });

  it('空章（totalPages < 1）返回 1', () => {
    expect(clampChapterOffset(5, 0)).toBe(1);
    expect(clampChapterOffset(5, -1)).toBe(1);
  });

  it('首批渲染页数少于全章时页码不缩水（绝对页码语义）', () => {
    // 重进时首批仅渲染 5 页（全章 30 页）：页码 5 不因首批页数被 clamp（DB 页码基于全章，
    // 真实 clamp 基准是 store.comicImages.length = 全章含 pending 占位）
    expect(clampChapterOffset(5, 30)).toBe(5);
  });
});
/* ==================== 任务25：章内字符偏移（内容锚点，免疫排版变化） ==================== */

/** 复现实测场景的段落数组（模拟小说章节，段长不一） */
const SAMPLE_PARAS = [
  '第一章 古宅。',
  '黑色云雾渐渐消失，但是高天之上却更加的阴森恐怖了，仿佛有无数双眼睛在窥视着下方的一切生灵。',
  '古堡充满了岁月的沧桑，仿佛自远古划破时空而来，斑驳的墙壁上爬满了不知名的藤蔓。',
  '他深吸一口气，推开了那扇沉重的大门。',
  '门后是一条幽深的长廊，两侧的烛火摇曳不定，将人的影子拉得忽长忽短，诡异非常。',
  '“谁？”他低声喝问，声音在空荡的长廊中回荡，久久不散。'
];

describe('computeChapterCharOffset', () => {
  it('段落累加 + 段内 0.5 比例（默认）', () => {
    // 视口顶在第 2 段：偏移 = len(0) + len(1) + round(len(2) × 0.5)
    const expected =
      SAMPLE_PARAS[0].length + SAMPLE_PARAS[1].length + Math.round(SAMPLE_PARAS[2].length * 0.5);
    expect(computeChapterCharOffset(SAMPLE_PARAS, 2)).toBe(expected);
  });

  it('第 0 段返回段内偏移（不丢段内位置信息）', () => {
    expect(computeChapterCharOffset(SAMPLE_PARAS, 0)).toBe(Math.round(SAMPLE_PARAS[0].length * 0.5));
    expect(computeChapterCharOffset(SAMPLE_PARAS, 0, 0)).toBe(0);
    expect(computeChapterCharOffset(SAMPLE_PARAS, 0, 1)).toBe(SAMPLE_PARAS[0].length);
  });

  it('inParaRatio 边界 clamp 到 [0,1]', () => {
    expect(computeChapterCharOffset(SAMPLE_PARAS, 1, -0.5)).toBe(SAMPLE_PARAS[0].length);
    expect(computeChapterCharOffset(SAMPLE_PARAS, 1, 1.5)).toBe(
      SAMPLE_PARAS[0].length + SAMPLE_PARAS[1].length
    );
  });

  it('末段 + ratio=1 = 全章总字符数（滚动到末尾）', () => {
    const total = SAMPLE_PARAS.reduce((s, p) => s + p.length, 0);
    expect(computeChapterCharOffset(SAMPLE_PARAS, SAMPLE_PARAS.length - 1, 1)).toBe(total);
  });

  it('防御：空数组/负索引/越界索引', () => {
    expect(computeChapterCharOffset([], 3)).toBe(0);
    expect(computeChapterCharOffset(SAMPLE_PARAS, -1)).toBe(0);
    // paraIndex 越界：累加全部被截断到数组长度（cur 为 undefined 不加段内偏移）
    expect(computeChapterCharOffset(SAMPLE_PARAS, 99)).toBe(
      SAMPLE_PARAS.reduce((s, p) => s + p.length, 0)
    );
  });
});

describe('computeParagraphIndexByCharOffset', () => {
  it('偏移落在对应段落内', () => {
    // 构造精确边界：段0长度 L0，偏移 L0+1 → 第 1 段
    const paras = ['aaaa', 'bbbb', 'cccc'];
    expect(computeParagraphIndexByCharOffset(paras, 1)).toBe(0);
    expect(computeParagraphIndexByCharOffset(paras, 4)).toBe(0); // acc+len=4 >= 4 → 段0
    expect(computeParagraphIndexByCharOffset(paras, 5)).toBe(1);
    expect(computeParagraphIndexByCharOffset(paras, 8)).toBe(1);
    expect(computeParagraphIndexByCharOffset(paras, 9)).toBe(2);
  });

  it('≤0 / 非法偏移返回首段', () => {
    expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, 0)).toBe(0);
    expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, -100)).toBe(0);
    expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, NaN)).toBe(0);
  });

  it('越界偏移 clamp 到末段（章节变短兜底）', () => {
    expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, 10_000_000)).toBe(SAMPLE_PARAS.length - 1);
  });

  it('空数组返回 0', () => {
    expect(computeParagraphIndexByCharOffset([], 100)).toBe(0);
  });
});

describe('任务25 字符偏移往返一致性（offset → 段落 → offset）', () => {
  it('任意段落往返：charOffset 严格相等', () => {
    for (let idx = 0; idx < SAMPLE_PARAS.length; idx++) {
      const offset = computeChapterCharOffset(SAMPLE_PARAS, idx);
      const restoredIdx = computeParagraphIndexByCharOffset(SAMPLE_PARAS, offset);
      expect(restoredIdx).toBe(idx);
      // 再保存：锚点严格相等（差 = 0）
      expect(computeChapterCharOffset(SAMPLE_PARAS, restoredIdx)).toBe(offset);
    }
  });

  it('段内任意字符位置往返落在同一段', () => {
    // 随机取段内多个位置（含边界），反查必须回到同一段
    for (let idx = 0; idx < SAMPLE_PARAS.length; idx++) {
      const base = SAMPLE_PARAS.slice(0, idx).reduce((s, p) => s + p.length, 0);
      for (const inner of [1, Math.floor(SAMPLE_PARAS[idx].length / 2), SAMPLE_PARAS[idx].length]) {
        const offset = base + inner;
        expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, offset)).toBe(idx);
      }
    }
  });
});

describe('任务25 关键用例：免疫排版变化（字号 18→26 实测场景）', () => {
  it('同一 charOffset 在不同"排版批次"下反查结果恒等', () => {
    // 实测：字号 18→26 后 scrollTop 不变、视口首段完全变化（比例锚点失效）。
    // 字符偏移只依赖源文本数组——模拟分批渲染 renderedCount 变化
    //（30→34→全部），反查输入始终是完整 paragraphs，结果不受渲染状态影响
    const charOffset = computeChapterCharOffset(SAMPLE_PARAS, 2);
    // 模拟"字号 18 时渲染 3 段"与"字号 26 时渲染 6 段"两种排版状态：
    // 恢复链的输入都是完整源文本数组（splitParagraphs(store.chapterContent)），
    // 与 renderedCount/字号/行距完全无关
    for (const simulatedRenderState of [3, 4, 6]) {
      void simulatedRenderState; // 排版状态不参与计算
      expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, charOffset)).toBe(2);
    }
  });

  it('排版变化恢复路径：charOffset → 段落归一位置 → 段落中部定位语义不变', () => {
    // 恢复链（Reader.vue resolvePositionByCharOffset）：charOffset 反查段落 idx
    // → paragraphIndexToPosition 换算统一坐标系 → scrollToPosition 段中部定位
    // 整个链条只依赖源文本数组与段落数，排版参数（字号/行距/页宽/边距/字体）
    // 任何变化都不影响反查结果 → 视口首段 100% 保持
    const charOffset = computeChapterCharOffset(SAMPLE_PARAS, 2);
    const idx = computeParagraphIndexByCharOffset(SAMPLE_PARAS, charOffset);
    const pos = paragraphIndexToPosition(idx, SAMPLE_PARAS.length);
    // 换算回段落索引仍指向同一段（与根因①统一坐标系衔接，往返不回退）
    expect(positionToParagraphIndex(pos, SAMPLE_PARAS.length)).toBe(2);
  });

  it('分段规则变化（章节变短）时反查 clamp 不越界', () => {
    // textConvert/替换规则后段落数变少：旧偏移反查 clamp 到新数组末段
    const shorter = SAMPLE_PARAS.slice(0, 2);
    const bigOffset = computeChapterCharOffset(SAMPLE_PARAS, 5, 1);
    const idx = computeParagraphIndexByCharOffset(shorter, bigOffset);
    expect(idx).toBe(shorter.length - 1);
    // 换算后的归一位置在新坐标系内合法
    const pos = paragraphIndexToPosition(idx, shorter.length);
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeLessThanOrEqual(1);
  });
});
/* ==================== 任务27：段内真实比例（修复恢复定位半行偏移） ==================== */

describe('charOffsetToInParaRatio', () => {
  it('段内偏移精确反推比例', () => {
    // offset = 前段累加 + 段内字符数 → 比例 = 段内字符数 / 段长
    const acc2 = SAMPLE_PARAS[0].length + SAMPLE_PARAS[1].length;
    const len2 = SAMPLE_PARAS[2].length;
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, 2, acc2 + len2 * 0.3)).toBeCloseTo(0.3, 12);
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, 2, acc2)).toBe(0);
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, 2, acc2 + len2)).toBe(1);
  });

  it('paraIndex 越界 clamp 到数组范围内', () => {
    const len0 = SAMPLE_PARAS[0].length;
    // paraIndex=99 clamp 到末段：按末段累加反推，首段范围内的偏移 clamp 到 0
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, 99, len0)).toBe(0);
    // paraIndex=-1 clamp 到段 0：段内偏移正常反推（短段 round 误差 ≤ 0.5/len0）
    const restored = charOffsetToInParaRatio(SAMPLE_PARAS, -1, Math.round(len0 * 0.5));
    expect(Math.abs(restored - 0.5)).toBeLessThanOrEqual(0.5 / len0 + 1e-9);
  });

  it('无效输入返回 0.5（旧调用兼容的中性值 = 任务23 段中部定位）', () => {
    // scrollToPosition 无 charOffset 时组件层固定用 0.5；本函数在无法计算时
    // 返回同值 0.5，保证任何异常输入都回退到既有行为，不产生新偏差
    expect(charOffsetToInParaRatio([], 0, 100)).toBe(0.5);
    expect(charOffsetToInParaRatio(['', ''], 1, 5)).toBe(0.5); // 段长 0
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, 1, NaN)).toBe(0.5);
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, 1, Infinity)).toBe(0.5); // 非有限值统一中性
  });
});

describe('任务27 段内比例往返（用户实测：向上偏半行一行 → 像素级）', () => {
  it.each([0.25, 0.5, 0.75, 0.9])('段内 %s 位置：保存 → 恢复比例还原（误差 ≤ 字符级下界 0.5/段长）', (ratio) => {
    // 模拟用户视口顶在段内 ratio 像素位置处退出：
    // 保存 computeChapterCharOffset(paras, i, ratio)（真实段内像素比例，任务27）
    // → 恢复 charOffsetToInParaRatio 反推段内比例
    // 误差数学下界 = round 半字符 / 段长（短段落字符数少精度略低，但短段仅
    // 1-2 行高，像素误差同样只有 2-3px；长段落 ≤ 0.5/40 ≈ 0.012）
    for (let i = 0; i < SAMPLE_PARAS.length; i++) {
      const offset = computeChapterCharOffset(SAMPLE_PARAS, i, ratio);
      const restored = charOffsetToInParaRatio(SAMPLE_PARAS, i, offset);
      expect(Math.abs(restored - ratio)).toBeLessThanOrEqual(0.5 / SAMPLE_PARAS[i].length + 1e-9);
    }
  });

  it('长段落（≥25 字符）往返误差 < 0.02（用户感知阈值）', () => {
    // 真实阅读场景的"半行一行"偏移发生在 4-5 行长段落（40+ 字符）——
    // 此时字符级误差 ≤ 0.5/40 = 0.0125，远低于 0.02 验收线
    const longParas = SAMPLE_PARAS.filter((p) => p.length >= 25);
    expect(longParas.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < longParas.length; i++) {
      for (const ratio of [0.25, 0.5, 0.75, 0.9]) {
        const offset = computeChapterCharOffset(longParas, i, ratio);
        const restored = charOffsetToInParaRatio(longParas, i, offset);
        expect(Math.abs(restored - ratio)).toBeLessThan(0.02);
      }
    }
  });

  it('量化对照：0.75 位置往返偏差从 0.25×段高降到字符级', () => {
    // 用户实测场景：长段落 4-5 行（段高 ~100px），用户读到段内 0.75 处退出
    const ratio = 0.75;
    const paraHeight = 100;
    // 修复前（任务23 固定 0.5）：恢复偏上 (0.75-0.5)×100 = 25px ≈ 半行~一行
    const legacyError = Math.abs(0.5 - ratio) * paraHeight;
    expect(legacyError).toBeGreaterThanOrEqual(20); // 半行级别的可感知偏移
    // 修复后：反推比例 ≈ 0.75，偏差 = round 半字符/段长 × 段高 ≈ 1px
    const idx = 2;
    const offset = computeChapterCharOffset(SAMPLE_PARAS, idx, ratio);
    const restored = charOffsetToInParaRatio(SAMPLE_PARAS, idx, offset);
    const fixedError = Math.abs(restored - ratio) * paraHeight;
    expect(fixedError).toBeLessThan(2); // 像素级，不可感知
    expect(fixedError).toBeLessThan(legacyError / 10); // 偏差降低一个数量级以上
  });

  it('段边界：charOffset 落在段首/段尾时反推不越界', () => {
    for (let i = 0; i < SAMPLE_PARAS.length; i++) {
      const acc = SAMPLE_PARAS.slice(0, i).reduce((s, p) => s + p.length, 0);
      const len = SAMPLE_PARAS[i].length;
      // 恰好段首（前段末尾 = 本段开头）：对本段反推 0，不越界为负
      expect(charOffsetToInParaRatio(SAMPLE_PARAS, i, acc)).toBe(0);
      // 恰好段尾（= 下一段开头）：对本段反推 1（clamp），不越界超过 1
      expect(charOffsetToInParaRatio(SAMPLE_PARAS, i, acc + len)).toBe(1);
      // 对下一段反推 0（同一边界值的两种解释都在 [0,1] 内）
      if (i + 1 < SAMPLE_PARAS.length) {
        expect(charOffsetToInParaRatio(SAMPLE_PARAS, i + 1, acc + len)).toBe(0);
      }
    }
  });

  it('越界偏移 clamp：超出全章的 charOffset 反推到段末', () => {
    const idx = SAMPLE_PARAS.length - 1;
    const total = SAMPLE_PARAS.reduce((s, p) => s + p.length, 0);
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, idx, total + 1000)).toBe(1);
    // 负偏移 clamp 到段首
    expect(charOffsetToInParaRatio(SAMPLE_PARAS, idx, -5)).toBe(0);
  });

  it('全链往返：段内像素位置 → charOffset → 段落 idx + 段内比例 → 像素位置还原', () => {
    // ScrollView 保存侧：inParaRatio = (viewportTop - p.offsetTop) / p.offsetHeight
    // ScrollView 恢复侧：scrollTop += pRect.top - elRect.top + pRect.height × ratio'
    // 纯函数链路：ratio → offset → idx（段落不变）+ ratio' ≈ ratio → 像素位置还原
    for (let i = 0; i < SAMPLE_PARAS.length; i++) {
      for (const ratio of [0.1, 0.3, 0.6, 0.85]) {
        const offset = computeChapterCharOffset(SAMPLE_PARAS, i, ratio);
        // 段落级：反查回同一段（段落索引不变，根因①/任务25 的既有保证）
        expect(computeParagraphIndexByCharOffset(SAMPLE_PARAS, offset)).toBe(i);
        // 段内级：比例还原（任务27 新增保证，误差 ≤ 字符级下界 0.5/段长）
        const restored = charOffsetToInParaRatio(
          SAMPLE_PARAS,
          computeParagraphIndexByCharOffset(SAMPLE_PARAS, offset),
          offset
        );
        expect(Math.abs(restored - ratio)).toBeLessThanOrEqual(0.5 / SAMPLE_PARAS[i].length + 1e-9);
      }
    }
  });
});