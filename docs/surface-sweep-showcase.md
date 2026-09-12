# Surface sweep / showcase handoff

Run date: 2026-09-11
Target: local Vite app at `http://127.0.0.1:5173`
Source revision: `756ee28` plus the local showcase changes in this worktree
Browser: Playwright Chromium 153.0.8010.12 headless, macOS arm64
Fixture mode: repository-authored curated replays and local simulator state; no external account or provider data

## Coverage matrix

| Case | Surface / state | Viewport | Assertions | Capture | Disposition |
| --- | --- | --- | --- | --- | --- |
| `viewer-overview-desktop` | `/`, opening replay at ply 0 | 1440 × 1100 | viewer ready, board present, rail controls present, no horizontal overflow, images/canvas settled | full page | passed |
| `viewer-workflow-desktop` | `/?replay=italian-castle&ply=9`, final castle position | 1440 × 1100 | exact replay title, cursor `9 / 9`, `O-O` current move, transport paused at end, move list visible | full page | passed |
| `viewer-mobile-390` | `/?replay=italian-castle&ply=9`, responsive stacked layout | 390 × 844 | board remains primary, rail reflows below, controls remain visible, no horizontal overflow | full page | passed |
| `simulator-overview-desktop` | `/simulator/`, ready state | 1440 × 1000 | simulator entry loads independently, board and run controls present, viewer-only markup absent | viewport | passed |
| `showcase-desktop` | `/showcase/`, direct load | 1440 × 1100 | metadata/title, all curated images decode, section links and app links resolve, no overflow | viewport + full page | passed |
| `showcase-mobile` | `/showcase/`, responsive story | 390 × 844 | hero and capture cards reflow, images preserve proportions, footer links remain reachable | viewport + full page | passed |
| `showcase-refresh` | `/showcase/`, hard refresh | 1440 × 1100 | deep entry returns showcase HTML and all image responses retain image content types | none | passed |

The matrix samples the supported desktop and phone breakpoints and the main route/state transitions. Tablet/intermediate widths remain covered by the existing responsive viewer rules but were not promoted into the showcase asset set.

## Capture manifest

Public assets and their source cases, dimensions, transforms, and alt text are recorded in [`web/public/showcase/assets/manifest.json`](../web/public/showcase/assets/manifest.json). Raw browser captures remain under the ignored `.surface-sweep/` run directory and are not shipped with the public route.

## Findings

No product visual defects were found in the reviewed viewer or simulator states. The showcase adds no shared selectors outside its `.showcase-*` namespace. The only capture-specific behavior is the existing app's URL-state initialization for a curated replay and ply, which is also a useful forward-compatible deep-link surface.

## Verification commands

```sh
npm run typecheck
npm run test:replay
npm run build
```

The local showcase route is `/showcase/`. Deployment was not performed in this sweep.
