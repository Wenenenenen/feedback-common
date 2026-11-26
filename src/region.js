// Region data helpers: normalization, (de)serialization and edit operations.
// Coordinates throughout are integers in 1/16-pixel units.

export function cloneRegion(region) {
  return {
    outer: region.outer.map((p) => [p[0], p[1]]),
    holes: (region.holes || []).map((ring) => ring.map((p) => [p[0], p[1]])),
  };
}

export function totalVertices(region) {
  return region.outer.length +
    (region.holes || []).reduce((n, ring) => n + ring.length, 0);
}

// Parse the user's coordinate text for one ring. Accepts "x,y" pairs
// separated by whitespace, commas between pairs, or newlines. All values must
// be integers (1/16 pixel). Throws with a 1-based position on bad input.
export function parseRingText(text) {
  const tokens = text
    .replace(/[;；]/g, ' ')
    .split(/[\s,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length % 2 !== 0) {
    throw new Error('坐标必须成对出现（x, y），当前数字个数为奇数');
  }
  const ring = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const x = Number(tokens[i]);
    const y = Number(tokens[i + 1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`第 ${i / 2 + 1} 个顶点不是整数坐标：${tokens[i]}, ${tokens[i + 1]}`);
    }
    ring.push([x, y]);
  }
  return ring;
}

export function ringToText(ring) {
  return ring.map(([x, y]) => `${x}, ${y}`).join('\n');
}

// Add a vertex to a ring at a given index (defaults to appending).
export function insertVertex(ring, point, index = ring.length) {
  ring.splice(index, 0, [point[0], point[1]]);
}

export function removeVertex(ring, index) {
  ring.splice(index, 1);
}
