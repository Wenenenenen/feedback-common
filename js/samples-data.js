// 包内样例（samples/rally-gate-steward-cases.zip）的原样副本，供页面内“样例校验”使用。
// 判门内核与物理都用这些样例做黄金值断言；不改动其中任何数值。
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.RallySamples = data;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
  "segmentCases": {
    "gates": [
      {
        "a": [
          0,
          -2
        ],
        "b": [
          0,
          2
        ],
        "normal": [
          1,
          0
        ]
      },
      {
        "a": [
          2,
          -2
        ],
        "b": [
          2,
          2
        ],
        "normal": [
          1,
          0
        ]
      }
    ],
    "independentSegments": true,
    "cases": [
      {
        "p": [
          -1,
          0
        ],
        "q": [
          3,
          0
        ],
        "expectedOrder": [
          0,
          1
        ],
        "expectedFractions": [
          0.25,
          0.75
        ]
      },
      {
        "p": [
          1,
          0
        ],
        "q": [
          -1,
          0
        ],
        "expectedReverse": [
          0
        ]
      },
      {
        "p": [
          0,
          0
        ],
        "q": [
          1,
          0
        ],
        "expectedOrder": []
      },
      {
        "p": [
          -1,
          2
        ],
        "q": [
          1,
          2
        ],
        "expectedOrder": [
          0
        ],
        "expectedFractions": [
          0.5
        ]
      },
      {
        "p": [
          -1,
          3
        ],
        "q": [
          1,
          3
        ],
        "expectedOrder": []
      }
    ]
  },
  "race": {
    "initial": {
      "x": -10,
      "y": -2,
      "yaw": 0,
      "v": 0
    },
    "params": {
      "wheelbase": 2,
      "maxSteer": 0.6,
      "accel": 6,
      "drag": 0.1,
      "maxSpeed": 30,
      "brakeAccel": 10
    },
    "gates": [
      {
        "a": [
          0,
          -5
        ],
        "b": [
          0,
          5
        ],
        "normal": [
          1,
          0
        ]
      },
      {
        "a": [
          20,
          0
        ],
        "b": [
          30,
          0
        ],
        "normal": [
          0,
          1
        ]
      },
      {
        "a": [
          10,
          20
        ],
        "b": [
          10,
          30
        ],
        "normal": [
          -1,
          0
        ]
      },
      {
        "a": [
          -5,
          10
        ],
        "b": [
          5,
          10
        ],
        "normal": [
          0,
          -1
        ]
      }
    ],
    "inputs": [
      {
        "tick": 0,
        "throttle": 1,
        "steer": 0,
        "brake": false
      },
      {
        "tick": 180,
        "throttle": 0.6,
        "steer": 0.3,
        "brake": false
      },
      {
        "tick": 1000,
        "throttle": 0,
        "steer": 0,
        "brake": true
      }
    ]
  },
  "straightReference": {
    "initial": {
      "x": 0,
      "y": 0,
      "yaw": 0,
      "v": 12
    },
    "params": {
      "wheelbase": 2,
      "maxSteer": 0.6,
      "accel": 6,
      "drag": 0,
      "maxSpeed": 30,
      "brakeAccel": 10
    },
    "gates": [
      {
        "a": [
          0,
          -2
        ],
        "b": [
          0,
          2
        ],
        "normal": [
          1,
          0
        ]
      },
      {
        "a": [
          2,
          -2
        ],
        "b": [
          2,
          2
        ],
        "normal": [
          1,
          0
        ]
      }
    ],
    "inputs": [
      {
        "tick": 0,
        "throttle": 0,
        "steer": 0,
        "brake": false
      }
    ],
    "ticks": 120,
    "expected": {
      "x": 12,
      "y": 0,
      "yaw": 0,
      "v": 12
    }
  }
};
});
