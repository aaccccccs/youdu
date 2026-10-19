// 预览脚本：清除 ELECTRON_RUN_AS_NODE 环境变量后启动 electron-vite preview
import { spawn } from 'child_process';

delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn('npx', ['electron-vite', 'preview'], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
