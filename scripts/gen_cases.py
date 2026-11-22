#!/usr/bin/env python3
"""生成随附用例与参考期望（samples/expected.json）。

用例全部由本脚本确定性写出，便于审阅：
  samples/cases/*.json          调度语义用例（含 _title / _note）
  samples/cases/invalid/*.json  导入应被拒绝的结构问题（expect 指出类别与指令号）
  samples/expected.json         由 Python 参考实现 lfv_ref.py 计算出的结果

用法：python3 -I scripts/gen_cases.py
"""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(ROOT, "src", "py"))
import lfv_ref as ref  # noqa: E402

CASES = os.path.join(ROOT, "samples", "cases")
INVALID_DIR = os.path.join(CASES, "invalid")


def quota_case():
    # 600 条直线指令：PUSH/STORE 交替，栈深度恒为 1；每帧 256 条，跨 3 帧。
    code = []
    for i in range(300):
        code.append(["PUSH", i])
        code.append(["STORE", i % 32])
    code.append(["LOAD", 31])
    code.append(["EMIT", "last"])
    code.append(["HALT"])
    return code


def fork_limit_case():
    # 每个协程：FORK 自己 → WAIT。每帧新增 1 个，超过 64 个存活协程时 FORK 报错。
    return [["FORK", 0], ["WAIT", "x"], ["HALT"]]


def fiber_order_case():
    # 三个协程在同一帧各自 EMIT，日志应按协程号升序出现 0,1,2
    return [
        ["FORK", 6], ["FORK", 10],
        ["PUSH", 0], ["EMIT", "id"], ["HALT"], ["HALT"],
        ["PUSH", 1], ["EMIT", "id"], ["HALT"], ["HALT"],
        ["PUSH", 2], ["EMIT", "id"], ["HALT"],
    ]


def quota_two_fibers_case():
    # 两个协程各执行 300 条直线指令：每帧各 256 条配额，需两帧完成。
    code = []
    # 协程 0：FORK 到子程序，然后 300 条计数
    code.append(["FORK", 304])            # 0
    code.append(["WAIT", "go"])           # 1 让出到 frame1
    for i in range(300):                  # 2..301
        code.append(["PUSH", 1])
    code.append(["PUSH", 7])              # 302
    code.append(["EMIT", "a"])            # 303
    code.append(["HALT"])                 # 304? 这里索引需谨慎
    # 子程序：从 305 起 300 条
    code.append(["HALT"])                 # 305 占位（目标）
    # 改为更简单的结构，见下方重建
    code = [["FORK", 3], ["WAIT", "go"], ["HALT"]]
    # 子协程：300 条 PUSH 1（栈会满）→ 改为 PUSH/STORE 交替
    code.append(["PUSH", 0])              # 3
    for i in range(300):                  # 4..303
        code.append(["PUSH", 1])
        code.append(["STORE", 2])
        code.append(["LOAD", 2])
        code.append(["STORE", 3])
    code.append(["LOAD", 3])              # 304
    code.append(["EMIT", "b"])            # 305
    code.append(["HALT"])                 # 306
    return code


