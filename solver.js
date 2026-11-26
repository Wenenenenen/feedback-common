/*
 * Imprint stack inference: exact subset DP for up to 18 layers.
 * The file is dependency-free and works both as a browser global and a Node module.
 */
(function attachImprintStack(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ImprintStack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  const MAX_LAYERS = 18;
  const MAX_DIMENSION = 512;

  class ImprintFormatError extends Error {
    constructor(message, path) {
      super(path ? `${path}: ${message}` : message);
      this.name = 'ImprintFormatError';
      this.path = path;
    }
  }

  function isPlainInteger(value) {
    return typeof value === 'number' && Number.isInteger(value);
  }

  function parseImprintJSON(input) {
    let raw = input;
    if (typeof input === 'string') {
      try {
        raw = JSON.parse(input);
      } catch (error) {
        throw new ImprintFormatError(`不是合法 JSON：${error.message}`);
      }
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ImprintFormatError('顶层必须是 JSON 对象');
    }

    const width = raw.width;
    const height = raw.height;
    const layerCount = raw.layers;

    if (!isPlainInteger(width) || width < 1 || width > MAX_DIMENSION) {
      throw new ImprintFormatError(`width 必须是 1–${MAX_DIMENSION} 的整数`, 'width');
    }
    if (!isPlainInteger(height) || height < 1 || height > MAX_DIMENSION) {
      throw new ImprintFormatError(`height 必须是 1–${MAX_DIMENSION} 的整数`, 'height');
    }
    if (!isPlainInteger(layerCount) || layerCount < 1 || layerCount > MAX_LAYERS) {
      throw new ImprintFormatError(`layers 必须是 1–${MAX_LAYERS} 的整数`, 'layers');
    }

    const pixelCount = width * height;
    const coverInput = raw.cover;
    const observedInput = raw.observed;
    const weightInput = raw.weight;

    if (!Array.isArray(coverInput) || coverInput.length !== pixelCount) {
      throw new ImprintFormatError(`cover 必须是长度 ${pixelCount} 的数组`, 'cover');
    }
    if (!Array.isArray(observedInput) || observedInput.length !== pixelCount) {
      throw new ImprintFormatError(`observed 必须是长度 ${pixelCount} 的数组`, 'observed');
    }
    if (!Array.isArray(weightInput) || weightInput.length !== pixelCount) {
      throw new ImprintFormatError(`weight 必须是长度 ${pixelCount} 的数组`, 'weight');
    }

    const fullMask = (1 << layerCount) - 1;
    const cover = new Uint32Array(pixelCount);
    const observed = new Uint8Array(pixelCount);
    const weight = new Float64Array(pixelCount);

    for (let i = 0; i < pixelCount; i += 1) {
      const c = coverInput[i];
      const o = observedInput[i];
      const w = weightInput[i];

      if (!isPlainInteger(c) || c < 0 || c > fullMask) {
        throw new ImprintFormatError(
          `cover[${i}] 必须是 0–${fullMask} 的整数位掩码`,
          `cover[${i}]`,
        );
      }
      if (!isPlainInteger(o) || o < 0 || o > layerCount) {
        throw new ImprintFormatError(
          `observed[${i}] 必须是 0–${layerCount} 的整数`,
          `observed[${i}]`,
        );
      }
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 255) {
        throw new ImprintFormatError(`weight[${i}] 必须是 0–255 的数值`, `weight[${i}]`);
      }

      cover[i] = c >>> 0;
      observed[i] = o;
      weight[i] = w;
    }

    const aboveInput = Array.isArray(raw.above)
      ? raw.above
      : Array.isArray(raw.locks)
        ? raw.locks
        : [];

    if (!Array.isArray(aboveInput)) {
      throw new ImprintFormatError('above 必须是层对数组', 'above');
    }

    const locks = [];
    aboveInput.forEach((pair, index) => {
      if (!Array.isArray(pair) || pair.length < 2) {
        throw new ImprintFormatError(`above[${index}] 必须是 [a, b]`, `above[${index}]`);
      }
      const a = pair[0];
      const b = pair[1];
      if (!isPlainInteger(a) || a < 1 || a > layerCount) {
        throw new ImprintFormatError(`above[${index}][0] 必须是 1–${layerCount} 的层号`);
      }
      if (!isPlainInteger(b) || b < 1 || b > layerCount) {
        throw new ImprintFormatError(`above[${index}][1] 必须是 1–${layerCount} 的层号`);
      }
      locks.push({ above: a, below: b });
    });

    return {
      width,
      height,
      layerCount,
      pixelCount,
      cover,
      observed,
      weight,
      locks,
      note: typeof raw.说明 === 'string' ? raw.说明 : '',
    };
  }

  function bitIndex(bit) {
    return 31 - Math.clz32(bit >>> 0);
  }

  function costsEqual(a, b) {
    if (a === b) return true;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= 1e-9 * scale;
  }

  // edges are zero-based [ancestor/above, descendant/below] pairs.
  function findCycle(layerCount, edges) {
    const adjacency = Array.from({ length: layerCount }, () => []);
    for (const [u, v] of edges) {
      if (u >= 0 && u < layerCount && v >= 0 && v < layerCount) adjacency[u].push(v);
    }

    // 0 = unvisited, 1 = on current DFS stack, 2 = finished.
    const state = new Uint8Array(layerCount);
    const stack = [];

    function visit(u) {
      state[u] = 1;
      stack.push(u);

      for (const v of adjacency[u]) {
        if (state[v] === 0) {
          const cycle = visit(v);
          if (cycle) return cycle;
        } else if (state[v] === 1) {
          const start = stack.lastIndexOf(v);
          if (start !== -1) return stack.slice(start).concat(v);
          return [v, v];
        }
      }

      stack.pop();
      state[u] = 2;
      return null;
    }

    for (let u = 0; u < layerCount; u += 1) {
      if (state[u] === 0) {
        const cycle = visit(u);
        if (cycle) return cycle;
      }
    }
    return null;
  }

  class StackOptimizer {
    constructor(data) {
      this.data = data;
      this.n = data.layerCount;
      this.pixelCount = data.pixelCount;
      this.size = 1 << this.n;
      this.fullMask = this.size - 1;

      // mismatchCost[x][mask] starts as exact-mask weights, then becomes a
      // subset-zeta table. Query with mask = complement(chosen higher layers).
      this.mismatchCost = Array.from({ length: this.n }, () => new Float64Array(this.size));
      this.constantCost = 0;
      this._buildCostTables();
    }

    _buildCostTables() {
      const { cover, observed, weight } = this.data;

      for (let p = 0; p < this.pixelCount; p += 1) {
        const coverMask = cover[p];
        const observedLayer = observed[p]; // 0 means blank
        const w = weight[p];

        if (coverMask === 0) {
          // No order can make a covered layer visible here.
          if (observedLayer !== 0) this.constantCost += w;
          continue;
        }

        let bits = coverMask;
        while (bits) {
          const bit = bits & -bits;
          bits -= bit;
          const x = bitIndex(bit);

          // If x is the highest covered layer, it is the prediction.
          // An observed layer equal to x+1 is the only zero-cost case.
          if (observedLayer !== x + 1) {
            const otherCovered = coverMask ^ bit;
            this.mismatchCost[x][otherCovered] += w;
          }
        }
      }

      // Subset zeta transform:
      // table[x][T] = sum_{M subseteq T} raw[x][M].
      for (let x = 0; x < this.n; x += 1) {
        const table = this.mismatchCost[x];
        for (let bitIndexToAdd = 0; bitIndexToAdd < this.n; bitIndexToAdd += 1) {
          const step = 1 << bitIndexToAdd;
          const block = step << 1;
          for (let base = 0; base < this.size; base += block) {
            for (let offset = 0; offset < step; offset += 1) {
              table[base + step + offset] += table[base + offset];
            }
          }
        }
      }
    }

    transitionCost(layer, chosenMask) {
      const allowedCoverMask = this.fullMask ^ chosenMask;
      return this.mismatchCost[layer][allowedCoverMask];
    }

    // edges: zero-based [aboveLayer, belowLayer].
    solve(edges = []) {
      const cycle = findCycle(this.n, edges);
      if (cycle) {
        return {
          ok: false,
          cycle,
          cycleLayers: cycle.map((x) => x + 1),
          cycleText: cycle.map((x) => x + 1).join(' → '),
        };
      }

      const predecessors = new Uint32Array(this.n);
      for (const [above, below] of edges) {
        predecessors[below] |= 1 << above;
      }

      // suffix[mask] = minimum cost of placing all not-yet-chosen layers,
      // given that `mask` are already chosen from top to bottom.
      const suffix = new Float64Array(this.size);

      for (let mask = this.size - 2; mask >= 0; mask -= 1) {
        let best = Number.POSITIVE_INFINITY;
        const remaining = this.fullMask ^ mask;
        let bits = remaining;

        while (bits) {
          const bit = bits & -bits;
          bits -= bit;
          const x = bitIndex(bit);
          const missingPredecessors = predecessors[x] & remaining;

          if (missingPredecessors === 0) {
            const candidate = this.transitionCost(x, mask) + suffix[mask | bit];
            if (candidate < best) best = candidate;
          }
        }

        suffix[mask] = best;
      }

      const variableCost = suffix[0];
      const order = [];
      let mask = 0;

      // Ascending layer IDs make the first equal-cost choice the
      // lexicographically smallest complete permutation.
      while (mask !== this.fullMask) {
        const target = suffix[mask];
        const remaining = this.fullMask ^ mask;
        let chosen = -1;

        for (let x = 0; x < this.n; x += 1) {
          const bit = 1 << x;
          if ((remaining & bit) === 0) continue;
          if ((predecessors[x] & remaining) !== 0) continue;

          const value = this.transitionCost(x, mask) + suffix[mask | bit];
          if (Number.isFinite(value) && costsEqual(value, target)) {
            chosen = x;
            break;
          }
        }

        if (chosen === -1) {
          // findCycle already ruled this out; kept as a defensive boundary.
          return { ok: false, cycle: null, error: '约束图无环但 DP 无法构造拓扑序' };
        }

        order.push(chosen);
        mask |= 1 << chosen;
      }

      return {
        ok: true,
        order,
        orderLayers: order.map((x) => x + 1),
        variableCost,
        constantCost: this.constantCost,
        score: this.constantCost + variableCost,
      };
    }

    evaluate(order) {
      const { cover, observed, weight, pixelCount } = this.data;
      const prediction = new Uint8Array(pixelCount);
      const mismatch = new Uint8Array(pixelCount);
      const pixelCost = new Float64Array(pixelCount);
      let score = 0;
      let mismatchCount = 0;

      for (let p = 0; p < pixelCount; p += 1) {
        const coverMask = cover[p];
        let predicted = 0;

        if (coverMask !== 0) {
          for (let k = 0; k < order.length; k += 1) {
            const layer = order[k];
            if (coverMask & (1 << layer)) {
              predicted = layer + 1;
              break;
            }
          }
        }

        prediction[p] = predicted;
        if (predicted !== observed[p]) {
          mismatch[p] = 1;
          pixelCost[p] = weight[p];
          score += weight[p];
          mismatchCount += 1;
        }
      }

      return { prediction, mismatch, pixelCost, score, mismatchCount };
    }
  }

  return {
    MAX_LAYERS,
    MAX_DIMENSION,
    ImprintFormatError,
    parseImprintJSON,
    findCycle,
    StackOptimizer,
  };
});
