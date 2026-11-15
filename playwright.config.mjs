import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:8791/',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  },
  webServer: {
    command: 'python3 -I -m http.server 8791 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8791/app/index.html',
    reuseExistingServer: true,
    timeout: 10000
  }
});
