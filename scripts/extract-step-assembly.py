#!/usr/bin/env python3
"""
extract-step-assembly.py  --  Sesame Lab / Phase 0 task F5 (companion)

A deliberately narrow STEP AP-214/242 reader. It does NOT evaluate B-Rep
geometry - that would need OpenCascade. It reads only the two things the STL
files cannot tell us:

  1. the unit context   (SI_UNIT / CONVERSION_BASED_UNIT declarations), which
     settles what "1.0" means in this design, and
  2. the assembly tree  (PRODUCT_DEFINITION -> NEXT_ASSEMBLY_USAGE_OCCURRENCE
     -> CONTEXT_DEPENDENT_SHAPE_REPRESENTATION -> ITEM_DEFINED_TRANSFORMATION
     -> AXIS2_PLACEMENT_3D), which gives every component instance a rigid pose
     in the root assembly's frame.

Those two are pure symbolic data in the exchange file, so a regex-level reader
is exact for them - there is no tessellation or surface evaluation involved.

Usage:
    python extract-step-assembly.py <file.step> [--json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np

ENTITY_RE = re.compile(r"#(\d+)\s*=\s*(.*?);", re.S)
REF_RE = re.compile(r"#(\d+)")


def load_entities(path: Path) -> dict[int, str]:
    """id -> entity body, with continuation lines joined."""
    text = path.read_text(encoding="utf-8", errors="replace")
    start = text.find("DATA;")
    if start >= 0:
        text = text[start + 5:]
    out: dict[int, str] = {}
    for m in ENTITY_RE.finditer(text):
        out[int(m.group(1))] = " ".join(m.group(2).split())
    return out


def args_of(body: str) -> list[str]:
    """Split the top-level argument list of a single simple entity."""
    i = body.find("(")
    if i < 0:
        return []
    depth, buf, out = 0, [], []
    in_str = False
    for ch in body[i:]:
        if in_str:
            buf.append(ch)
            if ch == "'":
                in_str = False
            continue
        if ch == "'":
            in_str = True
            buf.append(ch)
        elif ch == "(":
            depth += 1
            if depth == 1:
                buf = []
                continue
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            if depth == 0:
                out.append("".join(buf).strip())
                break
            buf.append(ch)
        elif ch == "," and depth == 1:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    return [a for a in out if a != ""] if out != [""] else []


NUM_RE = re.compile(r"[-+]?\d*\.\d*(?:[EeDd][-+]?\d+)?|[-+]?\d+(?:[EeDd][-+]?\d+)?")


def floats(body: str) -> list[float]:
    """All numeric literals in an entity body, in order."""
    return [float(t.replace("D", "E").replace("d", "e"))
            for t in NUM_RE.findall(body[body.find("("):])]


def ref(a: str) -> int | None:
    m = REF_RE.fullmatch(a.strip())
    return int(m.group(1)) if m else None


def unquote(a: str) -> str:
    a = a.strip()
    return a[1:-1] if a.startswith("'") and a.endswith("'") else a


# --------------------------------------------------------------------------

def read_units(ent: dict[int, str]) -> dict[str, Any]:
    # Unit declarations live inside AP-214 *complex* entities, e.g.
    #   #440624=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
    # so match anywhere in the body, not just at its start.
    si_re = re.compile(r"SI_UNIT\s*\([^)]*\)")
    cv_re = re.compile(r"CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'")
    si, conv = set(), set()
    for b in ent.values():
        si.update(m.group(0) for m in si_re.finditer(b))
        conv.update(m.group(1) for m in cv_re.finditer(b))
    si, conv = sorted(si), sorted(conv)
    value = "millimetre" if any(".MILLI." in s and "METRE" in s for s in si) else None
    return {
        "lengthUnit": value,
        "siUnitDeclarations": si,
        "conversionBasedUnits": conv,
        "note": ("Read verbatim from the STEP unit context. This is a declared "
                 "fact in the exchange file, not an inference."),
    }


def placement(ent: dict[int, str], pid: int) -> tuple[np.ndarray, np.ndarray]:
    """AXIS2_PLACEMENT_3D -> (3x3 rotation, translation)."""
    a = args_of(ent[pid])
    loc = np.array(floats(args_of(ent[ref(a[1])])[-1])[:3])
    z = np.array([0.0, 0.0, 1.0])
    x = np.array([1.0, 0.0, 0.0])
    if len(a) > 2 and ref(a[2]) is not None:
        z = np.array(floats(args_of(ent[ref(a[2])])[-1])[:3])
    if len(a) > 3 and ref(a[3]) is not None:
        x = np.array(floats(args_of(ent[ref(a[3])])[-1])[:3])
    z = z / np.linalg.norm(z)
    x = x - (x @ z) * z
    nx = np.linalg.norm(x)
    x = np.array([1.0, 0.0, 0.0]) if nx < 1e-12 else x / nx
    y = np.cross(z, x)
    return np.column_stack([x, y, z]), loc


def mat4(R: np.ndarray, t: np.ndarray) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = t
    return T


def build_assembly(ent: dict[int, str]) -> dict[str, Any]:
    # -- index the entities we care about ---------------------------------
    pd_name: dict[int, str] = {}
    for i, b in ent.items():
        if b.startswith("PRODUCT_DEFINITION("):
            pd_name[i] = unquote(args_of(b)[0])

    nauo: dict[int, tuple[str, int, int]] = {}
    for i, b in ent.items():
        if b.startswith("NEXT_ASSEMBLY_USAGE_OCCURRENCE("):
            a = args_of(b)
            nauo[i] = (unquote(a[0]), ref(a[3]), ref(a[4]))

    # PRODUCT_DEFINITION_SHAPE whose definition is a NAUO
    pds_for_nauo: dict[int, int] = {}
    for i, b in ent.items():
        if b.startswith("PRODUCT_DEFINITION_SHAPE("):
            d = ref(args_of(b)[2])
            if d in nauo:
                pds_for_nauo[d] = i

    # CDSR(representation_relation, represented_product_relation)
    cdsr_by_pds: dict[int, int] = {}
    for i, b in ent.items():
        if b.startswith("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION("):
            a = args_of(b)
            cdsr_by_pds[ref(a[1])] = ref(a[0])

    def transform_of(nid: int) -> np.ndarray | None:
        pds = pds_for_nauo.get(nid)
        if pds is None:
            return None
        rr = cdsr_by_pds.get(pds)
        if rr is None or rr not in ent:
            return None
        body = ent[rr]
        m = re.search(r"REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\s*\(\s*#(\d+)",
                      body)
        if not m:
            return None
        idt = int(m.group(1))
        a = args_of(ent[idt])
        p1, p2 = ref(a[2]), ref(a[3])
        if p1 is None or p2 is None:
            return None
        R1, t1 = placement(ent, p1)
        R2, t2 = placement(ent, p2)
        # child-local -> parent: apply A2 then undo A1
        return mat4(R2, t2) @ np.linalg.inv(mat4(R1, t1))

    children: dict[int, list[int]] = {}
    is_child: set[int] = set()
    for nid, (_, parent, child) in nauo.items():
        children.setdefault(parent, []).append(nid)
        is_child.add(child)

    roots = [p for p in children if p not in is_child]

    occurrences: list[dict[str, Any]] = []

    def walk(pd: int, T: np.ndarray, path: list[str], depth: int) -> None:
        if depth > 12:
            return
        for nid in sorted(children.get(pd, [])):
            label, _, child = nauo[nid]
            M = transform_of(nid)
            missing = M is None
            Tc = T if missing else T @ M
            name = pd_name.get(child, f"#{child}")
            occurrences.append({
                "product": name,
                "occurrence": label,
                "path": "/".join(path + [label]),
                "depth": depth,
                "transformResolved": not missing,
                "matrix": [[round(float(v), 6) for v in row] for row in Tc[:3]],
                "origin": [round(float(v), 6) for v in Tc[:3, 3]],
                "xAxis": [round(float(v), 6) for v in Tc[:3, 0]],
                "yAxis": [round(float(v), 6) for v in Tc[:3, 1]],
                "zAxis": [round(float(v), 6) for v in Tc[:3, 2]],
            })
            walk(child, Tc, path + [label], depth + 1)

    for rpd in sorted(roots):
        walk(rpd, np.eye(4), [pd_name.get(rpd, f"#{rpd}")], 0)

    occurrences.sort(key=lambda o: (o["path"], o["product"]))
    return {
        "rootProducts": sorted(pd_name.get(x, f"#{x}") for x in roots),
        "occurrenceCount": len(occurrences),
        "unresolvedTransforms": sum(1 for o in occurrences
                                    if not o["transformResolved"]),
        "occurrences": occurrences,
    }


JOINT_RE = re.compile(r"^(femur|foot)-?joint-?([RL][1-4])$", re.I)


def joint_poses(asm: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for o in asm["occurrences"]:
        m = JOINT_RE.match(o["product"])
        if not m:
            continue
        out.append({
            "firmwareJointName": m.group(2).upper(),
            "cadProduct": o["product"],
            "cadRole": m.group(1).lower(),
            "occurrencePath": o["path"],
            "transformResolved": o["transformResolved"],
            "origin": o["origin"],
            "xAxis": o["xAxis"], "yAxis": o["yAxis"], "zAxis": o["zAxis"],
        })
    out.sort(key=lambda x: (x["firmwareJointName"], x["occurrencePath"]))
    return out


def analyse(path: Path) -> dict[str, Any]:
    ent = load_entities(path)
    asm = build_assembly(ent)
    return {
        "entityCount": len(ent),
        "units": read_units(ent),
        "assembly": {
            "rootProducts": asm["rootProducts"],
            "occurrenceCount": asm["occurrenceCount"],
            "unresolvedTransforms": asm["unresolvedTransforms"],
        },
        "jointPoses": joint_poses(asm),
        "namedProducts": sorted({o["product"] for o in asm["occurrences"]
                                 if not re.match(r"^[CRLDQU]\d{4}", o["product"])})[:80],
        "keyOccurrences": [o for o in asm["occurrences"]
                           if o["depth"] == 0
                           and re.search(r"joint|Frame|Cover|Servo|Display|Battery",
                                         o["product"], re.I)],
        "method": ("symbolic STEP read: PRODUCT_DEFINITION / "
                   "NEXT_ASSEMBLY_USAGE_OCCURRENCE / "
                   "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION / "
                   "ITEM_DEFINED_TRANSFORMATION / AXIS2_PLACEMENT_3D. No B-Rep "
                   "surfaces were evaluated."),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    res = analyse(Path(a.step))
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        print(f"entities        : {res['entityCount']}")
        print(f"length unit     : {res['units']['lengthUnit']}")
        print(f"si declarations : {res['units']['siUnitDeclarations']}")
        print(f"conversion units: {res['units']['conversionBasedUnits']}")
        print(f"root products   : {res['assembly']['rootProducts']}")
        print(f"occurrences     : {res['assembly']['occurrenceCount']} "
              f"({res['assembly']['unresolvedTransforms']} without a transform)")
        print("joint poses:")
        for j in res["jointPoses"]:
            print(f"  {j['firmwareJointName']:3s} {j['cadRole']:6s} "
                  f"origin={j['origin']} z={j['zAxis']} x={j['xAxis']} "
                  f"resolved={j['transformResolved']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
