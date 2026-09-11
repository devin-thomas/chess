import { createSimulator } from '../typescript/chess_cpu.ts';
import { isRecord, MOVE_PATTERN, parsePosition, ReplayError } from './schema.ts';
import type { Color, Position, ReplayRoot } from './schema.ts';

export interface ReplayOutcome { reason: string; result: '1-0' | '0-1' | '1/2-1/2'; winner?: Color }
export interface ReplayState extends Position {
  mode: 'all-rules-enabled'; status: 'active' | 'terminal'; check: Color | null;
  outcome: ReplayOutcome | null; claimable_draws: string[];
  repetition_counts: Record<string, number>; moves: string[]; revision: number;
}
export class ReplayEngineError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ReplayEngineError'; this.code = code; }
}
function protocol(message: string): never { throw new ReplayEngineError('E_REPLAY_ENGINE', message); }
export function positionToFen(p: Position): string {
  const letters = { king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p' };
  const ranks: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = ''; let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = p.board[rank * 8 + file];
      if (piece === null) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const letter = letters[piece.type]; row += piece.color === 'white' ? letter.toUpperCase() : letter;
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  const c = p.castling_rights;
  const rights = (c.white_kingside ? 'K' : '') + (c.white_queenside ? 'Q' : '') + (c.black_kingside ? 'k' : '') + (c.black_queenside ? 'q' : '');
  return `${ranks.join('/')} ${p.side_to_move === 'white' ? 'w' : 'b'} ${rights || '-'} ${p.en_passant_target ?? '-'} ${p.halfmove_clock} ${p.fullmove_number}`;
}
function stateFromResponse(value: unknown, revision: number): ReplayState {
  if (!isRecord(value)) protocol('Missing engine state');
  const rights = value.castling_rights;
  if (typeof rights !== 'string' || !/^(?:-|K?Q?k?q?)$/.test(rights)) protocol('Invalid engine castling rights');
  let position: Position;
  try {
    position = parsePosition({ board: value.board, side_to_move: value.side_to_move,
      castling_rights: { white_kingside: rights.includes('K'), white_queenside: rights.includes('Q'), black_kingside: rights.includes('k'), black_queenside: rights.includes('q') },
      en_passant_target: value.en_passant_target, halfmove_clock: value.halfmove_clock, fullmove_number: value.fullmove_number });
  } catch (error) { if (error instanceof ReplayError) protocol(`Invalid engine position: ${error.message}`); throw error; }
  if (value.mode !== 'all-rules-enabled' || (value.status !== 'active' && value.status !== 'terminal') ||
      (value.check !== null && value.check !== 'white' && value.check !== 'black')) protocol('Invalid engine status');
  let outcome: ReplayOutcome | null = null;
  if (value.outcome !== null) {
    const o = value.outcome;
    if (!isRecord(o) || typeof o.reason !== 'string' || (o.result !== '1-0' && o.result !== '0-1' && o.result !== '1/2-1/2') ||
        (o.winner !== undefined && o.winner !== 'white' && o.winner !== 'black')) protocol('Invalid engine outcome');
    outcome = { reason: o.reason, result: o.result };
    if (o.winner !== undefined) outcome.winner = o.winner;
  }
  if ((value.status === 'terminal') !== (outcome !== null)) protocol('Inconsistent engine outcome');
  if (!Array.isArray(value.claimable_draws) || !value.claimable_draws.every(v => typeof v === 'string')) protocol('Invalid engine claims');
  if (!Array.isArray(value.moves) || !value.moves.every(v => typeof v === 'string' && MOVE_PATTERN.test(v)) || value.moves.length !== revision) protocol('Invalid engine ledger');
  if (!isRecord(value.repetition_counts)) protocol('Invalid engine repetition history');
  const repetition_counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.repetition_counts)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) protocol('Invalid engine repetition count');
    Object.defineProperty(repetition_counts, key, { value: count, enumerable: true, writable: true, configurable: true });
  }
  return { ...position, mode: value.mode, status: value.status, check: value.check, outcome,
    claimable_draws: [...value.claimable_draws], repetition_counts, moves: [...value.moves], revision };
}
export interface ReplaySession { state(): ReplayState; play(move: string): ReplayState; legalMoves(): string[] }
export function createReplaySession(root: ReplayRoot): ReplaySession {
  const simulator = createSimulator();
  let revision = 0;
  function request(op: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const response = simulator.request({ op, ...fields });
    if (response.op !== op) protocol('Mismatched engine operation');
    if (response.ok === false) {
      if (!isRecord(response.error) || typeof response.error.code !== 'string' || typeof response.error.message !== 'string') protocol('Invalid engine error');
      throw new ReplayEngineError(response.error.code, response.error.message);
    }
    if (response.ok !== true) protocol('Invalid engine response');
    return response;
  }
  stateFromResponse(request('new', { mode: 'all-rules-enabled', ...(root.kind === 'position' ? { fen: positionToFen(root.position) } : {}) }).state, revision);
  return {
    state: () => stateFromResponse(request('state').state, revision),
    play(move) { const response = request('play', { move }); const state = stateFromResponse(response.state, revision + 1); revision++; return state; },
    legalMoves() {
      const moves = request('legal_moves').moves;
      if (!Array.isArray(moves) || !moves.every(move => typeof move === 'string' && MOVE_PATTERN.test(move))) protocol('Invalid engine legal moves');
      return [...moves];
    },
  };
}
