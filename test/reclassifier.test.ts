/**
 * 批量重新分类内核单元测试（任务40）
 *
 * 覆盖 reclassifier.ts 的纯函数层：
 *   - normalizeContentTypeLabel：DB 可空标签 → 进度事件非空字符串归一
 *   - decideReclassify：变更判定（标签不同 / is_comic 脱节 / null 标签）
 *   - mergeClassifySignalsIntoCustomMeta：特征向量合并（保留其余键 / 损坏自愈）
 *   - buildUnchangedProgressPayload：skipped/failed 进度事件构造（from=to、
 *     fromOverride 语义）
 *
 * 端到端判据贯通（信号 → classifyDocument → decideReclassify）：
 *   - 任务39 矫正样本 822（Acrobat图片转换 Producer + 逐页书签密度1.0）
 *     illustrated → comic
 *   - 任务39 矫正样本 979（无书签 + FreePic2Pdf + 黑白图片主导 99%）
 *     comic → illustrated
 *   即 scripts/reclassify-books.mjs dry-run 实测的 4 本变更中的两类代表路径。
 *
 * 环境说明：reclassifier → db/repositories、pdf-parser → utils 均依赖 electron
 * （safeStorage/app 路径），vitest node 环境无 Electron 运行时，mock 后即可加载
 * （与 volume-chapters.test.ts 同款基建）。纯函数不触发被 mock 的 API。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import {
  buildUnchangedProgressPayload,
  decideReclassify,
  mergeClassifySignalsIntoCustomMeta,
  normalizeContentTypeLabel,
  type ReclassifyTargetRow
} from '../src/main/core/reclassifier';
import { classifyDocument, type DocumentSignals } from '../src/main/core/parsers/document-classifier';

/** 构造特征（默认值代表"无目录纯图"的图片型文档，与 classify.test.ts 同款） */
function sig(over: Partial<DocumentSignals> = {}): DocumentSignals {
  return {
    pageCount: 200,
    totalTextChars: 0,
    textCharsPerPage: 0,
    textStdDev: 0,
    textPageRatio: 0,
    imageCount: 190,
    imageDensity: 0.95,
    outlineCount: 0,
    hasMixedOrientation: false,
    pageRatioStdDev: 0,
    fileSizePerPageMB: 0.3,
    ccittRatio: 0,
    ...over
  };
}

/** 构造待重检书行（DB 行子集） */
function row(over: Partial<ReclassifyTargetRow> = {}): ReclassifyTargetRow {
  return {
    id: 822,
    title: '藤子F不二雄大全集',
    content_type: 'illustrated',
    is_comic: 0,
    local_file_path: '/tmp/book.pdf',
    custom_meta: null,
    ...over
  };
}

describe('normalizeContentTypeLabel（标签归一）', () => {
  it('null/undefined/空串 → unknown（DB 列可空，进度事件需非空）', () => {
    expect(normalizeContentTypeLabel(null)).toBe('unknown');
    expect(normalizeContentTypeLabel(undefined)).toBe('unknown');
    expect(normalizeContentTypeLabel('')).toBe('unknown');
  });

  it('合法标签原样返回', () => {
    expect(normalizeContentTypeLabel('text')).toBe('text');
    expect(normalizeContentTypeLabel('illustrated')).toBe('illustrated');
    expect(normalizeContentTypeLabel('comic')).toBe('comic');
  });
});

describe('decideReclassify（变更判定）', () => {
  it('标签与 is_comic 均一致 → 不变更', () => {
    const d = decideReclassify({ content_type: 'comic', is_comic: 1 }, { contentType: 'comic', isComic: true });
    expect(d.changed).toBe(false);
    expect(d.from).toBe('comic');
    expect(d.to).toBe('comic');
  });

  it('标签不同 → 变更（822 场景：illustrated → comic）', () => {
    const d = decideReclassify({ content_type: 'illustrated', is_comic: 0 }, { contentType: 'comic', isComic: true });
    expect(d.changed).toBe(true);
    expect(d.from).toBe('illustrated');
    expect(d.to).toBe('comic');
  });

  it('标签相同但 is_comic 脱节（旧库异常行）→ 防御性变更', () => {
    const d = decideReclassify({ content_type: 'text', is_comic: 1 }, { contentType: 'text', isComic: false });
    expect(d.changed).toBe(true);
  });

  it('content_type=null（旧数据）→ from 归一 unknown 且判变更', () => {
    const d = decideReclassify({ content_type: null, is_comic: 0 }, { contentType: 'text', isComic: false });
    expect(d.from).toBe('unknown');
    expect(d.to).toBe('text');
    expect(d.changed).toBe(true);
  });
});

