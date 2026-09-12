import type { Replay } from './schema.ts';

export interface CuratedReplayEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly replay: Replay;
}

const scoreSource = 'Historical game score · PGN Mentor archive';

export const CURATED_REPLAYS = [
  {
    id: 'immortal-game',
    title: 'The Immortal Game',
    description: 'Anderssen gives up nearly everything to build a model mating attack.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: [
        'e2e4', 'e7e5', 'f2f4', 'e5f4', 'f1c4', 'd8h4', 'e1f1', 'b7b5', 'c4b5', 'g8f6',
        'g1f3', 'h4h6', 'd2d3', 'f6h5', 'f3h4', 'h6g5', 'h4f5', 'c7c6', 'g2g4', 'h5f6',
        'h1g1', 'c6b5', 'h2h4', 'g5g6', 'h4h5', 'g6g5', 'd1f3', 'f6g8', 'c1f4', 'g5f6',
        'b1c3', 'f8c5', 'c3d5', 'f6b2', 'f4d6', 'c5g1', 'e4e5', 'b2a1', 'f1e2', 'b8a6',
        'f5g7', 'e8d8', 'f3f6', 'g8f6', 'd6e7',
      ],
      metadata: {
        white: 'Adolf Anderssen',
        black: 'Lionel Kieseritzky',
        result: '1-0',
        event: 'Casual game',
        site: 'London',
        date: '1851',
        source: scoreSource,
        source_url: 'https://en.wikipedia.org/wiki/Immortal_Game',
      },
    },
  },
  {
    id: 'opera-game',
    title: 'The Opera Game',
    description: 'Morphy turns a theater-box consultation into a 17-move lesson in development and sacrifice.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: [
        'e2e4', 'e7e5', 'g1f3', 'd7d6', 'd2d4', 'c8g4', 'd4e5', 'g4f3', 'd1f3', 'd6e5',
        'f1c4', 'g8f6', 'f3b3', 'd8e7', 'b1c3', 'c7c6', 'c1g5', 'b7b5', 'c3b5', 'c6b5',
        'c4b5', 'b8d7', 'e1c1', 'a8d8', 'd1d7', 'd8d7', 'h1d1', 'e7e6', 'b5d7', 'f6d7',
        'b3b8', 'd7b8', 'd1d8',
      ],
      metadata: {
        white: 'Paul Morphy',
        black: 'Duke Karl & Count Isouard',
        result: '1-0',
        event: 'Consultation game',
        site: 'Paris opera house',
        date: '1858',
        source: scoreSource,
        source_url: 'https://en.wikipedia.org/wiki/Opera_Game',
      },
    },
  },
  {
    id: 'evergreen-game',
    title: 'The Evergreen Game',
    description: "Anderssen's evergreen attack lands in a queen-sacrifice finish against Dufresne.",
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: [
        'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'b2b4', 'c5b4', 'c2c3', 'b4a5',
        'd2d4', 'e5d4', 'e1g1', 'd4d3', 'd1b3', 'd8f6', 'e4e5', 'f6g6', 'f1e1', 'g8e7',
        'c1a3', 'b7b5', 'b3b5', 'a8b8', 'b5a4', 'a5b6', 'b1d2', 'c8b7', 'd2e4', 'g6f5',
        'c4d3', 'f5h5', 'e4f6', 'g7f6', 'e5f6', 'h8g8', 'a1d1', 'h5f3', 'e1e7', 'c6e7',
        'a4d7', 'e8d7', 'd3f5', 'd7e8', 'f5d7', 'e8f8', 'a3e7',
      ],
      metadata: {
        white: 'Adolf Anderssen',
        black: 'Jean Dufresne',
        result: '1-0',
        event: 'Casual game',
        site: 'Berlin',
        date: '1852',
        source: scoreSource,
        source_url: 'https://en.wikipedia.org/wiki/Evergreen_Game',
      },
    },
  },
  {
    id: 'game-of-century',
    title: 'The Game of the Century',
    description: 'Thirteen-year-old Fischer accepts a queen sacrifice and coordinates a textbook mating net.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: [
        'g1f3', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'd2d4', 'e8g8', 'c1f4', 'd7d5',
        'd1b3', 'd5c4', 'b3c4', 'c7c6', 'e2e4', 'b8d7', 'a1d1', 'd7b6', 'c4c5', 'c8g4',
        'f4g5', 'b6a4', 'c5a3', 'a4c3', 'b2c3', 'f6e4', 'g5e7', 'd8b6', 'f1c4', 'e4c3',
        'e7c5', 'f8e8', 'e1f1', 'g4e6', 'c5b6', 'e6c4', 'f1g1', 'c3e2', 'g1f1', 'e2d4',
        'f1g1', 'd4e2', 'g1f1', 'e2c3', 'f1g1', 'a7b6', 'a3b4', 'a8a4', 'b4b6', 'c3d1',
        'h2h3', 'a4a2', 'g1h2', 'd1f2', 'h1e1', 'e8e1', 'b6d8', 'g7f8', 'f3e1', 'c4d5',
        'e1f3', 'f2e4', 'd8b8', 'b7b5', 'h3h4', 'h7h5', 'f3e5', 'g8g7', 'h2g1', 'f8c5',
        'g1f1', 'e4g3', 'f1e1', 'c5b4', 'e1d1', 'd5b3', 'd1c1', 'g3e2', 'c1b1', 'e2c3',
        'b1c1', 'a2c2',
      ],
      metadata: {
        white: 'Donald Byrne',
        black: 'Bobby Fischer',
        result: '0-1',
        event: 'Rosenwald Memorial Tournament',
        site: 'Marshall Chess Club, New York',
        date: '1956-10-17',
        source: scoreSource,
        source_url: 'https://en.wikipedia.org/wiki/Game_of_the_Century_(chess)',
      },
    },
  },
  {
    id: 'fischer-spassky-game-six',
    title: 'Fischer-Spassky, Game 6',
    description: 'The famous 1972 match produces a quietly devastating positional masterpiece.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: [
        'c2c4', 'e7e6', 'g1f3', 'd7d5', 'd2d4', 'g8f6', 'b1c3', 'f8e7', 'c1g5', 'e8g8',
        'e2e3', 'h7h6', 'g5h4', 'b7b6', 'c4d5', 'f6d5', 'h4e7', 'd8e7', 'c3d5', 'e6d5',
        'a1c1', 'c8e6', 'd1a4', 'c7c5', 'a4a3', 'f8c8', 'f1b5', 'a7a6', 'd4c5', 'b6c5',
        'e1g1', 'a8a7', 'b5e2', 'b8d7', 'f3d4', 'e7f8', 'd4e6', 'f7e6', 'e3e4', 'd5d4',
        'f2f4', 'f8e7', 'e4e5', 'c8b8', 'e2c4', 'g8h8', 'a3h3', 'd7f8', 'b2b3', 'a6a5',
        'f4f5', 'e6f5', 'f1f5', 'f8h7', 'c1f1', 'e7d8', 'h3g3', 'a7e7', 'h2h4', 'b8b7',
        'e5e6', 'b7c7', 'g3e5', 'd8e8', 'a2a4', 'e8d8', 'f1f2', 'd8e8', 'f2f3', 'e8d8',
        'c4d3', 'd8e8', 'e5e4', 'h7f6', 'f5f6', 'g7f6', 'f3f6', 'h8g8', 'd3c4', 'g8h8',
        'e4f4',
      ],
      metadata: {
        white: 'Bobby Fischer',
        black: 'Boris Spassky',
        result: '1-0',
        event: 'World Championship Match',
        site: 'Reykjavik',
        date: '1972',
        round: '6',
        source: scoreSource,
        source_url: 'https://en.wikipedia.org/wiki/World_Chess_Championship_1972',
      },
    },
  },
  {
    id: 'kasparov-topalov-1999',
    title: 'Kasparov-Topalov, 1999',
    description: 'A 44-move king hunt with a rook sacrifice and a finish that still looks impossible.',
    replay: {
      schema_version: 1,
      ruleset: 'orthodox-chess-v1',
      root: { kind: 'standard' },
      moves: [
        'e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'c1e3', 'f8g7', 'd1d2', 'c7c6',
        'f2f3', 'b7b5', 'g1e2', 'b8d7', 'e3h6', 'g7h6', 'd2h6', 'c8b7', 'a2a3', 'e7e5',
        'e1c1', 'd8e7', 'c1b1', 'a7a6', 'e2c1', 'e8c8', 'c1b3', 'e5d4', 'd1d4', 'c6c5',
        'd4d1', 'd7b6', 'g2g3', 'c8b8', 'b3a5', 'b7a8', 'f1h3', 'd6d5', 'h6f4', 'b8a7',
        'h1e1', 'd5d4', 'c3d5', 'b6d5', 'e4d5', 'e7d6', 'd1d4', 'c5d4', 'e1e7', 'a7b6',
        'f4d4', 'b6a5', 'b2b4', 'a5a4', 'd4c3', 'd6d5', 'e7a7', 'a8b7', 'a7b7', 'd5c4',
        'c3f6', 'a4a3', 'f6a6', 'a3b4', 'c2c3', 'b4c3', 'a6a1', 'c3d2', 'a1b2', 'd2d1',
        'h3f1', 'd8d2', 'b7d7', 'd2d7', 'f1c4', 'b5c4', 'b2h8', 'd7d3', 'h8a8', 'c4c3',
        'a8a4', 'd1e1', 'f3f4', 'f7f5', 'b1c1', 'd3d2', 'a4a7',
      ],
      metadata: {
        white: 'Garry Kasparov',
        black: 'Veselin Topalov',
        result: '1-0',
        event: 'Hoogovens Tournament',
        site: 'Wijk aan Zee',
        date: '1999-01-20',
        round: '4',
        source: scoreSource,
        source_url: 'https://books.chessbase.com/de/wijk-aan-zee-classics-great-games-timeless-le/kasparov-topalov-1999',
      },
    },
  },
] as const satisfies readonly CuratedReplayEntry[];

export const DEFAULT_CURATED_REPLAY_ID = CURATED_REPLAYS[0].id;

export function curatedReplayById(id: string): CuratedReplayEntry | null {
  return CURATED_REPLAYS.find((entry) => entry.id === id) ?? null;
}

export function cloneCuratedReplay(id: string): Replay | null {
  const entry = curatedReplayById(id);
  return entry === null ? null : structuredClone(entry.replay);
}
