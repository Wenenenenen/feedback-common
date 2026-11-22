#!/usr/bin/env python3
"""关卡脚本协程解释器 —— Python 参考实现（独立于 JS 实现，遵循同一规范）。

用途：
  * 生成 samples/expected.json（各用例的参考输出）
  * 与 JS 实现交叉核对（tests/crosscheck.mjs 随机程序逐项比对）

只依赖标准库；用 `python3 -I` 运行，避免样例目录被植入同名模块。

命令行：
  python3 -I src/py/lfv_ref.py compile <case.json>      仅校验，打印 {"ok":true}
  python3 -I src/py/lfv_ref.py run <case.json>          运行，打印结果 JSON
  python3 -I src/py/lfv_ref.py snapshot <case.json> <n> 执行 n 条指令后导出快照（JSON）
"""

from __future__ import annotations

import json
import sys

INT32_MIN = -(1 << 31)
INT32_MAX = (1 << 31) - 1

LIMITS = {
    "CODE": 8192,
    "FIBERS": 64,
    "EVENTS": 20000,
    "SLOTS": 32,
    "STACK": 256,
    "CALL_DEPTH": 64,
    "PER_FRAME": 256,
    "MAX_FRAMES": 10_000_000,
    "RETAINED_DONE": 256,
}

OPS = ["PUSH", "LOAD", "STORE", "ADD", "JNZ", "CALL", "RET",
       "FORK", "SLEEP", "WAIT", "EMIT", "HALT"]
OP_INDEX = {name: i for i, name in enumerate(OPS)}
ARITY = {name: 0 for name in ("ADD", "RET", "HALT")}

READY, WAITING, SLEEPING, NEW, DONE, FAILED = "ready", "waiting", "sleeping", "new", "done", "failed"
LIVE = {NEW, READY, WAITING, SLEEPING}


class ImportErrorLfv(Exception):
    def __init__(self, message: str, pc: int = -1, kind: str = "structure"):
        super().__init__(message)
        self.message = message
        self.pc = pc
        self.kind = kind

    def to_dict(self):
        return {"ok": False, "error": self.message, "pc": self.pc, "kind": self.kind}


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _int32(v, what, pc):
    if not _is_int(v):
        raise ImportErrorLfv(f"{what} 必须是整数", pc, "operand")
    if v < INT32_MIN or v > INT32_MAX:
        raise ImportErrorLfv(f"{what} {v} 超出有符号 32 位范围", pc, "operand")
    return v


class Program:
    __slots__ = ("n", "code", "frames", "events_by_frame", "event_frames", "source")

    def __init__(self, n, code, frames, events_by_frame, event_frames, source):
        self.n = n
        self.code = code                    # [(name, operand_or_None, target)]
        self.frames = frames
        self.events_by_frame = events_by_frame
        self.event_frames = event_frames
        self.source = source                # 快照中保存的规范化源


