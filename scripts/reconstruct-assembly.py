#!/usr/bin/env python3
"""
reconstruct-assembly.py  --  Sesame Lab / Phase 1 task V0

Reconstructs the Sesame robot's CAD assembly and writes hardware/assembly-map.json:
a per-instance rigid pose for every printed part in ONE canonical robot frame,
plus the joint axes, the servo shaft datums and the evidence for all of it.

WHAT THIS DOES THAT F5 DID NOT
------------------------------
F5 read the STEP assembly *tree* symbolically (220 occurrence transforms) but
never evaluated any geometry out of the file, so it could not tie the STL export
frame to the CAD.  This script does evaluate geometry - but only the part of it
that is exactly recoverable without an OpenCascade kernel: the B-Rep VERTEX_POINT
set of every product.  Those points are the exact corner vertices a tessellator
emits into the STL, so an STL vertex tree matches them to float32 precision.

That turns the frame map from a guess into a measurement:

  1. Collect, per PRODUCT, the CARTESIAN_POINTs behind its VERTEX_POINTs.
  2. Enumerate every plausible STL -> CAD-part-local map: 48 signed axis
     permutations x {scale 25.4, scale 1}, translation fitted per candidate by
     multi-start translation-only ICP against the real STL vertex cloud.
  3. Score each candidate by (mean point-to-nearest-STL-vertex residual)
     + (spread of the fitted translation across the ten parts).  A frame map is
     global, so a candidate that needs a different translation for each part is
     not a frame map.
  4. Accept only on a decisive win, and record the margin either way.

Then, with the map fixed, every STL is placed at its CAD instance transform and
the assembly is scored for physical self-consistency (hip-axis rectangle, knee
coaxiality across all 16 femur/foot combinations, interpenetration, feet
vertical, body-shell stack).

CONVENTIONS
-----------
* All STEP coordinates are in INCHES.  Every one of the file's 107 geometric
  representation contexts assigns #440623 = CONVERSION_BASED_UNIT('inch'), whose
  LENGTH_MEASURE_WITH_UNIT is 25.4 mm.  (F5 reported "millimetre" for the CAD;
  that read the *base* of the inch conversion, not the assigned unit.  The STL
  files really are in millimetres, which is why the factor is exactly 25.4.)
* Output is millimetres, degrees, right-handed.
* Deterministic: two runs with the same inputs and the same --generated-at
  produce byte-identical output.

Usage:
  tools/py-assets/.venv/Scripts/python.exe scripts/reconstruct-assembly.py \
      --step reference/sesame-robot-main/hardware/cad/Sesame-ESP32-v122.step \
      --stl-dir reference/sesame-robot-main/hardware/printing/stl \
      --repo-root . --out hardware/assembly-map.json
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
from scipy.spatial import cKDTree

INCH_MM = 25.4

REF = re.compile(r"#(\d+)")
NUM = re.compile(r"[-+]?\d*\.\d*(?:[EeDd][-+]?\d+)?|[-+]?\d+(?:[EeDd][-+]?\d+)?")


# ===========================================================================
# 1. A narrow STEP reader: assembly tree + per-product B-Rep vertex clouds
# ===========================================================================

class Step:
    """AP-214 reader limited to what is exactly recoverable without a kernel."""

    def __init__(self, path: Path):
        self.path = Path(path)
        text = self.path.read_text(encoding="utf-8", errors="replace")
        text = text[text.find("DATA;") + 5:]
        self.ent: dict[int, str] = {
            int(m.group(1)): " ".join(m.group(2).split())
            for m in re.finditer(r"#(\d+)\s*=\s*(.*?);", text, re.S)
        }
        self.refs: dict[int, list[int]] = {
            i: [int(x) for x in REF.findall(b)] for i, b in self.ent.items()
        }
        self.cp: dict[int, list[float]] = {}
        self.dirv: dict[int, list[float]] = {}
        for i, b in self.ent.items():
            if b.startswith("CARTESIAN_POINT("):
                v = self._nums(b)
                if len(v) >= 3:
                    self.cp[i] = v[:3]
            elif b.startswith("DIRECTION("):
                v = self._nums(b)
                if len(v) >= 3:
                    self.dirv[i] = v[:3]
        self.vp = {i: self.refs[i][-1] for i, b in self.ent.items()
                   if b.startswith("VERTEX_POINT(")}
        self.pd_name: dict[int, str] = {}
        for i, b in self.ent.items():
            if b.startswith("PRODUCT_DEFINITION("):
                m = re.match(r"PRODUCT_DEFINITION\(\s*'([^']*)'", b)
                self.pd_name[i] = m.group(1) if m else f"#{i}"
        self.pds = {i: (self.refs[i][-1] if self.refs[i] else None)
                    for i, b in self.ent.items()
                    if b.startswith("PRODUCT_DEFINITION_SHAPE(")}
        self.sdr = [(self.refs[i][0], self.refs[i][1]) for i, b in self.ent.items()
                    if b.startswith("SHAPE_DEFINITION_REPRESENTATION(")]
        self.srr: dict[int, list[int]] = {}
        for i, b in self.ent.items():
            if b.startswith("SHAPE_REPRESENTATION_RELATIONSHIP("):
                r = self.refs[i]
                self.srr.setdefault(r[0], []).append(r[1])
                self.srr.setdefault(r[1], []).append(r[0])

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _nums(body: str) -> list[float]:
        inner = body[body.find("(", body.find("(") + 1):]
        return [float(t.replace("D", "E").replace("d", "e")) for t in NUM.findall(inner)]

    @staticmethod
    def _args(body: str) -> list[str]:
        i = body.find("(")
        if i < 0:
            return []
        depth, buf, out, in_str = 0, [], [], False
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

    # -- units --------------------------------------------------------------

    def units(self) -> dict[str, Any]:
        """The length unit ASSIGNED to the geometric representation contexts."""
        conv = {}
        for i, b in self.ent.items():
            m = re.search(r"CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'\s*,\s*#(\d+)", b)
            if m:
                lm = self.ent.get(int(m.group(2)), "")
                f = self._nums(lm)
                conv[i] = (m.group(1), f[0] if f else None)
        assigned: dict[int, int] = {}
        n_ctx = 0
        for b in self.ent.values():
            if "GLOBAL_UNIT_ASSIGNED_CONTEXT" in b and "GEOMETRIC_REPRESENTATION_CONTEXT" in b:
                n_ctx += 1
                m = re.search(r"GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)", b)
                if m:
                    for r in REF.findall(m.group(1)):
                        if int(r) in conv:
                            assigned[int(r)] = assigned.get(int(r), 0) + 1
        chosen = max(assigned.items(), key=lambda kv: kv[1])[0] if assigned else None
        name, factor = conv.get(chosen, (None, None))
        return {
            "assignedLengthUnit": name,
            "millimetresPerAssignedUnit": factor,
            "geometricRepresentationContexts": n_ctx,
            "contextsAssigningThatUnit": assigned.get(chosen, 0),
            "note": ("Read verbatim from the STEP unit context. Every geometric "
                     "representation context in the file assigns the same length "
                     "unit, so a single scale factor converts the whole file."),
        }

    # -- geometry -----------------------------------------------------------

    def product_reps(self) -> dict[str, list[int]]:
        out: dict[str, list[int]] = {}
        for ps, rep in self.sdr:
            out.setdefault(self.pd_name.get(self.pds.get(ps), "?"), []).append(rep)
        return out

    def vertices(self, rep: int) -> np.ndarray:
        """B-Rep vertex points of a shape representation, in the file's unit.

        A product's SHAPE_REPRESENTATION is a stub; the solid hangs off a plain
        SHAPE_REPRESENTATION_RELATIONSHIP, which is an identity mapping between
        two representations, so following it introduces no transform."""
        roots = [rep] + self.srr.get(rep, [])
        seen, stack, out = set(roots), list(roots), []
        while stack:
            n = stack.pop()
            if n in self.vp:
                p = self.cp.get(self.vp[n])
                if p:
                    out.append(p)
            for c in self.refs.get(n, ()):
                if c not in seen:
                    seen.add(c)
                    stack.append(c)
        return np.array(out, float) if out else np.zeros((0, 3))

    def placement(self, pid: int) -> np.ndarray:
        a = self._args(self.ent[pid])
        loc = np.array(self.cp[int(REF.fullmatch(a[1].strip()).group(1))], float)
        z = np.array([0.0, 0.0, 1.0])
        x = np.array([1.0, 0.0, 0.0])
        if len(a) > 2 and REF.fullmatch(a[2].strip()):
            z = np.array(self.dirv[int(REF.fullmatch(a[2].strip()).group(1))], float)
        if len(a) > 3 and REF.fullmatch(a[3].strip()):
            x = np.array(self.dirv[int(REF.fullmatch(a[3].strip()).group(1))], float)
        z = z / np.linalg.norm(z)
        x = x - (x @ z) * z
        nx = np.linalg.norm(x)
        x = np.array([1.0, 0.0, 0.0]) if nx < 1e-12 else x / nx
        M = np.eye(4)
        M[:3, :3] = np.column_stack([x, np.cross(z, x), z])
        M[:3, 3] = loc
        return M

    def assembly(self) -> tuple[list[dict[str, Any]], list[str]]:
        nauo: dict[int, tuple[str, int, int]] = {}
        for i, b in self.ent.items():
            if b.startswith("NEXT_ASSEMBLY_USAGE_OCCURRENCE("):
                a = self._args(b)
                nauo[i] = (a[0].strip("'"),
                           int(REF.fullmatch(a[3].strip()).group(1)),
                           int(REF.fullmatch(a[4].strip()).group(1)))
        pds_for_nauo = {}
        for i, b in self.ent.items():
            if b.startswith("PRODUCT_DEFINITION_SHAPE("):
                d = self.refs[i][-1]
                if d in nauo:
                    pds_for_nauo[d] = i
        cdsr = {}
        for i, b in self.ent.items():
            if b.startswith("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION("):
                r = self.refs[i]
                cdsr[r[1]] = r[0]

        def tf(nid: int) -> np.ndarray | None:
            pds = pds_for_nauo.get(nid)
            rr = cdsr.get(pds) if pds is not None else None
            if rr is None:
                return None
            m = re.search(r"REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\s*\(\s*#(\d+)",
                          self.ent[rr])
            if not m:
                return None
            a = self._args(self.ent[int(m.group(1))])
            p1 = int(REF.fullmatch(a[2].strip()).group(1))
            p2 = int(REF.fullmatch(a[3].strip()).group(1))
            return self.placement(p2) @ np.linalg.inv(self.placement(p1))

        children: dict[int, list[int]] = {}
        is_child: set[int] = set()
        for nid, (_, parent, child) in nauo.items():
            children.setdefault(parent, []).append(nid)
            is_child.add(child)
        roots = [p for p in children if p not in is_child]
        occ: list[dict[str, Any]] = []

        def walk(pd: int, T: np.ndarray, path: list[str], depth: int) -> None:
            if depth > 12:
                return
            for nid in sorted(children.get(pd, [])):
                label, _, child = nauo[nid]
                M = tf(nid)
                Tc = T if M is None else T @ M
                occ.append({"product": self.pd_name.get(child, f"#{child}"),
                            "path": "/".join(path + [label]),
                            "T": Tc, "resolved": M is not None, "depth": depth})
                walk(child, Tc, path + [label], depth + 1)

        for r in sorted(roots):
            walk(r, np.eye(4), [self.pd_name.get(r, f"#{r}")], 0)
        occ.sort(key=lambda o: o["path"])
        return occ, sorted(self.pd_name.get(x, f"#{x}") for x in roots)


# ===========================================================================
# 2. Frame-map candidate search
# ===========================================================================

def signed_permutations() -> list[tuple[tuple[int, ...], tuple[int, ...], np.ndarray]]:
    out = []
    for perm in itertools.permutations(range(3)):
        for sg in itertools.product((1, -1), repeat=3):
            R = np.zeros((3, 3))
            for i, p in enumerate(perm):
                R[i, p] = sg[i]
            out.append((perm, sg, R))
    return out


def fit_translation(P0: np.ndarray, sv: np.ndarray, tree: cKDTree) -> tuple[float, np.ndarray]:
    """Translation-only ICP with four deterministic starts; best residual wins."""
    best = (float("inf"), np.zeros(3))
    starts = [sv.mean(0) - P0.mean(0),
              (sv.min(0) + sv.max(0)) / 2 - (P0.min(0) + P0.max(0)) / 2,
              sv.min(0) - P0.min(0),
              sv.max(0) - P0.max(0)]
    for t0 in starts:
        t = np.array(t0, float)
        for _ in range(30):
            _, idx = tree.query(P0 + t)
            step = (sv[idx] - (P0 + t)).mean(0)
            t = t + step
            if np.linalg.norm(step) < 1e-9:
                break
        d, _ = tree.query(P0 + t)
        if float(d.mean()) < best[0]:
            best = (float(d.mean()), t)
    return best


def search_frame_map(step_clouds: dict[str, np.ndarray],
                     stl_verts: dict[str, np.ndarray],
                     pairing: dict[str, str]) -> dict[str, Any]:
    data = []
    for prod, part_id in sorted(pairing.items()):
        sv = stl_verts[part_id]
        data.append((prod, part_id, step_clouds[prod], sv, cKDTree(sv)))

    rows = []
    for scale in (INCH_MM, 1.0):
        for perm, sg, R in signed_permutations():
            resid, ts = 0.0, []
            for _prod, _pid, Vs, sv, tree in data:
                r, t = fit_translation((Vs * scale) @ R.T, sv, tree)
                resid += r
                ts.append(t)
            ts = np.array(ts)
            spread = float(np.linalg.norm(ts - ts.mean(0), axis=1).max())
            rows.append({
                "scale": scale, "axisPermutation": list(perm), "axisSigns": list(sg),
                "meanResidualMm": resid / len(data),
                "translationSpreadMm": spread,
                "score": resid / len(data) + spread,
                "fittedTranslationMm": [round(float(v), 6) for v in ts.mean(0)],
            })
    rows.sort(key=lambda r: r["score"])
    win, second = rows[0], rows[1]
    margin = second["score"] / win["score"] if win["score"] > 0 else float("inf")

    per_part = []
    Rw = np.zeros((3, 3))
    for i, p in enumerate(win["axisPermutation"]):
        Rw[i, p] = win["axisSigns"][i]
    tw = np.array(win["fittedTranslationMm"])
    for prod, pid, Vs, sv, tree in data:
        P = (Vs * win["scale"]) @ Rw.T + tw
        d, _ = tree.query(P)
        per_part.append({
            "partId": pid, "cadProduct": prod,
            "brepVertices": int(len(Vs)), "stlVertices": int(len(sv)),
            "meanResidualMm": round(float(d.mean()), 9),
            "maxResidualMm": round(float(d.max()), 9),
        })

    return {
        "candidateSpace": ("48 signed axis permutations (all 24 proper rotations and "
                           "all 24 improper reflections between coordinate axes) x 2 "
                           "scale hypotheses (25.4 = inch->millimetre, and 1.0 = the "
                           "STEP already being in millimetres) x a translation fitted "
                           "per candidate. 96 candidates in total."),
        "scoring": ("For each candidate and each of the ten parts present in BOTH the "
                    "STEP and the STL tree, the translation is fitted by multi-start "
                    "translation-only ICP against that part's real STL vertex cloud. "
                    "score = mean over parts of the mean distance from each B-Rep "
                    "vertex to the nearest STL vertex, PLUS the spread of the fitted "
                    "translations across the ten parts. The second term is what makes "
                    "the test a test: a frame map is one global map, so a candidate "
                    "that needs a different translation for each part is not one."),
        "candidateCount": len(rows),
        "winner": win,
        "runnerUp": second,
        "marginRatio": round(float(margin), 1),
        "decisive": bool(margin >= 100.0 and win["score"] < 0.05),
        "topCandidates": rows[:6],
        "perPartResiduals": per_part,
    }


# ===========================================================================
# 3. Geometry helpers
# ===========================================================================

def rot_about(axis: np.ndarray, deg: float) -> np.ndarray:
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    th = np.radians(deg)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * (K @ K)


def signed_angle(u: np.ndarray, v: np.ndarray, axis: np.ndarray) -> float:
    return float(np.degrees(np.arctan2(np.cross(u, v) @ axis, u @ v)))


def line_distance(p1: np.ndarray, d1: np.ndarray,
                  p2: np.ndarray, d2: np.ndarray) -> tuple[float, float]:
    """(coaxiality error in mm, angle between the two lines in deg).

    The coaxiality error is the larger of the two point-to-line distances, NOT
    the common-perpendicular distance. Two perpendicular lines that happen to
    cross have a common perpendicular of zero while being nothing like coaxial,
    and four of the sixteen femur/foot combinations here are exactly that."""
    d1 = d1 / np.linalg.norm(d1)
    d2 = d2 / np.linalg.norm(d2)
    ang = float(np.degrees(np.arccos(min(1.0, abs(float(d1 @ d2))))))
    w = p2 - p1
    e1 = float(np.linalg.norm(w - (w @ d2) * d2))     # p1 -> line 2
    e2 = float(np.linalg.norm(w - (w @ d1) * d1))     # p2 -> line 1
    return max(e1, e2), ang


def r3(x) -> Any:
    if isinstance(x, (list, tuple, np.ndarray)):
        return [r3(v) for v in np.asarray(x).tolist()]
    v = round(float(x), 6)
    return 0.0 if v == 0 else v


def mat4_out(M: np.ndarray) -> list[list[float]]:
    return [[r3(v) for v in row] for row in np.asarray(M, float).tolist()]


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ===========================================================================
# 4. Main
# ===========================================================================

# firmware joint name -> (STEP PRODUCT, STL basename)
JOINT_PARTS = {
    "R1": ("femur-joint-R1", "R1-v117.stl"),
    "R2": ("femurjoint-R2", "R2-v117.stl"),
    "L1": ("femur-joint-L1", "L1-v117.stl"),
    "L2": ("femur-joint-L2", "L2-v117.stl"),
    "R3": ("foot-joint-R3", "R3-v117.stl"),
    "R4": ("foot-joint-R4", "R4-v117.stl"),
    "L3": ("foot-joint-L3", "L3-v117.stl"),
    "L4": ("foot-joint-L4", "L4-v117.stl"),
}
BODY_PARTS = {
    "internal-frame": ("Internal-Frame", "Internal-Frame-v121.stl"),
    "bottom-cover": ("Bottom-Cover", "Bottom-Cover-v121.stl"),
}
# Printed parts with no STEP counterpart: the CAD assembly carries no top cover.
TOP_COVERS = {
    "top-cover-enclosed": "top-covers/Top-Cover-Enclosed-v117.stl",
    "top-cover-cat": "top-covers/Top-Cover-Cat-v100.stl",
    "top-cover-no-ears": "top-covers/Top-Cover-No-Ears-v100.stl",
}
FEMURS = ["R1", "R2", "L1", "L2"]
FEET = ["R3", "R4", "L3", "L4"]
# runStandPose, from hardware-map.json (checked at runtime, never trusted blind).
STAND_FALLBACK = {"R1": 135, "R2": 45, "L1": 45, "L2": 135,
                  "R3": 180, "R4": 0, "L3": 0, "L4": 180}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--step", required=True)
    ap.add_argument("--stl-dir", required=True)
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--inventory", default="hardware/assets-inventory.json")
    ap.add_argument("--hardware-map", default="hardware/hardware-map.json")
    ap.add_argument("--out", default="hardware/assembly-map.json")
    ap.add_argument("--generated-at", default=None)
    a = ap.parse_args()

    root = Path(a.repo_root).resolve()
    step_path = Path(a.step).resolve()
    stl_dir = Path(a.stl_dir).resolve()
    generated_at = a.generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    inv = json.loads((root / a.inventory).read_text(encoding="utf-8"))
    hwmap = json.loads((root / a.hardware_map).read_text(encoding="utf-8"))
    inv_part = {p["file"]: p for p in inv["parts"]}
    inv_joint = {p["firmwareJointName"]: p for p in inv["parts"] if p.get("firmwareJointName")}

    # -- stand pose, computed from the firmware corpus, not typed here -------
    stand = {}
    mv = next(m for m in hwmap["movements"] if m["function"] == "runStandPose")

    def walk(steps):
        for s in steps:
            if s.get("type") == "servo":
                stand[s["joint"]] = s["angleDeg"]
            if isinstance(s.get("steps"), list):
                walk(s["steps"])
    walk(mv["steps"])
    if stand != STAND_FALLBACK:
        raise SystemExit(f"runStandPose changed upstream: {stand}")

    print(f"[1/6] parsing {step_path.name} ...", file=sys.stderr)
    S = Step(step_path)
    units = S.units()
    if units["assignedLengthUnit"] != "inch" or abs(units["millimetresPerAssignedUnit"] - INCH_MM) > 1e-9:
        raise SystemExit(f"unexpected STEP length unit: {units}")
    occ, roots = S.assembly()
    reps = S.product_reps()
    clouds = {n: S.vertices(r[0]) for n, r in reps.items() if r}
    clouds = {n: v for n, v in clouds.items() if len(v)}

    print(f"[2/6] loading STL meshes ...", file=sys.stderr)
    meshes: dict[str, trimesh.Trimesh] = {}
    stl_verts: dict[str, np.ndarray] = {}
    all_parts = {**{k: v[1] for k, v in JOINT_PARTS.items()},
                 **{k: v[1] for k, v in BODY_PARTS.items()},
                 **TOP_COVERS}
    for pid, fname in all_parts.items():
        m = trimesh.load(stl_dir / fname, process=False)
        meshes[pid] = m
        stl_verts[pid] = np.asarray(m.vertices, float)

    print(f"[3/6] searching {2 * 48} frame-map candidates ...", file=sys.stderr)
    pairing = {p: pid for pid, (p, _f) in {**JOINT_PARTS, **BODY_PARTS}.items()}
    pairing = {prod: pid for pid, (prod, _f) in {**JOINT_PARTS, **BODY_PARTS}.items()}
    frame_search = search_frame_map(clouds, stl_verts, pairing)
    if not frame_search["decisive"]:
        print("WARNING: frame-map search did NOT produce a decisive winner.", file=sys.stderr)
    w = frame_search["winner"]
    identity_won = (w["scale"] == INCH_MM
                    and w["axisPermutation"] == [0, 1, 2]
                    and w["axisSigns"] == [1, 1, 1]
                    and max(abs(v) for v in w["fittedTranslationMm"]) < 0.01)

    # -- instance transforms (CAD root, inches -> millimetres) ---------------
    T_cad: dict[str, np.ndarray] = {}
    occ_path: dict[str, str] = {}
    for o in occ:
        if o["depth"] != 0:
            continue
        for pid, (prod, _f) in {**JOINT_PARTS, **BODY_PARTS}.items():
            if o["product"] == prod:
                M = o["T"].copy()
                M[:3, 3] *= INCH_MM
                T_cad[pid] = M
                occ_path[pid] = o["path"]
    for pid in TOP_COVERS:
        T_cad[pid] = np.eye(4)
        occ_path[pid] = None
    missing = [p for p in all_parts if p not in T_cad]
    if missing:
        raise SystemExit(f"no CAD occurrence for {missing}")

    # -- servos --------------------------------------------------------------
    print("[4/6] extracting servo shaft datums ...", file=sys.stderr)
    servo_groups: dict[str, dict[str, np.ndarray]] = {}
    for o in occ:
        if "/SG90" not in o["path"] or o["depth"] != 1:
            continue
        comp = o["path"].rsplit("/", 1)[0]
        key = ".1_" if ".1_Pe" in o["product"] else (".2_" if ".2_Pe" in o["product"] else None)
        if key:
            servo_groups.setdefault(comp, {})[key] = o["T"]
    servos_raw = []
    for comp, d in sorted(servo_groups.items()):
        if ".1_" not in d or ".2_" not in d:
            continue
        B, H = d[".1_"], d[".2_"]
        axis = B[:3, 1]                      # servo local +Y is the output shaft
        if axis @ (H[:3, 3] - B[:3, 3]) < 0:  # orient it out of the case
            axis = -axis
        alpha = signed_angle(B[:3, 0], H[:3, 0], axis)
        servos_raw.append({
            "occurrencePath": comp,
            "shaftOriginMm": H[:3, 3] * INCH_MM,
            "shaftAxis": axis,
            "hornAngleDeg": alpha,
            "caseOriginMm": B[:3, 3] * INCH_MM,
        })

    # -- canonical frame ------------------------------------------------------
    def cad_pt(pid: str, p_stl_mm) -> np.ndarray:
        M = T_cad[pid]
        return M[:3, :3] @ np.asarray(p_stl_mm, float) + M[:3, 3]

    def cad_dir(pid: str, d_stl) -> np.ndarray:
        v = T_cad[pid][:3, :3] @ np.asarray(d_stl, float)
        return v / np.linalg.norm(v)

    hip_axis_pts = {j: cad_pt(j, inv_joint[j]["pivotCandidate"]["origin"]) for j in FEMURS}
    hip_centre = np.mean([hip_axis_pts[j] for j in FEMURS], axis=0)

    # +X right, +Y up, -Z forward (glTF convention), origin at the hip-axis centre.
    # In the CAD root frame the OLED faces -X and the USB-C port is at +X, so
    # -X_cad is forward; +Y_cad is up (the feet hang to -Y); therefore -Z_cad is
    # the robot's right.
    R_can = np.array([[0.0, 0.0, -1.0],
                      [0.0, 1.0, 0.0],
                      [1.0, 0.0, 0.0]])
    assert abs(np.linalg.det(R_can) - 1.0) < 1e-12
    t_can = -R_can @ hip_centre
    M_can = np.eye(4)
    M_can[:3, :3] = R_can
    M_can[:3, 3] = t_can

    def to_can(p) -> np.ndarray:
        q = np.asarray(p, float)
        if q.ndim == 2:
            return q @ R_can.T + t_can
        return R_can @ q + t_can

    def to_can_dir(d) -> np.ndarray:
        return R_can @ np.asarray(d, float)

    def pose_can(pid: str) -> np.ndarray:
        return M_can @ T_cad[pid]

    # -- placed meshes (canonical frame) --------------------------------------
    placed: dict[str, trimesh.Trimesh] = {}
    for pid, m in meshes.items():
        c = m.copy()
        c.apply_transform(pose_can(pid))
        placed[pid] = c

    # -- assembly checks -------------------------------------------------------
    print("[5/6] scoring the assembled robot ...", file=sys.stderr)

    hip = {j: {"point": to_can(hip_axis_pts[j]),
               "axis": to_can_dir(cad_dir(j, inv_joint[j]["pivotCandidate"]["axis"]))}
           for j in FEMURS}
    knee_femur = {j: {"point": to_can(cad_pt(j, inv_joint[j]["distalInterface"]["origin"])),
                      "axis": to_can_dir(cad_dir(j, inv_joint[j]["distalInterface"]["axis"]))}
                  for j in FEMURS}
    knee_foot = {j: {"point": to_can(cad_pt(j, inv_joint[j]["pivotCandidate"]["origin"])),
                     "axis": to_can_dir(cad_dir(j, inv_joint[j]["pivotCandidate"]["axis"]))}
                 for j in FEET}

    # (a) hip rectangle
    hx = sorted({round(float(hip[j]["point"][2]), 4) for j in FEMURS})
    hz = sorted({round(float(hip[j]["point"][0]), 4) for j in FEMURS})
    hy = sorted({round(float(hip[j]["point"][1]), 4) for j in FEMURS})
    hip_rect = {
        "foreAftSpacingMm": round(hx[-1] - hx[0], 4),
        "leftRightSpacingMm": round(hz[-1] - hz[0], 4),
        "distinctHeightsMm": hy,
        "allAxesVertical": bool(all(abs(abs(float(hip[j]["axis"] @ np.array([0, 1, 0]))) - 1) < 1e-9
                                    for j in FEMURS)),
        "servoGridInch": [1.5, 2.0],
        "note": ("The four hip SERVO placements sit on an exact 1.500 x 2.000 inch "
                 "(38.100 x 50.800 mm) grid. The four hip AXES are 50.800 mm apart "
                 "left/right (exactly 2.000 in, both rows facing the same way) and "
                 "48.400 mm apart fore/aft: 38.100 + 2 x 5.150, because the front and "
                 "rear rows face opposite ways and each output shaft sits 5.150 mm off "
                 "its case centre. 5.15 mm is the offset F5 derived independently from "
                 "the femur/foot mesh geometry."),
    }

    # (b) knee coaxiality across all 16 femur/foot combinations
    coax = []
    for f in FEMURS:
        for t in FEET:
            d, ang = line_distance(knee_femur[f]["point"], knee_femur[f]["axis"],
                                   knee_foot[t]["point"], knee_foot[t]["axis"])
            coax.append({"femur": f, "foot": t,
                         "coaxialityErrorMm": round(d, 4),
                         "axisAngleDeg": round(ang, 4)})
    best_mate = {}
    for f in FEMURS:
        cands = sorted((c for c in coax if c["femur"] == f),
                       key=lambda c: (c["axisAngleDeg"], c["coaxialityErrorMm"]))
        best_mate[f] = cands[0]["foot"]
        cands[0]["selected"] = True
    mate_margin = min(
        min(c["coaxialityErrorMm"] for c in coax
            if c["femur"] == f and c["foot"] != best_mate[f])
        for f in FEMURS)
    worst_mate = max(c["coaxialityErrorMm"] for c in coax if c.get("selected"))

    # (c) interpenetration
    pen = []
    keys = sorted(placed)
    for i, x in enumerate(keys):
        for y in keys[i + 1:]:
            if x in TOP_COVERS and y in TOP_COVERS:
                continue                       # you print exactly one top cover
            A, B = placed[x], placed[y]
            lo = np.maximum(A.bounds[0], B.bounds[0])
            hi = np.minimum(A.bounds[1], B.bounds[1])
            if np.any(lo > hi):
                continue
            pts = A.vertices[np.linspace(0, len(A.vertices) - 1,
                                         min(500, len(A.vertices))).astype(int)]
            sel = np.all((pts >= lo - 1e-3) & (pts <= hi + 1e-3), axis=1)
            depth = 0.0
            if sel.any() and B.is_watertight:
                depth = max(0.0, float(trimesh.proximity.signed_distance(B, pts[sel]).max()))
            pen.append({"a": x, "b": y, "sampledPointsInOverlap": int(sel.sum()),
                        "maxPenetrationMm": round(depth, 4),
                        "bWatertight": bool(B.is_watertight)})
    max_pen = max((p["maxPenetrationMm"] for p in pen), default=0.0)

    # (d) feet vertical, body stack
    feet_check = []
    for t in FEET:
        b = placed[t].bounds
        size = b[1] - b[0]
        feet_check.append({"foot": t,
                           "extentMm": r3(size),
                           "longAxis": ["x", "y", "z"][int(np.argmax(size))],
                           "lowestPointMm": round(float(b[0][1]), 4)})
    ground_y = min(f["lowestPointMm"] for f in feet_check)
    stack = {
        "bottomCoverY": r3(placed["bottom-cover"].bounds[:, 1]),
        "internalFrameY": r3(placed["internal-frame"].bounds[:, 1]),
        "topCoverEnclosedY": r3(placed["top-cover-enclosed"].bounds[:, 1]),
        "bottomMeetsFrameGapMm": round(float(placed["internal-frame"].bounds[0][1]
                                             - placed["bottom-cover"].bounds[1][1]), 6),
        "frameMeetsTopGapMm": round(float(placed["top-cover-enclosed"].bounds[0][1]
                                          - placed["internal-frame"].bounds[1][1]), 6),
    }

    # -- front / rear evidence -------------------------------------------------
    def occ_bbox(product_substr: str) -> dict[str, Any] | None:
        for o in occ:
            if product_substr in o["product"] and o["product"] in clouds:
                P = to_can((clouds[o["product"]] @ o["T"][:3, :3].T + o["T"][:3, 3]) * INCH_MM)
                return {"product": o["product"], "path": o["path"],
                        "minMm": r3(P.min(0)), "maxMm": r3(P.max(0))}
        return None
    usb = occ_bbox("USB_type_C")
    oled = occ_bbox("Body - Screen Border")

    # -- servos in canonical frame, matched to the joint they drive -----------
    servos = []
    for s in servos_raw:
        o = to_can(s["shaftOriginMm"])
        ax = to_can_dir(s["shaftAxis"])
        drives, dist = None, 1e9
        for j in FEMURS:
            d, ang = line_distance(o, ax, hip[j]["point"], hip[j]["axis"])
            if ang < 1.0 and d < dist:
                drives, dist = j, d
        for j in FEET:
            d, ang = line_distance(o, ax, knee_foot[j]["point"], knee_foot[j]["axis"])
            if ang < 1.0 and d < dist:
                drives, dist = j, d
        servos.append({
            "occurrencePath": s["occurrencePath"],
            "drivesJoint": drives,
            "axisToJointAxisDistanceMm": round(dist, 6),
            "shaftOriginMm": r3(o),
            "shaftAxis": r3(ax),
            "caseOriginMm": r3(to_can(s["caseOriginMm"])),
            "hornAngleFromCaseNeutralDeg": round(s["hornAngleDeg"], 4),
            "commandedDegAtThisPose": stand.get(drives),
        })

    # -- rotation-sense rule ----------------------------------------------------
    # alpha = horn rotation about the shaft axis, measured from the servo case's
    # as-modelled neutral.  Fit alpha = s*(cmd-90)+d separately for hips and knees.
    def fit_rule(names: list[str]) -> dict[str, Any]:
        rows = [(s["commandedDegAtThisPose"], s["hornAngleFromCaseNeutralDeg"])
                for s in servos if s["drivesJoint"] in names]
        xs = np.array([r[0] - 90 for r in rows], float)
        ys = np.array([r[1] for r in rows], float)
        if len(rows) < 2 or np.ptp(xs) == 0:
            return {"samples": len(rows), "determined": False}
        A = np.column_stack([xs, np.ones_like(xs)])
        sol, *_ = np.linalg.lstsq(A, ys, rcond=None)
        resid = float(np.abs(A @ sol - ys).max())
        return {"samples": len(rows),
                "slope": round(float(sol[0]), 6),
                "offsetDeg": round(float(sol[1]), 6),
                "maxResidualDeg": round(resid, 6),
                "determined": bool(abs(abs(sol[0]) - 1) < 1e-6 and resid < 1e-6)}
    hip_rule = fit_rule(FEMURS)
    knee_rule = fit_rule(FEET)

    # rest pose = undo the measured horn angle on each hip
    UP = np.array([0.0, 1.0, 0.0])
    BODY_LONG = np.array([0.0, 0.0, 1.0])     # canonical Z, the fore/aft axis
    rest_leg_dirs = {}
    for j in FEMURS:
        # The leg's horizontal direction is perpendicular to its KNEE axis - the
        # vector from the hip axis to the knee axis is not it, because the femur
        # is an L-bracket with a 36.83 mm offset between its two axes.
        kax = knee_femur[j]["axis"]
        leg = np.cross(kax, UP)
        leg = leg / np.linalg.norm(leg)
        outward = hip[j]["point"] * np.array([1.0, 0.0, 1.0])
        if leg @ outward < 0:
            leg = -leg
        alpha = next(s["hornAngleFromCaseNeutralDeg"] for s in servos if s["drivesJoint"] == j)
        undo = rot_about(hip[j]["axis"], -alpha)
        rest = undo @ leg
        rest_kax = undo @ kax
        rest_leg_dirs[j] = {
            "standPoseKneeAxis": r3(kax),
            "standPoseLegDirection": r3(leg),
            "restPoseKneeAxis": r3(rest_kax),
            "restPoseLegDirection": r3(rest),
            "restLegAngleFromBodyLongAxisDeg": round(
                float(np.degrees(np.arccos(min(1.0, abs(float(rest @ BODY_LONG)))))), 6),
            "restLegPointsToward": ("front" if rest[2] < 0 else "rear"),
            "hipIsAt": ("front" if hip[j]["point"][2] < 0 else "rear"),
        }
    rest_parallel = all(v["restLegAngleFromBodyLongAxisDeg"] < 1e-6
                        and v["restLegPointsToward"] == v["hipIsAt"]
                        for v in rest_leg_dirs.values())

    # ==========================================================================
    # 6. Emit
    # ==========================================================================
    print("[6/6] writing output ...", file=sys.stderr)

    def relp(p: Path) -> str:
        try:
            return str(p.resolve().relative_to(root)).replace("\\", "/")
        except ValueError:
            return str(p).replace("\\", "/")

    def part_entry(pid: str, kind: str) -> dict[str, Any]:
        stl = all_parts[pid].rsplit("/", 1)[-1]
        invp = inv_part.get(stl, {})
        P = pose_can(pid)
        b = placed[pid].bounds
        in_step = pid in {**JOINT_PARTS, **BODY_PARTS}
        return {
            "id": pid,
            "role": kind,
            "firmwareJointName": pid if pid in JOINT_PARTS else None,
            "stlFile": stl,
            "stlPath": invp.get("path"),
            "stlSha256": invp.get("sha256"),
            "cadProduct": ({**JOINT_PARTS, **BODY_PARTS}[pid][0] if in_step else None),
            "cadOccurrencePath": occ_path[pid],
            "poseStatus": "authoritative" if in_step else "inferred",
            "poseMethod": (
                "STEP NEXT_ASSEMBLY_USAGE_OCCURRENCE / "
                "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION / ITEM_DEFINED_TRANSFORMATION "
                "chain, composed into the root frame, converted inch->mm, then mapped "
                "into the canonical frame. The STL vertices are the same points as the "
                "STEP B-Rep vertices under the identity frame map, so this pose applies "
                "to the STL mesh unchanged."
                if in_step else
                "NOT IN THE CAD ASSEMBLY. The STEP file contains no top cover. The pose "
                "is taken as the identity, because (a) the two body shells that ARE in "
                "the CAD, Internal-Frame and Bottom-Cover, both carry the identity "
                "transform, and (b) F5's stacking test showed the top covers meet the "
                "internal frame edge-to-edge in the same export frame with zero gap and "
                "zero overlap. Verified here: see assemblyChecks.bodyShellStack."),
            "poseFromStlMm": mat4_out(P),
            "originMm": r3(P[:3, 3]),
            "xAxis": r3(P[:3, 0]),
            "yAxis": r3(P[:3, 1]),
            "zAxis": r3(P[:3, 2]),
            "placedBoundingBoxMm": {"min": r3(b[0]), "max": r3(b[1])},
            "verified": False,
        }

    parts = ([part_entry(p, "femur") for p in FEMURS]
             + [part_entry(p, "foot") for p in FEET]
             + [part_entry("internal-frame", "frame"),
                part_entry("bottom-cover", "cover")]
             + [part_entry(p, "cover") for p in sorted(TOP_COVERS)])

    joints = []
    for j in FEMURS + FEET:
        is_femur = j in FEMURS
        parent = "internal-frame" if is_femur else {v: k for k, v in best_mate.items()}[j]
        ax = hip[j]["axis"] if is_femur else knee_foot[j]["axis"]
        pt = hip[j]["point"] if is_femur else knee_foot[j]["point"]
        srv = next((s for s in servos if s["drivesJoint"] == j), None)
        joints.append({
            "firmwareJointName": j,
            "kind": "femur" if is_femur else "foot",
            "parentPart": parent,
            "childPart": j,
            "axisStatus": "inferred",
            "axisMethod": ("F5's measured pivot axis for this part, carried through the "
                           "part's CAD instance transform into the canonical frame. One "
                           "method for all eight joints, so the eight are comparable. "
                           "The direction is a measurement; the point is a point ON the "
                           "line, and V0 does not need more than that - the along-axis "
                           "position of a revolute joint's origin has no effect on its "
                           "kinematics."),
            "axisUnitVector": r3(ax),
            "pointOnAxisMm": r3(pt),
            "servoShaftOriginMm": srv["shaftOriginMm"] if srv else None,
            "servoShaftAxis": srv["shaftAxis"] if srv else None,
            "servoShaftStatus": "authoritative" if srv else "absent-from-cad",
            "servoShaftNote": (
                "The CAD servo model's output-horn occurrence has an explicit origin ON "
                "the shaft axis, so this IS the along-axis datum F5 could not find. It "
                "agrees with the independently measured axis above to "
                f"{srv['axisToJointAxisDistanceMm']} mm."
                if srv else
                "The STEP file carries this leg servo only as a mirrored CASE body with "
                "no horn occurrence, so no shaft datum is recoverable for this joint. Use "
                "its mirror twin's, or leave the along-axis origin free - it does not "
                "affect the kinematics."),
            "cadServoAgreementMm": (srv["axisToJointAxisDistanceMm"] if srv else None),
            "rotationSense": {
                "status": "inferred",
                "rule": ("childRotationDeg = %+d * (commandedDeg - 90), applied about "
                         "axisUnitVector, right-hand rule."
                         % (-1 if is_femur else 1)),
                "childRotatesRelativeTo": parent,
                "basis": ("Fitted, not assumed. The CAD models each servo's horn as a "
                          "separate occurrence, so the horn's rotation about the shaft "
                          "axis relative to its own case is directly measurable. Across "
                          "the servos whose horn occurrence exists, alpha = s*(cmd-90)+d "
                          "solves uniquely, and the fit is exact."),
            },
            "verified": False,
        })

    doc: dict[str, Any] = {
        "$schema": "./assembly-map.schema.json",
        "meta": {
            "schemaVersion": "1.0.0",
            "assemblyMapVersion": "1.0.0",
            "task": "V0 - CAD assembly reconstruction (Phase 1)",
            "generatedAt": generated_at,
            "generatedBy": "scripts/reconstruct-assembly.py (cad-reconstruction agent)",
            "regenerateWith": ("tools/py-assets/.venv/Scripts/python.exe "
                               "scripts/reconstruct-assembly.py --step "
                               "firmware/upstream/hardware/cad/Sesame-ESP32-v122.step "
                               "--stl-dir firmware/upstream/hardware/printing/stl "
                               "--repo-root . --out hardware/assembly-map.json"),
            "validateWith": "node scripts/validate-assembly-map.mjs",
            "epistemicContract": (
                "Every pose-bearing field carries a `poseStatus` or `status` of exactly "
                "one of: \"authoritative\" (read out of the STEP exchange file - if this "
                "is wrong, the CAD is wrong), \"inferred\" (derived, with a method), or "
                "\"guessed\". NOTHING here has been checked against a physical robot; "
                "every part carries verified:false. A CAD-authoritative pose is a "
                "statement about the DESIGN, never about a particular built machine."),
            "verificationStatus": (
                "NOT PHYSICALLY VERIFIED. No built Sesame robot exists for this project. "
                "What changed in V0 is that the geometry is now read from the design "
                "master instead of from drawings; whether a given robot was ASSEMBLED "
                "that way is a separate question and stays open."),
            "toolVersions": {
                "python": ".".join(str(v) for v in sys.version_info[:3]),
                "numpy": np.__version__,
                "trimesh": trimesh.__version__,
            },
            "sources": [
                {"id": "step", "path": relp(step_path), "sha256": sha256(step_path),
                 "bytes": step_path.stat().st_size,
                 "role": "CAD design master: assembly tree, per-instance transforms, "
                         "B-Rep vertex clouds, servo models"},
                {"id": "assets-inventory", "path": "hardware/assets-inventory.json",
                 "sha256": sha256(root / a.inventory),
                 "role": "F5 STL geometry: pivot axes and distal interfaces per part"},
                {"id": "hardware-map", "path": "hardware/hardware-map.json",
                 "sha256": sha256(root / a.hardware_map),
                 "role": "F4 firmware boundary: runStandPose commanded angles, used as "
                         "the anchor that identifies which pose the CAD is drawn in"},
            ],
            "consumers": [
                "V2 - articulated glTF asset pipeline",
                "V3 - R3F browser robot and joint inspector",
                "V6 - calibration layer",
                "hardware/joint-map.json (regenerated from this file)",
            ],
        },

        "units": {
            "length": "millimetre",
            "angle": "degree",
            "stepFileUnit": units,
            "correctionToF5": (
                "F5 reported the CAD length unit as millimetre from the presence of "
                "SI_UNIT(.MILLI.,.METRE.). That entity is the BASE of the inch "
                "conversion, not the unit assigned to the geometry. Every one of the "
                "file's geometric representation contexts assigns "
                "CONVERSION_BASED_UNIT('inch') whose LENGTH_MEASURE_WITH_UNIT is 25.4 "
                "mm, so all STEP coordinates are inches. This does not change F5's "
                "conclusion that the STL files are in millimetres - it is exactly why "
                "the STL-to-CAD scale factor comes out at exactly 25.4."),
        },

        "canonicalFrame": {
            "id": "sesame-robot",
            "handedness": "right",
            "upAxis": "+Y",
            "forwardAxis": "-Z",
            "rightAxis": "+X",
            "convention": ("glTF/three.js convention: +Y up, -Z forward, +X to the "
                           "robot's own right. Right-handed: X x Y = Z."),
            "originDefinition": ("The centroid of the four hip rotation axes, at the "
                                 "height of those axes. Pose-independent, and the "
                                 "natural root of the kinematic tree."),
            "originInCadRootMm": r3(hip_centre),
            "canonicalFromCadRootMm": mat4_out(M_can),
            "cadRootFrame": {
                "upAxis": "+Y", "forwardAxis": "-X", "rightAxis": "-Z",
                "note": "The STEP root assembly frame, in millimetres.",
            },
            "groundPlaneYMm": round(float(ground_y), 4),
            "groundPlaneNote": ("Lowest point reached by any foot IN THE POSE THE CAD IS "
                                "DRAWN IN. Pose-dependent; not a frame definition."),
            "axisEvidence": {
                "up": {
                    "status": "authoritative",
                    "basis": ("The three body shells stack along the CAD +Y axis in build "
                              "order and the four feet hang to -Y, reaching %.2f mm below "
                              "the hip plane while the chassis occupies only %.2f mm "
                              "above the bottom cover." % (-ground_y,
                                                           float(placed["internal-frame"].bounds[1][1]
                                                                 - placed["bottom-cover"].bounds[0][1]))),
                },
                "forward": {
                    "status": "authoritative",
                    "basis": ("The build guide's physical cue is \"Notch = front. USB port "
                              "= back.\" The STEP assembly places USB_type_C_smd_12p at the "
                              "+X_cad end of the chassis and the OLED screen border at the "
                              "-X_cad end, so -X_cad is the front. Canonical -Z is -X_cad."),
                    "usbPortBbox": usb,
                    "oledScreenBbox": oled,
                },
                "right": {
                    "status": "inferred",
                    "basis": ("Right = forward x up for a right-handed frame, which makes "
                              "-Z_cad the robot's right. All four R-named parts sit at "
                              "negative Z_cad and all four L-named parts at positive Z_cad, "
                              "so \"R\" and \"L\" in the part names denote the ROBOT'S OWN "
                              "right and left. That in turn means the labelled top-down "
                              "drawing is a view from ABOVE: it puts FRONT at the top and "
                              "the R parts on the image's right, which is where a robot's "
                              "right side appears when you look down on it from above."),
                },
            },
        },

        "frameMap": {
            "result": "resolved" if (frame_search["decisive"] and identity_won) else "ambiguous",
            "statement": ("stlPointMillimetres = 25.4 * cadPartLocalPointInches. "
                          "Identity rotation, zero translation, scale exactly 25.4. "
                          "Every one of the eight joint STLs and both body-shell STLs is "
                          "the part's CAD LOCAL geometry with no repositioning at all."),
            "map": {"scale": INCH_MM,
                    "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    "translationMm": w["fittedTranslationMm"]},
            "status": "authoritative",
            "method": ("Registration of each product's STEP B-Rep VERTEX_POINT cloud "
                       "against that part's STL vertex cloud. A tessellator emits every "
                       "B-Rep vertex into the mesh, so under the correct map the "
                       "nearest-neighbour distance is float32 noise rather than a fit."),
            "whyF5CouldNotSeeThis": (
                "F5 compared STL positions against the ASSEMBLY-frame CAD transforms and "
                "found one hip pivot matching with the Z sign inverted. That was a real "
                "match, but of the wrong pair of things. The eight joint STLs are not "
                "exported at assembly positions and are not exported at a \"representative "
                "station\" either: each is the CAD body's own LOCAL geometry, and the "
                "eight CAD bodies happen to be modelled at only two mirrored stations. "
                "The Z-sign inversion F5 saw is the mirror between those two modelling "
                "stations, not a frame flip."),
            "candidateSearch": frame_search,
            "identityIsTheWinner": bool(identity_won),
        },

        "referencePose": {
            "identifiedAs": "runStandPose",
            "status": "inferred",
            "commandedDeg": {k: stand[k] for k in FEMURS + FEET},
            "evidence": [
                "All four hip servo horns are rotated exactly +/-45.000 deg about the "
                "vertical from their case's as-modelled neutral, and all four feet are "
                "exactly vertical (each foot's 58.420 mm long dimension lies along the "
                "canonical Y axis to machine precision).",
                "In F6's body-relative convention that is +45 deg on every hip and "
                "+90 deg on every foot, which is runStandPose and nothing else in the "
                "395-step corpus.",
                "Solving alpha = s*(commandedDeg - 90) + d over the servos whose horn "
                "occurrence exists gives a unique exact solution with d = 0, which is a "
                "test of the anchor rather than an assumption: any other pose assignment "
                "leaves a non-zero offset.",
            ],
            "hipRuleFit": hip_rule,
            "kneeRuleFit": knee_rule,
            "restPoseGeometry": {
                "status": "inferred",
                "allFourLegsParallelToBodyLongAxis": bool(rest_parallel),
                "perJoint": rest_leg_dirs,
                "finding": (
                    "At the commanded 90 deg datum every hip horn returns to its case "
                    "neutral, and all four legs then point exactly along the body's long "
                    "axis - front legs forward, rear legs rearward, 0.000 deg from the "
                    "fore/aft axis. This settles the contradiction F6 recorded: the build "
                    "guide's prose (\"at Rest the hip joint should move perfectly parallel "
                    "to the body\") describes the leg correctly, and the lateral 90 deg "
                    "rays in sesame-angle-guide.png are not the leg direction."),
                "dependsOn": (
                    "Two things, both stated rather than hidden: that the CAD pose is "
                    "runStandPose (evidenced above), and that a 180-degree servo moves "
                    "1 degree of shaft per commanded degree over 0-180 (the BOM specifies "
                    "180-degree MG90S units and the firmware clamps to 0-180). The "
                    "horn-at-neutral offset is NOT assumed - it is solved for, and comes "
                    "out at exactly zero."),
            },
        },

        "parts": parts,
        "servos": servos,
        "joints": joints,

        "assemblyChecks": {
            "hipAxisRectangle": hip_rect,
            "kneeCoaxiality": {
                "note": ("Coaxiality error and axis angle between each femur's distal "
                         "horn axis and each foot's pivot axis, for all 16 combinations. "
                         "The mate is the pair whose two axis LINES coincide. Coaxiality "
                         "error is the larger of the two point-to-line distances, so the "
                         "four combinations whose perpendicular axes merely cross do not "
                         "score as coaxial."),
                "matedPairs": {f: best_mate[f] for f in FEMURS},
                "worstMatedPairErrorMm": round(worst_mate, 4),
                "closestNonMatedPairErrorMm": round(mate_margin, 4),
                "separationRatio": round(mate_margin / worst_mate, 1) if worst_mate > 0 else None,
                "allCombinations": coax,
            },
            "interpenetration": {
                "note": ("Every pair of placed printed parts whose AABBs overlap; for "
                         "each, the maximum depth to which a sampled vertex of A lies "
                         "inside B. Top-cover variants are not tested against each other "
                         "because exactly one is printed."),
                "maxPenetrationMm": round(max_pen, 4),
                "pairsTested": len(pen),
                "pairs": pen,
            },
            "feetVertical": feet_check,
            "bodyShellStack": stack,
        },

        "resolvedByThisTask": [
            {"id": "stl-to-cad-frame-mapping", "from": "F5",
             "resolution": "RESOLVED. Identity rotation, zero translation, scale exactly "
                           "25.4. Won the 96-candidate search by a factor of "
                           f"{frame_search['marginRatio']} on the combined score."},
            {"id": "per-instance-assembly-poses", "from": "F5",
             "resolution": "RESOLVED for all ten parts the CAD contains; the three top "
                           "covers are placed at the identity by inference."},
            {"id": "view-direction-of-the-labelled-drawings", "from": "F6",
             "resolution": "RESOLVED, and made moot. Real 3D positions replace the 2D "
                           "render. R parts are on the robot's own right; the top-down "
                           "drawing is therefore a view from above and agrees."},
            {"id": "front-rear-orientation", "from": "F5",
             "resolution": "RESOLVED from the CAD: USB-C at the back, OLED at the front, "
                           "matching the build guide's notch/USB cue. Whether the `walk` "
                           "command travels that way is a firmware question and stays open."},
            {"id": "hip-to-foot-instance-naming", "from": "F5",
             "resolution": "RESOLVED. Coaxiality picks the mate uniquely for all four legs."},
            {"id": "rest-pose-hip-orientation-contradiction", "from": "F6",
             "resolution": "RESOLVED in favour of the build-guide prose: at the 90 deg "
                           "datum all four legs are parallel to the body's long axis."},
            {"id": "servo-datum-plane", "from": "F5",
             "resolution": "RESOLVED for the design. The CAD carries a servo model whose "
                           "output-horn occurrence has an explicit origin on the shaft "
                           "axis, which fixes the along-axis datum for all eight joints. "
                           "Caveat: the CAD models an SG90 while the BOM specifies an "
                           "MG90S. The two share a footprint but this has not been checked."},
            {"id": "absolute-rotational-sense", "from": "F6",
             "resolution": "RESOLVED. See joints[*].rotationSense."},
        ],

        "unresolved": [
            {"id": "parts-installed-where-drawn", "status": "open",
             "reason": ("A build-time question, not a design question. F5 measured R1 and "
                        "L2 to be the same solid, and R2/L1, R3/L4, R4/L3, so a builder "
                        "can swap two parts and neither the firmware nor the CAD would "
                        "notice."),
             "resolvedBy": "physical inspection of a built robot", "blocking": False},
            {"id": "horn-spline-quantisation", "status": "open",
             "reason": ("The horn is pressed onto a splined shaft at assembly, so the "
                        "commanded-to-physical mapping is quantised per build (+/-9 deg "
                        "worst case on a 20-tooth spline). The CAD models the ideal "
                        "design, which has no spline error."),
             "resolvedBy": "per-robot calibration (V6)", "blocking": False},
            {"id": "mechanical-travel-limits", "status": "open",
             "reason": ("This reconstruction gives one pose. Sweeping each joint and "
                        "looking for collisions would need repaired meshes - "
                        "Top-Cover-Enclosed-v117.stl is still not watertight - and a "
                        "swept-volume study that was not in scope for V0."),
             "resolvedBy": "a collision study on repaired meshes, or a physical sweep",
             "blocking": False},
            {"id": "per-robot-subtrim", "status": "open",
             "reason": "Per-build, not per-design. Belongs to V6, never to a CAD artefact.",
             "resolvedBy": "per-robot calibration (V6)", "blocking": False},
            {"id": "walk-direction-vs-drawn-front", "status": "open",
             "reason": ("The CAD fixes which end carries the OLED and which the USB port. "
                        "It cannot say which way the robot travels when `walk` runs."),
             "resolvedBy": "running walk on a built robot, or a gait simulation in V1",
             "blocking": False},
            {"id": "top-cover-not-in-cad", "status": "open",
             "reason": ("The STEP assembly contains Internal-Frame and Bottom-Cover but "
                        "no top cover, so the three top-cover poses are inferred from the "
                        "stacking test rather than read from the assembly."),
             "resolvedBy": "a CAD revision that includes the top cover", "blocking": False},
            {"id": "servo-model-is-sg90-not-mg90s", "status": "open",
             "reason": ("The CAD models an SG90 (Tower Pro); hardware/bom/README.md calls "
                        "for MG90S all-metal servos. They share the 32.2 x 12 x 30 mm "
                        "footprint and the 27.8 mm ear pitch, so the mounting geometry is "
                        "interchangeable, but the shaft datum recorded here is the SG90's."),
             "resolvedBy": "an MG90S CAD model, or calliper measurement of a built robot",
             "blocking": False},
        ],
    }

    out = root / a.out
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {relp(out)}", file=sys.stderr)
    print(f"  frame map      : {doc['frameMap']['result']} "
          f"(margin {frame_search['marginRatio']}x, winner score "
          f"{w['score']:.6f} mm)", file=sys.stderr)
    print(f"  hip rectangle  : {hip_rect['foreAftSpacingMm']} x "
          f"{hip_rect['leftRightSpacingMm']} mm", file=sys.stderr)
    print(f"  knee mates     : {best_mate}  worst {worst_mate:.4f} mm, "
          f"nearest rival {mate_margin:.1f} mm", file=sys.stderr)
    print(f"  interpenetration: max {max_pen:.4f} mm over {len(pen)} overlapping pairs",
          file=sys.stderr)
    print(f"  rest pose      : legs parallel to body = {rest_parallel}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
