// electron-builder 编程 API 打包 deb
// 背景：本机 node 是 ELECTRON_RUN_AS_NODE shim，CLI 的 yargs 会把 cli.js
// 路径误解析为选项（"无法识别的选项"），--version 可用但 build 命令不可用。
// 改用编程 API 绕过 CLI 解析，配置仍自动读取 electron-builder.yml。
import { build, Platform, Arch } from 'electron-builder';

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const targets = Platform.LINUX.createTarget(['deb'], Arch.x64);

await build({
  targets,
  publish: 'never',
});

console.log('\n✅ deb 打包完成');