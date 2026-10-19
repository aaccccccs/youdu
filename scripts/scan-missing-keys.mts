/**
 * 用 tsx 加载 i18n.ts，提取 zh-CN 所有叶子键路径，
 * 然后扫描代码中 t('...') 静态调用，找出缺失键。
 * 用法: npx tsx scripts/scan-missing-keys.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 动态导入 i18n 模块（用 tsx 运行）
const i18nPath = path.join(root, 'src/renderer/src/i18n.ts');
const i18nUrl = 'file://' + i18nPath.replace(/\\/g, '/');
const i18nModule = await import(i18nUrl);

// i18n.ts 导出 i18n 实例，messages 在 i18n.global.messages
// 或者直接从模块中找 messages
const messages = i18nModule.default?.global?.messages ?? i18nModule.i18n?.global?.messages;
if (!messages) {
  // 尝试直接访问
  console.log('可用导出:', Object.keys(i18nModule));
  console.error('无法获取 messages');
  process.exit(1);
}

const zhCn = messages['zh-CN'];
const en = messages['en'];

/** 递归提取所有叶子键路径 */
function extractLeafKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of extractLeafKeys(value, fullPath)) keys.add(k);
    } else {
      keys.add(fullPath);
    }
  }
  return keys;
}

const zhCnKeys = extractLeafKeys(zhCn);
const enKeys = extractLeafKeys(en);
console.log(`zh-CN 叶子键总数: ${zhCnKeys.size}`);
console.log(`en 叶子键总数: ${enKeys.size}`);

// 检查 en 和 zh-CN 键结构是否一致
const zhOnly = [...zhCnKeys].filter(k => !enKeys.has(k));
const enOnly = [...enKeys].filter(k => !zhCnKeys.has(k));
if (zhOnly.length > 0) {
  console.log(`\nzh-CN 有但 en 没有的键 (${zhOnly.length}):`);
  zhOnly.sort().forEach(k => console.log(`  - ${k}`));
}
if (enOnly.length > 0) {
  console.log(`\nen 有但 zh-CN 没有的键 (${enOnly.length}):`);
  enOnly.sort().forEach(k => console.log(`  - ${k}`));
}

// 扫描 src/renderer/src 下所有 .vue 和 .ts 文件中的 t('...') 调用
function scanDir(dir, exts) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDir(fullPath, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = scanDir(path.join(root, 'src/renderer/src'), ['.vue', '.ts']);
const usedKeys = new Map(); // key -> [files]
const missingKeys = new Map(); // key -> [files]

// 匹配 t('key.path') 或 t("key.path") 或 t(`key.path`)
const tCallRegex = /\bt\(\s*['"`]([^'"`]+)['"`]/g;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = tCallRegex.exec(content)) !== null) {
    const key = match[1];
    // 跳过包含 ${ 的动态键
    if (key.includes('${')) continue;
    // 跳过明显不是键路径的（没有点且不是单字母的）
    if (!key.includes('.')) continue;
    const relFile = path.relative(root, file);
    if (!usedKeys.has(key)) usedKeys.set(key, []);
    usedKeys.get(key).push(relFile);
    if (!zhCnKeys.has(key)) {
      if (!missingKeys.has(key)) missingKeys.set(key, []);
      missingKeys.get(key).push(relFile);
    }
  }
}

console.log(`\n代码中使用的静态 t() 键总数: ${usedKeys.size}`);
console.log(`\n缺失的键（在代码中使用但 zh-CN 中不存在）: ${missingKeys.size}`);
if (missingKeys.size > 0) {
  console.log('\n缺失键列表:');
  for (const key of [...missingKeys.keys()].sort()) {
    const files = missingKeys.get(key);
    console.log(`  - ${key}  (用于: ${files.join(', ')})`);
  }
}