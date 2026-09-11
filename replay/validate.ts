import { parseReplay, ReplayError } from './schema.ts';
import type { Replay } from './schema.ts';
import { createReplaySession, ReplayEngineError } from './engine.ts';
import type { ReplayState, ReplaySession } from './engine.ts';

export interface ReplayDiagnostic { code: 'W_REPLAY_RESULT'; message: string; recorded_result: string; rules_result: string }
export type ReplayValidation = { ok: true; replay: Replay; root_state: ReplayState; final_state: ReplayState; diagnostics: ReplayDiagnostic[] } | { ok: false; error: ReplayError };
export type ValidationResult = ReplayValidation;
export function validateReplay(input: unknown): ReplayValidation {
  let replay: Replay;
  try { replay = parseReplay(input, { deferMoveSyntax: true }); }
  catch (error) { if (error instanceof ReplayError) return { ok: false, error }; throw error; }
  let session: ReplaySession;
  try { session = createReplaySession(replay.root); }
  catch (underlying) {
    if (!(underlying instanceof ReplayEngineError)) throw underlying;
    const error = new ReplayError('E_REPLAY_ROOT', 'Replay root was rejected by the rules engine');
    error.underlying_error = { code: underlying.code, message: underlying.message };
    return { ok: false, error };
  }
  const root_state = session.state();
  let final_state = root_state;
  for (let i = 0; i < replay.moves.length; i++) {
    try { final_state = session.play(replay.moves[i]); }
    catch (underlying) {
      if (!(underlying instanceof ReplayEngineError)) throw underlying;
      const error = new ReplayError('E_REPLAY_MOVE', `Replay move ${i + 1} was rejected: ${replay.moves[i]}`);
      error.move_index = i; error.ply = i + 1; error.last_valid_ply = i; error.last_valid_state = final_state;
      error.underlying_error = { code: underlying.code, message: underlying.message };
      return { ok: false, error };
    }
  }
  const diagnostics: ReplayDiagnostic[] = [];
  const recorded = replay.metadata?.result;
  if (typeof recorded === 'string' && recorded !== '*' && final_state.outcome && recorded !== final_state.outcome.result) {
    diagnostics.push({ code: 'W_REPLAY_RESULT', message: 'Recorded result disagrees with the authoritative rules outcome', recorded_result: recorded, rules_result: final_state.outcome.result });
  }
  return { ok: true, replay, root_state, final_state, diagnostics };
}
