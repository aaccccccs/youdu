/**
 * 直接从 i18n.ts 提取 messages 对象并用 eval 解析，
 * 然后扫描代码中 t('...') 静态调用，找出缺失键。
 * 用法: node scripts/scan-missing-keys.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const i18nContent = fs.readFileSync(path.join(root, 'src/renderer/src/i18n.ts'), 'utf8');

// 提取 const messages = { ... }; 的对象字面量
const messagesMatch = i18nContent.match(/const\s+messages\s*=\s*(\{[\s\S]*?\});/);
if (!messagesMatch) {
  console.error('无法提取 messages 对象');
  process.exit(1);
}

// 用 eval 解析对象（messages 对象只含字符串和嵌套对象，安全）
const messages = eval('(' + messagesMatch[1] + ')');

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

// 检查 en 和 zh-CN 键结构差异
const zhOnly = [...zhCnKeys].filter((k) => !enKeys.has(k)).sort();
const enOnly = [...enKeys].filter((k) => !zhCnKeys.has(k)).sort();
if (zhOnly.length > 0) {
  console.log(`\n⚠️ zh-CN 有但 en 没有的键 (${zhOnly.length}):`);
  zhOnly.forEach((k) => console.log(`  - ${k}`));
}
if (enOnly.length > 0) {
  console.log(`\n⚠️ en 有但 zh-CN 没有的键 (${enOnly.length}):`);
  enOnly.forEach((k) => console.log(`  - ${k}`));
}
if (zhOnly.length === 0 && enOnly.length === 0) {
  console.log('✅ zh-CN 和 en 键结构完全一致');
}

// 扫描 src/renderer/src 下所有 .vue 和 .ts 文件中的 t('...') 调用
function scanDir(dir, exts) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDir(fullPath, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = scanDir(path.join(root, 'src/renderer/src'), ['.vue', '.ts']);
const usedKeys = new Map();
const missingKeys = new Map();

const tCallRegex = /\bt\(\s*['"`]([^'"`]+)['"`]/g;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = tCallRegex.exec(content)) !== null) {
    const key = match[1];
    if (key.includes('${')) continue;
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
  console.log('\n⚠️ 缺失键列表:');
  for (const key of [...missingKeys.keys()].sort()) {
    const fileList = [...new Set(missingKeys.get(key))].join(', ');
    console.log(`  - ${key}  (用于: ${fileList})`);
  }
} else {
  console.log('✅ 所有代码中使用的静态 t() 键在 zh-CN 中都存在！');
}

// 额外检查：值=键路径的占位键
console.log('\n--- 占位键检查（值=键路径）---');
let placeholderCount = 0;
for (const key of zhCnKeys) {
  const parts = key.split('.');
  let obj = zhCn;
  for (const p of parts) {
    obj = obj?.[p];
  }
  if (typeof obj === 'string' && obj === key) {
    console.log(`  - ${key} = "${obj}"`);
    placeholderCount++;
  }
}
if (placeholderCount === 0) {
  console.log('✅ 没有值=键路径的占位键');
} else {
  console.log(`⚠️ 发现 ${placeholderCount} 个占位键`);
}