def compile_program(obj) -> Program:
    if not isinstance(obj, dict):
        raise ImportErrorLfv("关卡脚本必须是 JSON 对象", -1, "root")
    raw = obj.get("code")
    if not isinstance(raw, list):
        raise ImportErrorLfv("code 必须是数组", -1, "root")
    if not raw:
        raise ImportErrorLfv("code 不能为空", -1, "root")
    if len(raw) > LIMITS["CODE"]:
        raise ImportErrorLfv(f"指令数 {len(raw)} 超过上限 {LIMITS['CODE']}", LIMITS["CODE"], "limit")

    frames = obj.get("frames")
    if frames is not None:
        if not _is_int(frames) or frames < 0:
            raise ImportErrorLfv("frames 必须是非负整数", -1, "root")
        if frames > LIMITS["MAX_FRAMES"]:
            raise ImportErrorLfv(f"frames 超过上限 {LIMITS['MAX_FRAMES']}", -1, "limit")

    raw_events = obj.get("events", [])
    if raw_events is None:
        raw_events = []
    if not isinstance(raw_events, list):
        raise ImportErrorLfv("events 必须是数组", -1, "root")
    if len(raw_events) > LIMITS["EVENTS"]:
        raise ImportErrorLfv(f"事件数 {len(raw_events)} 超过上限 {LIMITS['EVENTS']}", -1, "limit")

    n = len(raw)
    code = []
    norm_code = []
    for pc, ins in enumerate(raw):
        if not isinstance(ins, list) or not ins:
            raise ImportErrorLfv(f"指令 {pc} 必须是非空数组", pc, "structure")
        name = ins[0]
        if not isinstance(name, str) or name not in OP_INDEX:
            raise ImportErrorLfv(f"指令 {pc} 的名字 {json.dumps(name, ensure_ascii=False)} 未知", pc, "structure")
        want = ARITY.get(name, 1)
        if len(ins) != want + 1:
            raise ImportErrorLfv(f"指令 {pc} {name} 需要 {want} 个操作数，实际 {len(ins) - 1} 个", pc, "operand")
        operand = None
        target = -1
        if name == "PUSH":
            operand = _int32(ins[1], f"指令 {pc} PUSH 常量", pc)
            norm_code.append([name, operand])
        elif name in ("LOAD", "STORE"):
            operand = _int32(ins[1], f"指令 {pc} {name} 槽号", pc)
            if operand < 0 or operand >= LIMITS["SLOTS"]:
                raise ImportErrorLfv(
                    f"指令 {pc} {name} 槽号 {operand} 越界（0..{LIMITS['SLOTS'] - 1}）", pc, "operand")
            norm_code.append([name, operand])
        elif name in ("JNZ", "CALL", "FORK"):
            target = _int32(ins[1], f"指令 {pc} {name} 目标", pc)
            if target < 0 or target >= n:
                raise ImportErrorLfv(
                    f"指令 {pc} {name} 跳转目标 {target} 越界（有效范围 0..{n - 1}）", pc, "jump")
            norm_code.append([name, target])
        elif name == "SLEEP":
            operand = _int32(ins[1], f"指令 {pc} SLEEP 延迟", pc)
            if operand < 1:
                raise ImportErrorLfv(f"指令 {pc} SLEEP 延迟至少为 1", pc, "operand")
            norm_code.append([name, operand])
        elif name in ("WAIT", "EMIT"):
            operand = ins[1]
            if not isinstance(operand, str) or operand == "":
                raise ImportErrorLfv(f"指令 {pc} {name} 需要非空事件名", pc, "operand")
            norm_code.append([name, operand])
        else:
            norm_code.append([name])
        code.append((name, operand, target))

    events_by_frame = {}
    norm_events = []
    for i, e in enumerate(raw_events):
        if not isinstance(e, list) or len(e) != 3:
            raise ImportErrorLfv(f"events[{i}] 必须是 [帧, 事件名, 值]", -1, "event")
        frame, name, value = e
        if not _is_int(frame) or frame < 0:
            raise ImportErrorLfv(f"events[{i}] 的帧号必须是非负整数", -1, "event")
        if frame > LIMITS["MAX_FRAMES"]:
            raise ImportErrorLfv(f"events[{i}] 的帧号 {frame} 超过上限 {LIMITS['MAX_FRAMES']}", -1, "limit")
        if not isinstance(name, str) or name == "":
            raise ImportErrorLfv(f"events[{i}] 的事件名必须是非空字符串", -1, "event")
        value = _int32(value, f"events[{i}] 的值", -1)
        events_by_frame.setdefault(frame, []).append((name, value))
        norm_events.append([frame, name, value])

    event_frames = sorted(events_by_frame)
    source = {"frames": frames, "code": norm_code, "events": norm_events}
    return Program(n, code, frames, events_by_frame, event_frames, source)


class Fiber:
    __slots__ = ("id", "pc", "status", "stack", "calls", "wait_name", "wait_pc",
                 "wake_frame", "used", "start_frame")

    def __init__(self, fid, pc, start_frame, status):
        self.id = fid
        self.pc = pc
        self.status = status
        self.stack = []
        self.calls = []
        self.wait_name = None
        self.wait_pc = -1
        self.wake_frame = 0
        self.used = 0
        self.start_frame = start_frame


