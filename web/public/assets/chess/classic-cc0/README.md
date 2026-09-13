# Classic CC0 chess pieces

This runtime pack contains six low-poly GLB chess pieces from [OpenGameArt's “3d chess pieces” pack](https://opengameart.org/content/3d-chess-pieces) by tunakron. The source page identifies the pack as CC0; the exact archive URL, download date, archive hash, file hashes, and license deed are recorded in `provenance.json`.

The GLBs are stored in `web/public/assets/chess/classic-cc0/` so Vite serves them as repository-owned static assets. They are not hotlinked. `web/chess-piece-assets.ts` loads each type once, keeps one shared prototype per type, applies the white/black material at clone time, and normalizes scale and board contact at runtime. No binary preprocessing was performed.

To replace the pack, add one GLB for each of `king`, `queen`, `rook`, `bishop`, `knight`, and `pawn`, update the hashes and provenance record, then verify that the source license permits redistribution. The loader keeps a readable procedural primitive for any type whose model is missing or fails to load.

Chess legality and canonical occupancy remain owned by the replay/rules layer. Three.js objects are presentation views keyed by stable presentation piece identity; seeking, promotion, capture, castling, en passant, and board flipping continue to use the existing replay projections.
