#include "nes_replay.h"

#define FLAG_POSITION_ROOT 0x01u
#define FLAG_TIER1_METADATA 0x02u
#define KNOWN_FLAGS (FLAG_POSITION_ROOT | FLAG_TIER1_METADATA)

#define WHITE 0u
#define BLACK 1u

static unsigned int read_u16(const unsigned char *value) {
    return (unsigned int)value[0] | ((unsigned int)value[1] << 8);
}

static unsigned long read_u32(const unsigned char *value) {
    return (unsigned long)value[0]
        | ((unsigned long)value[1] << 8)
        | ((unsigned long)value[2] << 16)
        | ((unsigned long)value[3] << 24);
}

static int valid_piece(unsigned char piece) {
    return (piece >= 1u && piece <= 6u) || (piece >= 9u && piece <= 14u);
}

static int is_white_piece(unsigned char piece) {
    return piece >= 1u && piece <= 6u;
}

static int is_black_piece(unsigned char piece) {
    return piece >= 9u && piece <= 14u;
}

static int is_pawn(unsigned char piece) {
    return piece == 1u || piece == 9u;
}

static int is_rook(unsigned char piece) {
    return piece == 4u || piece == 12u;
}

static int is_king(unsigned char piece) {
    return piece == 6u || piece == 14u;
}

static int fail(NesReplay *replay, unsigned char error) {
    replay->error = error;
    replay->valid = 0u;
    return -(int)error;
}

static void clear_board(NesReplay *replay) {
    unsigned int index;
    for (index = 0u; index < 64u; ++index) replay->board[index] = 0u;
}

static void set_standard_root(NesReplay *replay) {
    static const unsigned char white_back[8] = {4u, 2u, 3u, 5u, 6u, 3u, 2u, 4u};
    static const unsigned char black_back[8] = {12u, 10u, 11u, 13u, 14u, 11u, 10u, 12u};
    unsigned int file;

    clear_board(replay);
    for (file = 0u; file < 8u; ++file) {
        replay->board[file] = white_back[file];
        replay->board[8u + file] = 1u;
        replay->board[48u + file] = 9u;
        replay->board[56u + file] = black_back[file];
    }
    replay->side_to_move = WHITE;
    replay->castling_rights = 0x0fu;
    replay->en_passant_target = 0xffu;
    replay->halfmove_clock = 0ul;
    replay->fullmove_number = 1ul;
}

static int set_position_root(NesReplay *replay, const unsigned char *root) {
    unsigned int index;
    unsigned char ep;

    for (index = 0u; index < 64u; ++index) {
        if (root[index] != 0u && !valid_piece(root[index])) return fail(replay, NES_REPLAY_ERROR_ROOT);
        replay->board[index] = root[index];
    }
    if (root[64] > 1u || (root[65] & 0xf0u) != 0u) return fail(replay, NES_REPLAY_ERROR_ROOT);
    ep = root[66];
    if (ep != 0xffu && ep >= 64u) return fail(replay, NES_REPLAY_ERROR_ROOT);
    replay->side_to_move = root[64];
    replay->castling_rights = root[65];
    replay->en_passant_target = ep;
    replay->halfmove_clock = read_u32(root + 67u);
    replay->fullmove_number = read_u32(root + 71u);
    if (replay->fullmove_number == 0ul) return fail(replay, NES_REPLAY_ERROR_ROOT);
    return NES_REPLAY_OK;
}

static int validate_metadata(NesReplay *replay, unsigned int metadata_offset, unsigned int metadata_length) {
    unsigned int offset = 0u;
    unsigned int field;
    unsigned char version;
    unsigned char mask;

    if ((replay->data[5] & FLAG_TIER1_METADATA) == 0u) {
        return metadata_length == 0u ? NES_REPLAY_OK : fail(replay, NES_REPLAY_ERROR_HEADER);
    }
    if (metadata_length < 2u) return fail(replay, NES_REPLAY_ERROR_HEADER);
    version = replay->data[metadata_offset];
    mask = replay->data[metadata_offset + 1u];
    if (version != 1u || mask == 0u || (mask & 0xf0u) != 0u) return fail(replay, NES_REPLAY_ERROR_HEADER);
    offset = 2u;
    for (field = 0u; field < 4u; ++field) {
        unsigned int value_length;
        if ((mask & (unsigned char)(1u << field)) == 0u) continue;
        if (offset + 2u > metadata_length) return fail(replay, NES_REPLAY_ERROR_HEADER);
        value_length = read_u16(replay->data + metadata_offset + offset);
        offset += 2u;
        if (value_length > metadata_length - offset) return fail(replay, NES_REPLAY_ERROR_HEADER);
        offset += value_length;
    }
    if (offset != metadata_length) return fail(replay, NES_REPLAY_ERROR_HEADER);
    return NES_REPLAY_OK;
}

