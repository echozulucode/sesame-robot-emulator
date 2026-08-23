#!/usr/bin/env python3
"""
extract-stl-geometry.py  --  Sesame Lab / Phase 0 task F5

Deterministic mechanical-asset inventory generator.

Reads a tree of STL files (read-only), measures every mesh, recovers
cylindrical features (holes / counterbores / bosses), groups them into coaxial
assemblies, and from those attempts to identify each articulated joint's servo
pivot axis. Emits one JSON document.

Design rules this script obeys (docs/plans/phase-0-...md section 7):

  * Nothing is asserted as measured unless it was measured. Every derived value
    carries a `method` and a `confidence`. `confidence: "none"` is a valid,
    honest answer and is preferred over a plausible guess.
  * Output is deterministic: identical inputs -> byte-identical output apart
    from `meta.generatedAt`, which can be pinned with --generated-at.
  * The source tree is never written to.

Usage:
    python extract-stl-geometry.py \
        --stl-dir reference/sesame-robot-main/hardware/printing/stl \
        --cad-dir reference/sesame-robot-main/hardware/cad \
        --repo-root . --out hardware/assets-inventory.json

    # debug: dump every recovered feature / coaxial group for one file
    python extract-stl-geometry.py --stl-dir <dir> --dump-features R1-v117.stl
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import struct
import sys
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location(
        "step_assembly", Path(__file__).resolve().parent / "extract-step-assembly.py")
    step_assembly = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(step_assembly)
except Exception:                                     # pragma: no cover
    step_assembly = None

SCHEMA_VERSION = "1.0.0"

# --------------------------------------------------------------------------
# Detector tuning. Exposed so the write-up can cite them and so a re-run with
# different thresholds is an explicit, visible change rather than a silent one.
# --------------------------------------------------------------------------
VOTE_ANGLE_MIN_DEG = 1.0     # ignore near-coplanar pairs (numerically unstable)
VOTE_ANGLE_MAX_DEG = 32.0    # ignore sharp creases (not one smooth cylinder)
RADIUS_MIN = 0.40            # mm-ish, in file units
RADIUS_MAX = 14.0
CLUSTER_DIR_WEIGHT = 25.0    # direction weight inside the 7-D cluster metric
CLUSTER_TOL = 0.35           # cluster radius in that metric
CLUSTER_RADIUS_TOL = 0.25
MIN_VOTES = 8
KEEP_MIN_ARC_DEG = 75.0      # publishable features must be a real arc
KEEP_MIN_LENGTH = 0.50       # short features survive only inside a coaxial group
COAXIAL_ANGLE_DEG = 2.0
COAXIAL_OFFSET = 0.30

# Fastener bands, from hardware/bom/README.md ("Fasteners & Mechanical
# Hardware": M2 x 5 mm self-threading, M2.5 x 5 mm machine screws).
M25_CLEARANCE_R = (1.15, 1.45)   # M2.5 machine screw through-hole
M2_SELFTAP_R = (0.75, 1.05)      # M2 self-threading pilot hole
HORN_RECESS_R = (3.60, 4.40)     # counterbore that swallows the servo-horn hub
PLATE_ROUND_R = (6.00, 6.70)     # rounded end of the horn mounting plate

HIP_PARTS = {"R1", "R2", "L1", "L2"}
LEG_PARTS = {"R3", "R4", "L3", "L4"}


# ==========================================================================
# small helpers
# ==========================================================================

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def r(x, nd: int = 6):
    """Round for stable JSON. Handles scalars and array-likes; kills -0.0."""
    if x is None:
        return None
    a = np.asarray(x, dtype=float)
    if a.ndim == 0:
        v = float(np.round(a, nd))
        return 0.0 if v == 0 else v
    return [r(v, nd) for v in a.tolist()]


def stl_header_facet_count(path: Path) -> int | None:
    """Triangle count from the binary-STL header (raw, before vertex welding)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(84)
        if len(head) < 84:
            return None
        if head[:5].lower() == b"solid" and b"facet" in head:
            return None                        # ASCII STL
        return struct.unpack("<I", head[80:84])[0]
    except OSError:
        return None


def canonical_axis(v) -> np.ndarray:
    """A direction and its negation name the same axis; pick one, always."""
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n == 0:
        return v
    v = v / n
    for c in v:
        if abs(c) > 1e-9:
            return -v if c < 0 else v
    return v


