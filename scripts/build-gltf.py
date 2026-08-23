#!/usr/bin/env python3
"""Build the articulated Sesame robot GLB from the printed-part STLs.

Phase 1 task V2.  Consumes:

  * hardware/assembly-map.json  (V0)  - per-part 4x4 pose in the canonical
    `sesame-robot` frame, the eight joint axes, the signed rotation rule, and
    the identification of the CAD pose as `runStandPose`.
  * hardware/joint-map.json     (F6/V0) - JOINT_ORDER, semantic aliases.
  * hardware/assets-inventory.json (F5) - triangle counts and watertightness,
    used only as a cross-check on what is read off disk.
  * firmware/upstream/hardware/printing/stl/*.stl - the geometry.
  * firmware/upstream/hardware/cad/Sesame-ESP32-v122.step - the OLED module
    placement (the only thing here not already in the assembly map).

Produces `assets/sesame.glb`: a named articulated hierarchy whose REST pose is
the neutral pose (every servo commanded 90 deg), so that

    childRotationDeg = sign * (commandedDeg - 90)

applied as the node's local rotation about the axis recorded in that node's
`extras` reproduces any commanded pose, and `commandedDeg == 90` is the
identity rotation on every joint.

Determinism
-----------
No timestamps, no wall-clock, no dict-order dependence, no RNG.  Two runs over
the same inputs produce a byte-identical GLB; `--check` re-runs the build and
compares the SHA-256 against the file already on disk.

Nothing in this file has been checked against a physical robot.  Every pose it
emits is a statement about the DESIGN, inherited from V0 with V0's confidences
attached; see `extras.epistemicContract` in the output.

Usage
-----
    tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py
    tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np

# --------------------------------------------------------------------------
# Constants that are decisions of THIS task, not measurements.
# --------------------------------------------------------------------------

#: glTF's declared length unit is the metre; every STL and every V0 pose is in
#: millimetres, so the whole model is scaled once, here, on the way out.
MM_PER_UNIT = 1000.0

#: Shading-only vertex weld.  Face normals within this angle of each other at a
#: shared position are averaged into one vertex normal; sharper edges get split
#: vertices.  This changes NO vertex POSITION - the exported positions are the
#: STL's own float32 values - so it cannot move a pivot or a mating face.
SMOOTHING_ANGLE_DEG = 35.0

#: The recommended top cover, `Top-Cover-Enclosed-v117.stl`, is not watertight
#: (10 disjoint bodies, no volume - ISSUE-20260823-006 / F5).  `Cat` is the
#: same cover with cat ears instead of stubby ears, is watertight, and shares
#: the recommended cover's footprint.  See docs/findings/V2-gltf-pipeline.md.
TOP_COVER_PART_ID = "top-cover-cat"
TOP_COVER_SUBSTITUTED_FOR = "top-cover-enclosed"

#: Hip nodes first, then the feet they carry.  Fixed so node indices are
#: stable; the firmware's own servo-channel order is JOINT_ORDER and is
#: recorded per node as `extras.firmwareIndex`.
HIP_ORDER = ("R1", "R2", "L1", "L2")
FOOT_ORDER = ("R3", "R4", "L3", "L4")

GENERATOR = "sesame-lab scripts/build-gltf.py (Phase 1 V2, asset-pipeline agent)"


# --------------------------------------------------------------------------
# Small linear-algebra helpers
# --------------------------------------------------------------------------

def rot_axis(axis: np.ndarray, deg: float) -> np.ndarray:
    """3x3 rotation of `deg` about a unit `axis`, right-hand rule."""
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    x, y, z = a
    c, s, t = math.cos(math.radians(deg)), math.sin(math.radians(deg)), 1.0 - math.cos(math.radians(deg))
    return np.array([
        [t * x * x + c,     t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c,     t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ])


def rot_about_line(axis: np.ndarray, point: np.ndarray, deg: float) -> np.ndarray:
    """4x4 rotation of `deg` about the line through `point` along `axis`."""
    R = rot_axis(axis, deg)
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = np.asarray(point, float) - R @ np.asarray(point, float)
    return M


def translate(t: np.ndarray) -> np.ndarray:
    M = np.eye(4)
    M[:3, 3] = np.asarray(t, float)
    return M


def apply(M: np.ndarray, P: np.ndarray) -> np.ndarray:
    """Apply a 4x4 to an (n,3) point array."""
    return P @ M[:3, :3].T + M[:3, 3]


def quat_from_matrix(R: np.ndarray) -> list[float]:
    """glTF quaternion order (x, y, z, w) from a proper rotation matrix."""
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2.0
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2.0
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2.0
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w], float)
    q = q / np.linalg.norm(q)
    if q[3] < 0:                     # canonical sign, so the bytes are stable
        q = -q
    return [round(float(v), 12) + 0.0 for v in q]   # + 0.0 normalises -0.0


def r(x: Any, nd: int = 9) -> Any:
    """Round for JSON, so tiny float noise cannot make the output unstable."""
    if isinstance(x, (list, tuple, np.ndarray)):
        return [r(v, nd) for v in np.asarray(x).tolist()]
    return round(float(x), nd)


# --------------------------------------------------------------------------
# Binary STL reader
# --------------------------------------------------------------------------

def read_binary_stl(path: Path) -> np.ndarray:
    """Return an (n, 3, 3) float64 array of triangle corners, in millimetres.

    Deliberately hand-rolled rather than via trimesh: no welding tolerance, no
    normal repair, no vertex reordering.  The exported positions are then the
    STL's own float32 values, exactly, which is what makes V0's poses apply
    unchanged.
    """
    raw = path.read_bytes()
    if len(raw) < 84:
        raise ValueError(f"{path}: too short to be a binary STL")
    n = struct.unpack_from("<I", raw, 80)[0]
    if len(raw) < 84 + n * 50:
        raise ValueError(f"{path}: declares {n} triangles but is only {len(raw)} bytes")
    block = np.frombuffer(raw, dtype=np.uint8, count=n * 50, offset=84).reshape(n, 50)
    tri = block[:, :48].copy().view("<f4").reshape(n, 4, 3)[:, 1:, :]
    return tri.astype(np.float64)


def build_mesh(tri: np.ndarray, xform: np.ndarray) -> dict[str, np.ndarray]:
    """Weld an STL soup into an indexed mesh with angle-split vertex normals.

    Positions are transformed by `xform` (part-STL millimetres -> node-local
    millimetres) and are otherwise untouched.  Vertices are shared only where
    the incident faces agree in normal to within SMOOTHING_ANGLE_DEG, so hard
    CAD edges stay hard and faceted fillets shade smoothly.
    """
    nfaces = len(tri)
    verts = tri.reshape(-1, 3)
    uniq, inv = np.unique(verts, axis=0, return_inverse=True)
    inv = np.asarray(inv).reshape(nfaces, 3)

    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    safe = np.where(area2 == 0.0, 1.0, area2)
    fnorm = cross / safe[:, None]

    incident: dict[int, list[int]] = {}
    for fi in range(nfaces):
        for k in range(3):
            incident.setdefault(int(inv[fi, k]), []).append(fi)

    cos_t = math.cos(math.radians(SMOOTHING_ANGLE_DEG))
    out_pos: list[np.ndarray] = []
    out_nrm: list[np.ndarray] = []
    # (vertex, face) -> emitted index
    slot: dict[tuple[int, int], int] = {}

    for vi in sorted(incident):
        clusters: list[list[int]] = []
        for fi in incident[vi]:                      # already in face order
            placed = False
            for cl in clusters:
                if float(fnorm[fi] @ fnorm[cl[0]]) >= cos_t:
                    cl.append(fi)
                    placed = True
                    break
            if not placed:
                clusters.append([fi])
        for cl in clusters:
            acc = (fnorm[cl] * area2[cl][:, None]).sum(axis=0)
            ln = float(np.linalg.norm(acc))
            nrm = fnorm[cl[0]] if ln < 1e-12 else acc / ln
            idx = len(out_pos)
            out_pos.append(uniq[vi])
            out_nrm.append(nrm)
            for fi in cl:
                slot[(vi, fi)] = idx

    indices = np.empty((nfaces, 3), dtype=np.uint32)
    for fi in range(nfaces):
        for k in range(3):
            indices[fi, k] = slot[(int(inv[fi, k]), fi)]

    P = apply(xform, np.array(out_pos, float))
    N = np.array(out_nrm, float) @ xform[:3, :3].T
    N = N / np.linalg.norm(N, axis=1, keepdims=True)
    return {
        "position": (P / MM_PER_UNIT).astype("<f4"),
        "normal": N.astype("<f4"),
        "indices": indices.reshape(-1),
        "triangles": nfaces,
    }


# --------------------------------------------------------------------------
# GLB assembly
# --------------------------------------------------------------------------

class GlbBuilder:
    """Minimal, deterministic glTF 2.0 / GLB writer."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.buffer_views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []
        self.meshes: list[dict[str, Any]] = []
        self.nodes: list[dict[str, Any]] = []
        self.materials: list[dict[str, Any]] = []

    def _view(self, data: bytes, target: int | None) -> int:
        while len(self.buf) % 4:
            self.buf.append(0)
        off = len(self.buf)
        self.buf.extend(data)
        v: dict[str, Any] = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            v["target"] = target
        self.buffer_views.append(v)
        return len(self.buffer_views) - 1

    def add_vec3(self, arr: np.ndarray, with_bounds: bool) -> int:
        view = self._view(arr.tobytes(), 34962)
        acc: dict[str, Any] = {"bufferView": view, "componentType": 5126,
                               "count": int(len(arr)), "type": "VEC3"}
        if with_bounds:
            acc["min"] = [float(v) for v in np.round(arr.min(axis=0).astype(np.float64), 9)]
            acc["max"] = [float(v) for v in np.round(arr.max(axis=0).astype(np.float64), 9)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_vec2(self, arr: np.ndarray) -> int:
        view = self._view(arr.tobytes(), 34962)
        self.accessors.append({"bufferView": view, "componentType": 5126,
                               "count": int(len(arr)), "type": "VEC2"})
        return len(self.accessors) - 1

    def add_indices(self, idx: np.ndarray) -> int:
        if int(idx.max(initial=0)) < 65536:
            data, ctype = idx.astype("<u2"), 5123
        else:
            data, ctype = idx.astype("<u4"), 5125
        view = self._view(data.tobytes(), 34963)
        self.accessors.append({"bufferView": view, "componentType": ctype,
                               "count": int(len(idx)), "type": "SCALAR"})
        return len(self.accessors) - 1

    def add_material(self, name: str, base: list[float], rough: float,
                     metal: float = 0.0) -> int:
        self.materials.append({
            "name": name,
            "pbrMetallicRoughness": {
                "baseColorFactor": base,
                "metallicFactor": metal,
                "roughnessFactor": rough,
            },
        })
        return len(self.materials) - 1

    def add_mesh(self, name: str, m: dict[str, np.ndarray], material: int,
                 uv: np.ndarray | None = None) -> int:
        attrs = {
            "POSITION": self.add_vec3(m["position"], True),
            "NORMAL": self.add_vec3(m["normal"], False),
        }
        if uv is not None:
            attrs["TEXCOORD_0"] = self.add_vec2(uv)
        prim = {"attributes": attrs, "indices": self.add_indices(m["indices"]),
                "material": material, "mode": 4}
        self.meshes.append({"name": name, "primitives": [prim]})
        return len(self.meshes) - 1

    def add_node(self, name: str, *, mesh: int | None = None,
                 translation: list[float] | None = None,
                 rotation: list[float] | None = None,
                 children: list[int] | None = None,
                 extras: dict[str, Any] | None = None) -> int:
        n: dict[str, Any] = {"name": name}
        if translation is not None and any(abs(v) > 0 for v in translation):
            n["translation"] = translation
        if rotation is not None:
            n["rotation"] = rotation
        if mesh is not None:
            n["mesh"] = mesh
        if children:
            n["children"] = children
        if extras:
            n["extras"] = extras
        self.nodes.append(n)
        return len(self.nodes) - 1

    def write(self, path: Path, scene: dict[str, Any], asset_extras: dict[str, Any]) -> bytes:
        gltf: dict[str, Any] = {
            "asset": {"version": "2.0", "generator": GENERATOR, "extras": asset_extras},
            "scene": 0,
            "scenes": [scene],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.buf)}],
        }
        js = json.dumps(gltf, ensure_ascii=True, separators=(",", ":"),
                        allow_nan=False).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        bin_ = bytes(self.buf) + b"\x00" * ((4 - len(self.buf) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(bin_)
        out = bytearray()
        out += struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<II", len(js), 0x4E4F534A) + js
        out += struct.pack("<II", len(bin_), 0x004E4942) + bin_
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(out))
        return bytes(out)


# --------------------------------------------------------------------------
# The OLED screen plane, read out of the STEP
# --------------------------------------------------------------------------

def oled_screen_frame(repo: Path, canonical_from_cad: np.ndarray) -> dict[str, Any]:
    """Locate the OLED's visible glass window in the canonical frame.

    The CAD models the display as a library part `Display_OLED_0.96_128x64`
    whose `Body - Screen Border` is a rectangular annulus lying on the front
    face of the glass: the OUTER rectangle is the module bezel, the INNER
    rectangle is the visible window.  Both are read here, exactly, out of the
    STEP B-Rep; nothing about the window is guessed.

    What IS a decision of this task: the CAD library part does not model the
    pixel-active area, so the 128x64 framebuffer target is taken as the 2:1
    rectangle of the window's full width, centred on the window.  Recorded as
    such in the output.
    """
    step = repo / "firmware/upstream/hardware/cad/Sesame-ESP32-v122.step"
    if not step.is_file():
        raise SystemExit(f"missing STEP file: {step}")
    spec = importlib.util.spec_from_file_location(
        "_sesame_recon", repo / "scripts" / "reconstruct-assembly.py")
    assert spec and spec.loader
    recon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recon)

    S = recon.Step(step)
    occ, _roots = S.assembly()
    reps = S.product_reps()

    target = [o for o in occ
              if o["product"] == "Body - Screen Border" and "Display_OLED" in o["path"]]
    if len(target) != 1:
        raise SystemExit(f"expected exactly one OLED screen border occurrence, got {len(target)}")
    o = target[0]
    pts = np.vstack([S.vertices(rep) for rep in reps[o["product"]]])
    if len(pts) != 16:
        raise SystemExit(f"screen border should be 16 B-Rep vertices, got {len(pts)}")

    # Vertices in the border's own local frame, in millimetres.
    L = pts * 25.4
    xs = np.unique(np.round(L[:, 0], 6))
    ys = np.unique(np.round(L[:, 1], 6))
    zs = np.unique(np.round(L[:, 2], 6))
    if len(xs) != 4 or len(ys) != 4 or len(zs) != 2:
        raise SystemExit(f"screen border is not the expected annulus: {xs} {ys} {zs}")

    outer_w, outer_h = float(xs[3] - xs[0]), float(ys[3] - ys[0])
    win_w, win_h = float(xs[2] - xs[1]), float(ys[2] - ys[1])
    cx, cy = float((xs[1] + xs[2]) / 2), float((ys[1] + ys[2]) / 2)
    cz = float(zs[1])                       # the outward face of the border

    # Border local -> CAD root (inches) -> millimetres -> canonical.
    T = o["T"]
    Mroot = np.eye(4)
    Mroot[:3, :3] = T[:3, :3]
    Mroot[:3, 3] = T[:3, 3] * 25.4
    M = canonical_from_cad @ Mroot          # border local mm -> canonical mm

    origin = apply(M, np.array([[cx, cy, cz]]))[0]
    R = M[:3, :3]
    # Orthonormalise defensively; the STEP placement is already orthonormal.
    U = R[:, 0] / np.linalg.norm(R[:, 0])
    W = R[:, 2] / np.linalg.norm(R[:, 2])
    V = np.cross(W, U)
    R = np.column_stack([U, V, W])

    return {
        "occurrencePath": o["path"],
        "originMm": origin,
        "rotation": R,
        "windowMm": [win_w, win_h],
        "bezelMm": [outer_w, outer_h],
        "borderWidthMm": round((outer_w - win_w) / 2, 6),
    }


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(repo: Path, out_path: Path) -> dict[str, Any]:
    amap = json.loads((repo / "hardware/assembly-map.json").read_text(encoding="utf-8"))
    jmap = json.loads((repo / "hardware/joint-map.json").read_text(encoding="utf-8"))
    inv = json.loads((repo / "hardware/assets-inventory.json").read_text(encoding="utf-8"))

    parts = {p["id"]: p for p in amap["parts"]}
    joints = {j["firmwareJointName"]: j for j in amap["joints"]}
    ref_cmd = amap["referencePose"]["commandedDeg"]
    canon = amap["canonicalFrame"]
    canonical_from_cad = np.array(canon["canonicalFromCadRootMm"], float)

    joint_order = [j["firmwareName"] for j in jmap["joints"]]
    if sorted(joint_order) != sorted(HIP_ORDER + FOOT_ORDER):
        raise SystemExit(f"joint-map joint set disagrees with this script: {joint_order}")
    semantic = {j["firmwareName"]: j["semanticName"]["value"] for j in jmap["joints"]}
    fw_index = {j["firmwareName"]: j["firmwareIndex"] for j in jmap["joints"]}
    if [joint_order[i] for i in range(8)] != [n for n, _ in
                                              sorted(fw_index.items(), key=lambda kv: kv[1])]:
        raise SystemExit("joint-map firmwareIndex disagrees with its own joint order")
    inv_tris = {p["file"]: p["mesh"]["triangles"] for p in inv["parts"]}

    # -- the signed rotation rule, read out of V0 rather than restated --------
    sign_of: dict[str, int] = {}
    for name, j in joints.items():
        rule = j["rotationSense"]["rule"]
        if rule.startswith("childRotationDeg = -1 *"):
            sign_of[name] = -1
        elif rule.startswith("childRotationDeg = +1 *"):
            sign_of[name] = +1
        else:
            raise SystemExit(f"{name}: unparsable rotation rule {rule!r}")

    def theta(name: str) -> float:
        return sign_of[name] * (float(ref_cmd[name]) - 90.0)

    # -- stand pose (== the CAD's own pose, V0 section 6.4) -------------------
    W_stand = {pid: np.array(parts[pid]["poseFromStlMm"], float) for pid in parts}

    def unit(v: np.ndarray) -> np.ndarray:
        """V0 rounds its axis components to six decimals, which leaves a 3e-7
        error in the norm.  A rotation axis is a direction; renormalising it
        changes no direction and keeps the emitted axes exactly unit."""
        v = np.asarray(v, float)
        return v / np.linalg.norm(v)

    hip_axis = {h: unit(joints[h]["axisUnitVector"]) for h in HIP_ORDER}
    hip_point = {h: np.array(joints[h]["pointOnAxisMm"], float) for h in HIP_ORDER}
    foot_of = {joints[f]["parentPart"]: f for f in FOOT_ORDER}
    hip_of = {f: joints[f]["parentPart"] for f in FOOT_ORDER}
    knee_axis_stand = {f: unit(joints[f]["axisUnitVector"]) for f in FOOT_ORDER}
    knee_point_stand = {f: np.array(joints[f]["pointOnAxisMm"], float) for f in FOOT_ORDER}

    # A hip rotation is about an axis that is fixed in the body, so the hip
    # axis and a point on it are the same at rest as at stand.
    A = {h: rot_about_line(hip_axis[h], hip_point[h], theta(h)) for h in HIP_ORDER}
    B = {f: rot_about_line(knee_axis_stand[f], knee_point_stand[f], theta(f)) for f in FOOT_ORDER}

    W_rest: dict[str, np.ndarray] = {}
    for h in HIP_ORDER:
        W_rest[h] = np.linalg.inv(A[h]) @ W_stand[h]
    for f in FOOT_ORDER:
        h = hip_of[f]
        W_rest[f] = np.linalg.inv(A[h]) @ np.linalg.inv(B[f]) @ W_stand[f]

    knee_axis_rest, knee_point_rest = {}, {}
    for f in FOOT_ORDER:
        Ai = np.linalg.inv(A[hip_of[f]])
        knee_axis_rest[f] = unit(Ai[:3, :3] @ knee_axis_stand[f])
        knee_point_rest[f] = apply(Ai, knee_point_stand[f][None, :])[0]

    # -- check 1: the rest knee axes V0 recorded, recomputed independently ----
    per_hip = amap["referencePose"]["restPoseGeometry"]["perJoint"]
    axis_residual_deg = 0.0
    axis_rows = []
    for f in FOOT_ORDER:
        recorded = unit(per_hip[hip_of[f]]["restPoseKneeAxis"])
        mine = knee_axis_rest[f]
        d = abs(float(np.degrees(math.acos(max(-1.0, min(1.0, float(mine @ recorded)))))))
        axis_residual_deg = max(axis_residual_deg, d)
        axis_rows.append({"joint": f, "hip": hip_of[f], "deg": round(d, 9)})

    # -- geometry -------------------------------------------------------------
    stl_root = repo / "firmware/upstream/hardware/printing/stl"
    tris: dict[str, np.ndarray] = {}
    for pid in list(HIP_ORDER) + list(FOOT_ORDER) + ["internal-frame", "bottom-cover",
                                                     TOP_COVER_PART_ID]:
        p = parts[pid]
        path = repo / p["stlPath"]
        if not path.is_file():
            raise SystemExit(f"missing STL: {path}")
        got = sha256(path)
        if got != p["stlSha256"]:
            raise SystemExit(f"{p['stlFile']}: sha256 {got} != assembly-map {p['stlSha256']}")
        t = read_binary_stl(path)
        if len(t) != inv_tris[p["stlFile"]]:
            raise SystemExit(f"{p['stlFile']}: {len(t)} triangles, F5 recorded "
                             f"{inv_tris[p['stlFile']]}")
        tris[pid] = t

    # Node-local bake: node R1 sits AT the hip axis with identity rotation, so
    # the mesh it carries must be the part's rest-pose geometry pulled back
    # into that frame.  Same for a foot, relative to its own knee axis.
    local_xform: dict[str, np.ndarray] = {}
    for h in HIP_ORDER:
        local_xform[h] = translate(-hip_point[h]) @ W_rest[h]
    for f in FOOT_ORDER:
        local_xform[f] = translate(-knee_point_rest[f]) @ W_rest[f]
    for pid in ("internal-frame", "bottom-cover", TOP_COVER_PART_ID):
        local_xform[pid] = np.array(parts[pid]["poseFromStlMm"], float)

    meshes = {pid: build_mesh(tris[pid], local_xform[pid]) for pid in sorted(tris)}

    # -- check 2: drive the rig to runStandPose and compare with the CAD ------
    # Exact by construction in float64, so this only proves the rig algebra is
    # self-consistent; the honest end-to-end number is the one the validator
    # measures after the GLB's float32 round-trip.
    def posed_world(pid: str, cmds: dict[str, float]) -> np.ndarray:
        if pid in HIP_ORDER:
            th = sign_of[pid] * (cmds[pid] - 90.0)
            local = translate(hip_point[pid]) @ rot_about_line(hip_axis[pid], np.zeros(3), th)
            return local @ local_xform[pid]
        h = hip_of[pid]
        th_h = sign_of[h] * (cmds[h] - 90.0)
        th_k = sign_of[pid] * (cmds[pid] - 90.0)
        hip_local = translate(hip_point[h]) @ rot_about_line(hip_axis[h], np.zeros(3), th_h)
        rel = knee_point_rest[pid] - hip_point[h]
        knee_local = translate(rel) @ rot_about_line(knee_axis_rest[pid], np.zeros(3), th_k)
        return hip_local @ knee_local @ local_xform[pid]

    stand = {k: float(v) for k, v in ref_cmd.items()}
    rig_residual_mm = 0.0
    bbox_residual_mm = 0.0
    for pid in list(HIP_ORDER) + list(FOOT_ORDER):
        Wp = posed_world(pid, stand)
        V = tris[pid].reshape(-1, 3)
        got = apply(Wp, V)
        want = apply(W_stand[pid], V)
        rig_residual_mm = max(rig_residual_mm, float(np.abs(got - want).max()))
        bb = parts[pid]["placedBoundingBoxMm"]
        bbox_residual_mm = max(
            bbox_residual_mm,
            float(np.abs(got.min(axis=0) - np.array(bb["min"], float)).max()),
            float(np.abs(got.max(axis=0) - np.array(bb["max"], float)).max()),
        )

    # -- check 3/4: ground plane and foot verticality, per pose ---------------
    def ground_plane(cmds: dict[str, float]) -> float:
        return min(float(apply(posed_world(f, cmds), tris[f].reshape(-1, 3))[:, 1].min())
                   for f in FOOT_ORDER)

    rest = {k: 90.0 for k in stand}
    ground_stand = ground_plane(stand)
    ground_rest = ground_plane(rest)

    # V0 section 6.4: at runStandPose every foot's 58.420 mm long dimension lies
    # along canonical Y.  Recomputed here: a foot's longest extent in its own STL
    # frame must survive intact as its placed Y extent, which it can only do if
    # the part is exactly vertical.
    foot_vertical_dev_mm = 0.0
    foot_long_mm = []
    for f in FOOT_ORDER:
        local_span = np.ptp(tris[f].reshape(-1, 3), axis=0)
        longest = float(local_span.max())
        P = apply(posed_world(f, stand), tris[f].reshape(-1, 3))
        span_y = float(np.ptp(P, axis=0)[1])
        foot_long_mm.append(round(longest, 4))
        foot_vertical_dev_mm = max(foot_vertical_dev_mm, abs(longest - span_y))

    # ======================================================================
    # Emit
    # ======================================================================
    g = GlbBuilder()
    mat_body = g.add_material("sesame-shell-plastic", [0.839, 0.843, 0.858, 1.0], 0.62)
    mat_femur = g.add_material("sesame-femur-plastic", [0.352, 0.388, 0.470, 1.0], 0.55)
    mat_foot = g.add_material("sesame-foot-plastic", [0.243, 0.267, 0.325, 1.0], 0.55)
    mat_oled = g.add_material("sesame-oled-screen", [0.020, 0.024, 0.031, 1.0], 0.22)

    mesh_id = {
        "internal-frame": g.add_mesh("internal_frame", meshes["internal-frame"], mat_body),
        "bottom-cover": g.add_mesh("bottom_cover", meshes["bottom-cover"], mat_body),
        TOP_COVER_PART_ID: g.add_mesh("top_cover", meshes[TOP_COVER_PART_ID], mat_body),
    }
    for h in HIP_ORDER:
        mesh_id[h] = g.add_mesh(f"{h}_femur", meshes[h], mat_femur)
    for f in FOOT_ORDER:
        mesh_id[f] = g.add_mesh(f"{f}_foot", meshes[f], mat_foot)

    # -- the OLED quad --------------------------------------------------------
    oled = oled_screen_frame(repo, canonical_from_cad)
    win_w, win_h = oled["windowMm"]
    # V2's decision, recorded as such: the 128x64 framebuffer is mapped to the
    # 2:1 rectangle of the window's full width, centred on the window.
    px_w = win_w
    px_h = win_w / 2.0
    hw, hh = px_w / 2.0 / MM_PER_UNIT, px_h / 2.0 / MM_PER_UNIT
    quad_pos = np.array([[-hw, hh, 0.0], [-hw, -hh, 0.0],
                         [hw, -hh, 0.0], [hw, hh, 0.0]], dtype="<f4")
    quad_nrm = np.array([[0.0, 0.0, 1.0]] * 4, dtype="<f4")
    quad_uv = np.array([[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]], dtype="<f4")
    quad_idx = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)
    oled_mesh = g.add_mesh("oled_screen_quad",
                           {"position": quad_pos, "normal": quad_nrm,
                            "indices": quad_idx, "triangles": 2},
                           mat_oled, uv=quad_uv)

    # -- nodes ----------------------------------------------------------------
    prov = {
        "poseSource": "hardware/assembly-map.json (V0)",
        "verified": False,
        "verificationNote": ("NOT PHYSICALLY VERIFIED. Read from the CAD design "
                             "master, never from a built robot."),
    }

    def joint_extras(name: str, axis: np.ndarray, point: np.ndarray,
                     parent: str, kind: str) -> dict[str, Any]:
        return {
            "firmwareName": name,
            "firmwareIndex": fw_index[name],
            "jointKind": kind,
            "linkKind": joints[name]["kind"],
            "parentNode": parent,
            "childNodes": [foot_of[name]] if name in foot_of else [],
            "rotationAxis": r(axis, 9),
            "rotationAxisFrame": ("this node's own local frame, which at rest is "
                                  "axis-aligned with the canonical sesame-robot frame"),
            "pivotOriginMm": r(point, 6),
            "neutralCommandedDeg": 90,
            "signPerCommandedDeg": sign_of[name],
            "rotationRule": (f"childRotationDeg = {sign_of[name]:+d} * (commandedDeg - 90), "
                             "applied as this node's LOCAL rotation about rotationAxis, "
                             "right-hand rule. commandedDeg 90 is the identity."),
            "rotationSenseStatus": joints[name]["rotationSense"]["status"],
            "axisStatus": joints[name]["axisStatus"],
            "semanticNameAlias": semantic[name],
            "semanticNameVerified": False,
            "semanticNameNote": ("An ALIAS only. The authoritative identity of this "
                                 "node is firmwareName + firmwareIndex; V0 corroborated "
                                 "the semantic name from the CAD but it stays "
                                 "verified:false because the CAD cannot say which "
                                 "printed part was bolted where."),
            **prov,
        }

    foot_nodes: dict[str, int] = {}
    for f in FOOT_ORDER:
        foot_nodes[f] = g.add_node(
            f, mesh=mesh_id[f],
            translation=r((knee_point_rest[f] - hip_point[hip_of[f]]) / MM_PER_UNIT, 12),
            extras=joint_extras(f, knee_axis_rest[f], knee_point_rest[f], hip_of[f], "knee"))

    hip_nodes: dict[str, int] = {}
    for h in HIP_ORDER:
        hip_nodes[h] = g.add_node(
            h, mesh=mesh_id[h],
            translation=r(hip_point[h] / MM_PER_UNIT, 12),
            children=[foot_nodes[foot_of[h]]],
            extras=joint_extras(h, hip_axis[h], hip_point[h], "sesame_body", "hip"))

    shell_nodes = [
        g.add_node("body_internal_frame", mesh=mesh_id["internal-frame"],
                   extras={"partId": "internal-frame",
                           "stlFile": parts["internal-frame"]["stlFile"], **prov}),
        g.add_node("body_bottom_cover", mesh=mesh_id["bottom-cover"],
                   extras={"partId": "bottom-cover",
                           "stlFile": parts["bottom-cover"]["stlFile"], **prov}),
        g.add_node("body_top_cover", mesh=mesh_id[TOP_COVER_PART_ID],
                   extras={"partId": TOP_COVER_PART_ID,
                           "stlFile": parts[TOP_COVER_PART_ID]["stlFile"],
                           "substitutedFor": parts[TOP_COVER_SUBSTITUTED_FOR]["stlFile"],
                           "substitutionReason": (
                               "The recommended print, Top-Cover-Enclosed-v117.stl, is NOT "
                               "watertight: 10 disjoint bodies and no enclosed volume "
                               "(F5 / ISSUE-20260823-006). Top-Cover-Cat-v100.stl is the "
                               "same cover with cat ears in place of stubby ears, is "
                               "watertight (5 bodies, all closed) and shares the recommended "
                               "cover's footprint. Shipping the broken mesh would put a "
                               "silently-degenerate solid in front of every viewer."),
                           "poseStatus": parts[TOP_COVER_PART_ID]["poseStatus"], **prov}),
    ]

    oled_node = g.add_node(
        "oled_screen", mesh=oled_mesh,
        translation=r(oled["originMm"] / MM_PER_UNIT, 12),
        rotation=quat_from_matrix(oled["rotation"]),
        extras={
            "role": "128x64 SSD1306 display, texture target for V4",
            "framebufferPx": [128, 64],
            "planeSizeMm": [round(px_w, 6), round(px_h, 6)],
            "uvConvention": (
                "The mesh is a single quad in this node's local z = 0 plane, "
                "spanning x in [-w/2, +w/2] and y in [-h/2, +h/2], with glTF's own "
                "UV origin: TEXCOORD_0 (0,0) is the quad's top-left corner "
                "(x = -w/2, y = +h/2) and (1,1) is bottom-right. Pixel (col 0, row 0) "
                "of the SSD1306 framebuffer therefore lands on the top-left of the "
                "screen as seen by an observer standing in front of the robot."),
            "localAxes": {
                "+X": "the robot's own LEFT, i.e. an observer-facing viewer's RIGHT; texture +U",
                "+Y": "screen up (canonical up, pitched back 20 deg with the module); texture -V",
                "+Z": "out of the screen toward the viewer, the surface normal",
            },
            "screenNormalCanonical": r(oled["rotation"][:, 2], 9),
            "tiltFromVerticalDeg": round(
                float(np.degrees(math.acos(max(-1.0, min(1.0,
                      float(np.array([0.0, 0.0, -1.0]) @ oled["rotation"][:, 2])))))), 6),
            "cadGlassWindowMm": [round(win_w, 6), round(win_h, 6)],
            "cadBezelOuterMm": [round(v, 6) for v in oled["bezelMm"]],
            "cadOccurrencePath": oled["occurrencePath"],
            "planeStatus": "inferred",
            "planeMethod": (
                "The window rectangle is read EXACTLY out of the STEP: "
                "'Body - Screen Border' is a rectangular annulus on the front face of "
                "the glass, so its inner rectangle is the visible window "
                f"({win_w:.2f} x {win_h:.2f} mm) and its outer rectangle the bezel. "
                "What is a DECISION of V2, not a measurement: the CAD library part does "
                "not model the pixel-active area, so the 128x64 target is taken as the "
                "2:1 rectangle of the window's full width, centred on the window. A "
                "real 0.96\" SSD1306's active area is smaller than its glass; if that "
                "ever matters, shrink planeSizeMm and keep this node's frame."),
            **prov,
        })

    body_node = g.add_node("sesame_body",
                           children=shell_nodes + [oled_node] + [hip_nodes[h] for h in HIP_ORDER],
                           extras={
                               "role": ("The chassis: kinematic root and parent of all four "
                                        "hips. Sits at the canonical frame origin with the "
                                        "identity transform, so world space IS the "
                                        "sesame-robot frame (scaled to metres)."),
                               "meshChildren": ["body_internal_frame", "body_bottom_cover",
                                                "body_top_cover"],
                               "originDefinition": canon["originDefinition"],
                               **prov,
                           })

    total_tris = sum(m["triangles"] for m in meshes.values()) + 2
    total_verts = sum(len(m["position"]) for m in meshes.values()) + 4

    asset_extras = {
        "producedBy": "Sesame Lab Phase 1, task V2 (asset-pipeline agent)",
        "regenerateWith": ("tools/py-assets/.venv/Scripts/python.exe "
                           "scripts/build-gltf.py"),
        "validateWith": "node scripts/validate-gltf.mjs",
        "epistemicContract": amap["meta"]["epistemicContract"],
        "verificationStatus": amap["meta"]["verificationStatus"],
        "units": {
            "length": "metre",
            "millimetresPerUnit": MM_PER_UNIT,
            "angle": "degree (all commanded angles and extras); node rotations are "
                     "glTF quaternions",
            "note": ("glTF's declared unit is the metre. Every source millimetre value "
                     "in extras keeps its Mm suffix and is NOT scaled; only vertex "
                     "positions and node translations are."),
        },
        "canonicalFrame": {
            "id": canon["id"],
            "handedness": canon["handedness"],
            "upAxis": canon["upAxis"],
            "forwardAxis": canon["forwardAxis"],
            "rightAxis": canon["rightAxis"],
            "convention": canon["convention"],
            "originDefinition": canon["originDefinition"],
            "note": ("Already glTF's own convention, so no axis conversion was applied "
                     "anywhere in this pipeline. sesame_body carries the identity "
                     "transform, so glTF world space is this frame in metres."),
        },
        "jointOrder": joint_order,
        "jointOrderNote": ("JOINT_ORDER[i] is the joint driven by servo channel i, as "
                           "used by setServoAngle(i, deg). Do not sort it."),
        "restPose": {
            "definition": "every joint commanded 90 deg",
            "nodeRotations": "identity on all eight joint nodes",
            "commandedDeg": {k: 90 for k in joint_order},
        },
        "poseRule": {
            "statement": ("For each joint node: localRotation = "
                          "quaternion(extras.rotationAxis, extras.signPerCommandedDeg * "
                          "(commandedDeg - 90) degrees). Nothing else moves."),
            "signPerCommandedDeg": {k: sign_of[k] for k in joint_order},
            "status": "inferred",
            "basis": ("V0 fitted alpha = s*(commandedDeg - 90) + d over the CAD servo "
                      "horn occurrences; both families solved uniquely and exactly with "
                      "d = 0 (hips s = -1 over 4 samples, knees s = +1 over 2 samples)."),
        },
        "referencePose": {
            "identifiedAs": amap["referencePose"]["identifiedAs"],
            "status": amap["referencePose"]["status"],
            "commandedDeg": ref_cmd,
            "note": ("V0 established that the CAD is drawn in this pose, which is what "
                     "makes it a check rather than an assumption: driving this rig to "
                     "these angles must reproduce the CAD's own part placements."),
        },
        "groundPlane": {
            "method": ("min over the canonical Y of every foot vertex at the pose in "
                       "question. POSE-DEPENDENT: this is not a property of the frame "
                       "and must not be baked in as a constant."),
            "atRunStandPoseMm": round(ground_stand, 6),
            "atRestPoseMm": round(ground_rest, 6),
            "v0RecordedStandMm": canon["groundPlaneYMm"],
            "computeItYourself": ("the four foot meshes are in this file; transform "
                                  "their vertices through the posed node chain and take "
                                  "the minimum Y."),
        },
        "selfChecks": {
            "standPoseReproductionMaxVertexMm": float(f"{rig_residual_mm:.6e}"),
            "standPoseReproductionNote": (
                "Max deviation, over every vertex of all eight moving parts, between "
                "(a) driving this rig from the rest pose with runStandPose's commanded "
                "angles and (b) V0's poseFromStlMm applied directly. Exact by "
                "construction in float64, so it proves the rig algebra self-consistent "
                "and no more; scripts/validate-gltf.mjs measures the same quantity "
                "AFTER the GLB's float32 round-trip, which is the honest number."),
            "placedBoundingBoxMaxDeviationMm": round(bbox_residual_mm, 9),
            "placedBoundingBoxNote": (
                "Same rig, compared against assembly-map's independently recorded "
                "placedBoundingBoxMm. Independent of the pose algebra above."),
            "restKneeAxisMaxDeviationDeg": round(axis_residual_deg, 12),
            "restKneeAxisNote": (
                "The four knee hinge axes at the rest pose, recomputed here by undoing "
                "the hip rotation, against V0's independently recorded "
                "referencePose.restPoseGeometry.perJoint[*].restPoseKneeAxis. This one "
                "is NOT circular: V0 derived those from the CAD servo horns."),
            "restKneeAxisPerJoint": axis_rows,
            "footVerticalityMaxDeviationMm": round(foot_vertical_dev_mm, 9),
            "footLongestDimensionMm": foot_long_mm,
            "footVerticalityNote": (
                "V0 section 6.4 states all four feet are exactly vertical at "
                "runStandPose. Recomputed: each foot's longest extent in its own STL "
                "frame, minus its placed extent along canonical Y at the pose this rig "
                "produces. Zero only if the part is exactly vertical."),
        },
        "meshPolicy": {
            "vertexPositions": ("the STL's own float32 values, rigidly transformed. No "
                                "decimation, no simplification, no quantisation, no "
                                "welding tolerance: a pivot or a mating face cannot have "
                                "moved."),
            "normals": (f"vertex normals area-weighted within a "
                        f"{SMOOTHING_ANGLE_DEG:g} deg smoothing angle; sharper edges get "
                        "split vertices. A shading choice only."),
            "compression": ("none. Draco would need an encoder this project has not "
                            "installed, and KHR_mesh_quantization would push a required "
                            "extension onto V3 for a payload that is already small."),
            "instancing": ("none. F5's four shape-equivalence classes agree only to "
                           "95-97 % of sampled surface points: the residual IS the "
                           "engraved part label, so sharing mesh data between R1 and L2 "
                           "would silently erase the engraving that names them."),
            "triangles": total_tris,
            "vertices": total_verts,
        },
        "forV3": {
            "driveThis": [f"node '{n}'" for n in joint_order],
            "howToDrive": ("set each joint node's local quaternion from extras."
                           "rotationAxis and extras.signPerCommandedDeg; parenting "
                           "already carries a foot with its femur."),
            "worldSpace": "the canonical sesame-robot frame, in metres",
            "doNotAssume": ["a ground plane height (pose-dependent, see groundPlane)",
                            "that semanticNameAlias is verified (it is not)",
                            "that the top cover shown is the recommended print"],
        },
        "knownDiscrepancies": [
            {"id": "servo-model-is-sg90-not-mg90s",
             "detail": ("The CAD models an SG90 (Tower Pro) while hardware/bom/README.md "
                        "calls for an MG90S. This GLB emits NO servo geometry, so nothing "
                        "here depends on it, but the joint axes it inherits from V0 were "
                        "read off the SG90 horn occurrences."),
             "status": "open"},
            {"id": "top-cover-not-in-cad",
             "detail": ("The STEP contains no top cover at all; its pose is V0's "
                        "inference (identity, corroborated by a zero-gap zero-overlap "
                        "shell stack), not a CAD reading."),
             "status": "open"},
            {"id": "front-leg-servo-datum-absent",
             "detail": ("R3 and L3 have no servo horn occurrence in the STEP, so no "
                        "along-axis shaft datum exists for them. Irrelevant to a "
                        "revolute joint's kinematics, and irrelevant here."),
             "status": "open"},
        ],
        "sources": [
            {"path": "hardware/assembly-map.json",
             "sha256": sha256(repo / "hardware/assembly-map.json"),
             "role": "V0 per-part poses, joint axes, rotation rule, reference pose"},
            {"path": "hardware/joint-map.json",
             "sha256": sha256(repo / "hardware/joint-map.json"),
             "role": "JOINT_ORDER and the semantic aliases"},
            {"path": "hardware/assets-inventory.json",
             "sha256": sha256(repo / "hardware/assets-inventory.json"),
             "role": "F5 triangle counts, cross-checked against every STL read here"},
            {"path": "firmware/upstream/hardware/cad/Sesame-ESP32-v122.step",
             "sha256": sha256(repo / "firmware/upstream/hardware/cad/Sesame-ESP32-v122.step"),
             "role": "the OLED module placement only"},
        ] + [
            {"path": parts[pid]["stlPath"], "sha256": parts[pid]["stlSha256"],
             "role": f"geometry for node {pid}"}
            for pid in list(HIP_ORDER) + list(FOOT_ORDER)
        ] + [
            {"path": parts[pid]["stlPath"], "sha256": parts[pid]["stlSha256"],
             "role": f"geometry for the {pid} shell"}
            for pid in ("internal-frame", "bottom-cover", TOP_COVER_PART_ID)
        ],
    }

    scene = {"name": "sesame-robot", "nodes": [body_node]}
    data = g.write(out_path, scene, asset_extras)

    return {
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "triangles": total_tris,
        "vertices": total_verts,
        "standPoseReproductionMaxVertexMm": rig_residual_mm,
        "placedBoundingBoxMaxDeviationMm": bbox_residual_mm,
        "restKneeAxisMaxDeviationDeg": axis_residual_deg,
        "groundPlaneStandMm": ground_stand,
        "groundPlaneRestMm": ground_rest,
        "topCover": parts[TOP_COVER_PART_ID]["stlFile"],
        "oledWindowMm": oled["windowMm"],
        "oledPlaneMm": [px_w, px_h],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    ap.add_argument("--out", default=None, help="default: <repo>/assets/sesame.glb")
    ap.add_argument("--check", action="store_true",
                    help="rebuild and fail if the SHA-256 differs from the file on disk")
    a = ap.parse_args()

    repo = Path(a.repo_root).resolve()
    out = Path(a.out) if a.out else repo / "assets" / "sesame.glb"

    prior = hashlib.sha256(out.read_bytes()).hexdigest() if out.is_file() else None
    if a.check and prior is None:
        print(f"FAIL  {out} does not exist", file=sys.stderr)
        return 1

    res = build(repo, out)

    print(f"wrote {out.relative_to(repo) if out.is_relative_to(repo) else out}")
    print(f"  {res['bytes']:,} bytes   sha256 {res['sha256']}")
    print(f"  {res['triangles']:,} triangles / {res['vertices']:,} vertices")
    print(f"  top cover                            {res['topCover']}")
    print(f"  stand-pose reproduction (float64)    {res['standPoseReproductionMaxVertexMm']:.3e} mm")
    print(f"  placed-bbox vs assembly-map          {res['placedBoundingBoxMaxDeviationMm']:.3e} mm")
    print(f"  rest knee axis vs V0                 {res['restKneeAxisMaxDeviationDeg']:.3e} deg")
    print(f"  ground plane  stand {res['groundPlaneStandMm']:.4f} mm   rest {res['groundPlaneRestMm']:.4f} mm")
    print(f"  OLED CAD window {res['oledWindowMm'][0]:.2f} x {res['oledWindowMm'][1]:.2f} mm"
          f"  ->  128x64 plane {res['oledPlaneMm'][0]:.2f} x {res['oledPlaneMm'][1]:.2f} mm")

    if a.check:
        if prior != res["sha256"]:
            print(f"FAIL  non-deterministic: was {prior}, now {res['sha256']}", file=sys.stderr)
            return 1
        print("  determinism: OK (byte-identical rebuild)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
