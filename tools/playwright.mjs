/*
 * Playwright 解析：优先项目本地 node_modules，回退到本机全局安装路径。
 * 浏览器内核由 Playwright 自行在 ~/.cache/ms-playwright 查找。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GLOBAL = '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import(GLOBAL));
}

export { chromium };
