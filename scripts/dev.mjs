// 启动脚本：清除 ELECTRON_RUN_AS_NODE 环境变量后启动 electron-vite dev
// 该变量在 CodeArts 等环境中被设置，会导致 electron 作为纯 Node.js 运行而非 Electron 主进程
import { spawn } from 'child_process';

delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
