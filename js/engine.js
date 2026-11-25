/*
 * 多轨录音缺块修复 —— 核心引擎（无 DOM 依赖，浏览器与 Node 通用）
 * 仅使用逐字节异或与 GF(2) 高斯消元，不依赖任何纠删码/消元库。
 */
(function (global) {
  'use strict';

  /* ---------------- CRC-32（标准表驱动，校验向量 123456789 -> cbf43926） ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- 严格 Base64（标准带填充） ---------------- */
  const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

  function b64ToBytes(s) {
    if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0 || !B64_RE.test(s)) {
      throw new Error('Base64 畸形');
    }
    if (typeof atob === 'function') {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(s, 'base64'));
    }
    throw new Error('当前环境没有可用的 Base64 解码器');
  }

  const HEX8_RE = /^[0-9a-f]{8}$/;
  const PAYLOAD_LEN = 512;

  function xorInto(dst, src) {
    for (let i = 0; i < PAYLOAD_LEN; i++) dst[i] ^= src[i];
  }

  function isZero(bytes) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
  }

  function mismatchPositions(bytes, limit) {
    const out = [];
    for (let i = 0; i < bytes.length && out.length < limit; i++) {
      if (bytes[i] !== 0) out.push(i);
    }
    return out;
  }

  /* ---------------- 整份文件结构校验（错误 => 整份拒绝，保留上一份结果） ---------------- */
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function isNonNegInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
  }

  function validateStructure(o) {
    const errs = [];
    const push = (m) => { if (errs.length < 30) errs.push(m); };

    if (!isPlainObject(o)) return ['根节点必须是 JSON 对象'];
    const { tracks, blocksPerTrack, blocks, checks } = o;

    if (!Array.isArray(tracks)) {
      push('tracks 必须是数组');
    } else {
      if (tracks.length < 1 || tracks.length > 8) push('tracks 数量必须在 1 至 8 之间');
      const seenNames = new Set();
      tracks.forEach((t, i) => {
        if (typeof t !== 'string' || t.length === 0) push(`tracks[${i}] 必须是非空字符串`);
        else if (seenNames.has(t)) push(`轨名重复：${t}`);
        else seenNames.add(t);
      });
    }

    if (!isNonNegInt(blocksPerTrack) || blocksPerTrack === 0) {
      push('blocksPerTrack 必须是正整数');
    } else if (Array.isArray(tracks) && tracks.length >= 1 && tracks.length <= 8) {
      if (tracks.length * blocksPerTrack > 8192) push('tracks × blocksPerTrack 不得超过 8192');
    }

    let N = 0;
    if (Array.isArray(tracks) && isNonNegInt(blocksPerTrack)) N = tracks.length * blocksPerTrack;

    if (!Array.isArray(blocks)) {
      push('blocks 必须是数组');
    } else if (N > 0) {
      const seen = new Set();
      blocks.forEach((b, i) => {
        if (!isPlainObject(b)) return push(`blocks[${i}] 必须是对象`);
        if (!isNonNegInt(b.id) || b.id >= N) return push(`blocks[${i}].id 超出合法范围 [0,${N - 1}]`);
        if (seen.has(b.id)) return push(`原音块 id 重复：${b.id}`);
        seen.add(b.id);
        if (typeof b.data !== 'string') push(`blocks[${i}].data 必须是字符串`);
        if (typeof b.crc !== 'string') push(`blocks[${i}].crc 必须是字符串`);
      });
    }

    if (!Array.isArray(checks)) {
      push('checks 必须是数组');
    } else {
      if (checks.length > 12000) push('checks 数量不得超过 12000');
      const seenIds = new Set();
      checks.forEach((c, i) => {
        if (!isPlainObject(c)) return push(`checks[${i}] 必须是对象`);
        if (!isNonNegInt(c.id) || c.id > 0xffffffff) return push(`checks[${i}].id 必须是 32 位非负整数`);
        if (seenIds.has(c.id)) return push(`校验行 id 重复：${c.id}`);
        seenIds.add(c.id);
        if (!Array.isArray(c.members)) return push(`checks[${i}].members 必须是数组`);
        if (c.members.length < 1 || c.members.length > 12) {
          push(`checks[${i}].members 数量必须在 1 至 12 之间`);
        }
        if (Array.isArray(c.members)) {
          const ms = new Set();
          for (const m of c.members) {
            if (!isNonNegInt(m) || (N > 0 && m >= N)) {
              push(`checks[${i}] 含非法块号：${String(m)}`);
            } else if (ms.has(m)) {
              push(`checks[${i}] 成员重复：${m}`);
            }
            ms.add(m);
          }
        }
        if (typeof c.data !== 'string') push(`checks[${i}].data 必须是字符串`);
        if (typeof c.crc !== 'string') push(`checks[${i}].crc 必须是字符串`);
      });
    }

    return errs;
  }

  /* ---------------- 记录级解码（坏数据按类别报告，不致命） ---------------- */
  function decodePayload(rec, kind, badList) {
    let bytes;
    try {
      bytes = b64ToBytes(rec.data);
    } catch (e) {
      badList.push({ id: rec.id, reason: 'Base64 畸形' });
      return null;
    }
    if (bytes.length !== PAYLOAD_LEN) {
      badList.push({ id: rec.id, reason: `载荷长度 ${bytes.length} ≠ ${PAYLOAD_LEN}` });
      return null;
    }
    if (!HEX8_RE.test(rec.crc)) {
      badList.push({ id: rec.id, reason: `CRC 字段格式错误：${String(rec.crc)}` });
      return null;
    }
    if (crc32(bytes) !== parseInt(rec.crc, 16)) {
      badList.push({ id: rec.id, reason: `CRC 不匹配（声明 ${rec.crc}，实得 ${crc32(bytes).toString(16).padStart(8, '0')}）` });
      return null;
    }
    return bytes;
  }

  /* 解析已通过结构校验的归档，返回模型（坏块视为缺失，坏校验不参与求解） */
  function buildModel(o) {
    const trackNames = o.tracks.slice();
    const blocksPerTrack = o.blocksPerTrack;
    const N = trackNames.length * blocksPerTrack;

    const blockData = new Array(N).fill(null);       // 有效原音块字节
    const blockReason = new Array(N).fill(null);     // null=有有效记录/未说明，否则坏数据原因
    const recordPresent = new Uint8Array(N);
    const badBlocks = [];

    for (const rec of o.blocks) {
      recordPresent[rec.id] = 1;
      const bytes = decodePayload(rec, 'block', badBlocks);
      if (bytes) blockData[rec.id] = bytes;
      else blockReason[rec.id] = badBlocks[badBlocks.length - 1].reason;
    }
    const missingBlocks = [];
    for (let id = 0; id < N; id++) {
      if (!blockData[id]) {
        if (!recordPresent[id]) {
          blockReason[id] = '记录缺失';
          missingBlocks.push(id);
        }
      }
    }

    const badChecks = [];
    const checks = [];
    for (const rec of o.checks) {
      const bytes = decodePayload(rec, 'check', badChecks);
      if (!bytes) continue;
      checks.push({
        id: rec.id,
        members: rec.members.slice(),
        data: bytes,
        enabled: true,
      });
    }
    const checkById = new Map(checks.map((c) => [c.id, c]));

    return {
      trackNames,
      blocksPerTrack,
      N,
      blockData,
      blockReason,
      recordPresent,
      badBlocks,
      missingBlocks,
      badChecks,
      checks,
      checkById,
    };
  }

  /* ---------------- 并查集 ---------------- */
  class DSU {
    constructor(n) {
      this.p = new Int32Array(n);
      for (let i = 0; i < n; i++) this.p[i] = -1; // -1 表示该块已知，不参与
    }
    activate(x) { if (this.p[x] === -1) this.p[x] = x; }
    find(x) {
      let r = x;
      while (this.p[r] !== r) r = this.p[r];
      while (this.p[x] !== x) { const nxt = this.p[x]; this.p[x] = r; x = nxt; }
      return r;
    }
    union(a, b) {
      const ra = this.find(a), rb = this.find(b);
      if (ra !== rb) this.p[rb] = ra;
    }
  }

  function popcountMask(mask, W) {
    let n = 0;
    for (let w = 0; w < W; w++) n += count32(mask[w]);
    return n;
  }
  function count32(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function hasBit(mask, col) {
    return (mask[col >>> 5] >>> (col & 31)) & 1;
  }

  function xorProv(a, b) {
    for (const id of b.prov) {
      if (a.prov.has(id)) a.prov.delete(id);
      else a.prov.add(id);
    }
  }
  function xorRow(a, b, W) {
    for (let w = 0; w < W; w++) a.mask[w] ^= b.mask[w];
    for (let i = 0; i < PAYLOAD_LEN; i++) a.rhs[i] ^= b.rhs[i];
    xorProv(a, b);
  }

  /*
   * 求解。
   * disabledIds: Set<number>，被停用的有效校验行 id。
   * 返回每个块的状态、可恢复块的可重验校验行组合、连通组与纯已知矛盾。
   */
  function solve(model, disabledIds) {
    const t0 = now();
    const disabled = disabledIds || new Set();
    const N = model.N;
    const known = model.blockData;

    const status = new Array(N);
    for (let i = 0; i < N; i++) status[i] = known[i] ? 'known' : 'undetermined';

    const dsu = new DSU(N);
    const prelim = [];
    const pureContradictions = [];

    // 第一步：有效且启用的校验行先代入已知块
    for (const row of model.checks) {
      if (disabled.has(row.id)) continue;
      const unknowns = [];
      const rhs = row.data.slice();
      for (const m of row.members) {
        if (known[m]) xorInto(rhs, known[m]);
        else {
          dsu.activate(m);
          unknowns.push(m);
        }
      }
      if (unknowns.length === 0) {
        // 无未知量：行必须自洽，否则单列纯已知矛盾
        if (!isZero(rhs)) {
          pureContradictions.push({
            checkId: row.id,
            mismatchBytes: mismatchPositions(rhs, 16),
            mismatchCount: countMismatch(rhs),
          });
        }
        continue;
      }
      for (let i = 1; i < unknowns.length; i++) dsu.union(unknowns[0], unknowns[i]);
      prelim.push({ checkId: row.id, unknowns, rhs });
    }

    // 第二步：按连通根分组
    const groupOf = new Map();
    for (const eq of prelim) {
      const root = dsu.find(eq.unknowns[0]);
      if (!groupOf.has(root)) groupOf.set(root, []);
      groupOf.get(root).push(eq);
    }
    // 不被任何启用校验行覆盖的未知块（dsu 中未激活，p 仍为 -1）各自成孤立组，永远未定
    for (let id = 0; id < N; id++) {
      if (!known[id] && dsu.p[id] === -1) groupOf.set(id, []);
    }

    const recovered = [];
    const groups = [];
    let groupSeq = 0;
    let contradictionGroups = 0;

    for (const [root, eqs] of groupOf) {
      groupSeq++;
      const cols = [...new Set(eqs.flatMap((e) => e.unknowns))].sort((a, b) => a - b);
      if (eqs.length === 0) {
        // 孤立项：无方程可解
        groups.push({
          seq: groupSeq, root, blocks: cols.length ? cols : [root],
          state: 'consistent', rank: 0, recoveredCount: 0,
        });
        continue;
      }
      const c = cols.length;
      const colIndex = new Map(cols.map((g, i) => [g, i]));
      const W = (c + 31) >>> 5;

      const rows = eqs.map((e) => {
        const mask = new Uint32Array(W);
        for (const g of e.unknowns) mask[colIndex.get(g) >>> 5] |= 1 << (colIndex.get(g) & 31);
        return { mask, rhs: e.rhs.slice(), prov: new Set([e.checkId]) };
      });

      // 第三步：GF(2) 完整 RREF（逐列扫描，主元立即从所有其他行消去）。
      // prov 记录每行由哪些校验行异或而来，用于给出可重验组合。
      const pivotRowOfCol = new Int32Array(c).fill(-1);
      const pivotCols = [];
      let contradiction = null;
      let pr = 0;

      for (let col = 0; col < c && pr < rows.length; col++) {
        // 在 pr 及以下寻找该列含 1 的行
        let piv = -1;
        for (let i = pr; i < rows.length; i++) {
          if (hasBit(rows[i].mask, col)) { piv = i; break; }
        }
        if (piv === -1) continue; // 该列是自由变量列
        if (piv !== pr) {
          const tmp = rows[pr]; rows[pr] = rows[piv]; rows[piv] = tmp;
        }
        const pivotRow = rows[pr];
        // 从所有其他行消去该主元列 => 完整 RREF（主元列在其余行全为 0）
        for (let i = 0; i < rows.length; i++) {
          if (i !== pr && hasBit(rows[i].mask, col)) xorRow(rows[i], pivotRow, W);
        }
        pivotRowOfCol[col] = pr;
        pivotCols.push(col);
        pr++;
      }

      // 消元后若出现 0 系数行但 RHS 非零 => 组内矛盾（任一字节无解即整组封锁）
      if (!contradiction) {
        for (let i = pr; i < rows.length; i++) {
          if (popcountMask(rows[i].mask, W) === 0 && !isZero(rows[i].rhs)) {
            contradiction = {
              checkIds: [...rows[i].prov].sort((a, b) => a - b),
              mismatchBytes: mismatchPositions(rows[i].rhs, 16),
              mismatchCount: countMismatch(rows[i].rhs),
            };
            break;
          }
        }
      }

      const groupBlockIds = cols.slice();
      if (contradiction) {
        // 矛盾只封锁所在组：组内未知块全部标矛盾，已知原音块照常保留
        contradictionGroups++;
        for (const g of cols) status[g] = 'contradiction';
        groups.push({
          seq: groupSeq, root, blocks: groupBlockIds,
          state: 'contradiction', rank: pivotCols.length,
          recoveredCount: 0, evidence: contradiction,
        });
        continue;
      }

      // RREF 已在消元中完成：每个主元行在其他主元列均为 0，
      // 主元行若掩码 popcount=1（不含任何自由变量列），该块即唯一可恢复。
      let recoveredCount = 0;
      for (const pc of pivotCols) {
        const row = rows[pivotRowOfCol[pc]];
        if (popcountMask(row.mask, W) === 1) {
          // 即使组内存在自由变量，主元行只剩单个未知量 => 该块全能唯一恢复
          const blockId = cols[pc];
          status[blockId] = 'recovered';
          recoveredCount++;
          recovered.push({
            blockId,
            data: row.rhs.slice(),
            checks: [...row.prov].sort((a, b) => a - b),
            groupSeq,
          });
        }
      }
      groups.push({
        seq: groupSeq, root, blocks: groupBlockIds,
        state: 'consistent', rank: pivotCols.length, recoveredCount,
      });
    }

    // 汇总
    let knownCount = 0, recoveredCountAll = 0, undeterminedCount = 0, contradictionCount = 0;
    for (let i = 0; i < N; i++) {
      if (status[i] === 'known') knownCount++;
      else if (status[i] === 'recovered') recoveredCountAll++;
      else if (status[i] === 'contradiction') contradictionCount++;
      else undeterminedCount++;
    }

    return {
      statusByBlock: status,
      recovered,
      groups: groups.sort((a, b) => a.seq - b.seq),
      pureContradictions,
      stats: {
        total: N,
        known: knownCount,
        recovered: recoveredCountAll,
        undetermined: undeterminedCount,
        contradiction: contradictionCount,
        contradictionGroups,
        activeChecks: model.checks.filter((c) => !disabled.has(c.id)).length,
        disabledChecks: disabled.size,
      },
      durationMs: now() - t0,
    };
  }

  function countMismatch(bytes) {
    let n = 0;
    for (const b of bytes) if (b !== 0) n++;
    return n;
  }

  /*
   * 用原始校验行重新验证恢复组合：
   * 逐行异或校验载荷；成员块按出现奇偶性处理——偶次成员已在异或中抵消，
   * 奇次成员里除待恢复块外逐个代入已知/已恢复值。最终左边只剩待恢复块，右边即其字节。
   * targetBlockId: 待恢复块号；extraKnown: 其他已恢复块（Map<blockId, Uint8Array>）。
   */
  function verifyRecovery(model, checkIds, expectedBytes, extraKnown, targetBlockId) {
    const x = new Uint8Array(PAYLOAD_LEN);
    const usedRows = [];
    const parity = new Map(); // blockId -> 出现次数奇偶（1=奇, 0=偶）
    for (const id of checkIds) {
      const row = model.checkById.get(id);
      if (!row) return { ok: false, error: `校验行 ${id} 不存在或已损坏` };
      usedRows.push(id);
      for (let i = 0; i < PAYLOAD_LEN; i++) x[i] ^= row.data[i];
      for (const m of row.members) parity.set(m, (parity.get(m) || 0) ^ 1);
    }
    const extra = extraKnown || new Map();
    const unresolved = [];
    for (const [m, p] of parity) {
      if (p === 0) continue;                 // 偶次成员：已抵消
      if (m === targetBlockId) continue;     // 待恢复块：留在左边
      const k = model.blockData[m] || extra.get(m);
      if (!k) { unresolved.push(m); continue; }
      xorInto(x, k);
    }
    const mismatches = [];
    if (expectedBytes && unresolved.length === 0) {
      for (let i = 0; i < PAYLOAD_LEN; i++) {
        if (x[i] !== expectedBytes[i]) {
          if (mismatches.length < 16) mismatches.push(i);
        }
      }
    }
    return {
      ok: expectedBytes && unresolved.length === 0 ? mismatches.length === 0 : null,
      bytes: x,
      mismatches,
      unresolved,
      rows: usedRows,
    };
  }

  /* 重新验证一条校验行（成员全部已知时可直接判定） */
  function verifyCheck(model, checkId) {
    const row = model.checkById.get(checkId);
    if (!row) return { ok: false, error: `校验行 ${checkId} 不存在或已损坏` };
    const x = row.data.slice();
    const unknownMembers = [];
    for (const m of row.members) {
      if (model.blockData[m]) xorInto(x, model.blockData[m]);
      else unknownMembers.push(m);
    }
    return {
      ok: unknownMembers.length === 0 ? isZero(x) : null,
      unknownMembers,
      mismatchBytes: mismatchPositions(x, 16),
      mismatchCount: countMismatch(x),
    };
  }

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  const API = {
    PAYLOAD_LEN,
    crc32,
    b64ToBytes,
    validateStructure,
    buildModel,
    solve,
    verifyRecovery,
    verifyCheck,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.ParityEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
