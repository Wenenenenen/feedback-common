/*
 * 种子配置的校验与序列化（纯函数，便于测试）
 *
 * 兼容 samples 目录中的配置格式：
 *   { "foreground": [[x, y], ...], "background": [[x, y], ...], "lambda": 1.2 }
 * 导出时额外写入尺寸、均值与能量；导入时这些附加字段只用于一致性检查，
 * 真正的种子与参数以 foreground / background / lambda 为准。
 */
(function (root) {
  'use strict';

  var MAX_SIDE = 256;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function describeEntry(entry) {
    try {
      return JSON.stringify(entry);
    } catch (e) {
      return String(entry);
    }
  }

  function parseSeedList(raw, name, width, height) {
    if (!Array.isArray(raw)) {
      throw new Error('配置中的 ' + name + ' 必须是 [x, y] 坐标数组');
    }
    var seen = Object.create(null);
    var list = [];
    var duplicates = 0;
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (!Array.isArray(entry) || entry.length !== 2 ||
          !Number.isInteger(entry[0]) || !Number.isInteger(entry[1])) {
        throw new Error('配置中的 ' + name + ' 第 ' + (i + 1) + ' 项 ' + describeEntry(entry) + ' 不是 [x, y] 整数对');
      }
      var x = entry[0];
      var y = entry[1];
      if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(
          '配置中的 ' + name + ' 第 ' + (i + 1) + ' 项 (' + x + ', ' + y + ') 超出图片范围 ' + width + '×' + height
        );
      }
      var key = y * width + x;
      if (seen[key]) {
        duplicates++;
        continue;
      }
      seen[key] = true;
      list.push([x, y]);
    }
    return { list: list, seen: seen, duplicates: duplicates };
  }

  /*
   * 校验配置并返回规范化的结果。
   * image: { width, height }（可选，用于一致性检查与边界检查）
   * 冲突（同一像素同时属于两类）会抛错，由调用方明确展示。
   */
  function validateSeedConfig(raw, image) {
    if (!isPlainObject(raw)) {
      throw new Error('配置文件必须是一个 JSON 对象');
    }
    if (!Object.prototype.hasOwnProperty.call(raw, 'foreground') ||
        !Object.prototype.hasOwnProperty.call(raw, 'background')) {
      throw new Error('配置缺少 foreground 或 background 字段');
    }

    var width = image && image.width ? image.width : MAX_SIDE;
    var height = image && image.height ? image.height : MAX_SIDE;
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
      throw new Error('当前图片尺寸无效，无法导入种子配置');
    }

    var declared = null;
    if (isPlainObject(raw.image)) {
      declared = { width: raw.image.width, height: raw.image.height };
    } else if (raw.width != null || raw.height != null) {
      declared = { width: raw.width, height: raw.height };
    }
    if (declared && declared.width != null && declared.height != null) {
      if (!Number.isInteger(declared.width) || !Number.isInteger(declared.height)) {
        throw new Error('配置中的图片尺寸无效');
      }
      var imageKnown = image && image.width && image.height;
      if (imageKnown && (declared.width !== width || declared.height !== height)) {
        throw new Error(
          '配置的图片尺寸 ' + declared.width + '×' + declared.height +
          ' 与当前图片 ' + width + '×' + height + ' 不一致'
        );
      }
    }

    var fg = parseSeedList(raw.foreground, 'foreground', width, height);
    var bg = parseSeedList(raw.background, 'background', width, height);

    var conflict = null;
    for (var key in fg.seen) {
      if (bg.seen[key]) {
        var idx = Number(key);
        conflict = [idx % width, Math.floor(idx / width)];
        break;
      }
    }
    if (conflict) {
      throw new Error('种子冲突：像素 (' + conflict[0] + ', ' + conflict[1] + ') 同时出现在 foreground 与 background 中');
    }

    var lambda = 1;
    var lambdaDefaulted = false;
    if (raw.lambda == null) {
      lambdaDefaulted = true;
    } else {
      lambda = raw.lambda;
      if (typeof lambda !== 'number' || !isFinite(lambda)) {
        throw new Error('lambda 必须是数字');
      }
      if (lambda < 0 || lambda > 20) {
        throw new Error('lambda 必须在 0 到 20 之间（当前为 ' + lambda + '）');
      }
    }

    return {
      foreground: fg.list,
      background: bg.list,
      lambda: lambda,
      lambdaDefaulted: lambdaDefaulted,
      duplicates: fg.duplicates + bg.duplicates,
      size: { width: width, height: height }
    };
  }

  /*
   * 生成可重新导入的种子配置。result 为当前最新的求解结果时才写入
   * 均值与能量；过期结果一律不写，避免把旧数据当成当前数据。
   */
  function buildSeedConfig(options) {
    var fg = options.foreground || [];
    var bg = options.background || [];
    var out = {
      format: 'seed-cut-matte/v1',
      foreground: fg.map(function (p) { return [p[0], p[1]]; }),
      background: bg.map(function (p) { return [p[0], p[1]]; }),
      lambda: options.lambda
    };
    if (options.image) {
      out.image = {
        width: options.image.width,
        height: options.image.height,
        name: options.image.name || null
      };
    }
    if (options.result) {
      var r = options.result;
      out.model = {
        beta: r.beta,
        meanForeground255: r.m1.map(function (v) { return v * 255; }),
        meanBackground255: r.m0.map(function (v) { return v * 255; }),
        unaryTerm: r.unary,
        boundaryTerm: r.boundary,
        totalEnergy: r.total,
        maxFlow: r.maxFlow,
        hardSeedCapacity: r.seedCapacity
      };
    } else {
      out.model = null;
    }
    return out;
  }

  root.MatteConfig = {
    validateSeedConfig: validateSeedConfig,
    buildSeedConfig: buildSeedConfig
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      validateSeedConfig: validateSeedConfig,
      buildSeedConfig: buildSeedConfig
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
