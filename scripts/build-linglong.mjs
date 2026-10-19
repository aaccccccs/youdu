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
// 产物（官方 UAB 命名格式 {app-id}_{version}_{arch}.uab）：
//   dist/io.github.youdu_0.2.0.1_x86_64.uab（可安装 UAB，官方命名，商店上架用）
//   dist/Youdu-0.2.0-linglong-x64.uab（同一内容的统一命名副本，GitHub Release 分发用）
//   dist/io.github.youdu_x86_64_0.2.0.1_main.uab（可执行 UABX，双击直接运行）
//   io.github.youdu_0.2.0.1_x86_64_binary.layer（可安装 layer 文件，ll-cli install 推荐）

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(process.cwd());
const tarball = resolve(projectRoot, 'dist/Youdu-0.2.0-linux-x64.tar.gz');

// 1. 检查 tar.gz 是否存在
if (!existsSync(tarball)) {
  console.error('❌ 未找到 dist/Youdu-0.2.0-linux-x64.tar.gz，请先运行 npm run build:linux');
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

// 4. 导出可安装 UAB（可选步骤，失败不退出）
console.log('\n=== 导出可安装 UAB ===');
try {
  execSync('ll-builder export -o dist/io.github.youdu_0.2.0.1_x86_64.uab', { stdio: 'inherit', cwd: projectRoot });
  console.log('\n✅ 可安装 UAB 导出完成：dist/io.github.youdu_0.2.0.1_x86_64.uab');
  // 追加统一命名副本（GitHub Release 分发用，与 deb/AppImage/tar.gz 命名风格一致）：
  // 文件名只是标签，ll-cli install 从包内容读取 appid，改名不影响安装；
  // 官方命名原件保留，供玲珑商店上架提交使用
  execSync('cp dist/io.github.youdu_0.2.0.1_x86_64.uab dist/Youdu-0.2.0-linglong-x64.uab');
  console.log('✅ 统一命名副本：dist/Youdu-0.2.0-linglong-x64.uab（GitHub Release 用）');
} catch (err) {
  console.warn('\n⚠️  可安装 UAB 导出失败：', err?.message);
}

// 5. 导出可执行 UABX（可选步骤，失败不退出）
console.log('\n=== 导出可执行 UABX ===');
try {
  execSync('ll-builder export --uabx -o dist/io.github.youdu_x86_64_0.2.0.1_main.uab', { stdio: 'inherit', cwd: projectRoot });
  console.log('\n✅ 可执行 UABX 导出完成：dist/io.github.youdu_x86_64_0.2.0.1_main.uab（双击可直接运行）');
} catch (err) {
  console.warn('\n⚠️  可执行 UABX 导出失败：', err?.message);
}

// 6. 导出 layer 文件（可选步骤，失败不退出）
console.log('\n=== 导出 layer 文件 ===');
try {
  execSync('ll-builder export --layer', { stdio: 'inherit', cwd: projectRoot });
  console.log('\n✅ layer 文件导出完成');
  console.log('   安装命令：ll-cli install ./io.github.youdu_0.2.0.1_x86_64_binary.layer');
} catch (err) {
  console.warn('\n⚠️  layer 文件导出失败：', err?.message);
  console.warn('   .uab 已生成，可手动执行 ll-builder export --layer 导出 layer 文件');
}
// 7. 清理项目根目录的 layer 临时文件（layer 安装后不再需要，保持目录干净）
console.log('\n=== 清理 layer 临时文件 ===');
try {
  execSync(
    'rm -f io.github.youdu_0.2.0.1_x86_64_binary.layer io.github.youdu_0.2.0.1_x86_64_develop.layer',
    { cwd: projectRoot }
  );
  console.log('✅ 已清理项目根目录的 layer 临时文件');
} catch (err) {
  console.warn('\n⚠️  layer 临时文件清理失败：', err?.message);
}