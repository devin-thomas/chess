# 3D Modeling and Platform Integration Path

Draft research report for the language-agnostic chess rules specification and its eventual PlayStation 1 (PS1) and Dreamcast renderers.

- Status: draft
- Research date: 2026-08-21
- Scope: model/texture authoring, runtime packet generation, batching, fixed-point concerns, and an asset contract
- Source policy: primary or first-party material is preferred. Community references are labeled where they are used to fill in hardware details.

## Executive direction

Keep the rules specification independent of rendering, and define a small canonical scene-asset format beside it. The canonical format should describe rigid triangle meshes, material groups, indexed textures, pivots, and animation transforms. Platform backends should compile that description into PS1 GPU packets/TIM-like texture uploads or Dreamcast PowerVR lists/textures.

The PS1 should be the lower common denominator. It has 1 MiB of VRAM organized as a 1024x512x16-bit framebuffer shared by display/drawing areas, textures, and CLUTs; it has no hardware Z-buffer or perspective-correct texture interpolation, and its command-stream GPU is fed from main memory. The Dreamcast backend can add higher LODs, bilinear/trilinear filtering, mipmaps, and VQ textures, but none of those should be required by the shared contract.

For chess pieces, use rigid instances and a small number of mesh archetypes rather than skeletal animation. A piece instance needs only a mesh ID, material variant, transform, and optional animation clip/time. This keeps the rules layer language-agnostic and gives the PS1 backend a predictable CPU-side transform and sort path.

## Evidence boundary and source quality

The original Sony documentation is no longer hosted by Sony in a stable public developer portal. The following URLs are mirrors of Sony/SCE documents or scans of first-party developer material:

