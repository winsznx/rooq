"""Builds a nargo Prover.toml from `W name [idx...] value` lines printed by the gen_prover_toml tests.

Indices apply to the segment marked `[]` (e.g. `outs[].value`), or to the last segment when none is marked
(e.g. `w.taker_path`).
"""
import sys


def put(node, segs, idxs, value):
    seg, *rest = segs
    arr_here = seg.endswith("[]") or (not rest and idxs and not any(s.endswith("[]") for s in segs))
    key = seg.removesuffix("[]")
    if not arr_here:
        if not rest:
            node[key] = value
            return
        put(node.setdefault(key, {}), rest, idxs, value)
        return
    cur = node.setdefault(key, [])
    for d, i in enumerate(idxs):
        last = d == len(idxs) - 1
        while len(cur) <= i:
            cur.append(({} if rest else None) if last else [])
        if not last:
            cur = cur[i]
    if rest:
        put(cur[idxs[-1]], rest, [], value)
    else:
        cur[idxs[-1]] = value


def emit(v):
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{k} = {emit(x)}" for k, x in v.items()) + " }"
    if isinstance(v, list):
        return "[" + ", ".join(emit(x) for x in v) + "]"
    return f'"{v}"'


def main():
    root = {}
    for line in sys.stdin:
        parts = line.split()
        if len(parts) < 3 or parts[0] != "W":
            continue
        name, *idx, value = parts[1:]
        put(root, name.split("."), [int(i) for i in idx], value)
    for k, v in root.items():
        print(f"{k} = {emit(v)}")


if __name__ == "__main__":
    main()
