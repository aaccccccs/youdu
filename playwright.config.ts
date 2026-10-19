/**
 * E2E 测试配置（P2-10）
 *
 * 使用 Playwright 对 Electron 应用进行端到端测试。
 * 运行前需先构建应用：npm run build
 * 运行 E2E：npx playwright test
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  retries: 1,
  use: {
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'electron',
      use: {
        // Electron E2E 通过 _electron fixture 启动
        channel: 'electron'
      }
    }
  ]
});
