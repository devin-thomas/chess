# 3D Presentation and Asset Requirements

Status: draft normative specification

This document translates the chess rules project into machine-facing requirements for a future 3D presentation layer. It is intentionally language agnostic. A C, C++, Rust, or other implementation may choose different in-memory types, but it must preserve the boundaries and observable behavior below.

`SPEC.md` is the preserved authoritative source for orthodox chess rules, state, commands, and adjudication. This document consumes a read-only projection of that source; it does not amend `SPEC.md`, add spatial chess rules, or make geometry part of legality.

## 1. Scope and non-goals

The system presents orthodox chess on a three-dimensional board. It does not make the rules three-dimensional: legal movement still operates on the 8-by-8 board, and geometry never participates in legality, check detection, repetition, or draw decisions.

The presentation layer is responsible for:

- selecting and placing piece visuals;
- drawing the board, coordinates, highlights, and optional scenery;
- turning accepted rules outcomes into readable movement and capture animations;
- handling camera and display input;
- selecting platform derivatives and fallbacks; and
- exposing measurable resource usage.

The presentation layer is not responsible for:

- deciding whether a move is legal;
- owning canonical piece placement;
- inventing a capture or promotion that is absent from the committed rules transition;
- storing GPU-specific handles in the rules state; or
- requiring runtime access to Blender, glTF, OBJ, JSON, or a dynamic mesh allocator.

## 2. Stable machine boundary

### 2.1 Rule state input

The adapter MUST consume a read-only presentation projection of the authoritative `SPEC.md` `GameState` and current `Position`. It MUST use the canonical board order defined there: exactly 64 cells from `a1` through `h8`. At minimum, the projection MUST expose:

- the selected mode, side to move, status, check, outcome, and terminal event;
- a piece type and color for every occupied square;
- all four castling rights;
- the raw `en_passant_target`, plus either the effective legally usable target or the authoritative legal-move data needed to distinguish it;
- halfmove and fullmove counters;
- the rules `revision` and current move-ledger boundary (`after_ply`); and
- the resulting position key when replay or stale-state diagnostics require it.

`SPEC.md` deliberately represents occupied cells as `{color, type}` and does not require piece IDs. The presentation adapter therefore owns the identity map described below. If a rules implementation exposes IDs as an extension, the adapter MAY use them, but the renderer MUST NOT depend on private rule-engine structures or on that extension.

The rules implementation MAY use a different internal representation, but the adapter MUST produce a deterministic presentation projection from the public state/command seams. A display orientation, camera, mesh, or asset choice MUST NOT change the canonical square or rules meaning.

### 2.2 Stable piece identity

Every occupied square in a presentation projection MUST have an opaque stable `PieceIdentity`. For a new standard game, the adapter assigns identities to the initial 32 pieces; for a setup position with no identity sidecar, it assigns identities deterministically in canonical square order and records that the identities are projection-local. The adapter MUST persist the map in its presentation snapshot or sidecar whenever replay continuity matters.

An identity MUST survive an ordinary move and the two independent piece effects of castling. A capture retires the captured identity. The baseline contract chooses identity preservation for promotion: the moving pawn keeps its identity while its `piece_type` and visual asset change. This is a presentation handle, not a claim that `SPEC.md`'s board cell retains the pawn object.

`new`, `restore`, or replacement of the upstream rules state begins a new `state_epoch`. A restore that includes a matching presentation sidecar MAY preserve identities; a rules-only restore MUST rebuild a deterministic projection and MUST NOT continue an in-flight animation as though its historical identity map were known.

A piece identity MUST NOT be derived from its current array position, mesh pointer, board square, or screen location. This allows an animation system to distinguish a moving rook from a newly promoted visual asset.

### 2.3 Normalized move record

For each committed `SPEC.md` move-ledger record, the adapter MUST expose an enriched `MoveRecord` with:

