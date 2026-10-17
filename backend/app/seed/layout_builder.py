"""Builds supermarket floor plans (fixtures, walkable graph and shelf locations) from a few parameters.

``build_layout`` is used by the store-onboarding layout builder; ``build_standard_layout`` is the
demo seed's sample plan (6 aisles, 40 m x 30 m). Coordinates are metres, x to the right and y
downwards (SVG convention). The default spec reproduces this plan exactly:

    y=0   ┌──────────────── back wall: Dairy & Eggs chillers (D) ───────────────┐
    y=3   │ B0 ─ B1 ─ ... back walkway ... ─ B6 ─ B7                             │
          │ P  |A1|  |A2|  |A3|  |A4|  |A5|  |A6|                     F (frozen) │
    y=5-20│ (produce/bakery wall)  aisles with shelf faces L/R, 4 sections         │
    y=21  │      E1    E2    E3    E4    E5   (endcaps facing the front walkway)   │
    y=22  │ F0 ─ F1 ─ FE1 ─ F2 ─ ... front walkway ...                ─ F7       │
    y=25  │ ENT              CLR (clearance)          checkouts C1-C3   EXIT      │
    y=30  └──────────────────────────────────────────────────────────────────────┘

Shelf codes follow ``<aisle>-<side>-<section>-<level>`` (e.g. ``A3-L-2-4``); walls use ``D``
(dairy chillers), ``P`` (produce wall) and ``Z`` (freezers); ``E<k>`` endcaps; ``CLR-1-1`` clearance.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.db.models import LayoutFixture, NavEdge, NavNode, ShelfLocation, StoreLayout

LEFT_X, BACK_Y, AISLE_TOP = 2.8, 3.0, 5.0
AISLE_SPACING, SECTION_LEN = 5.0, 3.75
LEVEL_HEIGHT_CM = {1: 20, 2: 60, 3: 100, 4: 140, 5: 180, 6: 210}


@dataclass(frozen=True)
class LayoutSpec:
    aisles: int = 6
    sections: int = 4
    levels: int = 5
    dairy_wall: bool = True
    produce_wall: bool = True
    frozen_wall: bool = True
    checkouts: int = 3

    def validate(self) -> None:
        if not 1 <= self.aisles <= 12:
            raise ValueError("aisles must be between 1 and 12")
        if not 2 <= self.sections <= 8:
            raise ValueError("sections must be between 2 and 8")
        if not 2 <= self.levels <= 6:
            raise ValueError("levels must be between 2 and 6")
        if not 1 <= self.checkouts <= 8:
            raise ValueError("checkouts must be between 1 and 8")

    # derived geometry -------------------------------------------------------------------------
    @property
    def aisle_x(self) -> list[float]:
        return [7.0 + AISLE_SPACING * i for i in range(self.aisles)]

    @property
    def right_x(self) -> float:
        return self.aisle_x[-1] + 4.5

    @property
    def width(self) -> float:
        return max(self.right_x + 3.5, 6.0 + 2.6 * self.checkouts + 12.0)

    @property
    def aisle_len(self) -> float:
        return SECTION_LEN * self.sections

    @property
    def front_y(self) -> float:
        return AISLE_TOP + self.aisle_len + 2.0

    @property
    def height(self) -> float:
        return self.front_y + 8.0


def build_layout(db: Session, store_id: uuid.UUID, spec: LayoutSpec, *, name: str, version: int = 1,
                 status: str = "active", created_by_id: uuid.UUID | None = None,
                 notes: str | None = None) -> tuple[StoreLayout, dict[str, ShelfLocation]]:
    spec.validate()
    aisle_x, right_x, width, height = spec.aisle_x, spec.right_x, spec.width, spec.height
    front_y, aisle_end = spec.front_y, AISLE_TOP + spec.aisle_len
    section_y = [AISLE_TOP + SECTION_LEN * (s - 0.5) for s in range(1, spec.sections + 1)]
    wall_sections = max(2, spec.sections - 1)
    wall_step = spec.aisle_len / wall_sections
    wall_y = [AISLE_TOP + wall_step * (k - 1) + wall_step * 0.6 for k in range(1, wall_sections + 1)]

    layout = StoreLayout(store_id=store_id, name=name, version=version, status=status, width_m=width,
                         height_m=height, created_by_id=created_by_id, notes=notes)
    db.add(layout)
    db.flush()

    nodes: dict[str, NavNode] = {}

    def node(code: str, x: float, y: float, kind: str = "walkway", label: str | None = None) -> NavNode:
        n = NavNode(layout_id=layout.id, code=code, x=round(x, 2), y=round(y, 2), kind=kind, label=label)
        db.add(n)
        nodes[code] = n
        return n

    edges: list[tuple[str, str, bool]] = []

    def edge(a: str, b: str, accessible: bool = True) -> None:
        edges.append((a, b, accessible))

    def nearest(codes: list[str], x: float) -> str:
        return min(codes, key=lambda c: abs(nodes[c].x - x))

    # Front walkway chain (aisle mouths + endcap access points)
    front_codes = ["F0"]
    node("F0", LEFT_X, front_y, label="the front walkway")
    for i, x in enumerate(aisle_x, start=1):
        node(f"F{i}", x, front_y, label=f"Aisle {i}")
        front_codes.append(f"F{i}")
        if i < len(aisle_x):
            node(f"FE{i}", x + 2.5, front_y, label="the front walkway")
            front_codes.append(f"FE{i}")
    last = f"F{len(aisle_x) + 1}"
    node(last, right_x, front_y, label="the front walkway")
    front_codes.append(last)
    for a, b in zip(front_codes, front_codes[1:], strict=False):
        edge(a, b)

    # Back walkway
    back_codes = ["B0"]
    node("B0", LEFT_X, BACK_Y, label="the back walkway")
    for i, x in enumerate(aisle_x, start=1):
        node(f"B{i}", x, BACK_Y, label=f"Aisle {i}")
        back_codes.append(f"B{i}")
    back_last = f"B{len(aisle_x) + 1}"
    node(back_last, right_x, BACK_Y, label="the back walkway")
    back_codes.append(back_last)
    for a, b in zip(back_codes, back_codes[1:], strict=False):
        edge(a, b)

    # Aisles
    for i, x in enumerate(aisle_x, start=1):
        prev = f"B{i}"
        for s, y in enumerate(section_y, start=1):
            code = f"A{i}-{s}"
            node(code, x, y, label=f"Aisle {i}")
            edge(prev, code)
            prev = code
        edge(prev, f"F{i}")

    # Perimeter walkways
    left_label = "the produce & bakery wall" if spec.produce_wall else "the left walkway"
    right_label = "the frozen wall" if spec.frozen_wall else "the right walkway"
    prev_l, prev_r = "B0", back_last
    for s, y in enumerate(wall_y, start=1):
        node(f"L{s}", LEFT_X, y, label=left_label)
        node(f"R{s}", right_x, y, label=right_label)
        edge(prev_l, f"L{s}")
        edge(prev_r, f"R{s}")
        prev_l, prev_r = f"L{s}", f"R{s}"
    edge(prev_l, "F0")
    edge(prev_r, last)

    # Entrance, clearance point, checkout and exit
    mid_x, chk_x = width / 2, width - 9.0
    aisle_mouths = [f"F{i}" for i in range(1, len(aisle_x) + 1)]
    endcap_points = [f"FE{i}" for i in range(1, len(aisle_x))]
    node("ENT", 3.5, front_y + 5.5, kind="entrance", label="the entrance")
    node("CLRN", mid_x, front_y + 2.5, label="the clearance bin")
    node("CHK", chk_x, front_y + 2.5, kind="checkout", label="the checkouts")
    node("EXIT", width - 3.0, front_y + 5.5, kind="exit", label="the exit")
    edge("ENT", "F0")
    edge("ENT", "F1")
    edge("CLRN", nearest(aisle_mouths, mid_x))
    if endcap_points:
        edge("CLRN", nearest(endcap_points, mid_x))
    edge("CHK", nearest(aisle_mouths, chk_x))
    if endcap_points:
        edge("CHK", nearest(endcap_points, chk_x))
    edge("CHK", last)
    edge("CHK", "EXIT")
    db.flush()
    seen: set[tuple[str, str]] = set()
    for a, b, acc in edges:
        if (a, b) in seen or (b, a) in seen or a == b:
            continue
        seen.add((a, b))
        na, nb = nodes[a], nodes[b]
        db.add(NavEdge(layout_id=layout.id, from_node_id=na.id, to_node_id=nb.id,
                       distance_m=round(math.hypot(na.x - nb.x, na.y - nb.y), 2), is_accessible=acc))

    # Fixtures & shelf locations
    shelves: dict[str, ShelfLocation] = {}

    def fixture(code: str, kind: str, label: str, x: float, y: float, w: float, h: float, levels: int = 1,
                aisle: str | None = None, chilled: bool = False, movable: bool = False, props: dict | None = None) -> LayoutFixture:
        f = LayoutFixture(layout_id=layout.id, code=code, kind=kind, label=label, x=round(x, 2), y=round(y, 2),
                          width=round(w, 2), height=round(h, 2), levels=levels, aisle_code=aisle, is_chilled=chilled,
                          is_movable=movable, properties=props or {})
        db.add(f)
        return f

    def shelf(f: LayoutFixture, code: str, aisle: str | None, section: int, level: int, x: float, y: float,
              access: str, clearance: bool = False, capacity: int = 6) -> None:
        sl = ShelfLocation(layout_id=layout.id, fixture=f, code=code, aisle_code=aisle, section=section, level=level,
                           height_cm=LEVEL_HEIGHT_CM.get(level, 60), x=round(x, 2), y=round(y, 2),
                           capacity_facings=capacity, access_node_id=nodes[access].id, is_clearance=clearance)
        db.add(sl)
        shelves[code] = sl

    for i, x in enumerate(aisle_x, start=1):
        aisle = f"A{i}"
        for side, fx in (("L", x - 2.0), ("R", x + 1.2)):
            f = fixture(f"{aisle}-{side}", "aisle_shelf", f"Aisle {i} {'left' if side == 'L' else 'right'}",
                        fx, AISLE_TOP, 0.8, spec.aisle_len, levels=spec.levels, aisle=aisle)
            for s, y in enumerate(section_y, start=1):
                for lvl in range(1, spec.levels + 1):
                    shelf(f, f"{aisle}-{side}-{s}-{lvl}", aisle, s, lvl, fx + 0.4, y, f"{aisle}-{s}")

    if spec.dairy_wall:
        dairy_len = max(4.0, right_x - 2.5 - 6.0)
        n_sec = max(1, round(dairy_len / 4.0))
        step = dairy_len / n_sec
        dairy = fixture("D", "chiller", "Dairy & eggs chillers", 6.0, 0.4, dairy_len, 1.0, levels=4, chilled=True)
        for s in range(1, n_sec + 1):
            cx = 6.0 + (s - 0.5) * step
            for lvl in range(1, 5):
                shelf(dairy, f"D-{s}-{lvl}", "D", s, lvl, cx, 0.9, nearest(back_codes, cx), capacity=8)

    if spec.produce_wall:
        produce = fixture("P", "wall_shelf", "Produce & bakery wall", 0.4, AISLE_TOP, 1.0, spec.aisle_len, levels=3)
        for s, y in enumerate(wall_y, start=1):
            for lvl in range(1, 4):
                shelf(produce, f"P-{s}-{lvl}", "P", s, lvl, 0.9, y, f"L{s}", capacity=8)

    if spec.frozen_wall:
        frozen = fixture("Z", "freezer", "Frozen foods", width - 1.4, AISLE_TOP, 1.0, spec.aisle_len, levels=3,
                         chilled=True)
        for s, y in enumerate(wall_y, start=1):
            for lvl in range(1, 4):
                shelf(frozen, f"Z-{s}-{lvl}", "Z", s, lvl, width - 0.9, y, f"R{s}")

    for k in range(1, len(aisle_x)):
        gx = aisle_x[k - 1] + 1.2
        f = fixture(f"E{k}", "endcap", f"Endcap {k}", gx, aisle_end + 0.4, 2.6, 0.8, levels=3, movable=True)
        for lvl in range(1, 4):
            shelf(f, f"E{k}-1-{lvl}", f"E{k}", 1, lvl, gx + 1.3, aisle_end + 0.8, f"FE{k}", capacity=4)

    clr = fixture("CLR", "clearance", "Clearance bin", mid_x - 1.2, front_y + 1.6, 2.4, 1.2, levels=1, movable=True)
    shelf(clr, "CLR-1-1", "CLR", 1, 1, mid_x, front_y + 2.2, "CLRN", clearance=True, capacity=12)

    for c in range(1, spec.checkouts + 1):
        fixture(f"C{c}", "checkout", f"Checkout {c}", chk_x - 3.0 + (c - 1) * 2.6, front_y + 3.5, 1.6, 2.2)
    fixture("ENTR", "entrance", "Entrance", 1.5, height - 1.4, 4.0, 1.2)
    fixture("EXT", "exit", "Exit", width - 5.0, height - 1.4, 4.0, 1.2)
    db.flush()
    return layout, shelves


def build_standard_layout(db: Session, store_id: uuid.UUID, name: str = "Main floor v1",
                          created_by_id: uuid.UUID | None = None) -> tuple[StoreLayout, dict[str, ShelfLocation]]:
    return build_layout(db, store_id, LayoutSpec(), name=name, created_by_id=created_by_id,
                        notes="Sample floor plan generated by the demo seed.")