static int validate_moves(NesReplay *replay) {
    unsigned int index;
    for (index = 0u; index < replay->move_count; ++index) {
        unsigned int packed = read_u16(replay->data + replay->move_offset + index * 2u);
        unsigned int promotion = (packed >> 12) & 0x07u;
        if ((packed & 0x8000u) != 0u || promotion > 4u ||
            (packed & 0x3fu) == ((packed >> 6) & 0x3fu)) {
            return fail(replay, NES_REPLAY_ERROR_MOVE);
        }
    }
    return NES_REPLAY_OK;
}

static void clear_rook_right(NesReplay *replay, unsigned int square) {
    if (square == 0u) replay->castling_rights &= (unsigned char)~0x02u;
    else if (square == 7u) replay->castling_rights &= (unsigned char)~0x01u;
    else if (square == 56u) replay->castling_rights &= (unsigned char)~0x08u;
    else if (square == 63u) replay->castling_rights &= (unsigned char)~0x04u;
}

static int move_castling_rook(NesReplay *replay, unsigned int source, unsigned int target,
                              unsigned char expected_rook) {
    unsigned char rook = replay->board[source];
    if (rook != expected_rook || replay->board[target] != 0u) return 0;
    replay->board[source] = 0u;
    replay->board[target] = rook;
    return 1;
}

static int apply_move(NesReplay *replay, unsigned int move_index) {
    unsigned int offset;
    unsigned int packed;
    unsigned int source;
    unsigned int target;
    unsigned int promotion;
    unsigned int source_file;
    unsigned int target_file;
    unsigned int source_rank;
    unsigned int target_rank;
    unsigned char piece;
    unsigned char captured;
    unsigned char moving_color;
    unsigned char pawn_move;
    unsigned char previous_en_passant;
    if (move_index >= replay->move_count) return fail(replay, NES_REPLAY_ERROR_MOVE);
    offset = replay->move_offset + move_index * 2u;
    packed = read_u16(replay->data + offset);
    source = packed & 0x3fu;
    target = (packed >> 6) & 0x3fu;
    promotion = (packed >> 12) & 0x07u;
    source_file = source & 7u;
    target_file = target & 7u;
    source_rank = source >> 3;
    target_rank = target >> 3;
    piece = replay->board[source];
    captured = replay->board[target];
    previous_en_passant = replay->en_passant_target;

    if ((packed & 0x8000u) != 0u || promotion > 4u || source == target || piece == 0u) {
        return fail(replay, NES_REPLAY_ERROR_MOVE);
    }
    moving_color = is_white_piece(piece) ? WHITE : (is_black_piece(piece) ? BLACK : 2u);
    if (moving_color != replay->side_to_move) return fail(replay, NES_REPLAY_ERROR_MOVE);
    if (captured != 0u && ((is_white_piece(captured) && moving_color == WHITE) ||
                           (is_black_piece(captured) && moving_color == BLACK))) {
        return fail(replay, NES_REPLAY_ERROR_MOVE);
    }
    if (promotion != 0u && (!is_pawn(piece) || (target_rank != 0u && target_rank != 7u))) {
        return fail(replay, NES_REPLAY_ERROR_MOVE);
    }
    pawn_move = (unsigned char)(is_pawn(piece) != 0);

    replay->board[source] = 0u;
    replay->en_passant_target = 0xffu;

    if (is_pawn(piece)) {
        if (target == previous_en_passant && captured == 0u && source_file != target_file) {
            unsigned int captured_square;
            if (moving_color == WHITE) {
                if (target < 8u) return fail(replay, NES_REPLAY_ERROR_MOVE);
                captured_square = target - 8u;
            } else {
                if (target > 55u) return fail(replay, NES_REPLAY_ERROR_MOVE);
                captured_square = target + 8u;
            }
            if (replay->board[captured_square] != (moving_color == WHITE ? 9u : 1u)) {
                return fail(replay, NES_REPLAY_ERROR_MOVE);
            }
            replay->board[captured_square] = 0u;
            captured = moving_color == WHITE ? 9u : 1u;
        }
        if (source_file == target_file && source_rank + 2u == target_rank && moving_color == WHITE) {
            replay->en_passant_target = (unsigned char)(source + 8u);
        } else if (source_file == target_file && source_rank == target_rank + 2u && moving_color == BLACK) {
            replay->en_passant_target = (unsigned char)(source - 8u);
        }
        if (promotion != 0u) {
            if (promotion == 1u) piece = moving_color == WHITE ? 5u : 13u;
            else if (promotion == 2u) piece = moving_color == WHITE ? 4u : 12u;
            else if (promotion == 3u) piece = moving_color == WHITE ? 3u : 11u;
            else piece = moving_color == WHITE ? 2u : 10u;
        }
    }

    if (is_king(piece)) {
        if (moving_color == WHITE) replay->castling_rights &= (unsigned char)~0x03u;
        else replay->castling_rights &= (unsigned char)~0x0cu;
        if (source_rank == target_rank && source_file + 2u == target_file) {
            if (captured != 0u) return fail(replay, NES_REPLAY_ERROR_MOVE);
            if (!move_castling_rook(replay, moving_color == WHITE ? 7u : 63u,
                                    moving_color == WHITE ? 5u : 61u,
                                    moving_color == WHITE ? 4u : 12u)) {
                return fail(replay, NES_REPLAY_ERROR_MOVE);
            }
        } else if (source_rank == target_rank && target_file + 2u == source_file) {
            if (captured != 0u) return fail(replay, NES_REPLAY_ERROR_MOVE);
            if (!move_castling_rook(replay, moving_color == WHITE ? 0u : 56u,
                                    moving_color == WHITE ? 3u : 59u,
                                    moving_color == WHITE ? 4u : 12u)) {
                return fail(replay, NES_REPLAY_ERROR_MOVE);
            }
        }
    } else if (is_rook(piece)) {
        clear_rook_right(replay, source);
    }
    if (is_rook(captured)) clear_rook_right(replay, target);

    replay->board[target] = piece;
    if (pawn_move != 0u || captured != 0u) replay->halfmove_clock = 0ul;
    else ++replay->halfmove_clock;
    if (moving_color == BLACK) ++replay->fullmove_number;
    replay->side_to_move = moving_color == WHITE ? BLACK : WHITE;
    return NES_REPLAY_OK;
}