VALID = {
    "sample-echo": {
        "title": "样例：FORK 后 WAIT / 开门",
        "note": "子协程在下一帧开始；frame2 的 bell 唤醒等待中的协程 0。",
        "frames": 6,
        "code": [
            ["FORK", 4], ["WAIT", "bell"], ["EMIT", "gate"], ["HALT"],
            ["PUSH", 9], ["STORE", 0], ["HALT"],
        ],
        "events": [[2, "bell", 7]],
    },
    "shared-same-frame": {
        "title": "共享槽同帧可见",
        "note": "frame1 中协程 0 先写槽 0，随后协程 1 在同一帧读到 42。",
        "code": [
            ["FORK", 8], ["WAIT", "go"],
            ["PUSH", 42], ["STORE", 0], ["PUSH", 1], ["EMIT", "a"], ["HALT"], ["HALT"],
            ["LOAD", 0], ["EMIT", "b"], ["HALT"],
        ],
        "events": [[1, "go", 0]],
    },
    "event-first-only": {
        "title": "同名事件只收首条",
        "note": "frame1 连续两条 tick(1)、tick(2)，两个等待者都只收到首条值 1。",
        "code": [
            ["FORK", 5], ["WAIT", "tick"], ["EMIT", "a"], ["HALT"], ["HALT"],
            ["WAIT", "tick"], ["EMIT", "b"], ["HALT"],
        ],
        "events": [[1, "tick", 1], [1, "tick", 2]],
    },
    "wait-midframe-no-catchup": {
        "title": "帧中才开始等待收不到本帧事件",
        "note": "事件在帧首广播；协程在 frame0 稍后才 WAIT，必须等 frame1 的事件。",
        "code": [
            ["PUSH", 1], ["EMIT", "pre"], ["WAIT", "sig"], ["EMIT", "post"], ["HALT"],
        ],
        "events": [[0, "sig", 5], [1, "sig", 6]],
    },
    "quota-per-frame": {
        "title": "每协程每帧 256 条上限",
        "note": "603 条直线指令分 3 帧执行；输出槽 31 的终值。",
        "code": quota_case(),
        "events": [],
    },
    "sleep-cross-frame": {
        "title": "SLEEP 跨帧恢复",
        "note": "SLEEP 2 在 frame0 执行，frame2 帧首恢复（当前帧 + 2）。",
        "code": [["PUSH", 1], ["SLEEP", 2], ["EMIT", "woke"], ["HALT"]],
        "events": [],
    },
    "call-per-fiber": {
        "title": "调用栈按协程独立",
        "note": "两个协程分别 CALL 同一子程，各自返回地址互不影响。",
        "code": [
            ["FORK", 6], ["PUSH", 1], ["CALL", 10], ["EMIT", "r"], ["HALT"], ["HALT"],
            ["PUSH", 2], ["CALL", 10], ["EMIT", "s"], ["HALT"],
            ["PUSH", 100], ["ADD"], ["RET"],
        ],
        "events": [],
    },
    "arith-wrap": {
        "title": "有符号 32 位回绕",
        "note": "2147483647+1 回绕为 -2147483648；-2147483648+(-1) 回绕为 2147483647。",
        "code": [
            ["PUSH", 2147483647], ["PUSH", 1], ["ADD"], ["EMIT", "a"],
            ["PUSH", -2147483648], ["PUSH", -1], ["ADD"], ["EMIT", "b"], ["HALT"],
        ],
        "events": [],
    },
    "fault-isolates-fiber": {
        "title": "运行错误只结束故障协程",
        "note": "协程 1 在空栈上 ADD 出错；协程 0 正常输出，错误记录帧号/协程号/指令号。",
        "code": [
            ["FORK", 5], ["PUSH", 1], ["EMIT", "ok"], ["HALT"], ["HALT"],
            ["ADD"], ["HALT"],
        ],
        "events": [],
    },
    "call-depth-fault": {
        "title": "调用栈深度上限 64",
        "note": "递归 CALL 自身；第 65 次 CALL 时结束该协程并记录指令号。",
        "code": [["CALL", 0], ["HALT"]],
        "events": [],
    },
    "exit-past-end": {
        "title": "执行越过程序末尾",
        "note": "最后一条 EMIT 之后 pc 指向末尾之外，只结束该协程。",
        "code": [["PUSH", 1], ["EMIT", "e"]],
        "events": [],
    },
    "deadlock": {
        "title": "全部等待且无后续事件",
        "note": "协程 0 等 \"never\"，之后不再有事件，判定死锁并停止。",
        "code": [["WAIT", "never"], ["EMIT", "x"], ["HALT"]],
        "events": [],
    },
    "frames-limit": {
        "title": "frames 作为运行帧数上限",
        "note": "无限循环在跑到 frames 指定帧数后停止。",
        "code": [["PUSH", 1], ["JNZ", 0]],
        "frames": 4,
        "events": [],
    },
    "jump-to-event": {
        "title": "空闲帧直接跳到事件帧",
        "note": "事件在 frame 500；中间无任何可运行协程，直接跳帧，输出仍为 frame 500。",
        "code": [["WAIT", "x"], ["EMIT", "e"], ["HALT"]],
        "events": [[500, "x", -7]],
    },
    "negative-values": {
        "title": "负值与事件值透传",
        "note": "WAIT 收到的值原样入栈，EMIT 原样输出。",
        "code": [["WAIT", "x"], ["EMIT", "got"], ["HALT"]],
        "events": [[1, "x", -123456789]],
    },
    "fork-limit": {
        "title": "并发协程上限 64",
        "note": "链式 FORK 每个协程保留为 WAIT；第 65 个存活协程时该次 FORK 结束发起协程。",
        "code": fork_limit_case(),
        "events": [],
    },
    "fiber-order": {
        "title": "同帧按协程号顺序运行",
        "note": "三个协程在 frame1 同时可运行，EMIT 顺序按协程号 0、1、2。",
        "code": fiber_order_case(),
        "events": [],
    },
}

