import { readFileSync } from 'node:fs';

const src = readFileSync('src/renderer/src/i18n.ts', 'utf8');
const m = src.match(/'zh-CN':\s*\{/);
const start = src.indexOf(m[0]) + m[0].length - 1;
let i = start,
  depth = 0,
  inStr = false,
  strCh = '';
for (; i < src.length; i++) {
  const c = src[i];
  if (inStr) {
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === strCh) {
      inStr = false;
      continue;
    }
    continue;
  }
  if (c === "'" || c === '"' || c === '`') {
    inStr = true;
    strCh = c;
    continue;
  }
  if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) break;
  }
}
const zhObj = new Function('return (' + src.slice(start, i + 1) + ')')();

function collect(obj, prefix, out) {
  for (const k of Object.keys(obj)) {
    const path = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (v && typeof v === 'object') collect(v, path, out);
    else out.set(path, v);
  }
  return out;
}

const zh = collect(zhObj, '', new Map());

// 找出所有"值=键路径"或"值包含点号像键路径"的占位键
const placeholders = [];
for (const [k, v] of zh) {
  if (typeof v !== 'string') continue;
  // 值 === 键路径（完全占位）
  if (v === k) {
    placeholders.push({ key: k, value: v, type: 'exact' });
    continue;
  }
  // 值看起来像键路径（包含点号、全英文、无空格）
  if (v.includes('.') && /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(v) && v.split('.').length >= 2) {
    placeholders.push({ key: k, value: v, type: 'keylike' });
  }
}

console.log(`zh-CN 总叶子键: ${zh.size}`);
console.log(`键名占位键: ${placeholders.length}`);
console.log('');
placeholders.forEach((p) => console.log(`  [${p.type}] ${p.key} = "${p.value}"`));
