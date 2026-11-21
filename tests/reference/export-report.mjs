#!/usr/bin/env node
/**
 * 从页面导出一份滤波器 JSON，供 tests/reference/crosscheck.py 做独立比对。
 * 用法：node tests/reference/export-report.mjs <输出路径>
 *
 * 若 BASE_URL 指向的服务没在跑，脚本会自己拉起 vite（用完即关），
 * 这样 `npm run test:ref` 不依赖用户先手动开服务器。
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE = path.resolve('samples/echo-path-nlms-desk-cases.zip');
const out = path.resolve(process.argv[2] ?? 'tests/e2e-out/report.json');
const port = Number(process.env.PORT ?? 4174);
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}/`;

fs.mkdirSync(path.dirname(out), { recursive: true });

async function reachable(url, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

let server = null;
if (!(await reachable(baseURL))) {
  if (process.env.BASE_URL) throw new Error(`BASE_URL 指定的服务不可达：${baseURL}`);
  server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });
  const ready = await reachable(baseURL, 20000);
  if (!ready) {
    server.kill();
    throw new Error(`无法启动 vite（端口 ${port}）`);
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL);
  await page.waitForFunction(() => Boolean(window.scenario));
  await page.evaluate(async (bytes) => {
    await window.scenario.openSampleZip(new File([Uint8Array.from(bytes)], 'cases.zip'));
    await window.scenario.loadSampleCase('main');
    window.scenario.run();
  }, Array.from(fs.readFileSync(ARCHIVE)));
  const report = await page.evaluate(() => window.scenario.report());
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`已写入 ${out}（${report.taps.length} 抽头，${report.processedFrames} 帧）`);
  if (errors.length) {
    console.error('页面错误：', errors);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  if (server) server.kill();
}