describe('mergeClassifySignalsIntoCustomMeta（特征向量合并）', () => {
  const signals = sig({ producer: 'iTextSharp 5.1.3' });

  it('null custom_meta → 新对象仅含 classify_signals', () => {
    const out = JSON.parse(mergeClassifySignalsIntoCustomMeta(null, signals)) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['classify_signals']);
    expect((out.classify_signals as DocumentSignals).producer).toBe('iTextSharp 5.1.3');
  });

  it('保留其余键（file_hash 等）+ 替换旧 classify_signals', () => {
    const old = JSON.stringify({
      file_hash: 'abc123',
      file_size: 12345,
      original_filename: 'book.pdf',
      classify_signals: { pageCount: 1 }
    });
    const out = JSON.parse(mergeClassifySignalsIntoCustomMeta(old, signals)) as Record<string, unknown>;
    // 其余键原样保留（custom_meta 是 importer 写入的多用途包，重检不得破坏）
    expect(out.file_hash).toBe('abc123');
    expect(out.file_size).toBe(12345);
    expect(out.original_filename).toBe('book.pdf');
    // classify_signals 替换为最新采集
    expect((out.classify_signals as DocumentSignals).producer).toBe('iTextSharp 5.1.3');
    expect((out.classify_signals as DocumentSignals).pageCount).toBe(200);
  });

  it('损坏 JSON → 丢弃旧内容重建（自愈，与手动修正路径容错一致）', () => {
    const out = JSON.parse(mergeClassifySignalsIntoCustomMeta('{broken json', signals)) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['classify_signals']);
  });

  it('JSON 数组（非对象）→ 同样重建', () => {
    const out = JSON.parse(mergeClassifySignalsIntoCustomMeta('[1,2,3]', signals)) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['classify_signals']);
  });
});

describe('buildUnchangedProgressPayload（未变更进度事件构造）', () => {
  it('skipped：from=to=原标签、changed=false、reason 透传', () => {
    const p = buildUnchangedProgressPayload(3, 240, row(), 'skipped', '文件不存在（可能已被移动或删除）');
    expect(p).toMatchObject({
      current: 3,
      total: 240,
      bookId: 822,
      title: '藤子F不二雄大全集',
      from: 'illustrated',
      to: 'illustrated',
      changed: false,
      status: 'skipped',
      reason: '文件不存在（可能已被移动或删除）'
    });
  });

  it('failed：fromOverride（写库失败展示判定前标签）优先生效', () => {
    const p = buildUnchangedProgressPayload(5, 240, row(), 'failed', '写库失败: boom', 'comic');
    expect(p.from).toBe('comic');
    expect(p.to).toBe('comic');
    expect(p.status).toBe('failed');
  });

  it('content_type=null 的书 → from/to 归一 unknown', () => {
    const p = buildUnchangedProgressPayload(1, 10, row({ content_type: null }), 'skipped', '无本地文件路径');
    expect(p.from).toBe('unknown');
    expect(p.to).toBe('unknown');
  });
});

describe('端到端判据贯通（信号 → 决策树 → 变更判定，任务39 判据在重检路径生效）', () => {
  it('822 场景：Acrobat图片转换 Producer + 逐页书签密度1.0 → illustrated 判 comic（3a-1c）', () => {
    // 高密度逐页书签（670/670）+ 强漫画 Producer + 页码式书签（serial 占比低）
    const nodes = Array.from({ length: 670 }, (_, i) => ({ title: String(i + 1) }));
    const signals = sig({
      pageCount: 670,
      imageCount: 670,
      imageDensity: 1.0,
      outlineCount: 670,
      producer: 'Adobe Acrobat 19.8 Image Conversion Plug-in',
      grayOrIndexImageRatio: 1.0,
      // 全部纯页码式标题：serial 占比 0（无 3a-1c 时会被 3a-1b 误判 scan）
      outlineSerialRatio: 0,
      outlineSemanticRatio: 0,
      outlinePageStyleRatio: 1
    });
    void nodes;
    const verdict = classifyDocument(signals);
    expect(verdict.contentType).toBe('comic');
    // 重检决策：illustrated → comic（dry-run 实测的 822 矫正）
    const d = decideReclassify({ content_type: 'illustrated', is_comic: 0 }, verdict);
    expect(d.changed).toBe(true);
    expect(d.from).toBe('illustrated');
    expect(d.to).toBe('comic');
  });

  it('979 场景：无书签 + FreePic2Pdf + 黑白图片主导 → comic 判 illustrated（3b-0）', () => {
    const signals = sig({
      pageCount: 300,
      imageCount: 300,
      imageDensity: 1.0,
      outlineCount: 0,
      textPageRatio: 0,
      producer: 'FreePic2Pdf 1.26',
      grayOrIndexImageRatio: 0.99,
      hasMixedOrientation: false,
      pageRatioStdDev: 0
    });
    const verdict = classifyDocument(signals);
    expect(verdict.contentType).toBe('illustrated');
    // 重检决策：comic → illustrated（dry-run 实测的 979/992/995 矫正）
    const d = decideReclassify({ content_type: 'comic', is_comic: 1 }, verdict);
    expect(d.changed).toBe(true);
    expect(d.from).toBe('comic');
    expect(d.to).toBe('illustrated');
  });

  it('标签一致的真漫画 → 重检不变更（回归保护：全库重检不误翻已正确的书）', () => {
    // iTextSharp 全彩漫画：高密度逐页书签 + 强漫画 Producer（3a-1c）
    const signals = sig({
      pageCount: 200,
      imageCount: 200,
      imageDensity: 1.0,
      outlineCount: 200,
      producer: 'iTextSharp 5.1.3 (c) 1T3XT BVBA',
      outlineSerialRatio: 1,
      outlineSemanticRatio: 0,
      grayOrIndexImageRatio: 0
    });
    const verdict = classifyDocument(signals);
    const d = decideReclassify({ content_type: 'comic', is_comic: 1 }, verdict);
    expect(verdict.contentType).toBe('comic');
    expect(d.changed).toBe(false);
  });
});
