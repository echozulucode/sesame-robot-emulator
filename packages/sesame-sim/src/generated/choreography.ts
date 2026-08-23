/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by `packages/sesame-sim/scripts/build-choreography.mjs` from
 * `hardware/hardware-map.json` (upstream 401730514cefed738710d22303e84b0dcd6b76d0).
 * 21 movement functions, 395 steps, every one
 * carrying the `file:line` it was extracted from.
 *
 * Regenerate:  pnpm --filter @sesame-lab/sesame-sim build:choreography
 * Check:       pnpm --filter @sesame-lab/sesame-sim validate:choreography
 *
 * `choreography-drift.test.ts` re-derives this from the JSON on every test run,
 * so an edit here fails the suite rather than silently changing the robot.
 */
import type { Choreography } from '../choreography-types.js';

export const CHOREOGRAPHY: Choreography = {
  "meta": {
    "generatedBy": "packages/sesame-sim/scripts/build-choreography.mjs",
    "sourceFile": "hardware/hardware-map.json",
    "upstreamCommit": "401730514cefed738710d22303e84b0dcd6b76d0",
    "movementCount": 21,
    "stepCount": 395
  },
  "movements": [
    {
      "function": "runRestPose",
      "kind": "pose",
      "signature": "void runRestPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "rest"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 71
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 71
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 75
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "REST",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 72
          }
        },
        {
          "type": "face",
          "name": "rest",
          "mode": "boomerang",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 73
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 74
          }
        }
      ]
    },
    {
      "function": "runStandPose",
      "kind": "pose",
      "signature": "void runStandPose(int face = 1)",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "stand"
      ],
      "defaultArgs": {
        "face": 1
      },
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 77
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 77
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 89
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "STAND",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 78
          }
        },
        {
          "type": "conditional",
          "condition": "face == 1",
          "steps": [
            {
              "type": "face",
              "name": "stand",
              "mode": "once",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 79
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 79
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 135,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 80
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 45,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 81
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 45,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 82
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 135,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 83
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 84
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 85
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 86
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 87
          }
        },
        {
          "type": "conditional",
          "condition": "face == 1",
          "steps": [
            {
              "type": "call",
              "function": "enterIdle",
              "args": null,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 88
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 88
          }
        }
      ]
    },
    {
      "function": "runWavePose",
      "kind": "pose",
      "signature": "void runWavePose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "wave"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 91
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 91
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 107
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "WAVE",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 92
          }
        },
        {
          "type": "face",
          "name": "wave",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 93
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 94
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 95
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 80,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 96
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 96
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 97
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 100,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 97
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 98
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 99
          }
        },
        {
          "type": "delay",
          "ms": 300,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 100
          }
        },
        {
          "type": "repeat",
          "count": 4,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 102
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 102
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 100,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 103
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 103
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 101
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 105
          }
        },
        {
          "type": "clearCommandIf",
          "command": "wave",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 106
          }
        }
      ]
    },
    {
      "function": "runDancePose",
      "kind": "pose",
      "signature": "void runDancePose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "dance"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 109
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 109
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 127
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "DANCE",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 110
          }
        },
        {
          "type": "face",
          "name": "dance",
          "mode": "loop",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 111
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 112
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 112
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 113
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 113
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 160,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 114
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 160,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 114
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 10,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 115
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 10,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 115
          }
        },
        {
          "type": "delay",
          "ms": 300,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 116
          }
        },
        {
          "type": "repeat",
          "count": 5,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 115,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 118
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 115,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 118
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 10,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 119
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 10,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 119
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 120
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 160,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 121
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 160,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 121
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 65,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 122
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 65,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 122
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 123
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 117
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 125
          }
        },
        {
          "type": "clearCommandIf",
          "command": "dance",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 126
          }
        }
      ]
    },
    {
      "function": "runSwimPose",
      "kind": "pose",
      "signature": "void runSwimPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "swim"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 129
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 129
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 143
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "SWIM",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 130
          }
        },
        {
          "type": "face",
          "name": "swim",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 131
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 132
          }
        },
        {
          "type": "repeat",
          "count": 4,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 134
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 134
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 135
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 135
              }
            },
            {
              "type": "delay",
              "ms": 400,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 136
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 137
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 137
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 138
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 138
              }
            },
            {
              "type": "delay",
              "ms": 400,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 139
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 133
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 141
          }
        },
        {
          "type": "clearCommandIf",
          "command": "swim",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 142
          }
        }
      ]
    },
    {
      "function": "runPointPose",
      "kind": "pose",
      "signature": "void runPointPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "point"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 145
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 145
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 155
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "POINT",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 146
          }
        },
        {
          "type": "face",
          "name": "point",
          "mode": "boomerang",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 147
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 148
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 135,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 148
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 100,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 149
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 149
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 25,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 150
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 145,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 150
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 80,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 151
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 170,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 151
          }
        },
        {
          "type": "delay",
          "ms": 2000,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 152
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 153
          }
        },
        {
          "type": "clearCommandIf",
          "command": "point",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 154
          }
        }
      ]
    },
    {
      "function": "runPushupPose",
      "kind": "pose",
      "signature": "void runPushupPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "pushup"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 157
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 157
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 177
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "PUSHUP",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 158
          }
        },
        {
          "type": "face",
          "name": "pushup",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 159
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 160
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 161
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 162
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 163
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 164
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 165
          }
        },
        {
          "type": "delay",
          "ms": 500,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 166
          }
        },
        {
          "type": "repeat",
          "count": 4,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 168
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 169
              }
            },
            {
              "type": "delay",
              "ms": 600,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 170
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 171
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 172
              }
            },
            {
              "type": "delay",
              "ms": 500,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 173
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 167
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 175
          }
        },
        {
          "type": "clearCommandIf",
          "command": "pushup",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 176
          }
        }
      ]
    },
    {
      "function": "runBowPose",
      "kind": "pose",
      "signature": "void runBowPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "bow"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 179
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 179
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 198
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "BOW",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 180
          }
        },
        {
          "type": "face",
          "name": "bow",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 181
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 182
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 183
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 184
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 185
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 186
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 187
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 188
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 189
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 190
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 191
          }
        },
        {
          "type": "delay",
          "ms": 600,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 192
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 193
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 194
          }
        },
        {
          "type": "delay",
          "ms": 3000,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 195
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 196
          }
        },
        {
          "type": "clearCommandIf",
          "command": "bow",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 197
          }
        }
      ]
    },
    {
      "function": "runCutePose",
      "kind": "pose",
      "signature": "void runCutePose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "cute"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 200
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 200
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 225
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "CUTE",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 201
          }
        },
        {
          "type": "face",
          "name": "cute",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 202
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 203
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 204
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 160,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 205
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 20,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 206
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 207
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 208
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 210
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 211
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 212
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 213
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 214
          }
        },
        {
          "type": "repeat",
          "count": 5,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 216
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 217
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 218
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 219
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 220
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 221
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 215
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 223
          }
        },
        {
          "type": "clearCommandIf",
          "command": "cute",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 224
          }
        }
      ]
    },
    {
      "function": "runFreakyPose",
      "kind": "pose",
      "signature": "void runFreakyPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "freaky"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 227
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 227
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 247
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "FREAKY",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 228
          }
        },
        {
          "type": "face",
          "name": "freaky",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 229
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 230
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 231
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 232
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 233
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 234
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 235
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 236
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 237
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 238
          }
        },
        {
          "type": "repeat",
          "count": 3,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 25,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 240
              }
            },
            {
              "type": "delay",
              "ms": 400,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 241
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 242
              }
            },
            {
              "type": "delay",
              "ms": 400,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 243
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 239
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 245
          }
        },
        {
          "type": "clearCommandIf",
          "command": "freaky",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 246
          }
        }
      ]
    },
    {
      "function": "runWormPose",
      "kind": "pose",
      "signature": "void runWormPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "worm"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 249
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 249
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 265
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "WORM",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 250
          }
        },
        {
          "type": "face",
          "name": "worm",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 251
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 252
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 253
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 254
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 254
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 254
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 254
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 255
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 255
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 255
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 255
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 256
          }
        },
        {
          "type": "repeat",
          "count": 5,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 258
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 258
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 258
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 258
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 259
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 260
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 260
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 260
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 260
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 261
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 257
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 263
          }
        },
        {
          "type": "clearCommandIf",
          "command": "worm",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 264
          }
        }
      ]
    },
    {
      "function": "runShakePose",
      "kind": "pose",
      "signature": "void runShakePose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "shake"
      ],
      "defaultArgs": null,
      "note": null,
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 267
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 267
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 283
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "SHAKE",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 268
          }
        },
        {
          "type": "face",
          "name": "shake",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 269
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 270
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 271
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 135,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 272
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 45,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 272
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 272
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 272
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 273
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 273
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 274
          }
        },
        {
          "type": "repeat",
          "count": 5,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 276
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 276
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 277
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 278
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 278
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 279
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 275
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 281
          }
        },
        {
          "type": "clearCommandIf",
          "command": "shake",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 282
          }
        }
      ]
    },
    {
      "function": "runShrugPose",
      "kind": "pose",
      "signature": "void runShrugPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "shrug"
      ],
      "defaultArgs": null,
      "note": "Only pose that calls runStandPose(0) BEFORE selecting its face, and the only one that shows two different faces (dead, then shrug).",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 285
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 285
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 297
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "SHRUG",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 286
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 287
          }
        },
        {
          "type": "face",
          "name": "dead",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 288
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 289
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 290
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 290
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 290
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 290
          }
        },
        {
          "type": "delay",
          "ms": 1000,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 291
          }
        },
        {
          "type": "face",
          "name": "shrug",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 292
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 293
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 293
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 293
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 293
          }
        },
        {
          "type": "delay",
          "ms": 1500,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 294
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 295
          }
        },
        {
          "type": "clearCommandIf",
          "command": "shrug",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 296
          }
        }
      ]
    },
    {
      "function": "runDeadPose",
      "kind": "pose",
      "signature": "void runDeadPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "dead"
      ],
      "defaultArgs": null,
      "note": "Does NOT return to stand at the end — the robot is left in the collapsed pose.",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 299
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 299
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 306
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "DEAD",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 300
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 301
          }
        },
        {
          "type": "face",
          "name": "dead",
          "mode": "boomerang",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 302
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 303
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 304
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 304
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 304
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 304
          }
        },
        {
          "type": "clearCommandIf",
          "command": "dead",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 305
          }
        }
      ]
    },
    {
      "function": "runCrabPose",
      "kind": "pose",
      "signature": "void runCrabPose()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [
        "crab"
      ],
      "defaultArgs": null,
      "note": "No delay between the line-314 pose and the first iteration of the loop.",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 308
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 308
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 323
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "CRAB",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 309
          }
        },
        {
          "type": "face",
          "name": "crab",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 310
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 0
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 311
          }
        },
        {
          "type": "delay",
          "ms": 200,
          "via": "delayWithFace",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 312
          }
        },
        {
          "type": "servo",
          "joint": "R1",
          "index": 0,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 313
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 313
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 313
          }
        },
        {
          "type": "servo",
          "joint": "L2",
          "index": 3,
          "angleDeg": 90,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 313
          }
        },
        {
          "type": "servo",
          "joint": "R4",
          "index": 4,
          "angleDeg": 0,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 314
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 180,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 314
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 45,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 314
          }
        },
        {
          "type": "servo",
          "joint": "L4",
          "index": 7,
          "angleDeg": 135,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 314
          }
        },
        {
          "type": "repeat",
          "count": 5,
          "countDefault": null,
          "countRef": null,
          "steps": [
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 316
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 316
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 316
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 316
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 317
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 318
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 318
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 318
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 318
              }
            },
            {
              "type": "delay",
              "ms": 300,
              "via": "delayWithFace",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 319
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 315
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 321
          }
        },
        {
          "type": "clearCommandIf",
          "command": "crab",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 322
          }
        }
      ]
    },
    {
      "function": "runWalkPose",
      "kind": "movement",
      "signature": "void runWalkPose()",
      "loops": true,
      "interruptible": true,
      "triggeredByCommand": [
        "forward"
      ],
      "defaultArgs": null,
      "note": "Does not clear currentCommand, so loop() re-invokes it while the \"forward\" command is held.",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 326
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 326
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 351
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "WALK FWD",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 327
          }
        },
        {
          "type": "face",
          "name": "walk",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 328
          }
        },
        {
          "type": "servo",
          "joint": "R3",
          "index": 5,
          "angleDeg": 135,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 330
          }
        },
        {
          "type": "servo",
          "joint": "L3",
          "index": 6,
          "angleDeg": 45,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 330
          }
        },
        {
          "type": "servo",
          "joint": "R2",
          "index": 1,
          "angleDeg": 100,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 331
          }
        },
        {
          "type": "servo",
          "joint": "L1",
          "index": 2,
          "angleDeg": 25,
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 331
          }
        },
        {
          "type": "interruptCheck",
          "command": "forward",
          "durationMsDefault": 100,
          "durationMsRef": "frameDelay",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 332
          }
        },
        {
          "type": "repeat",
          "count": null,
          "countDefault": 10,
          "countRef": "walkCycles",
          "steps": [
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 335
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 335
              }
            },
            {
              "type": "interruptCheck",
              "command": "forward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 336
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 337
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 337
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 338
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 338
              }
            },
            {
              "type": "interruptCheck",
              "command": "forward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 339
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 340
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 340
              }
            },
            {
              "type": "interruptCheck",
              "command": "forward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 341
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 342
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 342
              }
            },
            {
              "type": "interruptCheck",
              "command": "forward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 343
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 344
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 344
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 345
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 345
              }
            },
            {
              "type": "interruptCheck",
              "command": "forward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 346
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 347
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 347
              }
            },
            {
              "type": "interruptCheck",
              "command": "forward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 348
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 334
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 350
          }
        }
      ]
    },
    {
      "function": "runWalkBackward",
      "kind": "movement",
      "signature": "void runWalkBackward()",
      "loops": true,
      "interruptible": true,
      "triggeredByCommand": [
        "backward"
      ],
      "defaultArgs": null,
      "note": "Unlike runWalkPose there is no \"initial step\" before the loop — only an interrupt check.",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 354
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 354
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 376
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "WALK BACK",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 355
          }
        },
        {
          "type": "face",
          "name": "walk",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 356
          }
        },
        {
          "type": "interruptCheck",
          "command": "backward",
          "durationMsDefault": 100,
          "durationMsRef": "frameDelay",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 357
          }
        },
        {
          "type": "repeat",
          "count": null,
          "countDefault": 10,
          "countRef": "walkCycles",
          "steps": [
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 360
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 360
              }
            },
            {
              "type": "interruptCheck",
              "command": "backward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 361
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 362
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 362
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 363
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 363
              }
            },
            {
              "type": "interruptCheck",
              "command": "backward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 364
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 365
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 365
              }
            },
            {
              "type": "interruptCheck",
              "command": "backward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 366
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 367
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 367
              }
            },
            {
              "type": "interruptCheck",
              "command": "backward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 368
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 369
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 369
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 370
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 370
              }
            },
            {
              "type": "interruptCheck",
              "command": "backward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 371
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 372
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 372
              }
            },
            {
              "type": "interruptCheck",
              "command": "backward",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 373
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 359
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 375
          }
        }
      ]
    },
    {
      "function": "runTurnLeft",
      "kind": "movement",
      "signature": "void runTurnLeft()",
      "loops": true,
      "interruptible": true,
      "triggeredByCommand": [
        "left"
      ],
      "defaultArgs": null,
      "note": "Source comments group the body into \"legset 1 (R1 L2)\" (line 383) then \"legset 2 (R2 L1)\" (line 392).",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 379
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 379
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 403
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "TURN LEFT",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 380
          }
        },
        {
          "type": "face",
          "name": "walk",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 381
          }
        },
        {
          "type": "repeat",
          "count": null,
          "countDefault": 10,
          "countRef": "walkCycles",
          "steps": [
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 384
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 384
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 385
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 386
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 386
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 387
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 388
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 388
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 389
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 390
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 390
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 391
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 393
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 393
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 394
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 395
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 395
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 396
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 397
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 397
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 398
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 399
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 399
              }
            },
            {
              "type": "interruptCheck",
              "command": "left",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 400
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 382
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 402
          }
        }
      ]
    },
    {
      "function": "runTurnRight",
      "kind": "movement",
      "signature": "void runTurnRight()",
      "loops": true,
      "interruptible": true,
      "triggeredByCommand": [
        "right"
      ],
      "defaultArgs": null,
      "note": "Mirror of runTurnLeft with the legsets in the opposite order (\"legset 2\" first, line 409).",
      "source": {
        "file": "firmware/movement-sequences.h",
        "line": 405
      },
      "sourceRange": {
        "from": {
          "file": "firmware/movement-sequences.h",
          "line": 405
        },
        "to": {
          "file": "firmware/movement-sequences.h",
          "line": 429
        }
      },
      "steps": [
        {
          "type": "log",
          "text": "TURN RIGHT",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 406
          }
        },
        {
          "type": "face",
          "name": "walk",
          "mode": "once",
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 407
          }
        },
        {
          "type": "repeat",
          "count": null,
          "countDefault": 10,
          "countRef": "walkCycles",
          "steps": [
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 410
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 410
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 411
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 412
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 412
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 413
              }
            },
            {
              "type": "servo",
              "joint": "R4",
              "index": 4,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 414
              }
            },
            {
              "type": "servo",
              "joint": "L3",
              "index": 6,
              "angleDeg": 0,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 414
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 415
              }
            },
            {
              "type": "servo",
              "joint": "R2",
              "index": 1,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 416
              }
            },
            {
              "type": "servo",
              "joint": "L1",
              "index": 2,
              "angleDeg": 45,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 416
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 417
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 419
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 419
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 420
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 421
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 90,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 421
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 422
              }
            },
            {
              "type": "servo",
              "joint": "R3",
              "index": 5,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 423
              }
            },
            {
              "type": "servo",
              "joint": "L4",
              "index": 7,
              "angleDeg": 180,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 423
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 424
              }
            },
            {
              "type": "servo",
              "joint": "R1",
              "index": 0,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 425
              }
            },
            {
              "type": "servo",
              "joint": "L2",
              "index": 3,
              "angleDeg": 135,
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 425
              }
            },
            {
              "type": "interruptCheck",
              "command": "right",
              "durationMsDefault": 100,
              "durationMsRef": "frameDelay",
              "source": {
                "file": "firmware/movement-sequences.h",
                "line": 426
              }
            }
          ],
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 408
          }
        },
        {
          "type": "call",
          "function": "runStandPose",
          "args": {
            "face": 1
          },
          "source": {
            "file": "firmware/movement-sequences.h",
            "line": 428
          }
        }
      ]
    },
    {
      "function": "enterIdle",
      "kind": "idle-routine",
      "signature": "void enterIdle()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [],
      "defaultArgs": null,
      "note": "Moves no servos. Included because runStandPose(1) calls it (movement-sequences.h:88), which makes it the only entry point into idle. It is NOT triggered by inactivity — see idle.entryCondition.",
      "source": {
        "file": "firmware/sesame-firmware-main.ino",
        "line": 1011
      },
      "sourceRange": {
        "from": {
          "file": "firmware/sesame-firmware-main.ino",
          "line": 1011
        },
        "to": {
          "file": "firmware/sesame-firmware-main.ino",
          "line": 1017
        }
      },
      "steps": [
        {
          "type": "state",
          "variable": "idleActive",
          "value": true,
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1012
          }
        },
        {
          "type": "state",
          "variable": "idleBlinkActive",
          "value": false,
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1013
          }
        },
        {
          "type": "state",
          "variable": "idleBlinkRepeatsLeft",
          "value": 0,
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1014
          }
        },
        {
          "type": "face",
          "name": "idle",
          "mode": "boomerang",
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1015
          }
        },
        {
          "type": "call",
          "function": "scheduleNextIdleBlink",
          "args": {
            "minMs": 3000,
            "maxMs": 7000
          },
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1016
          }
        }
      ]
    },
    {
      "function": "exitIdle",
      "kind": "idle-routine",
      "signature": "void exitIdle()",
      "loops": false,
      "interruptible": false,
      "triggeredByCommand": [],
      "defaultArgs": null,
      "note": "Called from /cmd?pose= (ino:235), /cmd?go= (ino:241) and POST /api/command (ino:384). Not called by /cmd?stop=.",
      "source": {
        "file": "firmware/sesame-firmware-main.ino",
        "line": 1019
      },
      "sourceRange": {
        "from": {
          "file": "firmware/sesame-firmware-main.ino",
          "line": 1019
        },
        "to": {
          "file": "firmware/sesame-firmware-main.ino",
          "line": 1022
        }
      },
      "steps": [
        {
          "type": "state",
          "variable": "idleActive",
          "value": false,
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1020
          }
        },
        {
          "type": "state",
          "variable": "idleBlinkActive",
          "value": false,
          "source": {
            "file": "firmware/sesame-firmware-main.ino",
            "line": 1021
          }
        }
      ]
    }
  ],
  "angleClamp": {
    "min": 0,
    "max": 180
  },
  "motorCurrentDelayMs": 20,
  "subtrimDefaults": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
  ],
  "jointOrder": [
    "R1",
    "R2",
    "L1",
    "L2",
    "R4",
    "R3",
    "L3",
    "L4"
  ]
};
