import {
  importPgnCollection,
  PgnImportError,
  type PgnGameImport,
  type PgnImportCollection,
} from '../replay/pgn-import.ts';
import type { Replay } from '../replay/schema.ts';

export interface ReplayImportChoiceResult {
  readonly ok: true;
  readonly replay: Replay;
  readonly game: PgnGameImport;
}

export interface ReplayImportChoiceFailure {
  readonly ok: false;
  readonly error: PgnImportError;
}

export type ReplayImportChoice = ReplayImportChoiceResult | ReplayImportChoiceFailure;

/** Keep the browser import flow small and testable without coupling it to DOM state. */
export function parsePgnForViewer(source: string): PgnImportCollection {
  return importPgnCollection(source);
}

export function choosePgnGame(collection: PgnImportCollection, index: number): ReplayImportChoice {
  const game = collection.games[index];
  if (game === undefined) {
    return {
      ok: false,
      error: new PgnImportError('Selected PGN game does not exist', { gameIndex: index }),
    };
  }
  if (game.replay === null || game.error !== null) {
    return {
      ok: false,
      error: game.error ?? new PgnImportError('Selected PGN game is invalid', { gameIndex: index }),
    };
  }
  return { ok: true, replay: structuredClone(game.replay), game };
}

export function validPgnGames(collection: PgnImportCollection): readonly PgnGameImport[] {
  return collection.games.filter((game) => game.replay !== null && game.error === null);
}

export function pgnImportErrorMessage(error: PgnImportError): string {
  // PgnImportError already includes its source/game context in message.
  return error.message;
}

export function pgnGameOptionLabel(game: PgnGameImport): string {
  return game.valid ? `Game ${game.index + 1} · ${game.label}` : `Game ${game.index + 1} · unavailable · ${game.error?.message ?? 'invalid PGN'}`;
}