- [Sony/SCE Run-Time Library Overview, LIBOVR46](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf) - libgpu/libgte/libgs primitives, ordering tables, texture cache, fixed-point formats, polygon division, and double buffering.
- [Sony/SCE File Formats, release 4.7](https://psx.arthus.net/sdk/Psy-Q/DOCS/FileFormat47.pdf) - RSD, TMD, PMD, TOD, HMD, and TIM format specifications.
- [Sony/SCE Developer References: File Formats](https://psx.arthus.net/sdk/Psy-Q/DOCS/Devrefs/Filefrmt.pdf) - overview of the model pipeline and TMD coordinate/file structure.
- [SCEA March 1996 Advanced GPU presentation](https://psx.arthus.net/sdk/Psy-Q/DOCS/CONF/SCEA/adv_gpu.pdf) - first-party performance guidance, DMA/FIFO behavior, texture cache observations, and polygon subdivision advice.
- [Sega Dreamcast Hardware Specification Outline](https://github.com/luckyseoul/dreamcast-docs/blob/main/files/official/Dreamcast_Hardware_Specification_Outline.pdf) - first-party system-level specifications, mirrored in a community archive.
- [Sega Dreamcast/Dev.Box System Architecture](https://github.com/luckyseoul/dreamcast-docs/blob/main/files/official/DreamcastDevBoxSystemArchitecture.pdf) - first-party architecture/development-box material, mirrored in a community archive.

The following are open-source implementation references, not first-party specifications:

- [PSX-SPX GPU reference](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/) - useful bitfield and hardware-behavior reference; treat emulator/reverse-engineering observations as implementation evidence, not as a Sony contract.
- [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK) - current open-source PS1 C/C++ toolchain, libraries, examples, and asset/build utilities.
- [PCSX-Redux PSYQo concepts](https://github.com/pcsx-redux/nugget/blob/main/psyqo/CONCEPTS.md) and [PSYQo getting started](https://github.com/grumpycoders/pcsx-redux/blob/main/src/mips/psyqo/GETTING_STARTED.md) - modern PS1 C++ rendering and ordering-table usage.
- [PsyCross](https://github.com/OpenDriver2/PsyCross) - open-source Psy-Q-compatible implementation useful for cross-platform testing and understanding how PS1 calls can be adapted to a modern renderer.
- [KallistiOS PVR primitive headers](https://kos-docs.dreamcast.wiki/group__pvr__primitives__headers.html), [PVR vertex type](https://kos-docs.dreamcast.wiki/structpvr__vertex__t.html), [PVR texture management](https://kos-docs.dreamcast.wiki/group__pvr__txr__mgmt.html), and [the upstream `dc/pvr.h` header](https://github.com/KallistiOS/KallistiOS/blob/master/kernel/arch/dreamcast/include/dc/pvr.h) - open-source Dreamcast API and hardware-facing data structures.

## Sourced facts: PS1

### Memory and display

Sony's Run-Time Library Overview describes a 1 MB high-speed video-memory area used for the display buffer, drawing area, textures, and color tables. The GPU renders into that framebuffer and consumes primitive instruction strings stored in main memory. The same document describes display/drawing double buffering and states that the drawing must complete within 1/60 second for that scheme to be effective. See [LIBOVR46, pp. 86-91](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

The community PSX-SPX reference records the practical framebuffer sizes: at 320x240 in 16-bit mode, one buffer is about 150 KB and two are about 300 KB. At 640x480 in 16-bit mode, one buffer requires 600 KiB and two require 1,200 KiB, exceeding the PS1's 1 MiB VRAM; double buffering therefore leaves no VRAM for textures or CLUTs. PSX-SPX also records the selectable horizontal modes (256, 320, 512, 640, and 368) and 240/480 vertical modes. See [PSX-SPX display and framebuffer details](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#gp108h-display-mode) and [VRAM tables](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#gpu-video-memory-vram).

Implication: a 320x240, 15-bit/16-bit, double-buffered target is the sensible baseline for the first PS1 renderer. It leaves a meaningful but still finite VRAM budget for indexed textures, CLUTs, and upload scratch space.

### Primitive and packet model

The official library exposes polygon primitives as flat or Gouraud, textured or untextured, with 3 or 4 vertices: `POLY_F3`, `POLY_FT3`, `POLY_G3`, `POLY_GT3`, `POLY_F4`, `POLY_FT4`, `POLY_G4`, and `POLY_GT4`. It also exposes line, sprite, and tile primitives. See [LIBOVR46, pp. 92-93](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

At the GPU command level, the first word selects polygon/line/rectangle, flat/Gouraud, 3/4 vertices, textured/untextured, and transparency/raw-texture flags. A textured polygon vertex carries an XY word and a UV/CLUT word; a Gouraud polygon adds a color word per vertex. See the [PSX-SPX polygon command layout](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#gpu-render-polygon-commands).

The GPU has a 64-byte (16-word) command FIFO. SCEA documents the FIFO and source-chain DMA; PSX-SPX documents DMA2-linked-list submission of ordering tables. See [Advanced GPU, pp. 11-20](https://psx.arthus.net/sdk/Psy-Q/DOCS/CONF/SCEA/adv_gpu.pdf) and [PSX-SPX depth ordering](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#gpu-depth-ordering).

The packet sizes that matter for an asset compiler can be derived from the command layout. Before any optional platform padding, the common packet payloads are approximately:

| Primitive | GP0 words | Approx. bytes |
| --- | ---: | ---: |
| flat triangle | 4 | 16 |
| flat textured triangle | 7 | 28 |
| Gouraud textured triangle | 10 | 40 |
| flat quad | 5 | 20 |
| flat textured quad | 9 | 36 |
| Gouraud textured quad | 12 | 48 |

The exact in-memory structure and alignment must come from the selected SDK (`POLY_*`/`PACKET` definitions), not from this table. The table is a budgeting aid for a language-agnostic compiler.

### Depth ordering and batching

The PS1 GPU stores color, not per-pixel depth. It is unaware of Z at rasterization time. The normal path is to place primitives in a depth ordering table (OT) in main RAM and submit the linked list to the GPU farthest-first. The official documentation describes an OT as an array of pointers to primitives and gives `AddPrim()`/`DrawOTag()` as the basic path. See [LIBOVR46, pp. 97-98](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf) and [the OT section of PSX-SPX](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#gpu-depth-ordering).

Sony's extended graphics documentation says `GsOT.length` is an exponent from 1 through 14; an OT therefore contains `2^length` depth graduations. The choice not to use a full 16-bit depth index is a design inference, not a statement made by the manual. See [LIBOVR46, pp. 159-160](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

Batching on PS1 therefore has two competing constraints:

1. Depth order is authoritative. A material batch cannot freely reorder primitives across depth buckets.
2. Texture-page, CLUT, draw-mode, and transparency changes should be grouped where the OT ordering permits it.

The SCEA presentation says that `MargePrim` concatenates primitives to fit the 16-word command FIFO, recommends avoiding slow drawing-mode primitives, and suggests using a textured polygon to change texture pages for sprites. See [Advanced GPU, pp. 36-46](https://psx.arthus.net/sdk/Psy-Q/DOCS/CONF/SCEA/adv_gpu.pdf).

Use two frame-owned primitive buffers and two OTs. The official library describes non-blocking `DrawPrim()` and `DrawOTag()` operations, background GPU work, and a maximum queue of 64 non-blocking functions. See [LIBOVR46, pp. 91-92](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

### Coordinates, fixed point, and texture interpolation

The Sony file-format documentation states that TMD object coordinates are signed 16-bit integers in the PS1 3D coordinate space. Its coordinate convention is +X right, +Y down, and +Z depth. It also says that authoring/RSD vertices are floating point and are converted/scaled into TMD values. See [Devrefs File Formats, TMD section](https://psx.arthus.net/sdk/Psy-Q/DOCS/Devrefs/Filefrmt.pdf) and [FileFormat47, Chapter 2](https://psx.arthus.net/sdk/Psy-Q/DOCS/FileFormat47.pdf).

The GTE uses fixed-point arguments. Sony documents rotation and light matrices as `(1,3,12)`, translations as `(1,31,0)`, and `SVECTOR` input positions as signed 16-bit integer components. See [LIBOVR46, pp. 143-144](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

The GPU's screen vertex encoding is integer XY. PSX-SPX records signed 11-bit X and Y fields and hardware span restrictions: a primitive whose vertex distance exceeds 1023 horizontally or 511 vertically may fail to render. See [PSX-SPX vertex attributes](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#vertex-parameter-for-polygon-line-rectangle-commands).

The PS1 GPU does not do perspective-correct texture mapping. UVs and Gouraud colors are linearly interpolated in screen space, so large or oblique textured polygons visibly distort. The official guidance is to subdivide large polygons; the SCEA presentation discusses 4x4 subdivision, and Sony's library includes `DivideFT3`/`DivideFT4` and related functions. See [PSX-SPX perspective behavior](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#perspective-in-correct-rendering) and [LIBOVR46, pp. 149-150](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

### Textures and cache behavior

PS1 textured polygons use 4-bit CLUT, 8-bit CLUT, or 15-bit direct color. A texture page is 256x256 texels, and polygon UVs are 8-bit, so a single polygon cannot address more than a 256x256 page. A 4-bit 256x256 page is 32 KB, an 8-bit page is 64 KB, and a 15-bit page is 128 KB. CLUTs are 16x1 or 256x1 entries. See [PSX-SPX texture bitmap and CLUT details](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#texture-bitmaps).

Sony documents a 2 KB texture cache with cache dimensions of 64x64 for 4-bit, 64x32 for 8-bit, and 32x32 for 16-bit textures. It also notes that cache hits are faster and that, on misses, 4-bit is faster than 8-bit, which is faster than 16-bit. See [LIBOVR46, pp. 109-111](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf).

Implication: atlas layout is a performance concern, not just a memory concern. Keep frequently co-rendered texels inside cache-friendly blocks and avoid making a single piece span many texture-page/cache-block boundaries.

## Sourced facts: Dreamcast

The mirrored Sega hardware outline lists a 200 MHz SH-4 CPU, a 100 MHz HOLLY graphics ASIC, 16 MB main memory, 8 MB texture memory, and PowerVR 2 features including Z buffering, fog, shadowing, edge anti-aliasing, and trilinear mipmaps. The outline reports headline figures of 3 million polygons/sec peak and 1.5 million visible polygons/sec. The Dev.Box document reports 1 million polygons/sec for 100-pixel triangles with a 75% opaque/25% translucent workload. These figures use different benchmark definitions and are not directly comparable or general scene budgets. See the [hardware outline](https://github.com/luckyseoul/dreamcast-docs/blob/main/files/official/Dreamcast_Hardware_Specification_Outline.pdf) and [Dev.Box System Architecture](https://github.com/luckyseoul/dreamcast-docs/blob/main/files/official/DreamcastDevBoxSystemArchitecture.pdf).

KallistiOS exposes the practical PowerVR model:

- `pvr_vertex_t` uses floating-point `x`, `y`, `z`, `u`, and `v`, plus packed vertex colors and a vertex-flags word. See the [KOS vertex reference](https://kos-docs.dreamcast.wiki/structpvr__vertex__t.html).
- Every primitive is submitted to a list: opaque polygon, opaque modifier, translucent polygon, translucent modifier, or punch-through polygon. See [KOS PVR list types](https://kos-docs.dreamcast.wiki/group__pvr__primitives__headers.html).
- KOS supports ARGB1555, RGB565, ARGB4444, YUV422, bump, 4-bit palette, and 8-bit palette texture modes, plus nearest, bilinear, and trilinear filtering and mipmap controls. See [KOS PVR headers](https://kos-docs.dreamcast.wiki/group__pvr__primitives__headers.html).
- The KOS header defines twiddled/non-twiddled, VQ, and stride-related texture flags. Raw texture loads require a byte count that is a multiple of 32. See [KOS `pvr.h` texture flags and load API](https://github.com/KallistiOS/KallistiOS/blob/master/kernel/arch/dreamcast/include/dc/pvr.h).
- Non-power-of-two strided textures are supported by the current KOS texture API only for widths that are multiples of 32 and no more than 992 pixels; twiddled, paletted, and mipmapped textures cannot use that stride path. See [KOS texture management](https://kos-docs.dreamcast.wiki/group__pvr__txr__mgmt.html).
- KOS documents that primitive types must be submitted grouped by list type with delimiters; submitting in arbitrary order through a main-RAM vertex buffer is supported but slower. See [KOS PVR submission notes](https://github.com/KallistiOS/KallistiOS/blob/master/kernel/arch/dreamcast/include/dc/pvr.h).

This is a materially different integration path from PS1: the Dreamcast backend can use float transforms, hardware depth/hidden-surface testing, triangle strips, platform lists, filtering, mipmaps, and optional VQ, while the PS1 backend must explicitly quantize and depth-sort.

## Sourced facts: existing development paths

PSn00bSDK is an open-source C/C++ PS1 SDK with a compiler toolchain, `libpsn00b`, CMake integration, CD-image tools, and asset utilities. Its README states that the library implements much of the core official SDK surface while deliberately not being a drop-in replacement for every official library. See [PSn00bSDK README](https://github.com/Lameguy64/PSn00bSDK) and [installation/build docs](https://github.com/Lameguy64/PSn00bSDK/blob/master/doc/installation.md).

PCSX-Redux's PSYQo library is a modern C++ PS1 path. Its concepts documentation explicitly calls out the absence of a PS1 Z-buffer, uses an ordering table for depth buckets, requires double buffering for asynchronously submitted fragments, and notes a 255-word maximum for chained fragments. See [PSYQo concepts](https://github.com/pcsx-redux/nugget/blob/main/psyqo/CONCEPTS.md).

PsyCross reimplements the Psy-Q-facing GPU/GTE APIs and can translate them to a modern renderer. It is valuable for host-side tests and visual comparison, but it can add modern Z-buffer/perspective behavior that the real PS1 does not have. See [PsyCross implementation details](https://github.com/OpenDriver2/PsyCross).

For the Dreamcast, KallistiOS is the practical open-source SDK reference. The official Katana/Shinobi/Kamui material is proprietary/historically distributed and should be treated as a separate integration target. The [Dreamcast documentation repository](https://github.com/luckyseoul/dreamcast-docs) indexes mirrored official hardware manuals and distinguishes those materials from KallistiOS.

## Asset sourcing and generation strategy

### Candidates worth prototyping

The first asset pack should be assembled from sources whose redistribution terms are explicit and whose geometry can be reduced without losing the chess silhouette:

| Candidate | License/source evidence | Best use | Main risk |
| --- | --- | --- | --- |
| [OpenGameArt 3D Chess Pieces](https://opengameart.org/content/3d-chess-pieces) | CC0; low-poly source files are offered on the asset page | Fast baseline for PS1 and Dreamcast derivatives | Inspect topology, origin, UVs, and whether the downloaded archive matches the page version |
| [OpenGameArt Chess Pieces](https://opengameart.org/content/chess-pieces-0) | CC0 low-poly set | Alternate silhouette/style and comparison fixture | The set still needs platform-specific budgets, material reduction, and provenance hashing |
| [Poly Haven Chess Set](https://polyhaven.com/a/chess_set) | Poly Haven's [CC0 license](https://polyhaven.com/license) | High-detail bake/reference source for a custom low-poly set | The source is intended for modern rendering and is not a console-ready runtime asset |
| [Kenney asset library](https://kenney.nl/support) | Kenney states that its assets are CC0 | Board trim, UI, markers, or scenery where a matching style exists | It is a general library rather than a chess-piece solution |

These are candidates, not approved shipped assets. At acquisition time, store the exact download URL, archive hash, page capture or version, author credit if shown, license text, and modification notes. A URL returning a model is not by itself proof that the model may be redistributed.

CC0 is the preferred initial policy because it permits adaptation and redistribution; [Creative Commons' CC0 deed](https://creativecommons.org/publicdomain/zero/1.0/) should remain in the attribution bundle. CC-BY sources are usable only when the product ships the required credit and the derivative record is complete; [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) is the reference license. Reject assets with no clear license, noncommercial-only terms, no-derivatives terms, or an unclear chain of authorship.

### Procedural generation is the strongest fallback

Chess pieces are unusually well suited to a deterministic generator. Pawn, rook, bishop, queen, and king bodies can be built from a small rotational profile with controlled radial segment counts; the knight should use a separately authored low-poly silhouette because it is not rotationally symmetric. A generator can emit the same six archetypes at PS1, Dreamcast, and host-preview LODs, keep pivots and contact planes identical, and avoid the topology surprises of an arbitrary download.

The recommended generator workflow is:

1. Define a named profile for each piece, with silhouette landmarks, base radius, total height, radial segment count, and material regions.
2. Generate a clean high-LOD mesh, triangulate deterministically, assign flat/Gouraud-friendly material groups, and establish the board-contact pivot.
3. Produce lower LODs by controlled profile simplification first and decimation second. Validate silhouette error from the target camera rather than optimizing triangle count in isolation. The official Blender Manual source documents [Decimate](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/modeling/modifiers/generate/decimate.rst), [UV unwrapping](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/modeling/meshes/uv/unwrapping/index.rst), and [texture baking](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/render/cycles/baking.rst) as suitable offline operations.
4. Use a high-detail source only to bake restrained diffuse/AO information; resolve the result into solid colors, indexed textures, or vertex colors before console packing.
5. Emit a canonical source plus PS1 and Dreamcast derivatives and validate every one against the manifest and profile budgets.

This approach can still use an open model as the starting silhouette: normalize it, repair it, and make the generator or cleanup recipe the reproducible source. Generative-mesh services are not the baseline because topology, export behavior, and training/provenance terms vary. If one is used experimentally, its output MUST pass the same authorship, license, cleanup, deterministic conversion, and platform validation gates as a downloaded model; no unreviewed generated mesh should ship.

## Recommendations (not sourced facts)

### Canonical coordinate and numeric contract

Use a project-owned coordinate convention in the asset contract: right-handed, X right, Y up, Z toward the camera or a clearly documented forward direction. Do not make the Sony +Y-down convention the canonical source convention; convert it in the PS1 adapter.

Use signed 32-bit `Q16.16` positions and normalized `Q1.15` normals in the canonical serialized asset. Store transforms as integer translation, fixed-point quaternion or Euler angles, and uniform scale. The exact canonical fixed-point choice is a project decision; the reason for using it is deterministic conversion and language neutrality, not a claim that Dreamcast hardware requires it.

At PS1 build time:

1. Apply the asset's bake scale and pivot.
2. Quantize positions to signed 16-bit `SVECTOR` units.
3. Convert rotation/light matrices to the GTE's `(1,3,12)` representation.
4. Reject or subdivide geometry that cannot fit PS1 screen-span/clipping constraints.
5. Emit the selected `POLY_*` packet form and a material/texture-page record.

At Dreamcast build/runtime time, convert the same canonical values to float `pvr_vertex_t` values and submit them through KOS or the selected Katana-compatible layer.

### Canonical mesh representation

Use triangle lists as the interchange primitive. Preserve an optional `quad_hint` only for authoring/debugging; do not make quads semantically meaningful because the PS1 GPU internally splits quads and the Dreamcast backend will normally favor strips.

Require vertices to be split at every position/normal/UV/color/material seam. This makes the data directly compilable into PS1 independent-vertex packets and Dreamcast strip/vertex records without hidden deduplication rules.

Keep pieces rigid. A mesh asset should have a pivot, bounding sphere/AABB, and one or more material submeshes. A chess position should reference a piece archetype and a transform; it should not duplicate mesh data for every board square.

### Canonical material contract

Limit the shared material model to:

- one diffuse texture or a solid vertex color;
- opaque, punch-through/cutout, or translucent mode;
- flat or Gouraud shading;
- optional vertex color modulation;
- one UV set;
- no required normal map, multi-texture blend, physically based parameters, or perspective-correct effect.

Represent unsupported features as explicit validation errors in the asset compiler. Do not silently approximate alpha, filtering, or texture color behavior.

### Texture source and platform variants

Keep lossless RGBA source images in the authoring pipeline, but compile platform variants:

- PS1: indexed 4-bit or 8-bit TIM-like data, explicit page origin, CLUT origin, transparency policy, and optional dither flag. Prefer 4-bit for small piece materials and reserve 8-bit/15-bit for assets whose palette or shading needs it.
- Dreamcast: ARGB1555/RGB565/ARGB4444 or indexed formats, with explicit twiddle/VQ/mipmap/filtering flags. VQ and mipmaps are optional Dreamcast variants, never required by the common asset.

For PS1, make `page_x`, `page_y`, `clut_x`, `clut_y`, and pixel mode part of the compiled artifact. For Dreamcast, make texture address, pixel mode, twiddle/VQ, dimensions, and filter/mipmap settings part of the compiled artifact. The renderer should not infer these from a filename.

### Initial content budgets

These are conservative starting budgets for a chess scene, not hardware maxima. Measure on real hardware and adjust:

| Budget | PS1 baseline | Dreamcast optional target |
| --- | ---: | ---: |
| Full-board visible scene triangles, initial profile | 1,024 | 4,096 |
| Submitted scene triangles before culling, initial profile | 2,048 | 8,192 |
| Near piece archetype | 128-192 | 256-384 |
| Board/distant piece archetype | 80-128 | 128-192 |
| PS1 resident texture pages | 4 initial; 8 stress ceiling | n/a; use a byte budget instead |
| PS1 texture and CLUT residency target | <= 512 KiB including CLUTs | n/a |
| Dreamcast texture residency | n/a | <= 2 MiB for the initial chess scene |
| PS1 OT depth buckets | 256 | n/a; use hardware depth testing/lists |
| PS1 primitive packet buffer | 32-64 KB per frame buffer | n/a |
| Required frame rate | 30 FPS minimum, 60 FPS target | 60 FPS target |

The full-board limits and per-piece limits are different levels of the same budget: near LOD applies to a selected or close piece, while distant pieces use board LOD. Do not multiply the near-LOD number across all 32 pieces. These are CI validation thresholds for the first content pass, not promises of a final production ceiling. The PS1 numbers intentionally leave headroom for two 320x240 15-bit framebuffers, CLUTs, OT pointers, draw-mode packets, UI, and transient uploads. The Dreamcast number is deliberately much lower than Sega's historical peak figures so that CPU/gameplay, texture upload, and translucent-list costs remain visible.

### Batching policy

PS1 draw submission should use this ordering:

1. Cull by camera/frustum and piece bounds.
2. Transform with the GTE-compatible path and compute an average-Z/depth bucket.
3. Insert into the OT, farthest-first.
4. Within each bucket, group by opaque/translucent mode, texture page, CLUT, and primitive form where possible.
5. Emit state-change packets only when the state actually changes.

Dreamcast submission should use separate opaque, punch-through, and translucent batches. Compile one PVR context per material state, group primitives by PVR list, and use strips when the mesh topology supports them. The PS1 backend must remain the reference for visual behavior; do not use a modern host renderer's Z-buffer or perspective correction as the acceptance oracle.

## Proposed practical asset contract

The contract can be JSON, MessagePack, or another language-neutral serialization. The following is a field-level proposal, not a requirement to use JSON at runtime:

```text
AssetHeader
  magic: "CH3D"
  version: u16
  source_coordinate_system: enum
  units_per_world_unit: u32
  meshes: [Mesh]
  materials: [Material]
  textures: [Texture]
  animations: [Animation]

Mesh
  id: string
  pivot_q16_16: [i32, i32, i32]
  bounds_center_q16_16: [i32, i32, i32]
  bounds_radius_q16_16: i32
  vertices: [Vertex]
  indices_u16: [u16]
  submeshes: [Submesh]

Vertex
  position_q16_16: [i32, i32, i32]
  normal_q1_15: [i16, i16, i16]        # optional for lit/Gouraud variants
  uv_q0_16: [u16, u16]
  color_rgba8: [u8, u8, u8, u8]

Submesh
  first_index: u32
  index_count: u32
  material_id: string
  quad_hint: bool

Material
  id: string
  shading: enum(flat, gouraud)
  blend: enum(opaque, punch_through, translucent)
  texture_id: string | null
  modulation: enum(raw, modulate)

Texture
  id: string
  source_uri: string
  width: u16
  height: u16
  alpha_policy: enum(opaque, index_zero_transparent, bit15_semitransparent)
  platform_variants: [TextureVariant]

TextureVariant
  platform: enum(ps1, dreamcast)
  pixel_mode: enum(ps1_4bpp, ps1_8bpp, ps1_15bit, dc_argb1555, dc_rgb565,
                   dc_argb4444, dc_pal4, dc_pal8)
  page_or_address: platform-specific
  clut_or_palette: platform-specific | null
  twiddle: bool
  vq: bool
  mipmaps: bool
  filter: enum(nearest, bilinear, trilinear)

Animation
  id: string
  duration_ticks: u32
  channels: [rigid transform channel]
```

The serialized canonical asset should not contain raw PS1 GPU command links, PS1 VRAM pointers, Dreamcast PVR headers, or host pointers. Those belong in platform build products. A platform compiler should produce a validation report containing triangle counts, packet bytes, texture-page/CLUT usage, OT bucket usage, PVR list counts, and all quantization warnings.

## Integration sequence

1. Implement the rules-side piece archetype/instance references and keep them free of renderer types.
2. Author one low-poly king, one pawn, one board, and a small material/texture set under the proposed contract.
3. Write a host compiler that validates seams, bounds, material features, texture dimensions, PS1 quantization, and platform budgets.
4. Build a PS1 backend with PSn00bSDK or PSYQo: double-buffered packets, OT sorting, TIM/CLUT upload, GTE transforms, and no perspective correction.
5. Build a Dreamcast backend with KallistiOS: float vertices, PVR context/list grouping, texture upload, and depth/list validation.
6. Add a pixel/reference test scene that renders the same camera and assets through a real-PS1-accurate path, an emulator, a host software path, and Dreamcast.
7. Only after the baseline works, add Dreamcast-only higher LODs, mipmaps, VQ, and filtering variants.

## Explicit unknowns and risks

- Official Sony SDK manuals and tool binaries are mirrored rather than served from a current Sony developer portal. Provenance is strong for the documents cited, but URL permanence and licensing status should be verified before redistributing any SDK material.
- The selected PS1 SDK changes the exact structure packing, macro names, linker layout, and supported asset utilities. Treat the chosen SDK headers as the final ABI source of truth.
- The exact PS1 retail target is not fixed. GPU revisions, PAL/NTSC output, 240/480 display mode, emulator accuracy, and real-hardware timing can change the practical budget.
- No universal PS1 polygon-per-frame number is authoritative. The SCEA slide's pixel and DMA figures are idealized, and the official library explains that rendering cost depends on primitive type, texture-cache hit state, pixels written, bus contention, and overdraw.
- Dreamcast official headline polygon figures do not translate directly to this scene. They depend on polygon size, opacity/translucency mix, list allocation, overdraw, texture format, filtering, CPU time, and frame rate.
- KallistiOS is an open-source implementation, not the original Sega Katana/Shinobi/Kamui SDK. It is the recommended prototype path here, but a licensed first-party backend may have different APIs and packaging requirements.
- The project has not yet chosen a final camera, frame rate, video mode, lighting model, palette style, or whether the PS1 target must run on original retail hardware. These choices can move the budgets materially.
- Runtime asset streaming from PS1 CD-ROM and Dreamcast GD-ROM is outside this report. If used, it will add sector alignment, decompression, and upload-buffer constraints.
- Host-side visual tests that use OpenGL/Direct3D or PsyCross can accidentally hide PS1 affine texture warping, integer vertex behavior, missing depth buffer, and ordering artifacts. Hardware-accurate regression scenes remain necessary.

## References

The inline links above are the authoritative citations for individual claims. The most important starting set is:

1. [Sony/SCE Run-Time Library Overview, LIBOVR46](https://gamingdoc.org/wp-content/uploads/2020/07/Run-Time-Library-Ovewview-LIBOVR46.pdf)
2. [Sony/SCE File Formats, release 4.7](https://psx.arthus.net/sdk/Psy-Q/DOCS/FileFormat47.pdf)
3. [Sony/SCE Developer References: File Formats](https://psx.arthus.net/sdk/Psy-Q/DOCS/Devrefs/Filefrmt.pdf)
4. [SCEA Advanced GPU presentation](https://psx.arthus.net/sdk/Psy-Q/DOCS/CONF/SCEA/adv_gpu.pdf)
5. [PSX-SPX GPU reference](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/)
6. [Sega Dreamcast Hardware Specification Outline](https://github.com/luckyseoul/dreamcast-docs/blob/main/files/official/Dreamcast_Hardware_Specification_Outline.pdf)
7. [Sega Dreamcast/Dev.Box System Architecture](https://github.com/luckyseoul/dreamcast-docs/blob/main/files/official/DreamcastDevBoxSystemArchitecture.pdf)
8. [KallistiOS PVR primitive headers](https://kos-docs.dreamcast.wiki/group__pvr__primitives__headers.html)
9. [KallistiOS PVR texture management](https://kos-docs.dreamcast.wiki/group__pvr__txr__mgmt.html)
10. [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK)
11. [PCSX-Redux PSYQo concepts](https://github.com/pcsx-redux/nugget/blob/main/psyqo/CONCEPTS.md)
12. [PsyCross](https://github.com/OpenDriver2/PsyCross)
