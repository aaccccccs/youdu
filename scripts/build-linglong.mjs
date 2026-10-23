#!/usr/bin/env node
// 幽读（Youdu）玲珑包构建脚本
//
// 前提：
//   1. 已安装 linglong-builder：sudo apt install linglong-builder
//   2. 已构建 tar.gz：npm run build:linux
//
// 用法：
//   node scripts/build-linglong.mjs
//
// 产物（用户定稿 2026-10-23：仅唯一统一命名产物）：
//   dist/Youdu-{version}-linglong-x64.uab（可安装 UAB，唯一分发产物）
// 商店上架需要官方名时：cp 重命名为 io.github.youdu_{version}.0_x86_64.uab 即可（内容相同）
// 注意：版本号从 package.json 动态读取（玲珑四段格式 {version}.0），不再硬编码

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(process.cwd());
// 版本动态读取（根治硬编码漂移：历史教训——0.2.15 硬编码导致 0.3.x 打包失败）
const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));
const version = String(pkg.version);         // 如 '0.3.5'（package.json 三段）
const llVersion = `${version}.0`;           // 如 '0.3.5.0'（玲珑四段格式，末段为 build 号）
// 前置产物：dist/linux-unpacked 目录（deb 打包的必然副产物，linglong.yaml build
// 直接 cp 该目录——tar.gz 检查是历史残留，v 精简版 build:linux 已不再产 tar.gz）
const unpackedDir = resolve(projectRoot, 'dist/linux-unpacked');

// 1. 检查 linux-unpacked 是否存在
if (!existsSync(unpackedDir)) {
  console.error('❌ 未找到 dist/linux-unpacked，请先运行 npm run build:linux');
  process.exit(1);
}

// 2. 检查 ll-builder 是否安装
try {
  execSync('which ll-builder', { stdio: 'pipe' });
} catch {
  console.error('❌ 未安装 linglong-builder，请先运行：');
  console.error('   sudo apt install linglong-builder');
  process.exit(1);
}

// 3. 构建玲珑包
console.log('\n=== 开始构建玲珑包 ===');
try {
  execSync('ll-builder build', { stdio: 'inherit', cwd: projectRoot });
  console.log('\n✅ 玲珑包构建完成');
} catch (err) {
  console.error('\n❌ 玲珑包构建失败：', err?.message);
  process.exit(1);
}

// 4. 导出可安装 UAB（唯一产物）
console.log('\n=== 导出可安装 UAB ===');
try {
  execSync(`ll-builder export -o dist/io.github.youdu_${llVersion}_x86_64.uab`, { stdio: 'inherit', cwd: projectRoot });
  console.log(`\n✅ 可安装 UAB 导出完成`);

  // 统一命名（用户定稿：唯一分发产物，与 deb 命名风格一致）
  execSync(`cp dist/io.github.youdu_${llVersion}_x86_64.uab dist/Youdu-${version}-linglong-x64.uab`);
  // 删除官方名副本（只保留统一名——用户定稿：UABX/layer/官方名不再产出）
  execSync(`rm -f dist/io.github.youdu_${llVersion}_x86_64.uab io.github.youdu_${llVersion}_x86_64_binary.layer io.github.youdu_${llVersion}_x86_64_develop.layer dist/io.github.youdu_x86_64_${llVersion}_main.uab dist/io.github.youdu_${llVersion}_x86_64_binary.layer`);
  console.log(`\n🎉 最终产物：dist/Youdu-${version}-linglong-x64.uab`);
} catch (err) {
  console.warn('\n⚠️  UAB 导出失败：', err?.message);
  process.exit(1);
}