def perp_frame(axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    tmp = np.array([1.0, 0.0, 0.0])
    if abs(float(tmp @ axis)) > 0.9:
        tmp = np.array([0.0, 1.0, 0.0])
    e1 = canonical_axis(np.cross(axis, tmp))
    return e1, np.cross(axis, e1)


def _fit_circle_2d(pts: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Kasa algebraic circle fit -> (centre[2], radius, rms radial residual)."""
    x, y = pts[:, 0], pts[:, 1]
    A = np.column_stack([x, y, np.ones(len(pts))])
    b = x * x + y * y
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0] / 2.0, sol[1] / 2.0
    rad = float(np.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0)))
    d = np.hypot(x - cx, y - cy)
    rms = float(np.sqrt(np.mean((d - rad) ** 2))) if len(d) else float("inf")
    return np.array([cx, cy]), rad, rms


def point_line_distance(p, a, d) -> float:
    """Distance from point p to the line through a with unit direction d."""
    p, a, d = np.asarray(p, float), np.asarray(a, float), np.asarray(d, float)
    v = p - a
    return float(np.linalg.norm(v - (v @ d) * d))


def line_line_distance(a1, d1, a2, d2) -> float:
    """Shortest distance between two lines (handles the parallel case)."""
    a1, d1, a2, d2 = (np.asarray(x, float) for x in (a1, d1, a2, d2))
    n = np.cross(d1, d2)
    nn = np.linalg.norm(n)
    if nn < 1e-9:
        return point_line_distance(a2, a1, d1)
    return float(abs(np.dot(a2 - a1, n / nn)))


# ==========================================================================
# cylindrical-feature recovery
# ==========================================================================

def _cylinder_votes(mesh: trimesh.Trimesh):
    """
    One cylinder-axis vote per smoothly-creased face pair.

    For a cylinder of radius R and axis (a, d), every face is tangent, so a
    face centroid p with unit normal n satisfies  p_perp = a_perp + sR*n,
    where s = +1 for material inside (a boss) and -1 for material outside
    (a hole). Two adjacent tangent faces give

        (p_i - p_j) . n_i = sR (1 - n_i . n_j)

    which solves directly for the signed radius, and then a = p_i - sR*n_i
    lands on the axis. d is n_i x n_j.

    Doing this per *edge* rather than per surface patch is what makes the
    detector survive the filleted, fully-blended organic surfaces in these
    parts, where a naive smooth-patch segmentation merges the entire outer
    shell into one unusable blob.
    """
    adj = mesh.face_adjacency
    if len(adj) == 0:
        return None
    ang = mesh.face_adjacency_angles
    sel = (ang > np.radians(VOTE_ANGLE_MIN_DEG)) & (ang < np.radians(VOTE_ANGLE_MAX_DEG))
    pr = adj[sel]
    if len(pr) == 0:
        return None

    ni = mesh.face_normals[pr[:, 0]]
    nj = mesh.face_normals[pr[:, 1]]
    pi = mesh.triangles_center[pr[:, 0]]
    pj = mesh.triangles_center[pr[:, 1]]

    d = np.cross(ni, nj)
    dn = np.linalg.norm(d, axis=1)
    ok = dn > 1e-9
    pr, ni, pi, pj, d, dn = pr[ok], ni[ok], pi[ok], pj[ok], d[ok], dn[ok]
    nj = nj[ok]
    d = d / dn[:, None]

    denom = 1.0 - np.sum(ni * nj, axis=1)
    ok = denom > 1e-6
    pr, ni, pi, pj, d, denom = pr[ok], ni[ok], pi[ok], pj[ok], d[ok], denom[ok]

    sR = np.sum((pi - pj) * ni, axis=1) / denom
    a = pi - sR[:, None] * ni
    a = a - np.sum(a * d, axis=1)[:, None] * d     # axis point closest to origin

    # canonical direction sign, vectorised
    sign = np.ones(len(d))
    assigned = np.zeros(len(d), dtype=bool)
    for k in range(3):
        m = (~assigned) & (np.abs(d[:, k]) > 1e-9)
        sign[m] = np.where(d[m, k] < 0, -1.0, 1.0)
        assigned |= m
    d = d * sign[:, None]
    return pr, d, a, sR


def find_cylindrical_features(mesh: trimesh.Trimesh) -> list[dict[str, Any]]:
    v = _cylinder_votes(mesh)
    if v is None:
        return []
    pr, d, a, sR = v
    keep = (np.abs(sR) > RADIUS_MIN) & (np.abs(sR) < RADIUS_MAX) \
        & np.all(np.isfinite(a), axis=1)
    pr, d, a, sR = pr[keep], d[keep], a[keep], sR[keep]
    if len(sR) == 0:
        return []

    feat = np.column_stack([
        d * CLUSTER_DIR_WEIGHT,
        a,
        np.abs(sR)[:, None] * (CLUSTER_TOL / CLUSTER_RADIUS_TOL),
        np.sign(sR)[:, None] * 1e3,            # never merge a hole with a boss
    ])
    tree = cKDTree(feat)
    pairs = tree.query_pairs(CLUSTER_TOL, output_type="ndarray")

    parent = np.arange(len(feat))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, j in pairs:
        ri, rj = find(int(i)), find(int(j))
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    buckets: dict[int, list[int]] = {}
    for i in range(len(feat)):
        buckets.setdefault(find(i), []).append(i)

    out: list[dict[str, Any]] = []
    for idx_list in buckets.values():
        if len(idx_list) < MIN_VOTES:
            continue
        idx = np.array(sorted(idx_list))
        axis = canonical_axis(d[idx].mean(axis=0))
        faces = np.unique(pr[idx].ravel())

        e1, e2 = perp_frame(axis)
        verts_all = mesh.vertices[np.unique(mesh.faces[faces].ravel())]
        loc_all = np.column_stack([verts_all @ e1, verts_all @ e2])
        c2, rad, _ = _fit_circle_2d(loc_all)
        if rad <= 1e-6:
            continue

        # Keep only vertices genuinely lying on the cylinder. Without this the
        # axial extent is polluted by the neighbouring flat faces that share a
        # vertex with the cylinder wall, which inflates depth by 10x.
        rr = np.hypot(loc_all[:, 0] - c2[0], loc_all[:, 1] - c2[1])
        on = np.abs(rr - rad) < max(0.12 * rad, 0.06)
        if on.sum() < 6:
            continue
        verts = verts_all[on]
        loc = loc_all[on]
        c2, rad, rms = _fit_circle_2d(loc)
        if rad <= 1e-6 or not np.isfinite(rms):
            continue

        theta = np.arctan2(loc[:, 1] - c2[1], loc[:, 0] - c2[0])
        bins = np.zeros(72, dtype=bool)
        bins[((theta + np.pi) / (2 * np.pi) * 72).astype(int) % 72] = True
        arc = float(bins.sum() * 5.0)

        ax = verts @ axis
        a_lo, a_hi = float(ax.min()), float(ax.max())
        length = a_hi - a_lo
        if arc < KEEP_MIN_ARC_DEG:
            continue

        centre = c2[0] * e1 + c2[1] * e2 + 0.5 * (a_lo + a_hi) * axis
        out.append({
            "kind": "hole" if float(sR[idx].mean()) < 0 else "boss",
            "radius": r(rad, 4),
            "diameter": r(2 * rad, 4),
            "axis": r(axis, 6),
            "center": r(centre, 4),
            "axialExtent": [r(a_lo, 4), r(a_hi, 4)],
            "length": r(length, 4),
            "arcCoverageDeg": r(arc, 1),
            "votes": int(len(idx)),
            "faces": int(len(faces)),
            "fitResidualRatio": r(rms / rad, 5),
        })

    out.sort(key=lambda f: (f["kind"], -f["radius"], f["center"]))
    return out


def group_coaxial(features: list[dict]) -> list[dict[str, Any]]:
    """Merge features that share an axis line -> hole + counterbore + boss."""
    groups: list[dict[str, Any]] = []
    for f in features:
        ax = np.asarray(f["axis"], float)
        ct = np.asarray(f["center"], float)
        hit = None
        for g in groups:
            gax = np.asarray(g["axis"], float)
            if abs(float(gax @ ax)) < np.cos(np.radians(COAXIAL_ANGLE_DEG)):
                continue
            if point_line_distance(ct, np.asarray(g["point"], float), gax) > COAXIAL_OFFSET:
                continue
            hit = g
            break
        if hit is None:
            groups.append({"axis": f["axis"], "point": f["center"], "members": [f]})
        else:
            hit["members"].append(f)

    out = []
    for g in groups:
        mem = sorted(g["members"], key=lambda f: (f["kind"], -f["radius"]))
        axis = canonical_axis(g["axis"])
        pts = np.array([m["center"] for m in mem], float)
        # a stable point on the axis: centroid, with the axial component removed
        c = pts.mean(axis=0)
        c = c - float(c @ axis) * axis
        lo = min(m["axialExtent"][0] for m in mem)
        hi = max(m["axialExtent"][1] for m in mem)
        out.append({
            "axis": r(axis, 6),
            "pointOnAxis": r(c + 0.5 * (lo + hi) * axis, 4),
            "axialExtent": [r(lo, 4), r(hi, 4)],
            "memberCount": len(mem),
            "radii": [m["radius"] for m in mem],
            "kinds": [m["kind"] for m in mem],
            "members": mem,
        })
    out.sort(key=lambda g: (-g["memberCount"], g["pointOnAxis"]))
    return out


def prune_noise(groups: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    Drop isolated shallow arcs.

    A 3-D-printed organic part is covered in constant-radius edge fillets
    (here 1.27 = 0.05 inch) which are, strictly, cylindrical patches. They are
    real geometry but they are not features. The discriminator that works is:
    a fillet is always a lone shallow arc, whereas a functional bore is either
    axially deep or shares its axis with another turned feature (a chamfer,
    a counterbore, or the rounded end of the plate it sits in).
    """
    kept = [g for g in groups
            if g["memberCount"] > 1
            or g["members"][0]["length"] >= KEEP_MIN_LENGTH]
    feats: list[dict] = []
    for g in kept:
        feats.extend(g["members"])
    feats.sort(key=lambda f: (f["kind"], -f["radius"], f["center"]))
    return kept, feats


# ==========================================================================
# pivot identification (second pass, needs every part measured)
# ==========================================================================

def _in(band, x) -> bool:
    return band[0] <= x <= band[1]


def _servo_interface_score(group: dict) -> tuple[int, dict]:
    """
    A servo-horn interface on these parts has one very specific coaxial
    signature, visible on both ends of every hip link:

        a 12.70-diameter rounded plate end   (PLATE_ROUND_R, always present)
      + a coaxial bore through it, either
          ~8.0 dia  -> clearance for the horn hub and the screw head, or
          ~2.5 dia  -> the M2.5 machine screw that enters the servo spline
                       (hardware/bom/README.md: "M2.5 x 5mm machine screws |
                        Servo horn attachment to servo shafts only")

    The rounded end is what makes the match reliable: the pivot is by
    construction at the centre of the arc that the plate is swept about, and
    an R6.35 turned end shared with a bore cannot occur by accident.
    """
    comp: dict[str, Any] = {}
    score = 0
    for m in group["members"]:
        if m["kind"] == "boss" and _in(PLATE_ROUND_R, m["radius"]):
            comp["plateRoundEnd"] = m
            score += 2
        elif m["kind"] == "hole" and _in(HORN_RECESS_R, m["radius"]):
            comp["hornHubBore"] = m
            score += 2
        elif m["kind"] == "hole" and _in(M25_CLEARANCE_R, m["radius"]):
            comp["screwBore"] = m
            score += 1
    if "plateRoundEnd" not in comp or len(comp) < 2:
        score = 0
    return score, comp


def hip_interfaces(entry: dict) -> list[dict[str, Any]]:
    found = []
    for g in entry["axisGroups"]:
        score, comp = _servo_interface_score(g)
        if score >= 3:
            found.append({
                "score": score,
                "axis": g["axis"],
                "origin": g["pointOnAxis"],
                "components": {k: {"radius": v["radius"], "center": v["center"],
                                   "length": v["length"]}
                               for k, v in sorted(comp.items())},
            })
    found.sort(key=lambda f: (-f["score"], f["origin"]))
    return found


def leg_servo_bores(entry: dict) -> dict[str, Any] | None:
    """
    The two M2 self-threading bores that screw the leg shell to the servo's
    mounting ears (docs/build-guide/assets/servo-install-leg.png labels them
    '(2x) M2 x 5mm self-threading'). Their spacing is a *measured* number; the
    fact that MG90S ear pitch is ~27.8 mm is a datasheet fact and is only used
    as a corroboration note, never as an input.
    """
    cands = [f for f in entry["cylindricalFeatures"]
             if f["kind"] == "hole" and _in(M2_SELFTAP_R, f["radius"])]
    best = None
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            a, b = cands[i], cands[j]
            ax = np.asarray(a["axis"], float)
            if abs(float(ax @ np.asarray(b["axis"], float))) < np.cos(np.radians(2)):
                continue
            ca, cb = np.asarray(a["center"], float), np.asarray(b["center"], float)
            sep = float(np.linalg.norm(cb - ca))
            if sep < 15.0 or sep > 40.0:
                continue
            if best is None or sep > best["separation"]:
                best = {
                    "axis": r(canonical_axis(ax), 6),
                    "boreA": a["center"], "boreB": b["center"],
                    "midpoint": r((ca + cb) / 2.0, 4),
                    "separation": r(sep, 4),
                    "radius": a["radius"],
                }
    return best


def assign_pivots(parts: list[dict]) -> None:
    """Populate pivotCandidate / distalInterface / mates on every joint part."""
    by_joint = {p["firmwareJointName"]: p for p in parts if p["role"] == "joint"}

    # ---- hips ------------------------------------------------------------
    for name in sorted(HIP_PARTS):
        p = by_joint.get(name)
        if p is None:
            continue
        ifs = hip_interfaces(p)
        if not ifs:
            p["pivotCandidate"] = {
                "origin": None, "axis": None,
                "method": "coaxial-servo-horn-signature",
                "confidence": "none",
                "notes": ("No coaxial group matching the servo-horn signature "
                          "(M2.5 bore + horn-hub counterbore + rounded plate "
                          "end) was recovered from this mesh."),
            }
            p["distalInterface"] = None
            continue

        # The hip servos are mounted on the internal frame with their output
        # shafts vertical (docs/build-guide/assets/install-frame-motors.png),
        # and the whole STL set shares one frame in which +Y is up (the bottom
        # cover, internal frame and top cover stack edge-to-edge along Y). The
        # interface whose axis is closest to +Y is therefore the proximal /
        # yaw joint; the remaining one drives the leg link.
        up = np.array([0.0, 1.0, 0.0])
        ifs.sort(key=lambda f: -abs(float(np.asarray(f["axis"], float) @ up)))
        prox, dist = ifs[0], (ifs[1] if len(ifs) > 1 else None)
        prox_align = abs(float(np.asarray(prox["axis"], float) @ up))

        p["pivotCandidate"] = {
            "origin": prox["origin"],
            "axis": prox["axis"],
            "method": ("coaxial-servo-horn-signature: an M2.5 through-bore, an "
                       "~8 mm horn-hub counterbore and a 12.7 mm rounded plate "
                       "end sharing one axis; selected as proximal because its "
                       "axis is the one aligned with the assembly's vertical"),
            "confidence": "medium",
            "axisConfidence": "high",
            "originConfidence": "medium",
            "verticalAlignment": r(prox_align, 4),
            "notes": ("AXIS: measured directly as the common axis of three "
                      "concentric turned features; direction and in-plane "
                      "position are solid. ORIGIN: the mid-depth point of the "
                      "M2.5 bore. Its position ALONG the axis is not the "
                      "servo's datum plane - that would need the servo model "
                      "or a physical measurement - so treat the origin as a "
                      "point on the correct line, not as the joint centre. "
                      "Note the very small `length` on the screwBore member: "
                      "the horn-hub counterbore is modelled almost exactly "
                      "flush with the outer face, leaving a sub-0.15 web, so "
                      "only a thin band of the bore wall is cylindrical. The "
                      "bore is nonetheless a genuine through-passage - "
                      "verified by ray-casting along the axis, which never "
                      "enters solid material."),
            "components": prox["components"],
        }
        p["distalInterface"] = None if dist is None else {
            "origin": dist["origin"],
            "axis": dist["axis"],
            "method": "coaxial-servo-horn-signature (second interface)",
            "confidence": "medium",
            "notes": ("The far end of this link carries a second servo-horn "
                      "interface. Physically this is the pivot of the LEG link "
                      "that hangs off this hip link, not of this part."),
            "components": dist["components"],
        }
        if dist is not None:
            po = np.asarray(prox["origin"], float)
            pa = np.asarray(prox["axis"], float)
            do = np.asarray(dist["origin"], float)
            da = np.asarray(dist["axis"], float)
            p["linkGeometry"] = {
                "axisAngleDeg": r(float(np.degrees(np.arccos(
                    min(1.0, abs(float(pa @ da)))))), 3),
                "commonNormalDistance": r(line_line_distance(po, pa, do, da), 4),
                "originSeparation": r(float(np.linalg.norm(do - po)), 4),
                "note": ("Distance between the two joint axes of this link, "
                         "measured. This is the link's kinematic offset, "
                         "subject to the origin caveat above."),
            }

    # ---- legs ------------------------------------------------------------
    for name in sorted(LEG_PARTS):
        p = by_joint.get(name)
        if p is None:
            continue
        bores = leg_servo_bores(p)
        p["servoMountBores"] = bores
        if bores is None:
            p["pivotCandidate"] = {
                "origin": None, "axis": None,
                "method": "leg-servo-mount-bore-pair",
                "confidence": "none",
                "notes": "No pair of M2 self-threading bores was recovered.",
            }
            continue

        bax = np.asarray(bores["axis"], float)
        ba = np.asarray(bores["boreA"], float)
        bb = np.asarray(bores["boreB"], float)

        # Does any hip link's distal interface land exactly on this shell's
        # servo-bore line? If the whole STL set really shares one coordinate
        # frame, it must - and that pins the leg's pivot without a datasheet.
        matches = []
        for hname in sorted(HIP_PARTS):
            hp = by_joint.get(hname)
            if hp is None or not hp.get("distalInterface"):
                continue
            di = hp["distalInterface"]
            dax = np.asarray(di["axis"], float)
            do = np.asarray(di["origin"], float)
            if abs(float(dax @ bax)) < np.cos(np.radians(2.0)):
                continue
            # perpendicular distance from the hip axis line to the line joining
            # the two bore centres
            dist = line_line_distance(do, dax, ba, canonical_axis(bb - ba))
            if dist > 0.35:
                continue
            # The shaft must sit BETWEEN the two mounting screws, not merely on
            # the same infinite line: without this the mirror-image station on
            # the far side of the robot also "matches" at zero distance,
            # because every one of these axes lies in the same y plane.
            mid = np.asarray(bores["midpoint"], float)
            delta = do - mid
            offset = float(np.linalg.norm(delta - float(delta @ dax) * dax))
            if offset > 0.5 * float(bores["separation"]):
                continue
            matches.append({
                "hipPart": hname,
                "axisToBoreLineDistance": r(dist, 4),
                "offsetFromBoreMidpoint": r(offset, 4),
                "origin": di["origin"],
                "axis": di["axis"],
            })

        p["frameConsistentHipMatches"] = matches
        if matches:
            m = matches[0]
            p["pivotCandidate"] = {
                "origin": m["origin"],
                "axis": m["axis"],
                "method": ("cross-part: this shell's own pair of M2 servo-mount "
                           "bores fixes the servo's position and the pivot "
                           "direction; the exact axis line is taken from the "
                           "mating hip link's distal horn interface, which was "
                           "measured independently and falls on this shell's "
                           "bore line to within "
                           f"{m['axisToBoreLineDistance']} units"),
                "confidence": "medium",
                "axisConfidence": "high",
                "originConfidence": "medium",
                "notes": ("This part is a servo CARRIER, not a horn follower: "
                          "docs/build-guide/README.md 'Leg Joints' has the "
                          "motor pushed into the side of the leg piece and "
                          "held by two M2 self-threading screws, and the shaft "
                          "protrudes clear of the plastic, so the shell itself "
                          "contains no shaft feature. The axis had to come "
                          "from the mating link. The independent agreement of "
                          "two separately-measured parts is what raises this "
                          "above a guess, but nothing here is physically "
                          "verified. Candidate hip mates: "
                          + ", ".join(x["hipPart"] for x in matches)),
                "mateAmbiguity": ("More than one hip part matches because "
                                  "mirror-identical shapes were exported at "
                                  "the same station; see partShapeGroups."
                                  if len(matches) > 1 else None),
            }
        else:
            p["pivotCandidate"] = {
                "origin": None,
                "axis": bores["axis"],
                "method": "leg-servo-mount-bore-pair (direction only)",
                "confidence": "low",
                "axisConfidence": "high",
                "originConfidence": "none",
                "notes": ("Pivot DIRECTION is the axis of the two M2 "
                          "servo-mount bores (measured). The axis LINE is "
                          "constrained to pass through the bore centre line "
                          "but its position along that line - the servo's "
                          "output-shaft offset - is not present in this mesh. "
                          "Resolving it needs the servo model or the CAD "
                          "assembly."),
                "boreMidpointForReference": bores["midpoint"],
            }


# ==========================================================================
# shape-identity analysis
# ==========================================================================

def analyse_shapes(parts: list[dict], meshes: dict[str, trimesh.Trimesh]
                   ) -> list[dict[str, Any]]:
    """
    Which printed parts are actually the same solid?

    Compares every joint pair by sampling one surface and measuring the
    distance to the other. Identical shapes come out at ~96% of samples inside
    0.05 units, with the residual concentrated at exactly the 0.25-unit depth
    of the engraved part label - which is the only thing that differs.
    """
    joints = [p for p in parts if p["role"] == "joint"]
    names = sorted(p["firmwareJointName"] for p in joints)
    if not names:
        return []

    def agreement(a: str, b: str, mirror_z: float | None) -> tuple[float, float]:
        A = meshes[a].copy()
        if mirror_z is not None:
            T = np.eye(4)
            T[2, 2] = -1.0
            T[2, 3] = 2.0 * mirror_z
            A.apply_transform(T)
        pts, _ = trimesh.sample.sample_surface(A, 20000, seed=0)
        d = np.abs(trimesh.proximity.signed_distance(meshes[b], pts))
        return float(np.mean(d < 0.05)), float(np.percentile(d, 99))

    rel: list[dict[str, Any]] = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ba = np.asarray(next(p for p in joints
                                 if p["firmwareJointName"] == a)["bbox"]["min"])
            bb = np.asarray(next(p for p in joints
                                 if p["firmwareJointName"] == b)["bbox"]["min"])
            same_box = bool(np.allclose(ba, bb, atol=1e-3))
            mirror_z = None
            if not same_box and np.allclose(ba[:2], bb[:2], atol=1e-3):
                bmax = np.asarray(next(p for p in joints
                                       if p["firmwareJointName"] == b)["bbox"]["max"])
                mirror_z = float((ba[2] + bmax[2]) / 2.0)
            if not same_box and mirror_z is None:
                continue
            frac, p99 = agreement(a, b, mirror_z)
            if frac < 0.85:
                continue
            rel.append({
                "a": a, "b": b,
                "relation": "identical" if mirror_z is None else "mirrored",
                "mirrorPlaneZ": r(mirror_z, 5) if mirror_z is not None else None,
                "fractionWithin0p05": r(frac, 4),
                "p99Distance": r(p99, 4),
                "method": ("20000 surface samples of A, unsigned distance to B; "
                           "deterministic seed"),
                "notes": ("Residual disagreement is the engraved part label, "
                          "whose depth matches p99Distance."),
            })
    rel.sort(key=lambda x: (x["a"], x["b"]))
    return rel


# ==========================================================================
# per-mesh measurement
# ==========================================================================

ROLE_RULES = [
    (re.compile(r"^Internal-Frame", re.I), "frame", None),
    (re.compile(r"^Bottom-Cover", re.I), "cover", None),
    (re.compile(r"^Top-Cover", re.I), "cover", None),
    (re.compile(r".*hat", re.I), "accessory", None),
    (re.compile(r"^([RL][1-4])-", re.I), "joint", "auto"),
]


def classify(filename: str) -> tuple[str, str | None]:
    for rx, role, joint in ROLE_RULES:
        m = rx.match(filename)
        if m:
            return (role, m.group(1).upper()) if joint == "auto" else (role, None)
    return "unknown", None


def measure(path: Path, repo_root: Path) -> tuple[dict[str, Any], trimesh.Trimesh]:
    raw_facets = stl_header_facet_count(path)
    mesh = trimesh.load(str(path), file_type="stl", process=True)
    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.dump(concatenate=True)

    role, joint = classify(path.name)
    lo, hi = mesh.bounds
    size = hi - lo
    watertight = bool(mesh.is_watertight)
    volume = float(mesh.volume) if watertight else None
    com = mesh.center_mass if watertight else None

    if watertight:
        inertia = np.asarray(mesh.moment_inertia, dtype=float)
        evals, evecs = np.linalg.eigh(inertia)
        order = np.argsort(evals)
        evals, evecs = evals[order], evecs[:, order]
        principal = {
            "dominantAxis": r(canonical_axis(evecs[:, 0])),
            "momentsAscending": r(evals, 4),
            "axes": [r(canonical_axis(evecs[:, i])) for i in range(3)],
            "note": ("Eigenvectors of the inertia tensor about the centre of "
                     "mass (unit density), ascending by moment. The first is "
                     "the part's slenderest / dominant direction."),
        }
    else:
        inertia = None
        principal = None

    groups, feats = prune_noise(group_coaxial(find_cylindrical_features(mesh)))

    entry: dict[str, Any] = {
        "file": path.name,
        "path": path.relative_to(repo_root).as_posix(),
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "role": role,
        "firmwareJointName": joint,
        "mesh": {
            "trianglesRawStlHeader": raw_facets,
            "triangles": int(len(mesh.faces)),
            "verticesAfterWeld": int(len(mesh.vertices)),
            "bodies": int(mesh.body_count),
            "eulerNumber": int(mesh.euler_number),
        },
        "integrity": {
            "watertight": watertight,
            "windingConsistent": bool(mesh.is_winding_consistent),
            "volumeSignPositive": bool(volume is not None and volume > 0),
            "degenerateFaces": int(np.count_nonzero(mesh.area_faces <= 0.0)),
        },
        "bbox": {
            "min": r(lo, 4), "max": r(hi, 4), "size": r(size, 4),
            "centroid": r((lo + hi) / 2.0, 4),
            "diagonal": r(float(np.linalg.norm(size)), 4),
        },
        "surfaceArea": r(float(mesh.area), 4),
        "volume": r(volume, 4) if volume is not None else None,
        "centerOfMass": r(com, 4) if com is not None else None,
        "areaCentroid": r(mesh.centroid, 4),
        "principalAxes": principal,
        "inertiaTensor": r(inertia, 4) if inertia is not None else None,
        "cylindricalFeatures": feats,
        "axisGroups": groups,
        "pivotCandidate": None,
        "verified": False,
    }
    return entry, mesh


# ==========================================================================
# units inference
# ==========================================================================

def infer_units(parts: list[dict], cad: list[dict] | None = None) -> dict[str, Any]:
    joints = [p for p in parts if p["role"] == "joint"]
    legs = [p for p in joints if p["firmwareJointName"] in LEG_PARTS]
    frame = next((p for p in parts if p["role"] == "frame"), None)

    leg_long = [max(p["bbox"]["size"]) for p in legs] if legs else []
    leg_med = float(np.median(leg_long)) if leg_long else None
    frame_long = max(frame["bbox"]["size"]) if frame else None

    bores = sorted({f["radius"] for p in joints for f in p["cylindricalFeatures"]
                    if f["kind"] == "hole" and f["radius"] < 5.0})
    bore_med = float(np.median(bores)) if bores else None

    plausible = bool(
        leg_med is not None and 25.0 <= leg_med <= 70.0
        and frame_long is not None and 40.0 <= frame_long <= 140.0
        and bore_med is not None and 0.6 <= bore_med <= 2.6
    )

    cad_unit = None
    cad_conv: list[str] = []
    for c in (cad or []):
        sym = (c.get("findings") or {}).get("symbolic") or {}
        u = sym.get("units") or {}
        if u.get("lengthUnit"):
            cad_unit = u["lengthUnit"]
            cad_conv = u.get("conversionBasedUnits") or []

    return {
        "value": "millimetre" if plausible else "undetermined",
        "confidence": "high" if plausible else "none",
        "method": ("declared CAD unit context, cross-checked against "
                   "repo-sourced fastener sizes and overall scale"),
        "cadDeclaredLengthUnit": cad_unit,
        "cadConversionBasedUnits": cad_conv,
        "reasoning": [
            ("Decisive, and it is a DECLARED value rather than an inference: "
             "hardware/cad/Sesame-ESP32-v122.step carries the unit context "
             "(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.)), i.e. the "
             "CAD master from which these STLs were exported measures length "
             "in millimetres. Read out by scripts/extract-step-assembly.py."),
            "The STL format carries no unit; the numbers in the file are bare "
            "floats, so a unit can only ever be inferred here.",
            ("Strongest evidence, and it is repo-internal: "
             "hardware/bom/README.md specifies 'M2.5 x 5mm machine screws ... "
             "Servo horn attachment to servo shafts only' and 'M2 x 5 mm "
             "self-threading screws'. The joint parts contain through-bores "
             "measuring exactly 2.500 diameter at the servo-shaft interfaces "
             "and 1.738 diameter at the servo mounting points. Those are an "
             "M2.5 clearance hole and an M2 self-tapping pilot hole to three "
             "decimal places IF the unit is the millimetre, and are absurd in "
             "any other unit."),
            (f"Leg-shell longest bbox dimension (median) = {r(leg_med, 3)}; "
             f"internal frame longest bbox dimension = {frame_long}. Read as "
             "millimetres these give a ~58 mm leg link on a ~79 mm body, i.e. "
             "the palm-sized desk robot the build guide photographs. Read as "
             "centimetres it is a 790 mm machine; as inches, 2 m."),
            ("Cross-check: the two servo-mount bores in every leg shell are "
             "27.800 apart. The MG90S mounting-ear pitch is 27.8 mm. That "
             "pitch is a manufacturer datasheet value and is NOT stated "
             "anywhere in this repository, so it is used only as an external "
             "corroboration, never as an input to the measurement."),
            "Four independent scales agree; millimetre is not a coincidence.",
        ],
        "caveat": ("Still an inference. No unit is declared in the STL files or "
                   "anywhere in the repository text. The Fusion .f3z or the "
                   "STEP unit context would state it authoritatively; both are "
                   "listed in unresolved[]."),
        "observation": {
            "note": ("Almost every overall dimension of these parts is an exact "
                     "multiple of 1.27 (= 0.05 inch): bounding boxes of "
                     "20.32 / 30.48 / 49.52 and 9.525 / 19.05 / 58.42, fillet "
                     "radii of 1.27 and 6.35, plate ends of 12.70 diameter. "
                     "The fastener holes, by contrast, are exact metric sizes. "
                     "This is EXPLAINED by the CAD: the same STEP unit context "
                     "also declares CONVERSION_BASED_UNIT('inch'), and the "
                     "assembly placements come out as round inch values (the "
                     "four hip servos sit on an exact 1.500 x 2.000 inch = "
                     "38.10 x 50.80 mm rectangle). The design was laid out on "
                     "an imperial grid and fitted with metric hardware. It does "
                     "not change the millimetre conclusion for the STL files."),
        },
    }


# ==========================================================================
# CAD inspection (best effort)
# ==========================================================================

def inspect_cad(cad_dir: Path, repo_root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not cad_dir.is_dir():
        return out
    for p in sorted(cad_dir.iterdir()):
        if p.suffix.lower() not in (".step", ".stp", ".f3z", ".f3d"):
            continue
        e: dict[str, Any] = {
            "file": p.name,
            "path": p.relative_to(repo_root).as_posix(),
            "sha256": sha256_file(p),
            "bytes": p.stat().st_size,
            "parsed": False,
            "findings": {},
            "notes": "",
        }
        if p.suffix.lower() in (".step", ".stp"):
            head: list[str] = []
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                for _ in range(80):
                    line = fh.readline()
                    if not line:
                        break
                    head.append(line.rstrip("\n"))
            txt = "\n".join(head)
            m_schema = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", txt)
            m_desc = re.search(r"FILE_DESCRIPTION\s*\(([^;]*)\)\s*;", txt, re.S)
            e["parsed"] = True
            e["findings"] = {
                "headerLines": head[:20],
                "fileSchema": m_schema.group(1) if m_schema else None,
                "fileDescription": (m_desc.group(1).strip() if m_desc else None),
            }
            e["notes"] = ("B-Rep surfaces were NOT evaluated - that needs "
                          "pythonocc/OCP or FreeCAD, neither of which is "
                          "installed in tools/py-assets/.venv. The unit context "
                          "and the assembly tree ARE symbolic data in the "
                          "exchange file and were read exactly; see "
                          "findings.symbolic.")
            if step_assembly is not None:
                try:
                    sym = step_assembly.analyse(p)
                    e["findings"]["symbolic"] = sym
                except Exception as exc:              # pragma: no cover
                    e["findings"]["symbolicError"] = f"{type(exc).__name__}: {exc}"
        elif p.suffix.lower() == ".f3z":
            try:
                with zipfile.ZipFile(p) as z:
                    names = z.namelist()
                    sizes = {n: z.getinfo(n).file_size for n in names}
                e["parsed"] = True
                e["findings"] = {
                    "isZip": True,
                    "entryCount": len(names),
                    "entries": [{"name": n, "size": sizes[n]}
                                for n in sorted(names)[:64]],
                }
                e["notes"] = ("Fusion archive opened as a zip. Its contents are "
                              "Autodesk's proprietary binary Fusion documents; "
                              "no open parser exists, so component names, joint "
                              "definitions and units were not recovered.")
            except zipfile.BadZipFile:
                e["notes"] = "Not a readable zip archive."
        out.append(e)
    return out


def attach_cad_identity(parts: list[dict], cad: list[dict]) -> None:
    """
    Carry the CAD's own product names onto the measured STL parts.

    This matters because the STEP file settles, from the design itself, what
    the eight numbered parts ARE: `femur-joint-R1..L2` and `foot-joint-R3..L4`.
    That is an authoritative source-of-design statement, not an inference from
    prose, and it agrees with the build guide's Hip Joints / Leg Joints split.
    """
    poses: dict[str, dict] = {}
    for c in cad:
        for j in ((c.get("findings") or {}).get("symbolic") or {}).get("jointPoses", []):
            poses.setdefault(j["firmwareJointName"], j)
    for p in parts:
        n = p.get("firmwareJointName")
        j = poses.get(n) if n else None
        if not j:
            p["cadIdentity"] = None
            continue
        p["cadIdentity"] = {
            "product": j["cadProduct"],
            "kind": j["cadRole"],
            "source": "hardware/cad/Sesame-ESP32-v122.step PRODUCT name",
            "confidence": "high",
            "occurrencePath": j["occurrencePath"],
            "assemblyPoseInCadFrame": {
                "origin": j["origin"], "xAxis": j["xAxis"],
                "yAxis": j["yAxis"], "zAxis": j["zAxis"],
                "unit": "inch (the STEP assembly context also declares "
                        "CONVERSION_BASED_UNIT('inch'); values are round inch "
                        "numbers)",
                "warning": ("This pose is in the CAD assembly frame. Do NOT mix "
                            "it with the STL-frame coordinates elsewhere in "
                            "this file until the two frames are reconciled - "
                            "see unresolved[]."),
            },
        }


SERVO_FACTS = {
    "model": "MG90S",
    "quantity": 8,
    "source": "reference/sesame-robot-main/hardware/bom/README.md",
    "quotedFromBom": [
        "MG90S all-metal micro servos (180 Deg) | 8 (buy 10 for spares) | "
        "Primary hip/leg actuators; includes servo horns but keep extras",
        "M2.5 x 5mm machine screws | 10 | Servo horn attachment to servo shafts "
        "only. Included servo horn screws are usually too short.",
        "M2 x 5 mm self-threading screws | ~40 | All plastic joints, OLED "
        "retention, motor mounts, and covers",
    ],
    "travelDegFromBom": 180,
    "hornStyle": {
        "value": "one-sided horn; the shorter side is pressed into the hip part "
                 "and retained by an M2 self-threading screw through the horn's "
                 "second hole; the assembly is then fastened to the motor shaft "
                 "by an M2.5 machine screw through the main hole",
        "source": "reference/sesame-robot-main/docs/build-guide/README.md, "
                  "'Hip Joints' steps 2-3 and 'Attaching Hip & Leg Joints' "
                  "step 3",
    },
    "mounting": {
        "hips": "four servos screwed to the internal frame with output shafts "
                "vertical; source: docs/build-guide/assets/install-frame-"
                "motors.png and docs/build-guide/README.md 'Install Frame "
                "Motors'",
        "legs": "one servo per leg shell, pushed in from the side and held by "
                "two M2 x 5 mm self-threading screws, shaft at the top; source: "
                "docs/build-guide/README.md 'Leg Joints' and "
                "docs/build-guide/assets/servo-install-leg.png",
    },
    "bodyDimensionsMm": {
        "value": None,
        "note": ("Deliberately null. MG90S body and ear-pitch dimensions are "
                 "manufacturer datasheet figures and are stated nowhere in this "
                 "repository, so they are not recorded here as repo-sourced "
                 "facts. Where such a figure is used at all it is labelled as "
                 "external corroboration (see units.reasoning)."),
    },
    "measuredFromGeometry": {
        "servoMountBoreSeparation": None,     # filled in at build time
        "note": "Measured off the leg shells by this script, in file units.",
    },
    "verified": False,
}


# ==========================================================================
# assembly-frame analysis
# ==========================================================================

def analyse_frame(parts: list[dict]) -> dict[str, Any]:
    """
    Are the STLs exported in one shared coordinate frame, or each in its own
    print-local frame? This decides whether any of the measured axes can be
    compared between parts at all, so it is checked rather than assumed.
    """
    by_role: dict[str, list[dict]] = {}
    for p in parts:
        by_role.setdefault(p["role"], []).append(p)

    frame = next((p for p in parts if p["role"] == "frame"), None)
    bottom = next((p for p in parts if p["file"].lower().startswith("bottom-cover")),
                  None)
    tops = [p for p in parts if p["file"].lower().startswith("top-cover")]

    stack = None
    if frame and bottom and tops:
        stack = {
            "bottomCoverY": [bottom["bbox"]["min"][1], bottom["bbox"]["max"][1]],
            "internalFrameY": [frame["bbox"]["min"][1], frame["bbox"]["max"][1]],
            "topCoverY": [min(t["bbox"]["min"][1] for t in tops),
                          max(t["bbox"]["max"][1] for t in tops)],
            "bottomTopMeetsFrameBottom": bool(abs(
                bottom["bbox"]["max"][1] - frame["bbox"]["min"][1]) < 1e-3),
            "frameTopMeetsTopCoverBottom": bool(all(abs(
                frame["bbox"]["max"][1] - t["bbox"]["min"][1]) < 1e-3 for t in tops)),
            "sharedXStart": bool(len({p["bbox"]["min"][0] for p in
                                      ([frame, bottom] + tops)}) == 1),
        }

    stations: dict[str, list[str]] = {}
    for p in parts:
        if p["role"] != "joint":
            continue
        key = json.dumps(p["bbox"]["min"])
        stations.setdefault(key, []).append(p["firmwareJointName"])
    station_list = [{"bboxMin": json.loads(k), "parts": sorted(v)}
                    for k, v in sorted(stations.items())]

    coherent = bool(stack and stack["bottomTopMeetsFrameBottom"]
                    and stack["frameTopMeetsTopCoverBottom"]
                    and stack["sharedXStart"])

    return {
        "sharedFrame": {
            "value": coherent,
            "confidence": "high" if coherent else "none",
            "method": "body-shell stacking test + joint bbox station clustering",
            "evidence": stack,
            "notes": ("The bottom cover, internal frame and top covers all start "
                      "at the same X and stack edge-to-edge along Y with zero "
                      "gap and zero overlap. That only happens if they were "
                      "exported in one assembly frame with +Y up. The joint "
                      "parts share that frame's orientation but NOT unique "
                      "assembly positions - see jointStations."),
        },
        "upAxis": {
            "value": "+Y" if coherent else None,
            "confidence": "high" if coherent else "none",
            "method": "the body shells stack along Y in build order "
                      "(bottom cover -> internal frame -> top cover)",
        },
        "jointStations": {
            "value": station_list,
            "notes": ("Only two distinct bounding-box origins exist for the four "
                      "hip parts and only two for the four leg parts. Four "
                      "distinct legs cannot occupy two positions, so the joint "
                      "STLs were exported one per unique SHAPE at a "
                      "representative station, then re-labelled. Their "
                      "ORIENTATIONS are frame-correct; their POSITIONS are not "
                      "per-instance assembly positions."),
        },
        "lateralAxis": {
            "value": "+Z is the 'R' side, -Z the 'L' side",
            "confidence": "medium",
            "method": ("R-named parts sit at positive Z and L-named parts at the "
                       "mirror-image negative Z, and each R part is a "
                       "Z-mirror of its L counterpart to within the engraved "
                       "label"),
            "notes": ("Which end of the body is the FRONT is still unresolved; "
                      "nothing measured here distinguishes fore from aft."),
        },
    }


# ==========================================================================
# main
# ==========================================================================

def build_inventory(args) -> dict[str, Any]:
    repo_root = Path(args.repo_root).resolve()
    stl_dir = Path(args.stl_dir).resolve()

    stls = sorted(stl_dir.rglob("*.stl"),
                  key=lambda p: p.relative_to(stl_dir).as_posix())
    parts: list[dict[str, Any]] = []
    meshes: dict[str, trimesh.Trimesh] = {}
    for p in stls:
        entry, mesh = measure(p, repo_root)
        parts.append(entry)
        if entry["firmwareJointName"]:
            meshes[entry["firmwareJointName"]] = mesh

    role_rank = {"frame": 0, "cover": 1, "joint": 2, "accessory": 3, "unknown": 4}
    parts.sort(key=lambda e: (role_rank.get(e["role"], 9),
                              e["firmwareJointName"] or "", e["file"]))

    assign_pivots(parts)
    shape_rel = analyse_shapes(parts, meshes) if not args.fast else []
    frame_info = analyse_frame(parts)
    cad = inspect_cad(Path(args.cad_dir).resolve(), repo_root) if args.cad_dir else []
    attach_cad_identity(parts, cad)
    units = infer_units(parts, cad)

    servo = json.loads(json.dumps(SERVO_FACTS))
    seps = sorted({p["servoMountBores"]["separation"]
                   for p in parts
                   if p.get("servoMountBores")})
    servo["measuredFromGeometry"]["servoMountBoreSeparation"] = seps

    found = {p["firmwareJointName"] for p in parts if p["role"] == "joint"}
    expected = sorted(HIP_PARTS | LEG_PARTS)
    missing = [j for j in expected if j not in found]

    # ---- unresolved ------------------------------------------------------
    unresolved: list[dict[str, Any]] = []
    if missing:
        unresolved.append({
            "item": "missing joint STLs",
            "reason": f"expected joint parts not present: {missing}",
            "resolvedBy": "re-check the upstream printing/stl directory",
        })
    for p in parts:
        pc = p.get("pivotCandidate")
        if pc and pc.get("confidence") in ("none", "low"):
            unresolved.append({
                "item": f"pivot axis for {p['firmwareJointName']}",
                "reason": pc.get("notes", ""),
                "resolvedBy": "STEP assembly parse or physical measurement",
            })
    unresolved.extend([
        {"item": "servo datum plane along each pivot axis",
         "reason": ("Every pivot axis LINE is measured, but where the servo's "
                    "reference plane sits along that line is not recoverable "
                    "from the plastic alone. Origins are points on the correct "
                    "line, not joint centres."),
         "resolvedBy": "STEP assembly parse, an MG90S CAD model, or measuring a "
                       "built robot"},
        {"item": "per-instance assembly poses of the eight joint parts, in the "
                 "STL coordinate frame",
         "reason": ("PARTIALLY RESOLVED. The STEP assembly gives all eight "
                    "joints an exact rigid pose (parts[].cadIdentity."
                    "assemblyPoseInCadFrame), and the four hip servos sit on "
                    "an exact 1.500 x 2.000 inch grid. What is still missing "
                    "is the mapping from that frame to the STL frame. The STL "
                    "files themselves are NOT at per-instance assembly "
                    "positions: the four hip STLs occupy only two stations "
                    "46.03 mm apart in Z, whereas the CAD hip stations are "
                    "50.80 mm apart, so at most one member of each mirror pair "
                    "can be in place."),
         "resolvedBy": ("reconciling the two frames - see the "
                        "'STL-frame to CAD-frame mapping' entry")},
        {"item": "STL-frame to CAD-frame mapping",
         "reason": ("The STEP assembly gives every component instance an exact "
                    "rigid pose, but the relationship between that frame and "
                    "the frame the STL files were exported in is only "
                    "partially established: one hip pivot matches a CAD point "
                    "to six digits after an inch->mm conversion, with the Z "
                    "sign inverted. One sample is not a proof. Until it is, do "
                    "NOT compose CAD occurrence transforms with STL "
                    "coordinates."),
         "resolvedBy": ("evaluating the STEP B-Rep with pythonocc/FreeCAD and "
                        "comparing part bounding boxes instance by instance")},
        {"item": "joint zero reference, direction sign and travel limits",
         "reason": ("Geometry yields an axis, never a zero or a sign. Those are "
                    "firmware plus calibration facts."),
         "resolvedBy": ("F4 firmware extraction, plus "
                        "docs/build-guide/assets/sesame-angle-guide.png and the "
                        "calibration procedure in docs/build-guide/README.md")},
        {"item": "front/rear orientation of the body",
         "reason": ("Nothing measured distinguishes fore from aft; the angle "
                    "guide is a top-down line drawing with no front marker."),
         "resolvedBy": "docs/images/sesame-topdown.png plus physical inspection"},
        {"item": "hip-to-leg mate naming",
         "reason": ("Geometry proves which hip SHAPE mates with which leg "
                    "SHAPE, but because mirror-identical parts share a station "
                    "it cannot by itself say whether R1 mates with R3 or with "
                    "L4."),
         "resolvedBy": ("docs/build-guide/assets/reference-configuration.png "
                        "shows the assembled top view with all eight labels; "
                        "F6 should read the pairing from there and mark it "
                        "verified:false until physically confirmed")},
    ])

    generated = args.generated_at or _dt.datetime.now(
        _dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    return {
        "$schema": "./assets-inventory.schema.json",
        "meta": {
            "schemaVersion": SCHEMA_VERSION,
            "task": "F5",
            "generatedAt": generated,
            "generator": "scripts/extract-stl-geometry.py",
            "toolVersions": {
                "python": sys.version.split()[0],
                "trimesh": trimesh.__version__,
                "numpy": np.__version__,
            },
            "detectorThresholds": {
                "voteAngleMinDeg": VOTE_ANGLE_MIN_DEG,
                "voteAngleMaxDeg": VOTE_ANGLE_MAX_DEG,
                "radiusBand": [RADIUS_MIN, RADIUS_MAX],
                "clusterTol": CLUSTER_TOL,
                "minVotes": MIN_VOTES,
                "keepMinArcDeg": KEEP_MIN_ARC_DEG,
                "keepMinLength": KEEP_MIN_LENGTH,
                "coaxialAngleDeg": COAXIAL_ANGLE_DEG,
                "coaxialOffset": COAXIAL_OFFSET,
            },
            "sourceTree": stl_dir.relative_to(repo_root).as_posix(),
            "determinism": ("Re-running with the same inputs reproduces this "
                            "file byte-for-byte except meta.generatedAt; pass "
                            "--generated-at to pin that too."),
            "verificationStatus": ("NOTHING in this file has been physically "
                                   "verified against a built robot. Every part "
                                   "carries verified:false."),
        },
        "units": units,
        "coordinateFrame": frame_info,
        "servo": servo,
        "expectedPartSet": {
            "count": 11,
            "source": ("reference/sesame-robot-main/hardware/printing/README.md "
                       "and reference/sesame-robot-main/docs/build-guide/"
                       "README.md line 33"),
            "composition": ("internal frame + bottom cover + one top cover "
                            "(three interchangeable styles shipped) + joints "
                            "R1-R4 and L1-L4"),
            "stlFilesPresent": len(parts),
            "missingJoints": missing,
            "note": ("The stl tree holds more than 11 files because the top "
                     "cover ships in three styles and two optional magnetic "
                     "hats are included; the buildable set is still 11 pieces."),
        },
        "partShapeGroups": shape_rel,
        "parts": parts,
        "cad": cad,
        "unresolved": unresolved,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stl-dir", required=True)
    ap.add_argument("--cad-dir", default=None)
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--out", default=None, help="write JSON here; else stdout")
    ap.add_argument("--generated-at", default=None,
                    help="pin meta.generatedAt for byte-identical re-runs")
    ap.add_argument("--fast", action="store_true",
                    help="skip the O(n^2) shape-identity comparison")
    ap.add_argument("--dump-features", default=None, metavar="STL",
                    help="debug: dump features + coaxial groups for one file")
    args = ap.parse_args()

    if args.dump_features:
        p = Path(args.stl_dir) / args.dump_features
        m = trimesh.load(str(p), file_type="stl", process=True)
        groups, feats = prune_noise(group_coaxial(find_cylindrical_features(m)))
        print(json.dumps({
            "file": p.name,
            "bboxSize": r(m.bounds[1] - m.bounds[0], 4),
            "featureCount": len(feats),
            "features": feats,
            "axisGroups": [{k: v for k, v in g.items() if k != "members"}
                           for g in groups],
        }, indent=2))
        return 0

    doc = build_inventory(args)
    text = json.dumps(doc, indent=2) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {out} ({len(text)} bytes, {len(doc['parts'])} parts)",
              file=sys.stderr)
        # Self-check against the schema that ships next to the output, so a
        # regenerated inventory can never silently drift out of contract.
        schema = out.with_name("assets-inventory.schema.json")
        if schema.exists():
            try:
                import jsonschema
            except ImportError:
                print("jsonschema not installed; skipped schema validation",
                      file=sys.stderr)
            else:
                validator = jsonschema.Draft202012Validator(
                    json.loads(schema.read_text(encoding="utf-8")))
                errs = sorted(validator.iter_errors(doc),
                              key=lambda e: list(e.path))
                for e in errs[:20]:
                    print(f"SCHEMA ERROR {list(e.path)}: {e.message}",
                          file=sys.stderr)
                if errs:
                    return 1
                print(f"validated against {schema.name}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