static int reset_to_root(NesReplay *replay) {
    unsigned char flags = replay->data[5];
    unsigned int root_length = read_u16(replay->data + 10u);
    const unsigned char *root = replay->data + NES_REPLAY_HEADER_BYTES;

    if ((flags & FLAG_POSITION_ROOT) != 0u) {
        if (set_position_root(replay, root) != NES_REPLAY_OK) return -(int)replay->error;
    } else {
        set_standard_root(replay);
        if (root_length != 0u) return fail(replay, NES_REPLAY_ERROR_ROOT);
    }
    replay->current_ply = 0u;
    return NES_REPLAY_OK;
}

int nes_replay_load(NesReplay *replay, const unsigned char *data, unsigned int data_length) {
    unsigned int flags;
    unsigned int move_count;
    unsigned int root_length;
    unsigned int metadata_length;
    unsigned long expected_length;

    replay->data = data;
    replay->data_length = data_length;
    replay->valid = 0u;
    replay->error = 0u;
    if (data == 0 || data_length < NES_REPLAY_HEADER_BYTES) return fail(replay, NES_REPLAY_ERROR_HEADER);
    if (data[0] != 'R' || data[1] != 'P' || data[2] != 'L' || data[3] != 'Y' ||
        data[4] != 1u || data[6] != 1u || data[7] != 0u) {
        return fail(replay, NES_REPLAY_ERROR_HEADER);
    }
    flags = data[5];
    if ((flags & (unsigned int)~KNOWN_FLAGS) != 0u) return fail(replay, NES_REPLAY_ERROR_HEADER);
    move_count = read_u16(data + 8u);
    root_length = read_u16(data + 10u);
    metadata_length = read_u16(data + 12u);
    if (move_count > NES_REPLAY_MAX_PLIES) return fail(replay, NES_REPLAY_ERROR_LIMIT);
    if ((flags & FLAG_POSITION_ROOT) != 0u) {
        if (root_length != NES_REPLAY_POSITION_ROOT_BYTES) return fail(replay, NES_REPLAY_ERROR_ROOT);
    } else if (root_length != 0u) {
        return fail(replay, NES_REPLAY_ERROR_ROOT);
    }
    expected_length = (unsigned long)NES_REPLAY_HEADER_BYTES + root_length + metadata_length + (unsigned long)move_count * 2ul;
    if (expected_length != (unsigned long)data_length) return fail(replay, NES_REPLAY_ERROR_HEADER);
    replay->move_offset = NES_REPLAY_HEADER_BYTES + root_length + metadata_length;
    replay->move_count = move_count;
    if (validate_metadata(replay, NES_REPLAY_HEADER_BYTES + root_length, metadata_length) != NES_REPLAY_OK) {
        return -(int)replay->error;
    }
    if (validate_moves(replay) != NES_REPLAY_OK) return -(int)replay->error;
    if (reset_to_root(replay) != NES_REPLAY_OK) return -(int)replay->error;
    replay->valid = 1u;
    return NES_REPLAY_OK;
}