INVALID_CASES = {
    "jump-out-of-range": {
        "title": "跳转目标越界",
        "code": [["PUSH", 1], ["JNZ", 99]],
        "expect": {"kind": "jump", "pc": 1},
    },
    "call-out-of-range": {
        "title": "CALL 目标越界",
        "code": [["CALL", 5], ["HALT"]],
        "expect": {"kind": "jump", "pc": 0},
    },
    "fork-negative-target": {
        "title": "FORK 目标为负",
        "code": [["FORK", -1], ["HALT"]],
        "expect": {"kind": "jump", "pc": 0},
    },
    "bad-slot": {
        "title": "槽号越界",
        "code": [["PUSH", 1], ["STORE", 32]],
        "expect": {"kind": "operand", "pc": 1},
    },
    "bad-sleep": {
        "title": "SLEEP 延迟为 0",
        "code": [["SLEEP", 0]],
        "expect": {"kind": "operand", "pc": 0},
    },
    "bad-arity": {
        "title": "操作数个数错误",
        "code": [["PUSH", 1, 2]],
        "expect": {"kind": "operand", "pc": 0},
    },
    "unknown-opcode": {
        "title": "未知指令",
        "code": [["PUSH", 1], ["TELEPORT", 2]],
        "expect": {"kind": "structure", "pc": 1},
    },
    "bad-push-range": {
        "title": "PUSH 超出 32 位",
        "code": [["PUSH", 2147483648]],
        "expect": {"kind": "operand", "pc": 0},
    },
    "bad-event-frame": {
        "title": "事件帧号为负",
        "code": [["HALT"]],
        "events": [[-1, "x", 0]],
        "expect": {"kind": "event", "pc": -1},
    },
    "empty-event-name": {
        "title": "事件名为空",
        "code": [["WAIT", ""]],
        "expect": {"kind": "operand", "pc": 0},
    },
}


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main():
    expected = {"generator": "scripts/gen_cases.py", "valid": {}, "invalid": {}}

    for name, case in VALID.items():
        src = {}
        if "frames" in case:
            src["frames"] = case["frames"]
        src["code"] = case["code"]
        src["events"] = case.get("events", [])
        write_json(os.path.join(CASES, f"{name}.json"),
                   {"_title": case["title"], "_note": case["note"], **src})
        try:
            expected["valid"][name] = ref.run_case(src)
        except ref.ImportErrorLfv as exc:  # pragma: no cover
            raise SystemExit(f"有效用例 {name} 导入失败：{exc.message}")

    for name, case in INVALID_CASES.items():
        src = {"code": case["code"], "events": case.get("events", [])}
        write_json(os.path.join(INVALID_DIR, f"{name}.json"),
                   {"_title": case["title"], "expect": case["expect"], **src})
        try:
            ref.compile_program(src)
            raise SystemExit(f"无效用例 {name} 居然通过了导入")
        except ref.ImportErrorLfv as exc:
            if exc.kind != case["expect"]["kind"] or exc.pc != case["expect"]["pc"]:
                raise SystemExit(
                    f"无效用例 {name} 期望 {case['expect']}，实际 kind={exc.kind} pc={exc.pc}：{exc.message}")
            expected["invalid"][name] = {"kind": exc.kind, "pc": exc.pc, "message": exc.message}

    write_json(os.path.join(ROOT, "samples", "expected.json"), expected)
    print(f"写出 {len(VALID)} 个有效用例、{len(INVALID_CASES)} 个无效用例，expected.json 已更新。")


if __name__ == "__main__":
    main()