class VM:
    def __init__(self, prog: Program, state=None):
        self.prog = prog
        if state is None:
            state = {
                "frame": 0,
                "phase": "frame",
                "slots": [0] * LIMITS["SLOTS"],
                "fibers": [Fiber(0, 0, 0, READY)],
                "outputs": [],
                "faults": [],
                "next_id": 1,
                "finished": 0,
                "retained": 0,
                "live": 1,
                "halted": prog.frames == 0,
                "stop": "frames" if prog.frames == 0 else None,
                "total": 0,
            }
        self.st = state

    # ------------------------------------------------------------ 帧前处理

    def begin_frame(self):
        st = self.st
        frame = st["frame"]
        for f in st["fibers"]:
            if f.status in LIVE:
                f.used = 0

        waiting = {}
        for f in st["fibers"]:
            if f.status == WAITING:
                waiting.setdefault(f.wait_name, []).append(f)
        if waiting:
            for name, value in self.prog.events_by_frame.get(frame, []):
                group = waiting.pop(name, None)
                if not group:
                    continue
                for f in group:
                    self._deliver(f, value)
        for f in st["fibers"]:
            if f.status == SLEEPING and f.wake_frame <= frame:
                f.status = READY
                f.wake_frame = 0
        for f in st["fibers"]:
            if f.status == NEW and f.start_frame <= frame:
                f.status = READY
                f.used = 0
        st["phase"] = "run"

    def _deliver(self, f, value):
        if len(f.stack) >= LIMITS["STACK"]:
            self._fault(f, f.wait_pc if f.wait_pc >= 0 else f.pc, "stack",
                        f"WAIT {f.wait_name} 收到事件时操作数栈已满（{LIMITS['STACK']}）")
            return
        f.stack.append(value)
        f.status = READY
        f.wait_name = None
        f.wait_pc = -1

    # ------------------------------------------------------------ 调度

    def pick(self):
        for f in self.st["fibers"]:
            if f.status == READY and f.used < LIMITS["PER_FRAME"]:
                return f
        return None

    def end_frame(self):
        st = self.st
        if st["retained"] > LIMITS["RETAINED_DONE"]:
            excess = st["retained"] - LIMITS["RETAINED_DONE"]
            kept = []
            for f in st["fibers"]:
                if f.status in LIVE:
                    kept.append(f)
                elif excess > 0:
                    excess -= 1
                    st["retained"] -= 1
                else:
                    kept.append(f)
            st["fibers"] = kept
        st["frame"] += 1
        st["phase"] = "frame"
        for f in st["fibers"]:
            f.used = 0
        limit = float("inf") if self.prog.frames is None else self.prog.frames
        if st["frame"] >= limit:
            st["halted"] = True
            st["stop"] = "frames"
            return
        if st["live"] == 0:
            st["halted"] = True
            st["stop"] = "empty"
            return
        actionable = float("inf")
        for f in st["fibers"]:
            if f.status in (READY, NEW):
                actionable = st["frame"]
                break
            if f.status == SLEEPING and f.wake_frame < actionable:
                actionable = f.wake_frame
        nxt = self._next_event_frame(st["frame"])
        if nxt < actionable:
            actionable = nxt
        if actionable == float("inf"):
            st["halted"] = True
            st["stop"] = "deadlock"
            return
        if actionable >= limit:
            st["frame"] = int(limit)
            st["halted"] = True
            st["stop"] = "frames"
            return
        if actionable > st["frame"]:
            st["frame"] = actionable

    def _next_event_frame(self, frame):
        frames = self.prog.event_frames
        lo, hi = 0, len(frames)
        while lo < hi:
            mid = (lo + hi) // 2
            if frames[mid] < frame:
                lo = mid + 1
            else:
                hi = mid
        return frames[lo] if lo < len(frames) else float("inf")

    # ------------------------------------------------------------ 错误

    def _fault(self, f, pc, kind, message):
        if f.status in LIVE:
            self.st["live"] -= 1
        f.status = FAILED
        self.st["faults"].append({
            "frame": self.st["frame"], "fiber": f.id, "pc": pc,
            "kind": kind, "message": message,
        })
        self.st["finished"] += 1
        self.st["retained"] += 1

    def _retire(self, f):
        if f.status in LIVE:
            self.st["live"] -= 1
        f.status = DONE
        self.st["finished"] += 1
        self.st["retained"] += 1

    # ------------------------------------------------------------ 单条指令

    def exec_one(self, f):
        st = self.st
        prog = self.prog
        pc = f.pc
        if pc < 0 or pc >= prog.n:
            self._fault(f, pc, "exit", f"指令号 {pc} 越过程序末尾（0..{prog.n - 1}）")
            return
        name, operand, target = prog.code[pc]
        stack = f.stack
        if name == "PUSH":
            if len(stack) >= LIMITS["STACK"]:
                self._fault(f, pc, "stack", f"PUSH 时操作数栈已满（{LIMITS['STACK']}）")
                return
            stack.append(operand)
            f.pc = pc + 1
        elif name == "LOAD":
            if len(stack) >= LIMITS["STACK"]:
                self._fault(f, pc, "stack", f"LOAD 时操作数栈已满（{LIMITS['STACK']}）")
                return
            stack.append(st["slots"][operand])
            f.pc = pc + 1
        elif name == "STORE":
            if not stack:
                self._fault(f, pc, "stack", "STORE 需要 1 个操作数，栈为空")
                return
            st["slots"][operand] = _wrap32(stack.pop())
            f.pc = pc + 1
        elif name == "ADD":
            if len(stack) < 2:
                self._fault(f, pc, "stack", f"ADD 需要 2 个操作数，栈中只有 {len(stack)} 个")
                return
            b = stack.pop()
            a = stack.pop()
            stack.append(_wrap32(a + b))
            f.pc = pc + 1
        elif name == "JNZ":
            if not stack:
                self._fault(f, pc, "stack", "JNZ 需要 1 个操作数，栈为空")
                return
            f.pc = target if stack.pop() != 0 else pc + 1
        elif name == "CALL":
            if len(f.calls) >= LIMITS["CALL_DEPTH"]:
                self._fault(f, pc, "stack", f"CALL 时调用栈深度超过 {LIMITS['CALL_DEPTH']}")
                return
            f.calls.append(pc + 1)
            f.pc = target
        elif name == "RET":
            if not f.calls:
                self._retire(f)
                f.used += 1
                st["total"] += 1
                return
            f.pc = f.calls.pop()
        elif name == "FORK":
            if st["live"] >= LIMITS["FIBERS"]:
                self._fault(f, pc, "fiber", f"FORK 时并发协程已达上限 {LIMITS['FIBERS']}")
                return
            child = Fiber(st["next_id"], target, st["frame"] + 1, NEW)
            st["next_id"] += 1
            st["fibers"].append(child)
            st["live"] += 1
            f.pc = pc + 1
        elif name == "SLEEP":
            f.status = SLEEPING
            f.wake_frame = st["frame"] + operand
            f.pc = pc + 1
        elif name == "WAIT":
            f.status = WAITING
            f.wait_name = operand
            f.wait_pc = pc
            f.pc = pc + 1
        elif name == "EMIT":
            if not stack:
                self._fault(f, pc, "stack", "EMIT 需要 1 个操作数，栈为空")
                return
            st["outputs"].append([st["frame"], f.id, operand, _wrap32(stack.pop())])
            f.pc = pc + 1
        elif name == "HALT":
            self._retire(f)
            f.used += 1
            st["total"] += 1
            return
        else:  # pragma: no cover
            self._fault(f, pc, "structure", "未知指令")
            return
        f.used += 1
        st["total"] += 1
        if f.pc >= prog.n and f.status not in (DONE, FAILED):
            self._fault(f, pc, "exit", f"指令 {pc} 执行后越过程序末尾（pc={f.pc}）")

    # ------------------------------------------------------------ 运行

    def run(self, max_instructions=10**9):
        st = self.st
        executed = 0
        while executed < max_instructions and not st["halted"]:
            if st["phase"] == "frame":
                self.begin_frame()
                continue
            f = self.pick()
            if f is None:
                self.end_frame()
                continue
            self.exec_one(f)
            executed += 1
        return executed

    def step_instruction(self):
        st = self.st
        for _ in range(1000000):
            if st["halted"]:
                return None
            if st["phase"] == "frame":
                self.begin_frame()
                continue
            f = self.pick()
            if f is None:
                self.end_frame()
                continue
            info = {"frame": st["frame"], "fiber": f.id, "pc": f.pc, "op": self.prog.code[f.pc][0]}
            self.exec_one(f)
            return info
        raise RuntimeError("步进未能推进")

    def snapshot(self):
        st = self.st
        return {
            "format": "level-fiber-snapshot",
            "version": 1,
            "program": self.prog.source,
            "state": {
                "frame": st["frame"],
                "phase": st["phase"],
                "slots": list(st["slots"]),
                "fibers": [{
                    "id": f.id, "pc": f.pc, "status": f.status,
                    "stack": list(f.stack), "calls": list(f.calls),
                    "waitName": f.wait_name, "waitPc": f.wait_pc,
                    "wakeFrame": f.wake_frame, "used": f.used, "startFrame": f.start_frame,
                } for f in st["fibers"]],
                "outputs": [list(o) for o in st["outputs"]],
                "faults": [dict(x) for x in st["faults"]],
                "nextId": st["next_id"], "finished": st["finished"],
                "retained": st["retained"], "halted": st["halted"],
                "stopReason": st["stop"], "totalInstr": st["total"],
            },
        }

    @classmethod
    def from_snapshot(cls, snap):
        prog = compile_program(snap["program"])
        s = snap["state"]
        vm = cls.__new__(cls)
        vm.prog = prog
        fibers = []
        for f in s["fibers"]:
            obj = Fiber(f["id"], f["pc"], f["startFrame"], f["status"])
            obj.stack = list(f["stack"])
            obj.calls = list(f["calls"])
            obj.wait_name = f.get("waitName")
            obj.wait_pc = f.get("waitPc", -1)
            obj.wake_frame = f.get("wakeFrame", 0)
            obj.used = f.get("used", 0)
            fibers.append(obj)
        live = sum(1 for f in fibers if f.status in LIVE)
        vm.st = {
            "frame": s["frame"], "phase": s["phase"],
            "slots": [int(v) for v in s["slots"]],
            "fibers": fibers,
            "outputs": [list(o) for o in s["outputs"]],
            "faults": [dict(x) for x in s["faults"]],
            "next_id": s["nextId"], "finished": s["finished"],
            "retained": s["retained"], "live": live,
            "halted": s["halted"], "stop": s.get("stopReason"),
            "total": s["totalInstr"],
        }
        return vm

    def result(self):
        st = self.st
        return {
            "outputs": [list(o) for o in st["outputs"]],
            "faults": [dict(x) for x in st["faults"]],
            "slots": list(st["slots"]),
            "finalFrame": st["frame"],
            "halted": st["halted"],
            "stopReason": st["stop"],
            "totalInstr": st["total"],
            "liveFibers": st["live"],
            "finished": st["finished"],
        }


def _wrap32(v):
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v & 0x80000000 else v


def run_case(obj, max_instructions=10**9):
    prog = compile_program(obj)
    vm = VM(prog)
    vm.run(max_instructions)
    return vm.result()


def _main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, path = argv[1], argv[2]
    with open(path, encoding="utf-8") as fh:
        obj = json.load(fh)
    try:
        if cmd == "compile":
            compile_program(obj)
            print(json.dumps({"ok": True}, ensure_ascii=False))
        elif cmd == "run":
            limit = int(argv[3]) if len(argv) > 3 else 10**9
            print(json.dumps(run_case(obj, limit), ensure_ascii=False))
        elif cmd == "snapshot":
            limit = int(argv[3]) if len(argv) > 3 else 0
            prog = compile_program(obj)
            vm = VM(prog)
            vm.run(limit)
            print(json.dumps(vm.snapshot(), ensure_ascii=False))
        else:
            print(__doc__)
            return 2
    except ImportErrorLfv as exc:
        print(json.dumps(exc.to_dict(), ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
