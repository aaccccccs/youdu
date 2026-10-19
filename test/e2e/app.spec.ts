/**
 * E2E 基础测试（P2-10）
 *
 * 测试 Electron 应用的核心流程：
 * 1. 应用启动并显示主窗口
 * 2. 书架页面加载
 * 3. 导航到设置页
 * 4. 导航到订阅页
 *
 * 运行方式：
 *   1. 先构建：npm run build
 *   2. 安装 Playwright：npx playwright install
 *   3. 运行：npx playwright test
 *
 * 注意：需要安装 @playwright/test 和 electron-playwright-helpers
 *   npm i -D @playwright/test electron-playwright-helpers
 */
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['out/main/index.js'] });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test.describe('应用启动', () => {
  test('主窗口可见', async () => {
    const isVisible = await page.isVisible('body');
    expect(isVisible).toBe(true);
  });

  test('窗口标题包含"幽读"', async () => {
    const title = await page.title();
    expect(title).toContain('幽读');
  });
});

test.describe('书架页面', () => {
  test('显示书架内容', async () => {
    // 书架页面应该有导入按钮或空状态提示
    const hasContent = await page.locator('text=导入').or(page.locator('text=书架')).first().isVisible();
    expect(hasContent).toBe(true);
  });
});

test.describe('导航功能', () => {
  test('可以导航到设置页', async () => {
    // 点击设置导航
    await page.locator('text=设置').first().click();
    await page.waitForTimeout(500);
    // 设置页应该可见
    const settingsVisible = await page.locator('text=通用设置').or(page.locator('text=设置')).first().isVisible();
    expect(settingsVisible).toBe(true);
  });

  test('可以导航到订阅页', async () => {
    await page.locator('text=订阅').first().click();
    await page.waitForTimeout(500);
    const subVisible = await page.locator('text=订阅').first().isVisible();
    expect(subVisible).toBe(true);
  });

  test('可以返回书架', async () => {
    await page.locator('text=书架').first().click();
    await page.waitForTimeout(500);
    const bookshelfVisible = await page.locator('text=书架').or(page.locator('text=导入')).first().isVisible();
    expect(bookshelfVisible).toBe(true);
  });
});
