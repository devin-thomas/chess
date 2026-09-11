#include <stdio.h>

#include "nes_replay.h"
#include "nes_replay_data.h"

static void print_square(unsigned char square)
{
    if (square == 0xffu) {
        putchar('-');
        return;
    }
    putchar((int)('a' + (square & 7u)));
    putchar((int)('1' + (square >> 3)));
}

static void print_rights(unsigned char rights)
{
    if ((rights & 1u) != 0u) putchar('K');
    if ((rights & 2u) != 0u) putchar('Q');
    if ((rights & 4u) != 0u) putchar('k');
    if ((rights & 8u) != 0u) putchar('q');
    if ((rights & 15u) == 0u) putchar('-');
}

static int print_state(const NesReplay *replay)
{
    unsigned int rank;
    unsigned int file;
    unsigned int offset = 0u;
    char board[80];

    for (rank = 8u; rank > 0u; --rank) {
        unsigned int empty = 0u;
        for (file = 0u; file < 8u; ++file) {
            unsigned char piece = replay->board[(rank - 1u) * 8u + file];
            char symbol = piece == 0u ? '.' :
                piece <= 6u ? " PNBRQK"[piece] :
                piece >= 9u && piece <= 14u ? "       pnbrqk"[piece - 2u] : '?';
            if (symbol == '.') {
                ++empty;
            } else {
                if (empty > 0u) board[offset++] = (char)('0' + empty), empty = 0u;
                board[offset++] = symbol;
            }
        }
        if (empty > 0u) board[offset++] = (char)('0' + empty);
        if (rank > 1u) board[offset++] = '/';
    }
    board[offset] = '\0';
    printf("NES_PLY %u board=", replay->current_ply);
    fputs(board, stdout);
    printf(" side=%s rights=", replay->side_to_move == 0u ? "white" : "black");
    print_rights(replay->castling_rights);
    printf(" ep=");
    print_square(replay->en_passant_target);
    printf(" halfmove=%lu fullmove=%lu\n", replay->halfmove_clock, replay->fullmove_number);
    return 1;
}

static int expect_result(const char *name, int actual, int expected)
{
    if (actual == expected) return 1;
    fprintf(stderr, "NES_ERROR %s expected=%d actual=%d\n", name, expected, actual);
    return 0;
}

int main(void)
{
    NesReplay replay;
    NesReplay invalid;
    unsigned char bad[NES_REPLAY_DATA_LEN];
    unsigned int index;

    if (!expect_result("load", nes_replay_load(&replay, NES_REPLAY_DATA, NES_REPLAY_DATA_LEN), NES_REPLAY_OK)) return 1;
    printf("NES_OK format=1 moves=%u\n", replay.move_count);
    if (!print_state(&replay)) return 1;
    if (!expect_result("first-at-root", nes_replay_first(&replay), NES_REPLAY_NOOP)) return 1;
    if (!expect_result("previous-at-root", nes_replay_previous(&replay), NES_REPLAY_NOOP)) return 1;
    if (!expect_result("next-1", nes_replay_next(&replay), NES_REPLAY_OK) || !print_state(&replay)) return 1;
    if (!expect_result("next-2", nes_replay_next(&replay), NES_REPLAY_OK) || !print_state(&replay)) return 1;
    if (!expect_result("next-at-end", nes_replay_next(&replay), NES_REPLAY_NOOP)) return 1;
    if (!expect_result("previous", nes_replay_previous(&replay), NES_REPLAY_OK)) return 1;
    if (!expect_result("first", nes_replay_first(&replay), NES_REPLAY_OK)) return 1;
    if (!expect_result("last", nes_replay_last(&replay), NES_REPLAY_OK)) return 1;
    if (replay.current_ply != replay.move_count) return 1;
    puts("NES_NAV ok");

    for (index = 0u; index < NES_REPLAY_DATA_LEN; ++index) bad[index] = NES_REPLAY_DATA[index];
    bad[0] = 'X';
    if (nes_replay_load(&invalid, bad, NES_REPLAY_DATA_LEN) >= NES_REPLAY_OK) return 1;
    for (index = 0u; index < NES_REPLAY_DATA_LEN; ++index) bad[index] = NES_REPLAY_DATA[index];
    bad[8] = 0xffu;
    bad[9] = 0xffu;
    if (nes_replay_load(&invalid, bad, NES_REPLAY_DATA_LEN) >= NES_REPLAY_OK) return 1;
    for (index = 0u; index < NES_REPLAY_DATA_LEN; ++index) bad[index] = NES_REPLAY_DATA[index];
    bad[NES_REPLAY_HEADER_BYTES] = 7u;
    if (nes_replay_load(&invalid, bad, NES_REPLAY_DATA_LEN) >= NES_REPLAY_OK) return 1;
    for (index = 0u; index < NES_REPLAY_DATA_LEN; ++index) bad[index] = NES_REPLAY_DATA[index];
    bad[NES_REPLAY_DATA_LEN - 1u] |= 0x80u;
    if (nes_replay_load(&invalid, bad, NES_REPLAY_DATA_LEN) == NES_REPLAY_OK) return 1;
    puts("NES_INVALID ok");
    return 0;
}
