/* 导出 stress 场景的 JS 引擎公开结果，供 Python 参考实现交叉比对 */
'use strict';
var path = require('path');
var fs = require('fs');
var engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
var stress = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'samples', 'extracted', 'stress.json'), 'utf8'));
var recs = engine.detectScene(stress).map(engine.publicRecord);
fs.writeFileSync(path.join(__dirname, 'js_results.json'), JSON.stringify(recs));
console.log('写入 ' + recs.length + ' 条记录到 tests/js_results.json');