- `state_epoch`, source `ply`, actor, and stable event sequence;
- moving piece identity and original type;
- source and destination board squares;
- captured piece identity and capture square, if any;
- promotion type, if any;
- castling rook identity, rook source, and rook destination, if any;
- en passant capture square, when it differs from the destination; and
- rules-state revision before and after the move, plus the resulting `position_key` when available.

`SPEC.md` calls the submitted coordinate object a `Move` and identifies it by origin, destination, and optional promotion. The adapter enriches that public move using the pre-move projection, the committed ledger `kind`, and the post-move state. A rules implementation may provide the enriched fields directly, but the renderer MUST receive the same observable record either way.

The record MUST describe effects explicitly. A renderer MUST NOT infer en passant, rook movement, or a captured piece by comparing arbitrary meshes. For castling, the record names both the king and rook effects. For en passant, it names the removed pawn's square. For capture-promotion, it contains both the capture and promotion effects.

### 2.4 Presentation event stream

The adapter MUST emit a deterministic sequence of `PresentationEvent` values from the `SPEC.md` `execute` result, committed move ledger, and before/after projections. The rules source need not grow graphics-specific events: these are read-only presentation projections of authoritative state transitions. At minimum, the event vocabulary MUST cover:

- `state_reset_or_load` for `new` and `restore`;
- `move_accepted` with the complete `MoveRecord`;
- `move_rejected` with the stable command error code as a non-committed UI diagnostic;
- `capture`;
- `promotion`;
- `castling`;
- `en_passant`;
- `check`;
- `checkmate`;
- `stalemate`; and
- a draw outcome carrying the `SPEC.md` terminal-event reason.

For a committed move, the adapter MUST use this event order: `move_accepted`, the applicable piece effects (`capture` or `en_passant`, `castling`, then `promotion`), a resulting `check` event when present, and the resulting terminal/draw event when present. A capture-promotion therefore has both effects. `checkmate` and `stalemate` are terminal results, not additional legal moves.

Every committed event MUST carry `state_epoch`, `event_sequence`, `revision_before`, `revision_after`, and `after_ply`. A reset/load event starts a new epoch and may use null revision-before/after values when no mutation relation exists. `event_sequence`, not `revision`, orders events across reset/load boundaries because `SPEC.md` allows `restore` to preserve the snapshot revision. A rejected request MUST NOT enter the committed replay stream, change a ply or revision, or start an animation; it MAY be surfaced separately as the diagnostic above.

Renderers MAY delay, blend, skip, or simplify animation, but they MUST NOT change event order, create rule outcomes, or feed a visual result back into the rules state.

### 2.5 Rules-source crosswalk

The adapter MUST preserve this mapping when translating the rules source into presentation data:

| `SPEC.md` source | Presentation projection |
|---|---|
| `GameState` and current `Position` | Read-only `RuleState` input |
| 64-cell `board` in `a1` through `h8` order | Canonical `Board Square` occupancy; display orientation is separate |
| `Move` plus committed ledger `kind` and `ply` | Enriched `MoveRecord` with piece effects |
| `revision` | Event revision fields within a `state_epoch` |
| `terminal_event` and `outcome` | Checkmate, stalemate, draw, resignation, or timeout presentation outcomes |
| raw `en_passant_target` and effective position-key rule | Raw state for diagnostics; effective/legal data for highlights |
| `position_key` | Replay/stale-state identity; never a mesh or visual identity |
| rejected command error | Non-committed UI diagnostic; no chess event or animation |

The projection MUST preserve the `SPEC.md` distinction between a raw en-passant target and a legally usable en-passant move. A highlight may use only effective legal destinations. `SPEC.md` explicitly places board art and animations out of scope; this document supplies their adapter contract without moving those concerns into the rules core.

## 3. Presentation snapshot

The renderer SHOULD consume a compact `PresentationSnapshot` generated from rule state plus the event stream. The conceptual fields are:

```text
PresentationSnapshot {
    state_epoch
    rules_revision
    after_ply
    status
    check
    outcome
    raw_en_passant_target
    effective_en_passant_target
    board_orientation
    pieces[] {
        piece_identity
        piece_type
        color
        board_square
        visual_asset_id
        pose_state
        visibility
        selection_state
    }
    highlights[] {
        board_square
        highlight_kind
        source_piece_identity
    }
    active_animation {
        event_sequence
        animation_kind
        progress_tick
        duration_ticks
    }
}
```

`board_square` is the canonical location. World-space position is derived by the renderer from board orientation, board origin, square spacing, and piece pivot. The snapshot MUST remain valid if the camera changes. `effective_en_passant_target` and legal-destination highlights MUST be derived from legal rules data, never from the raw target alone.

The renderer MUST provide a visible fallback for an unknown `visual_asset_id`: a colored primitive or text/debug marker with the correct piece type and color. Missing presentation content must not produce a silent empty square.

## 4. Asset contract

### 4.1 Canonical authoring form

Each canonical chess piece set SHOULD be authored as a clean, editable scene with:

- six piece types, not twelve duplicated meshes;
- a shared origin and a documented board-relative scale;
- a documented ground contact plane;
- a documented rotation pivot suitable for a move animation;
- outward, consistently wound faces;
- applied object transforms;
- explicit material slots for side, accent, and board contact;
- a low-poly source or a reproducible reduction recipe;
- an optional high-detail source used only to bake color or ambient-occlusion detail; and
- a provenance record adjacent to the source file.

The canonical source MAY be Blender, another open authoring tool, or a procedural generator. It MUST NOT be treated as a runtime dependency.

### 4.2 Platform derivative manifest

Every generated derivative MUST have a machine-readable manifest with at least:

```text
asset_id
source_asset_id
source_hash
source_url
source_version_or_commit
license_identifier
attribution_text
modification_summary
generator_version
target_profile
mesh_lod
vertex_count
triangle_count
material_count
texture_count
texture_formats[]
payload_bytes
validation_status
```

The manifest MUST make it possible to answer: what source was used, under what license, what was changed, which tool generated the derivative, and whether the derivative passed the target profile.

### 4.3 Geometry requirements

The converter MUST validate:

- no unreferenced vertices unless the target format requires them;
- indices within the vertex range;
- finite coordinates;
- consistent winding and a declared front-face convention;
- no degenerate triangles after quantization;
- a bounded local coordinate range;
- a known pivot and base plane; and
- deterministic output for identical source, settings, and tool version.

The converter SHOULD split meshes by material only when the target renderer benefits from the split. It SHOULD prefer per-face or per-vertex color over a texture when a platform can achieve the desired look without consuming texture memory.

### 4.4 Texture requirements

Textures MUST be authored as platform-neutral source images and converted offline. A target derivative MUST declare dimensions, color format, transparency policy, palette or CLUT data, filtering mode, and placement/alignment requirements.

The pipeline MUST reject accidental PBR dependencies. Roughness, metallic, normal, displacement, and procedural shader graphs may be used to produce a source render or bake, but the console derivative must resolve to the target's supported color and texture inputs.

Texture padding and UV island margins MUST be applied before downsampling or target conversion when filtering could sample across a seam.

### 4.5 Animation requirements

The initial chess presentation MUST use rigid transforms and deterministic keyframes rather than requiring skeletal animation. A move animation may include lift, travel, settle, capture removal, castling second-piece motion, and promotion visual replacement while preserving the promoted piece identity, but each stage MUST be driven by the normalized `MoveRecord`.

The animation system MUST support a no-animation profile that applies the final board state immediately. It MUST also support a fixed-tick profile so replays and low-frame-rate targets do not change the sequence of rule outcomes.

## 5. PS1 render profile

The PS1 profile targets the retail baseline: 2 MiB main RAM and 1 MiB VRAM, with VRAM shared by framebuffers, textures, palettes, and drawing data. The profile MUST treat ordering-table and packet memory as explicit budgets. It MUST not assume arcade or expanded-VRAM behavior.

