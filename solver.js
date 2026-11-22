/*
 * 游戏内容包装载顺序求解器（纯逻辑，无 DOM 依赖）
 * UMD：浏览器挂到 globalThis.ModSolver，Node 下走 module.exports。
 *
 * 规则：
 *  - 版本为三段数字，版本范围含下界、不含上界；缺下界/上界视为无限制。
 *  - 同名包最多选一个版本；只安装勾选包及其传递依赖。
 *  - 冲突任一方声明即禁止共存；依赖图必须无环。
 *  - 多解时按包名排序的版本向量取字典序最大，未选包低于任何已选版本。
 *  - 装载顺序：依赖先装，同层按包名字典序。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ModSolver = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var LIMIT_PACKS = 24;
  var LIMIT_VERSIONS = 6;

  // ---------- 版本基础 ----------

  function parseVersion(raw) {
    if (typeof raw !== 'string') return { ok: false, error: '版本必须是字符串，得到 ' + typeOf(raw) };
    var parts = raw.split('.');
    if (parts.length < 1 || parts.length > 3) {
      return { ok: false, error: '版本号必须是 1~3 段数字：' + raw };
    }
    var triple = [0, 0, 0];
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+$/.test(parts[i])) {
        return { ok: false, error: '版本号包含非数字段：' + raw };
      }
      triple[i] = parseInt(parts[i], 10);
    }
    return { ok: true, triple: triple, raw: raw };
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function cmpTriple(a, b) {
    for (var i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function inRange(v, lo, hi) {
    if (lo !== null && cmpTriple(v, lo) < 0) return false;
    if (hi !== null && cmpTriple(v, hi) >= 0) return false;
    return true;
  }

  function formatRange(rule) {
    var parts = [];
    parts.push(rule.lo !== null ? '>=' + rule.rawLo : null);
    parts.push(rule.hi !== null ? '<' + rule.rawHi : null);
    var text = parts.filter(Boolean).join(' ');
    return text || '任意版本';
  }

  function label(id, rawV) {
    return id + '@' + rawV;
  }

  // ---------- 导入校验与规范化 ----------

  function validateModel(input) {
    var errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['顶层必须是 JSON 对象'] };
    }

    var roots = Array.isArray(input.roots) ? input.roots : [];
    if (!Array.isArray(input.roots)) errors.push('roots 必须是字符串数组');
    roots.forEach(function (r, i) {
      if (typeof r !== 'string') errors.push('roots[' + i + '] 不是字符串');
    });

    var base = input.base && typeof input.base === 'object' && !Array.isArray(input.base)
      ? input.base : {};
    if (input.base !== undefined && (typeof input.base !== 'object' || Array.isArray(input.base))) {
      errors.push('base 必须是对象');
    }

    if (!Array.isArray(input.packs)) {
      errors.push('packs 必须是数组');
      return { ok: false, errors: errors };
    }

    var groups = new Map(); // id -> [{raw 包对象}]
    var seen = new Set();

    input.packs.forEach(function (p, idx) {
      var where = 'packs[' + idx + ']';
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(where + ' 不是对象');
        return;
      }
      if (typeof p.id !== 'string' || !p.id) {
        errors.push(where + '.id 必须是非空字符串');
        return;
      }
      var pv = parseVersion(p.v);
      if (!pv.ok) {
        errors.push(where + '（' + p.id + '）：' + pv.error);
        return;
      }
      var key = p.id + '@' + pv.raw;
      if (seen.has(key)) {
        errors.push('重复的包版本：' + key);
        return;
      }
      seen.add(key);
      if (!groups.has(p.id)) groups.set(p.id, []);
      groups.get(p.id).push({ raw: p, vt: pv.triple, rawV: pv.raw, idx: idx });
    });

    if (groups.size > LIMIT_PACKS) {
      errors.push('包数量为 ' + groups.size + '，超过上限 ' + LIMIT_PACKS + ' 个');
    }
    groups.forEach(function (list, id) {
      if (list.length > LIMIT_VERSIONS) {
        errors.push('包 ' + id + ' 有 ' + list.length + ' 个版本，超过上限 ' + LIMIT_VERSIONS + ' 个');
      }
    });

    roots.forEach(function (r) {
      if (typeof r === 'string' && !groups.has(r)) {
        errors.push('roots 中的包不存在：' + r);
      }
    });

    // 规范化每个版本的 requires / conflicts / patch
    var byId = new Map();
    groups.forEach(function (list, id) {
      var versions = list.map(function (entry) {
        var p = entry.raw;
        return {
          id: id,
          rawV: entry.rawV,
          vt: entry.vt,
          requires: normalizeClauses(p.requires, id, entry.rawV, 'requires', groups, errors),
          conflicts: normalizeClauses(p.conflicts, id, entry.rawV, 'conflicts', groups, errors),
          patch: normalizePatch(p.patch, id, entry.rawV, errors)
        };
      });
      versions.sort(function (a, b) { return cmpTriple(b.vt, a.vt); }); // 高版本在前
      byId.set(id, { id: id, versions: versions });
    });

    if (errors.length) return { ok: false, errors: errors };

    return {
      ok: true,
      model: {
        roots: roots.slice(),
        base: Object.assign({}, base),
        ids: Array.from(byId.keys()).sort(),
        byId: byId
      }
    };
  }

  function normalizeClauses(clauses, ownerId, ownerV, field, groups, errors) {
    if (clauses === undefined || clauses === null) return [];
    if (!Array.isArray(clauses)) {
      errors.push(label(ownerId, ownerV) + ' 的 ' + field + ' 必须是数组');
      return [];
    }
    return clauses.map(function (c, i) {
      var where = label(ownerId, ownerV) + ' ' + field + '[' + i + ']';
      if (!Array.isArray(c) || c.length < 1 || c.length > 3) {
        errors.push(where + ' 必须是 1~3 个元素的数组 [包名, 下界?, 上界?]');
        return null;
      }
      var depId = c[0];
      if (typeof depId !== 'string' || !depId) {
        errors.push(where + ' 的包名必须是非空字符串');
        return null;
      }
      if (!groups.has(depId)) {
        errors.push(where + ' 引用了不存在的包：' + depId);
        return null;
      }
      var lo = null, hi = null, rawLo = null, rawHi = null;
      if (c.length >= 2 && c[1] !== null && c[1] !== undefined) {
        var plo = parseVersion(c[1]);
        if (!plo.ok) { errors.push(where + ' 下界：' + plo.error); return null; }
        lo = plo.triple; rawLo = plo.raw;
      }
      if (c.length >= 3 && c[2] !== null && c[2] !== undefined) {
        var phi = parseVersion(c[2]);
        if (!phi.ok) { errors.push(where + ' 上界：' + phi.error); return null; }
        hi = phi.triple; rawHi = phi.raw;
      }
      if (lo !== null && hi !== null && cmpTriple(lo, hi) >= 0) {
        errors.push(where + ' 范围为空（下界 ' + rawLo + ' 不小于上界 ' + rawHi + '）');
        return null;
      }
      return { id: depId, lo: lo, hi: hi, rawLo: rawLo, rawHi: rawHi };
    }).filter(Boolean);
  }

  function normalizePatch(patch, ownerId, ownerV, errors) {
    if (patch === undefined || patch === null) return [];
    if (!Array.isArray(patch)) {
      errors.push(label(ownerId, ownerV) + ' 的 patch 必须是数组');
      return [];
    }
    return patch.map(function (op, i) {
      var where = label(ownerId, ownerV) + ' patch[' + i + ']';
      if (!Array.isArray(op)) { errors.push(where + ' 必须是数组'); return null; }
      if (op[0] === 'set') {
        if (op.length !== 3 || typeof op[1] !== 'string') {
          errors.push(where + ' set 条目格式应为 ["set", 键, 值]');
          return null;
        }
        return { op: 'set', key: op[1], value: op[2] };
      }
      if (op[0] === 'delete') {
        if (op.length !== 2 || typeof op[1] !== 'string') {
          errors.push(where + ' delete 条目格式应为 ["delete", 键]');
          return null;
        }
        return { op: 'delete', key: op[1] };
      }
      errors.push(where + ' 未知操作：' + String(op[0]));
      return null;
    }).filter(Boolean);
  }

  // ---------- 求解 ----------

  function solve(model, checkedIds) {
    var checked = Array.from(new Set((checkedIds || []).filter(function (x) { return typeof x === 'string'; })));
    var reasons = new Map();
    function addReason(r) {
      var k = r.kind + '|' + JSON.stringify(r);
      if (!reasons.has(k) && reasons.size < 40) reasons.set(k, r);
    }

    var unknown = checked.filter(function (id) { return !model.byId.has(id); });
    unknown.forEach(function (id) { addReason({ kind: 'unknown', pkg: id }); });
    if (unknown.length) return fail(reasons);

    var assign = new Map();       // id -> 规范化版本对象
    var constraints = new Map();  // id -> [{lo,hi,rawLo,rawHi,by}]
    var edges = new Map();        // requirer -> Set(depId)
    var needCount = new Map();    // id -> 成为必装的计数（根初始为 1）
    checked.forEach(function (id) { needCount.set(id, 1); });

    function mandatoryIds() {
      return Array.from(needCount.keys()).filter(function (id) { return !assign.has(id); }).sort();
    }

    function findPath(from, to) {
      var stack = [[from, [from]]];
      var seen = new Set([from]);
      while (stack.length) {
        var cur = stack.pop();
        var node = cur[0], path = cur[1];
        var outs = edges.get(node);
        if (!outs) continue;
        var list = Array.from(outs).sort().reverse();
        for (var i = 0; i < list.length; i++) {
          var nxt = list[i];
          if (seen.has(nxt)) continue;
          seen.add(nxt);
          var np = path.concat([nxt]);
          if (nxt === to) return np;
          stack.push([nxt, np]);
        }
      }
      return null;
    }

    function dfs() {
      var pending = mandatoryIds();
      if (!pending.length) return true;
      var id = pending[0]; // 包名字典序最靠前的未决必装包
      var versions = model.byId.get(id).versions;
      var cons = constraints.get(id) || [];

      for (var vi = 0; vi < versions.length; vi++) {
        var cand = versions[vi];
        var me = label(id, cand.rawV);

        // 1) 已累积的版本范围
        var badRange = null;
        for (var ci = 0; ci < cons.length; ci++) {
          if (!inRange(cand.vt, cons[ci].lo, cons[ci].hi)) { badRange = cons[ci]; break; }
        }
        if (badRange) {
          addReason({
            kind: 'range', pkg: id, version: cand.rawV,
            rule: { lo: badRange.rawLo, hi: badRange.rawHi }, by: badRange.by,
            text: me + ' 不满足 ' + badRange.by + ' 声明的范围 ' + formatRange(badRange)
          });
          continue;
        }

        // 2) 冲突（双向）
        var clash = null;
        var assignedEntries = Array.from(assign.entries());
        for (var ai = 0; ai < assignedEntries.length; ai++) {
          var qid = assignedEntries[ai][0], qv = assignedEntries[ai][1];
          for (var k = 0; k < cand.conflicts.length; k++) {
            var cc = cand.conflicts[k];
            if (cc.id === qid && inRange(qv.vt, cc.lo, cc.hi)) {
              clash = { declaredBy: me, other: label(qid, qv.rawV), rule: cc, side: 'candidate' };
              break;
            }
          }
          if (clash) break;
          for (var k2 = 0; k2 < qv.conflicts.length; k2++) {
            var qc = qv.conflicts[k2];
            if (qc.id === id && inRange(cand.vt, qc.lo, qc.hi)) {
              clash = { declaredBy: label(qid, qv.rawV), other: me, rule: qc, side: 'other' };
              break;
            }
          }
          if (clash) break;
        }
        if (clash) {
          addReason({
            kind: 'conflict', pkg: id, version: cand.rawV,
            declaredBy: clash.declaredBy, other: clash.other,
            rule: { lo: clash.rule.rawLo, hi: clash.rule.rawHi, target: clash.rule.id },
            text: clash.declaredBy + ' 声明与 ' + clash.rule.id + ' ' + formatRange(clash.rule) +
              ' 冲突，命中 ' + clash.other
          });
          continue;
        }

        // 3) 应用候选并连边，再统一做前向检查（环、已装依赖的新范围约束）
        assign.set(id, cand);
        edges.set(id, new Set(cand.requires.map(function (r) { return r.id; })));
        var addedCons = [];
        var addedNeed = [];
        var cycleEdge = null;
        var forwardBad = null;
        cand.requires.forEach(function (r) {
          if (!constraints.has(r.id)) constraints.set(r.id, []);
          var entry = {
            lo: r.lo, hi: r.hi, rawLo: r.rawLo, rawHi: r.rawHi, by: me
          };
          constraints.get(r.id).push(entry);
          // 记录引用，回滚时精确删除（不能用 pop，同一依赖可能被多个候选累积过约束）
          addedCons.push({ depId: r.id, entry: entry });
          needCount.set(r.id, (needCount.get(r.id) || 0) + 1);
          addedNeed.push(r.id);

          if (r.id === id) {
            // 自依赖必然成环；path 仅含起点自身，展示时首尾各出现一次
            cycleEdge = cycleEdge || { req: r, path: [id], selfLoop: true };
          } else if (assign.has(r.id) && !cycleEdge) {
            // 新边 id -> dep；若 dep 沿现有边能回到 id，则成环
            var path = findPath(r.id, id);
            if (path) cycleEdge = { req: r, path: path, selfLoop: false };
          }
          // 依赖若已安装，新约束必须立刻满足，否则该分支不可能成立
          if (!forwardBad && assign.has(r.id)) {
            var depPack = assign.get(r.id);
            if (!inRange(depPack.vt, r.lo, r.hi)) {
              forwardBad = { req: r, depPack: depPack };
            }
          }
        });

        if (cycleEdge) {
          // pathNodes：从当前包出发、沿依赖边走一圈回到当前包（首尾都是 me，带版本）
          var pathNodes;
          if (cycleEdge.selfLoop) {
            pathNodes = [me, me];
          } else {
            var backPath = cycleEdge.path.slice(0, -1); // findPath 的末位就是 id，去掉后由收尾 me 补上
            pathNodes = [me].concat(backPath.map(function (nid) {
              return label(nid, assign.get(nid).rawV);
            })).concat([me]);
          }
          addReason({
            kind: 'cycle', pkg: id, version: cand.rawV,
            edge: me + ' -> ' + cycleEdge.req.id,
            path: cycleEdge.path, // 裸包名序列（程序化使用）
            pathNodes: pathNodes, // 带版本的完整环路径（展示用）
            text: '选择 ' + me + ' 会形成依赖环：' + pathNodes.join(' -> ')
          });
        } else if (forwardBad) {
          addReason({
            kind: 'range', pkg: forwardBad.req.id, version: forwardBad.depPack.rawV,
            rule: { lo: forwardBad.req.rawLo, hi: forwardBad.req.rawHi }, by: me,
            text: me + ' 要求 ' + forwardBad.req.id + ' ' + formatRange(forwardBad.req) +
              '，但已选的 ' + label(forwardBad.req.id, forwardBad.depPack.rawV) + ' 不在范围内'
          });
        } else if (dfs()) {
          return true;
        }

        // 回滚
        assign.delete(id);
        edges.delete(id);
        addedCons.forEach(function (item) {
          var arr = constraints.get(item.depId);
          var pos = arr.indexOf(item.entry);
          if (pos >= 0) arr.splice(pos, 1);
          if (!arr.length) constraints.delete(item.depId);
        });
        addedNeed.forEach(function (depId) {
          var n = needCount.get(depId) - 1;
          if (n <= 0) needCount.delete(depId); else needCount.set(depId, n);
        });
      }

      addReason({
        kind: 'stuck', pkg: id,
        constraints: cons.map(function (c) {
          return { by: c.by, lo: c.rawLo, hi: c.rawHi, text: c.by + ' 要求 ' + id + ' ' + formatRange(c) };
        }),
        available: versions.map(function (v) { return v.rawV; }),
        text: '包 ' + id + ' 无可用版本：' +
          (cons.length ? cons.map(function (c) {
            return c.by + ' 要求 ' + formatRange(c);
          }).join('；') : '没有版本通过其它检查')
      });
      return false;
    }

    if (!dfs()) return fail(reasons);

    // 叶子复核 + 拓扑排序（依赖先装，同名次按包名）
    var verify = verifySolution(model, assign);
    if (!verify.ok) {
      verify.errors.forEach(function (text) { addReason({ kind: 'verify', text: text }); });
      return fail(reasons);
    }

    var order = topoOrder(assign, edges, checked);
    return {
      feasible: true,
      selected: assign,
      edges: edges,
      order: order,
      checked: checked
    };
  }

  function fail(reasons) {
    return { feasible: false, reasons: Array.from(reasons.values()) };
  }

  function verifySolution(model, assign) {
    var errors = [];
    assign.forEach(function (pack, id) {
      pack.requires.forEach(function (r) {
        var dep = assign.get(r.id);
        if (!dep) {
          errors.push(label(id, pack.rawV) + ' 依赖的 ' + r.id + ' 未被选中');
        } else if (!inRange(dep.vt, r.lo, r.hi)) {
          errors.push(label(id, pack.rawV) + ' 要求 ' + r.id + ' ' + formatRange(r) +
            '，实际为 ' + dep.rawV);
        }
      });
      pack.conflicts.forEach(function (c) {
        var other = assign.get(c.id);
        if (other && inRange(other.vt, c.lo, c.hi)) {
          errors.push(label(id, pack.rawV) + ' 与 ' + label(c.id, other.rawV) + ' 冲突');
        }
      });
    });
    return { ok: !errors.length, errors: errors };
  }

  function topoOrder(assign, edges, checked) {
    var indeg = new Map();
    var dependents = new Map(); // dep -> [requirers]
    assign.forEach(function (_v, id) { indeg.set(id, 0); dependents.set(id, []); });
    assign.forEach(function (_v, id) {
      (edges.get(id) || []).forEach(function (dep) {
        if (!assign.has(dep)) return;
        indeg.set(id, indeg.get(id) + 1);
        dependents.get(dep).push(id);
      });
    });
    var ready = Array.from(indeg.keys()).filter(function (id) { return indeg.get(id) === 0; }).sort();
    var order = [];
    var direct = new Set(checked);
    while (ready.length) {
      var id = ready.shift();
      var pack = assign.get(id);
      order.push({
        id: id,
        version: pack.rawV,
        direct: direct.has(id),
        requires: Array.from(edges.get(id) || []).filter(function (d) { return assign.has(d); }).sort()
      });
      dependents.get(id).forEach(function (req) {
        indeg.set(req, indeg.get(req) - 1);
        if (indeg.get(req) === 0) {
          ready.push(req);
          ready.sort();
        }
      });
    }
    if (order.length !== assign.size) {
      throw new Error('拓扑排序失败：依赖图仍有环');
    }
    return order;
  }

  // ---------- 补丁合并模拟 ----------

  function simulate(model, solution) {
    var data = new Map();
    var history = new Map();
    Object.keys(model.base).sort().forEach(function (k) {
      data.set(k, model.base[k]);
      history.set(k, [{ op: 'base', source: 'base', value: model.base[k] }]);
    });

    solution.order.forEach(function (step) {
      var pack = solution.selected.get(step.id);
      var source = label(step.id, step.version);
      pack.patch.forEach(function (entry) {
        if (!history.has(entry.key)) history.set(entry.key, []);
        if (entry.op === 'set') {
          data.set(entry.key, entry.value);
          history.get(entry.key).push({ op: 'set', source: source, value: entry.value });
        } else {
          data.delete(entry.key);
          history.get(entry.key).push({ op: 'delete', source: source });
        }
      });
    });

    return {
      data: Object.fromEntries(data.entries()),
      history: Object.fromEntries(history.entries())
    };
  }

  // ---------- 版本向量比较（测试与说明用） ----------

  function solutionVector(model, selected) {
    return model.ids.map(function (id) {
      var pack = selected.get(id);
      return pack ? pack.vt.slice() : null; // 未选 = null，低于一切真实版本
    });
  }

  function compareVectors(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] === null && b[i] === null) continue;
      if (a[i] === null) return -1;
      if (b[i] === null) return 1;
      var c = cmpTriple(a[i], b[i]);
      if (c !== 0) return c;
    }
    return 0;
  }

  return {
    LIMIT_PACKS: LIMIT_PACKS,
    LIMIT_VERSIONS: LIMIT_VERSIONS,
    parseVersion: parseVersion,
    cmpTriple: cmpTriple,
    inRange: inRange,
    formatRange: formatRange,
    validateModel: validateModel,
    solve: solve,
    simulate: simulate,
    topoOrder: topoOrder,
    solutionVector: solutionVector,
    compareVectors: compareVectors
  };
});
