// 内置样例（与 cases-unpacked 一致）
export const SAMPLES = {
  case1_single_mirror: {
  "sceneId": "case1_single_mirror",
  "camera": {
    "eye": [
      0.0,
      1.5,
      5.0
    ],
    "target": [
      0.0,
      1.5,
      -1.0
    ],
    "up": [
      0.0,
      1.0,
      0.0
    ],
    "fovYDeg": 60.0,
    "near": 0.2,
    "far": 50.0,
    "width": 120,
    "height": 90
  },
  "maxBounceDepth": 2,
  "beamBudgetK": 4,
  "mirrors": [
    {
      "id": "M_front",
      "enabled": true,
      "reflectance": [
        0.9,
        0.95,
        1.0
      ],
      "vertices": [
        [
          -1.8,
          0.2,
          0.0
        ],
        [
          1.8,
          0.2,
          0.0
        ],
        [
          1.8,
          2.8,
          0.0
        ],
        [
          -1.8,
          2.8,
          0.0
        ]
      ]
    }
  ],
  "vertices": [
    [
      -0.8,
      0.6,
      2.0
    ],
    [
      0.8,
      0.6,
      2.0
    ],
    [
      0.0,
      2.2,
      2.0
    ],
    [
      -1.2,
      0.5,
      -2.0
    ],
    [
      1.2,
      0.5,
      -2.0
    ],
    [
      0.0,
      2.5,
      -2.0
    ]
  ],
  "triangles": [
    {
      "id": 1,
      "indices": [
        0,
        2,
        1
      ],
      "color": [
        0.9,
        0.25,
        0.2
      ],
      "singleSided": true
    },
    {
      "id": 2,
      "indices": [
        3,
        4,
        5
      ],
      "color": [
        0.2,
        0.85,
        0.3
      ],
      "singleSided": true
    }
  ]
},
  case2_periscope_relay: {
  "sceneId": "case2_periscope_relay",
  "camera": {
    "eye": [
      0.0,
      1.5,
      6.0
    ],
    "target": [
      0.0,
      1.5,
      0.0
    ],
    "up": [
      0.0,
      1.0,
      0.0
    ],
    "fovYDeg": 55.0,
    "near": 0.2,
    "far": 60.0,
    "width": 160,
    "height": 120
  },
  "maxBounceDepth": 3,
  "beamBudgetK": 3,
  "mirrors": [
    {
      "id": "M1",
      "enabled": true,
      "reflectance": [
        0.92,
        0.92,
        0.92
      ],
      "vertices": [
        [
          -1.5,
          0.3,
          0.5
        ],
        [
          0.5,
          0.3,
          -1.5
        ],
        [
          0.5,
          2.7,
          -1.5
        ],
        [
          -1.5,
          2.7,
          0.5
        ]
      ]
    },
    {
      "id": "M2",
      "enabled": true,
      "reflectance": [
        0.88,
        0.9,
        0.95
      ],
      "vertices": [
        [
          1.5,
          0.3,
          -0.5
        ],
        [
          3.5,
          0.3,
          1.5
        ],
        [
          3.5,
          2.7,
          1.5
        ],
        [
          1.5,
          2.7,
          -0.5
        ]
      ]
    }
  ],
  "vertices": [
    [
      2.0,
      0.8,
      -3.5
    ],
    [
      3.2,
      0.8,
      -3.5
    ],
    [
      2.6,
      2.2,
      -3.5
    ],
    [
      -2.2,
      0.5,
      1.8
    ],
    [
      -1.2,
      0.5,
      1.8
    ],
    [
      -1.7,
      2.0,
      1.8
    ]
  ],
  "triangles": [
    {
      "id": 10,
      "indices": [
        0,
        1,
        2
      ],
      "color": [
        0.95,
        0.75,
        0.15
      ],
      "singleSided": true
    },
    {
      "id": 11,
      "indices": [
        3,
        4,
        5
      ],
      "color": [
        0.25,
        0.6,
        0.95
      ],
      "singleSided": true
    }
  ]
},
  case3_occluded_mirror: {
  "sceneId": "case3_occluded_mirror",
  "camera": {
    "eye": [
      0.0,
      1.5,
      5.5
    ],
    "target": [
      0.0,
      1.5,
      0.0
    ],
    "up": [
      0.0,
      1.0,
      0.0
    ],
    "fovYDeg": 60.0,
    "near": 0.2,
    "far": 50.0,
    "width": 160,
    "height": 120
  },
  "maxBounceDepth": 2,
  "beamBudgetK": 4,
  "mirrors": [
    {
      "id": "M_main",
      "enabled": true,
      "reflectance": [
        0.95,
        0.9,
        0.85
      ],
      "vertices": [
        [
          -2.0,
          0.2,
          -0.5
        ],
        [
          2.0,
          0.2,
          -0.5
        ],
        [
          2.0,
          2.8,
          -0.5
        ],
        [
          -2.0,
          2.8,
          -0.5
        ]
      ]
    }
  ],
  "vertices": [
    [
      -0.35,
      0.2,
      1.2
    ],
    [
      0.35,
      0.2,
      1.2
    ],
    [
      0.35,
      2.8,
      1.2
    ],
    [
      -0.35,
      2.8,
      1.2
    ],
    [
      -1.4,
      0.6,
      2.5
    ],
    [
      1.4,
      0.6,
      2.5
    ],
    [
      0.0,
      2.5,
      2.5
    ]
  ],
  "triangles": [
    {
      "id": 1,
      "indices": [
        0,
        1,
        2
      ],
      "color": [
        0.3,
        0.35,
        0.4
      ],
      "singleSided": true
    },
    {
      "id": 2,
      "indices": [
        0,
        2,
        3
      ],
      "color": [
        0.3,
        0.35,
        0.4
      ],
      "singleSided": true
    },
    {
      "id": 3,
      "indices": [
        4,
        6,
        5
      ],
      "color": [
        0.95,
        0.4,
        0.2
      ],
      "singleSided": true
    }
  ]
},
};