The PS1 renderer SHOULD initially use untextured flat or Gouraud-shaded triangles/quads for the board and pieces. Textured pieces are allowed only after a TIM/VRAM layout and palette budget are validated.

The PS1 derivative SHOULD expose:

- quantized integer vertex positions compatible with the GTE input convention;
- indexed triangle data expanded or cached into the primitive form the renderer submits;
- per-face or per-vertex color data;
- optional UV, texture-page, and CLUT references;
- a local origin suitable for camera-relative transforms; and
- no runtime dependency on TMD loading unless a later implementation explicitly chooses it.

Starting content budgets are provisional acceptance targets, not hardware guarantees:

| Item | PS1 starting target |
|---|---:|
| Full-board visible triangles, initial profile | <= 1,024 |
| Submitted scene triangles before culling, initial profile | <= 2,048 |
| Unique piece mesh, near LOD | <= 128 vertices, <= 192 triangles |
| Unique piece mesh, board LOD | <= 80 vertices, <= 128 triangles |
| Board surface | <= 128 triangles before decoration |
| Material/color groups per piece | <= 4 |
| Texture pages per complete piece set | 0 for baseline; <= 4 for a textured experiment |
| Texture and CLUT residency for initial scene | <= 512 KiB |
| OT depth buckets, initial profile | 256 |
| Simultaneously animated rigid pieces | <= 4 |
| Runtime mesh allocations | 0 in the gameplay/render loop |
| Presentation tick | 30 Hz minimum; 60 Hz target; missed-frame count measured |

The full-board triangle limits are scene-level first-pass targets; near-LOD limits apply only to selected or close pieces and MUST NOT be multiplied across all 32 pieces. The normal camera should use board LOD for distant pieces. The profile MUST include a fallback LOD or primitive representation. If packet or ordering-table pressure exceeds the configured budget, the renderer MUST degrade by reducing view detail, material work, or animation effects and MUST expose a diagnostic counter. It MUST NOT write past fixed buffers.

The PS1 board coordinate mapping MUST be camera-independent and testable: the same square and orientation always resolve to the same local board coordinates before camera projection. Long-lived world positions SHOULD be rebased around the camera or board focus before entering limited-width transform inputs.

## 6. Dreamcast render profile

The Dreamcast profile targets a retail Dreamcast with 16 MiB system RAM and 8 MiB PVR VRAM. KallistiOS exposes the PVR as a low-level API; the renderer is responsible for perspective transforms, scene organization, texture allocation, and primitive submission.

The Dreamcast derivative SHOULD use KallistiOS PVR-native data at the final build boundary:

- aligned PVR vertex/strip data;
- opaque polygon lists for board and opaque pieces;
- explicit translucent/punch-through lists only when needed;
- target-supported ARGB1555, RGB565, ARGB4444, paletted, or VQ texture choices;
- twiddled/power-of-two or declared stride settings; and
- PVR texture addresses resolved at load time, not embedded as host pointers.

The Dreamcast profile SHOULD prefer a small number of shared piece meshes and materials over one unique mesh per board square. It MAY use higher geometry density than the PS1 profile, but it MUST retain a low-detail fallback so the same presentation snapshot remains playable under stress.

Starting content budgets are provisional:

| Item | Dreamcast starting target |
|---|---:|
| Full-board visible triangles, initial profile | <= 4,096 |
| Submitted scene triangles before culling, initial profile | <= 8,192 |
| Unique piece mesh, near LOD | <= 256 vertices, <= 384 triangles |
| Unique piece mesh, board LOD | <= 128 vertices, <= 192 triangles |
| Board surface | <= 256 triangles before decoration |
| Material groups per piece | <= 6 |
| Texture resolution per piece atlas | <= 128x128 until profiled |
| Complete piece texture set | <= 1 MiB of PVR payload before board/HUD allocation |
| Complete initial scene texture residency | <= 2 MiB before non-scene allocations |
| Runtime mesh allocations | 0 after asset load |
| Presentation tick | 60 Hz target; PVR/CPU timing measured |

