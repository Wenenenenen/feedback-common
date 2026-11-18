// 由 tools/build-samples.js 自动生成，请勿手改。数据源: samples/extracted/*.json
window.HLM_SAMPLES = {
  "cube": {
    "positions": [
      [
        -1,
        -1,
        3
      ],
      [
        1,
        -1,
        3
      ],
      [
        1,
        1,
        3
      ],
      [
        -1,
        1,
        3
      ],
      [
        -1,
        -1,
        5
      ],
      [
        1,
        -1,
        5
      ],
      [
        1,
        1,
        5
      ],
      [
        -1,
        1,
        5
      ]
    ],
    "triangles": [
      [
        0,
        2,
        1
      ],
      [
        0,
        3,
        2
      ],
      [
        4,
        5,
        6
      ],
      [
        4,
        6,
        7
      ],
      [
        0,
        1,
        5
      ],
      [
        0,
        5,
        4
      ],
      [
        1,
        2,
        6
      ],
      [
        1,
        6,
        5
      ],
      [
        2,
        3,
        7
      ],
      [
        2,
        7,
        6
      ],
      [
        3,
        0,
        4
      ],
      [
        3,
        4,
        7
      ]
    ],
    "camera": {
      "type": "orthographic",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4
    },
    "crease_degrees": 45
  },
  "single-occluder": {
    "positions": [
      [
        -1,
        0,
        4
      ],
      [
        1,
        0,
        4
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        2
      ],
      [
        0.5,
        -0.5,
        2
      ],
      [
        0,
        0.5,
        2
      ]
    ],
    "triangles": [
      [
        0,
        1,
        2
      ],
      [
        3,
        4,
        5
      ]
    ],
    "camera": {
      "type": "orthographic",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4
    },
    "crease_degrees": 45
  },
  "overlapping-occluders": {
    "positions": [
      [
        -1,
        0,
        4
      ],
      [
        1,
        0,
        4
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        2
      ],
      [
        0.5,
        -0.5,
        2
      ],
      [
        0,
        0.5,
        2
      ],
      [
        -0.1,
        -0.5,
        2
      ],
      [
        0.9,
        -0.5,
        2
      ],
      [
        0.4,
        0.5,
        2
      ]
    ],
    "triangles": [
      [
        0,
        1,
        2
      ],
      [
        3,
        4,
        5
      ],
      [
        6,
        7,
        8
      ]
    ],
    "camera": {
      "type": "orthographic",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4
    },
    "crease_degrees": 45
  },
  "coplanar": {
    "positions": [
      [
        -1,
        0,
        4
      ],
      [
        1,
        0,
        4
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        4
      ],
      [
        0.5,
        -0.5,
        4
      ],
      [
        0,
        0.5,
        4
      ]
    ],
    "triangles": [
      [
        0,
        1,
        2
      ],
      [
        3,
        4,
        5
      ]
    ],
    "camera": {
      "type": "orthographic",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4
    },
    "crease_degrees": 45
  },
  "perspective": {
    "positions": [
      [
        -1,
        0,
        4
      ],
      [
        1,
        0,
        6
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        2
      ],
      [
        0.5,
        -0.5,
        2
      ],
      [
        0,
        0.5,
        2
      ]
    ],
    "triangles": [
      [
        0,
        1,
        2
      ],
      [
        3,
        4,
        5
      ]
    ],
    "camera": {
      "type": "perspective",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4,
      "fov_y": 70
    },
    "crease_degrees": 45
  },
  "near-cross": {
    "positions": [
      [
        -1,
        0,
        0.05
      ],
      [
        1,
        0,
        6
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        2
      ],
      [
        0.5,
        -0.5,
        2
      ],
      [
        0,
        0.5,
        2
      ]
    ],
    "triangles": [
      [
        0,
        1,
        2
      ],
      [
        3,
        4,
        5
      ]
    ],
    "camera": {
      "type": "perspective",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4,
      "fov_y": 70
    },
    "crease_degrees": 45
  },
  "nonmanifold": {
    "positions": [
      [
        -1,
        0,
        4
      ],
      [
        1,
        0,
        4
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        2
      ],
      [
        0.5,
        -0.5,
        2
      ],
      [
        0,
        0.5,
        2
      ],
      [
        0,
        1,
        5
      ]
    ],
    "triangles": [
      [
        0,
        1,
        2
      ],
      [
        3,
        4,
        5
      ],
      [
        1,
        0,
        6
      ],
      [
        0,
        1,
        3
      ]
    ],
    "camera": {
      "type": "orthographic",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4
    },
    "crease_degrees": 45
  },
  "invalid-index": {
    "positions": [
      [
        -1,
        0,
        4
      ],
      [
        1,
        0,
        4
      ],
      [
        0,
        -1,
        4
      ],
      [
        -0.5,
        -0.5,
        2
      ],
      [
        0.5,
        -0.5,
        2
      ],
      [
        0,
        0.5,
        2
      ]
    ],
    "triangles": [
      [
        0,
        1,
        99
      ]
    ],
    "camera": {
      "type": "orthographic",
      "origin": [
        0,
        0,
        0
      ],
      "target": [
        0,
        0,
        1
      ],
      "up": [
        0,
        1,
        0
      ],
      "near": 0.1,
      "far": 10,
      "aspect": 1.3333333333333333,
      "height": 4
    },
    "crease_degrees": 45
  }
};