int nes_replay_seek(NesReplay *replay, unsigned int ply) {
    unsigned int index;
    if (replay->valid == 0u) return -(int)(replay->error == 0u ? NES_REPLAY_ERROR_STATE : replay->error);
    if (ply > replay->move_count) return fail(replay, NES_REPLAY_ERROR_LIMIT);
    if (reset_to_root(replay) != NES_REPLAY_OK) return -(int)replay->error;
    for (index = 0u; index < ply; ++index) {
        if (apply_move(replay, index) != NES_REPLAY_OK) return -(int)replay->error;
        replay->current_ply = index + 1u;
    }
    return NES_REPLAY_OK;
}

int nes_replay_first(NesReplay *replay) {
    if (replay->valid == 0u) return -(int)(replay->error == 0u ? NES_REPLAY_ERROR_STATE : replay->error);
    if (replay->current_ply == 0u) return NES_REPLAY_NOOP;
    return nes_replay_seek(replay, 0u);
}

int nes_replay_last(NesReplay *replay) {
    if (replay->valid == 0u) return -(int)(replay->error == 0u ? NES_REPLAY_ERROR_STATE : replay->error);
    if (replay->current_ply == replay->move_count) return NES_REPLAY_NOOP;
    return nes_replay_seek(replay, replay->move_count);
}

int nes_replay_next(NesReplay *replay) {
    if (replay->valid == 0u) return -(int)(replay->error == 0u ? NES_REPLAY_ERROR_STATE : replay->error);
    if (replay->current_ply >= replay->move_count) return NES_REPLAY_NOOP;
    if (apply_move(replay, replay->current_ply) != NES_REPLAY_OK) return -(int)replay->error;
    ++replay->current_ply;
    return NES_REPLAY_OK;
}

int nes_replay_previous(NesReplay *replay) {
    if (replay->valid == 0u) return -(int)(replay->error == 0u ? NES_REPLAY_ERROR_STATE : replay->error);
    if (replay->current_ply == 0u) return NES_REPLAY_NOOP;
    return nes_replay_seek(replay, replay->current_ply - 1u);
}

static char piece_character(unsigned char piece) {
    static const char white[] = "PNBRQK";
    static const char black[] = "pnbrqk";
    if (piece >= 1u && piece <= 6u) return white[piece - 1u];
    if (piece >= 9u && piece <= 14u) return black[piece - 9u];
    return '.';
}

unsigned int nes_replay_render(const NesReplay *replay, char *output, unsigned int capacity) {
    unsigned int rank;
    unsigned int file;
    unsigned int offset = 0u;
    if (replay == 0 || replay->valid == 0u || output == 0 || capacity < NES_REPLAY_RENDER_BYTES) return 0u;
    for (rank = 8u; rank > 0u; --rank) {
        for (file = 0u; file < 8u; ++file) output[offset++] = piece_character(replay->board[(rank - 1u) * 8u + file]);
        output[offset++] = '\n';
    }
    output[offset] = '\0';
    return offset;
}

const char *nes_replay_error_name(unsigned char error) {
    if (error == NES_REPLAY_ERROR_HEADER) return "header";
    if (error == NES_REPLAY_ERROR_ROOT) return "root";
    if (error == NES_REPLAY_ERROR_MOVE) return "move";
    if (error == NES_REPLAY_ERROR_LIMIT) return "limit";
    if (error == NES_REPLAY_ERROR_STATE) return "state";
    return "none";
}