These targets are intentionally conservative starting points. The final values MUST be established by an instrumented worst-case board and animation run, not by comparison with modern hardware.

## 7. Shared board and scene requirements

The board MUST be represented as one logical 8-by-8 coordinate surface even if the renderer chooses separate tile primitives. A renderer MUST be able to draw:

- board colors and side/edge trim;
- selected square;
- legal destination highlight;
- last-move source and destination;
- check or checkmate emphasis; and
- promotion UI or a platform-appropriate substitute.

Board decoration, lighting approximation, fog, particles, and camera shake MUST be presentation-only. They MUST be disableable independently of the rules core.

The scene MUST have a deterministic camera-neutral framing mode for tests. A platform may add free orbit, zoom, or cinematic cameras, but a default camera profile MUST make all 64 squares and the active piece readable at the target output resolution.

## 8. Offline pipeline requirements

The recommended pipeline is:

```text
canonical source or procedural generator
        -> geometry cleanup and scale validation
        -> target LOD generation
        -> UV/material reduction and optional bake
        -> PS1 and Dreamcast packers
        -> manifest, license bundle, and validation report
        -> checked-in or reproducibly generated console assets
```

The pipeline MUST be runnable without network access after source assets and tools are present. It MUST pin or record tool versions and source hashes. It MUST preserve source files separately from generated derivatives.

The pipeline SHOULD use CC0 or public-domain sources for the initial piece library. CC-BY sources are acceptable only when attribution can ship with the product and the derivative record is complete. Assets with unclear provenance, no explicit license, ND restrictions, or terms that forbid redistribution MUST be rejected from the shipped set.

The pipeline MUST emit a human-readable attribution file even when a license does not require credit. This makes later audits and platform packaging safer.

## 9. Acceptance tests

### Rules/presentation separation

- Replaying the same accepted move list produces the same event sequence and final `RuleState` regardless of renderer.
- Removing all meshes and textures still leaves a readable placeholder board and piece identities.
- A renderer cannot make an illegal move legal by changing camera, LOD, or asset availability.

### Asset conversion

- Every canonical asset has a provenance record and source hash.
- Every derivative passes bounds, winding, index, material, texture, and byte-budget validation.
- Two conversions with identical inputs produce byte-identical output or a documented normalized equivalent.
- A deliberately over-budget mesh fails or selects the documented fallback; it never silently truncates geometry.

### Chess presentation coverage

The worst-case fixture set MUST include:

- the initial position with all 32 pieces;
- a crowded middlegame position;
- castling on both sides;
- en passant;
- promotion with capture and without capture;
- simultaneous move and capture animation;
- check, checkmate, stalemate, and draw indicators;
- board orientation reversal;
- camera changes during an animation; and
- no-animation mode.

### Platform validation

PS1 and Dreamcast smoke tests MUST record, at minimum:

- active asset IDs;
- visible piece count;
- submitted vertex/triangle/primitive count;
- texture and palette bytes;
- renderer-local memory high-water marks;
- missed frame or wait counts; and
- fallback/degradation count.

The same fixture positions MUST be run through both profiles. A visual difference is acceptable; a difference in piece identity, square occupancy, event order, or final board state is not.

## 10. Open decisions

The following remain intentionally open until a first asset pack and renderer probe exist:

- whether the canonical source is Blender-only or Blender plus a procedural generator;
- whether PS1 assets are stored as custom packed meshes, TMD-like records, or generated C;
- whether Dreamcast textures use VQ for the initial release or only for larger scenery;
- exact piece LOD thresholds and camera distances;
- whether board coordinates are geometry, texture, or HUD overlays;
- final animation tick durations; and
- whether the product ships one visual style or multiple interchangeable asset packs.

These decisions MUST NOT leak into the chess rules model.
