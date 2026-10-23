// Linux 打包封装脚本
//
// 职责：串联执行 electron-vite build + electron-builder --linux，并设置国内镜像加速。
//
// 为何设镜像：
//   electron-builder 打包时会下载 electron 二进制、fpm 等工具，默认从 github 下载，
//   国内网络极易超时失败。设置 ELECTRON_MIRROR 和 ELECTRON_BUILDER_BINARIES_MIRROR
//   指向 npmmirror.com 镜像，可稳定快速下载。
//
// afterPack 自动替换原生模块：
//   electron-builder.yml 配置了 afterPack: scripts/after-pack.mjs，打包到 linux
//   target 时会自动调用 replaceNativeModules 把 win32 原生模块替换为 Linux 版
//   （@napi-rs/canvas、@img/sharp），因此无需手动跑 fix-native-modules.mjs。
//   如 afterPack 替换失败（如 tarball 缺失），可事后手动执行：
//     node scripts/fix-native-modules.mjs
import { execSync } from 'child_process';

// 国内镜像：electron 二进制 + electron-builder 工具链（fpm 等）
process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

function run(cmd, label) {
  console.log(`\n=== ${label} ===`);
  execSync(cmd, { stdio: 'inherit' });
}

// 1. 编译主进程 + 预加载 + 渲染进程
run('npx electron-vite build', '1. electron-vite build');

// 2. 打包 Linux（tar.gz + deb + AppImage），afterPack hook 会自动替换原生模块
run('npx electron-builder --linux deb', '2. electron-builder（仅 deb——用户定稿：AppImage/tar.gz 不再产出）');

console.log('\n✅ Linux 打包完成');