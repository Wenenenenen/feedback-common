/*
 * Node 侧测试辅助：在 Node 中加载浏览器端 engine.js（ES 模块）。
 * 仅用于测试，不参与网页运行时。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadEngine() {
  const url = pathToFileURL(
    path.resolve(import.meta.dirname, "../src/web/js/engine.js"),
  ).href;
  return import(url);
}
