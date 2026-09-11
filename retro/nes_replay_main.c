#include <conio.h>
#include <joystick.h>
#include <nes.h>

#include "nes_replay.h"
#include "nes_replay_data.h"

/* The linker maps this cartridge RAM range at $6000-$7fff.  The trace is
 * outside the cc65 BSS area so an emulator can inspect it without a debugger.
 */
#define TRACE ((volatile unsigned char *)0x7000)

#define TRACE_EVENT 0u
#define TRACE_COMMAND 1u
#define TRACE_VALID 2u
#define TRACE_PLY 3u
#define TRACE_MOVE_COUNT 4u
#define TRACE_SIDE 5u
#define TRACE_RIGHTS 6u
#define TRACE_EP 7u
#define TRACE_HALFMOVE 8u
#define TRACE_FULLMOVE 12u
#define TRACE_BOARD 16u
#define TRACE_ERROR 80u
#define TRACE_DEMO_STAGE 81u
#define TRACE_DONE 82u

#define COMMAND_LOAD 0u
#define COMMAND_NEXT 1u
#define COMMAND_PREVIOUS 2u
#define COMMAND_FIRST 3u
#define COMMAND_LAST 4u

static void put_unsigned(unsigned int value)
{
    char digits[6];
    unsigned char length = 0u;

    do {
        digits[length++] = (char)('0' + value % 10u);
        value /= 10u;
    } while (value != 0u);
    while (length != 0u) cputc(digits[--length]);
}

static void draw_board(const NesReplay *replay)
{
    char board[80];
    unsigned int length;
    unsigned int index;

    clrscr();
    gotoxy(2u, 1u);
    cputs("RPL-016 NES REPLAY");
    gotoxy(2u, 2u);
    cputs("PLY ");
    put_unsigned(replay->current_ply);
    cputs("/");
    put_unsigned(replay->move_count);
    cputs("  A:NEXT B:BACK SEL:FIRST START:LAST");
    gotoxy(4u, 4u);
    length = nes_replay_render(replay, board, sizeof(board));
    for (index = 0u; index < length; ++index) {
        if (board[index] == '\n') cputc(CH_ENTER);
        else cputc(board[index]);
    }
    gotoxy(4u, 14u);
    cputs("WHITE TO MOVE: ");
    cputs(replay->side_to_move == 0u ? "YES" : "NO");
}

static void trace_position(const NesReplay *replay, unsigned char command,
                           unsigned char demo_stage, unsigned char done)
{
    unsigned int index;
    unsigned long value;
    unsigned char event;

    /* Publish the event byte last so a Lua observer never consumes a partial
     * position while the board is being copied. */
    event = (unsigned char)(TRACE[TRACE_EVENT] + 1u);
    TRACE[TRACE_COMMAND] = command;
    TRACE[TRACE_VALID] = replay->valid;
    TRACE[TRACE_PLY] = (unsigned char)replay->current_ply;
    TRACE[TRACE_MOVE_COUNT] = (unsigned char)replay->move_count;
    TRACE[TRACE_SIDE] = replay->side_to_move;
    TRACE[TRACE_RIGHTS] = replay->castling_rights;
    TRACE[TRACE_EP] = replay->en_passant_target;
    value = replay->halfmove_clock;
    TRACE[TRACE_HALFMOVE] = (unsigned char)value;
    TRACE[TRACE_HALFMOVE + 1u] = (unsigned char)(value >> 8);
    TRACE[TRACE_HALFMOVE + 2u] = (unsigned char)(value >> 16);
    TRACE[TRACE_HALFMOVE + 3u] = (unsigned char)(value >> 24);
    value = replay->fullmove_number;
    TRACE[TRACE_FULLMOVE] = (unsigned char)value;
    TRACE[TRACE_FULLMOVE + 1u] = (unsigned char)(value >> 8);
    TRACE[TRACE_FULLMOVE + 2u] = (unsigned char)(value >> 16);
    TRACE[TRACE_FULLMOVE + 3u] = (unsigned char)(value >> 24);
    for (index = 0u; index < 64u; ++index) TRACE[TRACE_BOARD + index] = replay->board[index];
    TRACE[TRACE_ERROR] = replay->error;
    TRACE[TRACE_DEMO_STAGE] = demo_stage;
    TRACE[TRACE_DONE] = done;
    TRACE[TRACE_EVENT] = event;
}

static void navigation(NesReplay *replay, unsigned char command)
{
    if (command == COMMAND_NEXT) (void)nes_replay_next(replay);
    else if (command == COMMAND_PREVIOUS) (void)nes_replay_previous(replay);
    else if (command == COMMAND_FIRST) (void)nes_replay_first(replay);
    else if (command == COMMAND_LAST) (void)nes_replay_last(replay);
}

int main(void)
{
    NesReplay replay;
    unsigned int frame_count = 0u;
    unsigned char previous_buttons = 0u;
    unsigned char demo_stage = 0u;
    unsigned char demo_timer = 0u;
    unsigned char done = 0u;
    unsigned char buttons;
    unsigned char pressed;
    unsigned char command;

    if (nes_replay_load(&replay, NES_REPLAY_DATA, NES_REPLAY_DATA_LEN) != NES_REPLAY_OK) {
        TRACE[TRACE_VALID] = 0u;
        TRACE[TRACE_ERROR] = replay.error;
        TRACE[TRACE_DONE] = 1u;
        clrscr();
        cputs("RPL-016 INVALID REPLAY");
        while (1) waitvsync();
    }

    textcolor(COLOR_WHITE);
    bgcolor(COLOR_BLUE);
    bordercolor(COLOR_BLACK);
    joy_install(joy_static_stddrv);
    trace_position(&replay, COMMAND_LOAD, demo_stage, done);
    draw_board(&replay);

    while (1) {
        waitvsync();
        ++frame_count;
        buttons = joy_read(JOY_1);
        pressed = (unsigned char)(buttons & (unsigned char)~previous_buttons);
        command = 0xffu;

        if ((pressed & JOY_BTN_A_MASK) != 0u) command = COMMAND_NEXT;
        else if ((pressed & JOY_BTN_B_MASK) != 0u) command = COMMAND_PREVIOUS;
        else if ((pressed & JOY_SELECT_MASK) != 0u) command = COMMAND_FIRST;
        else if ((pressed & JOY_START_MASK) != 0u) command = COMMAND_LAST;
        else if (demo_stage < 5u) {
            ++demo_timer;
            if (demo_timer >= 20u) {
                demo_timer = 0u;
                command = (unsigned char)(demo_stage == 0u || demo_stage == 1u
                    ? COMMAND_NEXT
                    : (demo_stage == 2u ? COMMAND_PREVIOUS
                       : (demo_stage == 3u ? COMMAND_FIRST : COMMAND_LAST)));
                ++demo_stage;
                if (demo_stage == 5u) done = 1u;
            }
        }

        if (command != 0xffu) {
            navigation(&replay, command);
            trace_position(&replay, command, demo_stage, done);
            draw_board(&replay);
        }
        previous_buttons = buttons;
        if (frame_count == 0u) frame_count = 1u;
    }
    return 0;
}
