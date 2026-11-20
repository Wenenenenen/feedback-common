/*
 * 内置示例：来自 samples/seed-cut-matte-cases.zip，便于直接试用。
 * 图片为 8 位 RGB PNG 的 base64 副本。
 */
(function (root) {
  'use strict';

  root.MatteSamples = {
    tiny: {
      label: '微小样例',
      meta: '4×3',
      name: 'tiny.png',
      png:
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAMklEQVR4nAEnANj/ABQeKFoeN6AeRuYeVQAUWmRaWnOgWoLmWpEAFJagWpavoJa+5pbN9RMP01sMmfoAAAAASUVORK5CYII=',
      foreground: [[3, 1]],
      background: [[0, 1]],
      lambda: 0.7
    },
    islands: {
      label: '地面双岛',
      meta: '128×96',
      name: 'islands.png',
      png:
        'iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAIAAABaGO0eAAABzUlEQVR4nO3awW3DMBBEUTekJC4hHahEVZLactDFgINAIpe7Q84H9jIXU55nURTgx7YfH/vxuR9f+/HcD2JyfJRfgXkEAADvCAAA3hEAALwjAAB4RwAA8I4AAOAdAQDAOwIAgHcEAADvCIAHwM/3dmV0elkE4GLv71Pey/QAzdW73RDxACHVv45CTdMAhLe//I4UBjCo+uV3pBiAhPbPEWlNCyCt/XMUWhMCSG7/nKG9JK8LwO3HmBBASfvnhAPcWl0CoLD98F9iw+oAhAE0X0AlQHn75/QDdF4AAJYA5b2/TsKx5/8BAAAAMgHKG38fAAAAAAAAAAAAAADWfxMurxuA+sYDAXq+Uee6AHS92/e8gQPwR7y1Ys9CAPQeivoXAqDxC8Yu1AjQtmOOm6giqiIAAAAw+swwbkRKBECr0wyA64e2caNTIgBanSYBPNf6b+iUANta/44GAICmT0luX6E1LYDMU6lIa3IAOYcindYUAYY+EsprmgZgxCNBoaaZAAJ3JJ2a5gPo3JHKe1kE4O4NodPLagBEAEQjAAB4RwAA8I4AAOAdAQDAOwIAgHcEAADvCAAA3hEAALwjAAB4RwAA8I4AAOAdAQDAO/4CsUVKsMTU5DMAAAAASUVORK5CYII=',
      foreground: [[40, 45], [95, 40]],
      background: [[2, 2], [75, 75]],
      lambda: 1.2
    },
    constant: {
      label: '常色图',
      meta: '17×13',
      name: 'constant.png',
      png:
        'iVBORw0KGgoAAAANSUhEUgAAABEAAAANCAIAAADAGxJNAAAAE0lEQVR4nGOIIh0wjOoZ1UNHPQDTrekXzBLd+AAAAABJRU5ErkJggg==',
      foreground: [[8, 6]],
      background: [[0, 0]],
      lambda: 0
    },
    conflict: {
      label: '冲突配置',
      meta: '同行同列冲突',
      name: 'tiny.png',
      png:
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAMklEQVR4nAEnANj/ABQeKFoeN6AeRuYeVQAUWmRaWnOgWoLmWpEAFJagWpavoJa+5pbN9RMP01sMmfoAAAAASUVORK5CYII=',
      foreground: [[1, 1]],
      background: [[1, 1]],
      lambda: 1
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
