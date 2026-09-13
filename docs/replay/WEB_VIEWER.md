# Web Replay Viewer V1

## 1. Product goal

Create a replay viewer that makes a chess game feel like a competitive match worth watching.

The first impression should be the board and the game, not an editor, setup form, JSON protocol, or simulator dashboard.

A new visitor should be able to open the site and immediately watch something compelling.

## 2. Default landing behavior

The page MUST open with a curated replay already loaded at ply 0, paused.

The primary visual hierarchy is:

1. 3D board / current position;
2. replay transport controls and timeline;
3. player/game identity;
4. move list and optional supporting information.

Developer/protocol controls must not dominate the public replay route.

The existing simulator MUST remain available separately. RPL-007 makes `/` the replay viewer and `/simulator/` the simulator using the existing Vite static build. Both URLs must work on direct load and reload; preserve current simulator controls and deployment commands.

## 3. Required controls

V1 requires:

- Play / Pause;
- Previous ply;
- Next ply;
- Jump to start;
- Jump to end;
- seek/scrub timeline;
- board flip;
- replay speed selector with at least a small set of useful values;
- import PGN;
- load/select a curated replay.

Keyboard controls SHOULD include sensible equivalents where they do not conflict with browser behavior.

## 4. Timeline semantics

The timeline represents replay ply, not video time.

- left edge = ply `0`, root position;
- right edge = final replay ply;
- seek target resolves to an integer ply;
- dragging may preview or update continuously depending on performance;
- after a seek, board state must be authoritative before animation resumes.

V1 does not need variable durations per move. Speed choices are 0.5x, 1x, and 2x; 1x waits 1000 ms after each transition settles. Play at the end is a no-op until the user seeks back. Disable unavailable boundary controls and Play for empty replays. Board flip preserves cursor and play state.

## 5. Move list

The visible move list may display SAN for human readability, but SAN is presentation data derived during import or from authoritative position context.

The replay controller continues to execute canonical coordinate moves.

The move list must:

- identify the current ply;
- allow click/tap seeking;
- keep the current move visible during autoplay when practical;
- distinguish White and Black moves using root side-to-move and fullmove number, including Black-to-move setup roots;
- remain usable on mobile without shrinking the board into irrelevance.

## 6. 3D board requirements

The V1 web renderer uses Three.js behind the presentation adapter boundary.

Required V1 behavior:

- correct 64-square mapping independent of camera;
- deterministic piece placement from the presentation snapshot;
- smooth rigid-transform move animation;
- capture removal;
- castling with both pieces represented correctly;
- en-passant capture removal from the correct square;
- promotion visual replacement;
- board flip without changing canonical coordinates;
- camera framing that preserves board readability;
- no-animation path for seek/reduced motion;
- missing-asset fallback that still displays correct chess state.

The rules engine must never query Three.js to determine legality or occupancy.

The current web pack uses the six low-poly GLBs from [OpenGameArt's 3d chess pieces](https://opengameart.org/content/3d-chess-pieces) by tunakron, explicitly released as CC0. The repository-owned runtime files live in `web/public/assets/chess/classic-cc0/`, with exact download and file hashes in its `provenance.json`. `web/chess-piece-assets.ts` loads each type once, applies shared white/black materials, and normalizes height and board contact at runtime. If a model is unavailable, the renderer keeps the existing readable primitive for that piece; it never leaves an occupied square empty. Replacing the pack requires updating the six files and provenance record, not changing canonical replay state.

## 7. Visual direction

V1 should establish "premium replay" rather than imitate a conventional analysis board.

Useful direction:

- strong material response and controlled reflections;
- cinematic but readable camera angle;
- clear distinction between sides without relying only on subtle material differences;
- restrained move/capture highlights;
- motion with weight but short enough that stepping through a game stays responsive;
- optional environment/background treatment that does not compete with the board;
- UI chrome that feels closer to a match broadcast/player than a spreadsheet.

The exact art style remains open and should be implemented behind asset/theme seams.

## 8. Animation behavior

Normal autoplay:

1. controller advances one ply;
2. presentation adapter emits transition data/events;
3. renderer animates the move;
4. board settles into the authoritative post-move position;
5. viewer waits the configured presentation interval;
6. next move begins.

Seeking:

1. pause or suspend current animation;
2. seek controller to target ply;
3. rebuild/apply presentation snapshot immediately;
4. reset transient effects;
5. remain paused until the user presses Play. Manual previous/next/start/end controls also pause autoplay.

A seek must never simulate dozens of visible intermediate animations unless the user explicitly requested playback.

## 9. Responsive requirements

### Desktop

Prefer a large board with adjacent replay information.

### Mobile portrait

The board remains the primary element. Supporting panels may move below it or into compact drawers/tabs.

Controls must remain comfortably tappable without requiring hover.

The move list must not force horizontal page overflow.

### Mobile landscape/tablet

Use available width to keep board and move context visible together where practical.

## 10. Accessibility

V1 should include:

- semantic buttons;
- keyboard operability for replay transport;
- visible focus state;
- text representation of players, move, result, and current ply;
- reduced-motion behavior that applies moves immediately or with minimal transitions;
- sufficient contrast for controls and move indicators;
- board state that remains inspectable without relying solely on animation.

3D is the main presentation, not the only semantic representation of game state.

## 11. PGN import UX

Support:

- file selection / drop where appropriate;
- paste PGN text;
- parse at least one game;
- clear error when import fails;
- immediate conversion to canonical replay;
- no account requirement;
- client-side processing for V1.

If a PGN contains multiple games, V1 MUST present a game chooser. Apply the parsing policy and limits in [ARCHITECTURE.md](ARCHITECTURE.md#16-pgn-v1-decisions-and-limits). Validate the selected game before replacing the current replay.

## 12. Curated replay library

V1 should ship with several fixtures selected to exercise presentation and provide interesting content.

The technical fixture set should include games or constructed legal replays that cover:

- castling;
- captures;
- promotion;
- checkmate;
- long enough games to exercise seeking.

Historical publication rights/source attribution should be tracked in metadata where appropriate.

## 13. URL/share state

A future hosted replay should be able to deep-link to a game and optionally a ply.

V1 should avoid designing UI state that makes this impossible. A route concept such as:

```text
/replay/<id>?ply=42
```

is sufficient as a forward-compatible model; hosted IDs do not need to exist in the first local/static implementation.

## 14. Performance acceptance

- Loading a normal chess replay must feel immediate on a modern device.
- Seeking must not wait for visible replay of all prior moves.
- 3D rendering should target smooth interaction on mainstream current mobile/desktop hardware.
- Rules/replay correctness must not be traded for animation smoothness.
- If rendering falls behind, presentation may skip/interpolate effects but must settle on the correct authoritative state.

## 15. Explicit non-goals for V1

- live games;
- matchmaking;
- accounts;
- cloud saves;
- comments/social feed;
- real-time Stockfish analysis;
- opening database;
- puzzles;
- move editing after import;
- variation trees;
- collaborative annotations;
- video export;
- retro runtime in the same web milestone.
