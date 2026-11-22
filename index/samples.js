/*
 * samples.js — 内嵌样例，保证页面以 file:// 直接打开时也有数据。
 * samples/render-lifetime-cases.json 是同数据的原始文件。
 */
(function (root) {
  const Tfs = (root.Tfs = root.Tfs || {});
  Tfs.EMBEDDED_SAMPLES = {
    cases: [
      {
        id: 'peak',
        images: {
          a: { format: 'R8', mips: [[3, 3], [2, 2]] },
          b: { format: 'R8', mips: [[3, 3], [2, 2]] },
        },
        passes: [
          { id: 'a-large', out: 'a.0@1', op: 'const', read: [], values: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
          { id: 'b-large', out: 'b.0@1', op: 'const', read: [], values: [32, 32, 32, 32, 32, 32, 32, 32, 32] },
          { id: 'c-half', out: 'a.1@1', op: 'box2', read: ['a.0@1'] },
          { id: 'd-half', out: 'b.1@1', op: 'box2', read: ['b.0@1'] },
        ],
        exports: ['a.1@1', 'b.1@1'],
      },
      {
        id: 'ops-rgba',
        images: {
          scene: { format: 'RGBA8', mips: [[4, 4], [2, 2]] },
          light: { format: 'RGBA8', mips: [[4, 4]] },
        },
        passes: [
          {
            id: 'fill-scene',
            out: 'scene.0@1',
            op: 'const',
            read: [],
            values: [
              10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
              130, 140, 150, 255, 160, 170, 180, 255, 190, 200, 210, 255, 220, 230, 240, 255,
              200, 10, 10, 255, 10, 200, 10, 255, 10, 10, 200, 255, 250, 250, 20, 255,
              5, 5, 5, 255, 50, 50, 50, 255, 100, 100, 100, 255, 255, 255, 255, 255,
            ],
          },
          {
            id: 'fill-light',
            out: 'light.0@1',
            op: 'const',
            read: [],
            values: new Array(64).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 40)),
          },
          {
            id: 'lit',
            out: 'scene.0@2',
            op: 'add',
            read: ['scene.0@1', 'light.0@1'],
          },
          { id: 'lit-half', out: 'scene.1@1', op: 'box2', read: ['scene.0@2'] },
        ],
        exports: ['scene.1@1'],
      },
      {
        id: 'cycle',
        images: {
          a: { format: 'R8', mips: [[3, 3], [2, 2]] },
          b: { format: 'R8', mips: [[3, 3], [2, 2]] },
        },
        passes: [
          { id: 'x', out: 'a.0@1', op: 'add', read: ['a.0@2', 'a.0@2'] },
          { id: 'y', out: 'a.0@2', op: 'add', read: ['a.0@1', 'a.0@1'] },
        ],
        exports: ['a.0@2'],
      },
      {
        id: 'missing-read',
        images: { a: { format: 'R8', mips: [[2, 2]] } },
        passes: [
          { id: 'w', out: 'a.0@1', op: 'const', read: [], values: [1, 2, 3, 4] },
          { id: 'r', out: 'a.0@2', op: 'add', read: ['a.0@1', 'a.0@9'] },
        ],
        exports: ['a.0@2'],
      },
    ],
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
