#ifndef NES_REPLAY_H
#define NES_REPLAY_H

#define NES_REPLAY_HEADER_BYTES 46u
#define NES_REPLAY_POSITION_ROOT_BYTES 75u
#define NES_REPLAY_MAX_PLIES 4096u
#define NES_REPLAY_RENDER_BYTES 73u

#define NES_REPLAY_OK 0
#define NES_REPLAY_NOOP 1

#define NES_REPLAY_ERROR_HEADER 1
#define NES_REPLAY_ERROR_ROOT 2
#define NES_REPLAY_ERROR_MOVE 3
#define NES_REPLAY_ERROR_LIMIT 4
#define NES_REPLAY_ERROR_STATE 5

typedef struct NesReplay {
    const unsigned char *data;
    unsigned int data_length;
    unsigned int move_offset;
    unsigned int move_count;
    unsigned int current_ply;
    unsigned char side_to_move;
    unsigned char castling_rights;
    unsigned char en_passant_target;
    unsigned long halfmove_clock;
    unsigned long fullmove_number;
    unsigned char board[64];
    unsigned char error;
    unsigned char valid;
} NesReplay;

int nes_replay_load(NesReplay *replay, const unsigned char *data, unsigned int data_length);
int nes_replay_seek(NesReplay *replay, unsigned int ply);
int nes_replay_first(NesReplay *replay);
int nes_replay_last(NesReplay *replay);
int nes_replay_next(NesReplay *replay);
int nes_replay_previous(NesReplay *replay);
unsigned int nes_replay_render(const NesReplay *replay, char *output, unsigned int capacity);
const char *nes_replay_error_name(unsigned char error);

#endif
