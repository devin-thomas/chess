#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BOARD_SIZE 64
#define MAX_MOVES 512
#define KEY_SIZE 128
#define INITIAL_FEN \
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

enum {
    WHITE = 0,
    BLACK = 1
};

enum {
    MODE_BASIC = 0,
    MODE_ALL = 1
};

enum {
    CASTLE_WK = 1,
    CASTLE_WQ = 2,
    CASTLE_BK = 4,
    CASTLE_BQ = 8
};

enum {
    MOVE_EN_PASSANT = 1,
    MOVE_CASTLE = 2
};

typedef struct {
    char board[BOARD_SIZE];
    int side;
    int castling;
    int en_passant;
    uint64_t halfmove;
    uint64_t fullmove;
} Position;

typedef struct {
    int from;
    int to;
    char promotion;
    unsigned flags;
} Move;

typedef struct {
    Move items[MAX_MOVES];
    size_t count;
} MoveList;

typedef struct {
    char (*keys)[KEY_SIZE];
    size_t count;
    size_t capacity;
} History;

typedef struct {
    char **items;
    size_t count;
    size_t capacity;
} MoveLedger;

typedef struct {
    bool initialized;
    int mode;
    Position position;
    History history;
    MoveLedger ledger;
    uint64_t seed;
} Session;

typedef struct {
    bool terminal;
    const char *status;
    const char *reason;
    const char *result;
    int winner;
    int checked_color;
} Evaluation;

typedef struct {
    char *op;
    char *mode;
    char *fen;
    char *move;
    char *seed;
    bool has_depth;
    uint64_t depth;
    bool has_max_plies;
    uint64_t max_plies;
    bool has_samples;
    uint64_t samples;
    bool has_trace;
    bool trace;
} Request;

static char *duplicate_range(const char *begin, size_t length)
{
    char *result = (char *)malloc(length + 1U);
    if (result == NULL) {
        return NULL;
    }
    memcpy(result, begin, length);
    result[length] = '\0';
    return result;
}

static char *duplicate_string(const char *value)
{
    return value == NULL ? NULL : duplicate_range(value, strlen(value));
}

static void request_free(Request *request)
{
    if (request == NULL) {
        return;
    }
    free(request->op);
    free(request->mode);
    free(request->fen);
    free(request->move);
    free(request->seed);
    memset(request, 0, sizeof(*request));
}

static void skip_json_space(const char **cursor)
{
    while (**cursor != '\0' && isspace((unsigned char)**cursor) != 0) {
        ++*cursor;
    }
}

static int hex_value(char value)
{
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    if (value >= 'A' && value <= 'F') {
        return value - 'A' + 10;
    }
    return -1;
}

static bool append_buffer_char(char **buffer, size_t *length, size_t *capacity, char value)
{
    if (*length + 1U >= *capacity) {
        size_t next_capacity = *capacity == 0U ? 32U : *capacity * 2U;
        char *next = (char *)realloc(*buffer, next_capacity);
        if (next == NULL) {
            return false;
        }
        *buffer = next;
        *capacity = next_capacity;
    }
    (*buffer)[*length] = value;
    ++*length;
    (*buffer)[*length] = '\0';
    return true;
}

static bool parse_json_string_value(const char **cursor, char **result)
{
    const char *p = *cursor;
    char *buffer = NULL;
    size_t length = 0U;
    size_t capacity = 0U;

    if (*p != '"') {
        return false;
    }
    ++p;
    while (*p != '\0' && *p != '"') {
        unsigned char decoded;
        if ((unsigned char)*p < 0x20U) {
            free(buffer);
            return false;
        }
        if (*p != '\\') {
            if (!append_buffer_char(&buffer, &length, &capacity, *p)) {
                free(buffer);
                return false;
            }
            ++p;
            continue;
        }
        ++p;
        switch (*p) {
        case '"': decoded = '"'; ++p; break;
        case '\\': decoded = '\\'; ++p; break;
        case '/': decoded = '/'; ++p; break;
        case 'b': decoded = '\b'; ++p; break;
        case 'f': decoded = '\f'; ++p; break;
        case 'n': decoded = '\n'; ++p; break;
        case 'r': decoded = '\r'; ++p; break;
        case 't': decoded = '\t'; ++p; break;
        case 'u': {
            int value = 0;
            int i;
            ++p;
            for (i = 0; i < 4; ++i) {
                int digit = hex_value(p[i]);
                if (digit < 0) {
                    free(buffer);
                    return false;
                }
                value = value * 16 + digit;
            }
            p += 4;
            /* Protocol strings are ASCII. Preserve non-ASCII escapes as '?'. */
            decoded = value <= 0x7f ? (unsigned char)value : (unsigned char)'?';
            break;
        }
        default:
            free(buffer);
            return false;
        }
        if (!append_buffer_char(&buffer, &length, &capacity, (char)decoded)) {
            free(buffer);
            return false;
        }
    }
    if (*p != '"') {
        free(buffer);
        return false;
    }
    ++p;
    if (buffer == NULL) {
        buffer = duplicate_string("");
    }
    if (buffer == NULL) {
        return false;
    }
    *cursor = p;
    *result = buffer;
    return true;
}

static bool skip_json_string_value(const char **cursor)
{
    const char *p = *cursor;
    if (*p != '"') {
        return false;
    }
    ++p;
    while (*p != '\0' && *p != '"') {
        if ((unsigned char)*p < 0x20U) {
            return false;
        }
        if (*p == '\\') {
            ++p;
            if (*p == '\0') {
                return false;
            }
            if (*p == 'u') {
                int i;
                ++p;
                for (i = 0; i < 4; ++i) {
                    if (hex_value(p[i]) < 0) {
                        return false;
                    }
                }
                p += 4;
            } else if (strchr("\"\\/bfnrt", *p) != NULL) {
                ++p;
            } else {
                return false;
            }
        } else {
            ++p;
        }
    }
    if (*p != '"') {
        return false;
    }
    *cursor = p + 1;
    return true;
}

static bool skip_json_value(const char **cursor)
{
    const char *p = *cursor;
    skip_json_space(&p);
    if (*p == '"') {
        if (!skip_json_string_value(&p)) {
            return false;
        }
        *cursor = p;
        return true;
    }
    if (*p == '{') {
        ++p;
        skip_json_space(&p);
        if (*p == '}') {
            *cursor = p + 1;
            return true;
        }
        for (;;) {
            if (!skip_json_string_value(&p)) {
                return false;
            }
            skip_json_space(&p);
            if (*p != ':') {
                return false;
            }
            ++p;
            if (!skip_json_value(&p)) {
                return false;
            }
            skip_json_space(&p);
            if (*p == '}') {
                *cursor = p + 1;
                return true;
            }
            if (*p != ',') {
                return false;
            }
            ++p;
            skip_json_space(&p);
        }
    }
    if (*p == '[') {
        ++p;
        skip_json_space(&p);
        if (*p == ']') {
            *cursor = p + 1;
            return true;
        }
        for (;;) {
            if (!skip_json_value(&p)) {
                return false;
            }
            skip_json_space(&p);
            if (*p == ']') {
                *cursor = p + 1;
                return true;
            }
            if (*p != ',') {
                return false;
            }
            ++p;
            skip_json_space(&p);
        }
    }
    if (strncmp(p, "true", 4U) == 0) {
        *cursor = p + 4;
        return true;
    }
    if (strncmp(p, "false", 5U) == 0) {
        *cursor = p + 5;
        return true;
    }
    if (strncmp(p, "null", 4U) == 0) {
        *cursor = p + 4;
        return true;
    }
    if (*p == '-' || (*p >= '0' && *p <= '9')) {
        const char *start = p;
        if (*p == '-') {
            ++p;
        }
        if (*p == '0') {
            ++p;
            if (*p >= '0' && *p <= '9') {
                return false;
            }
        } else {
            if (*p < '1' || *p > '9') {
                return false;
            }
            while (*p >= '0' && *p <= '9') {
                ++p;
            }
        }
        if (*p == '.') {
            ++p;
            if (*p < '0' || *p > '9') {
                return false;
            }
            while (*p >= '0' && *p <= '9') {
                ++p;
            }
        }
        if (*p == 'e' || *p == 'E') {
            ++p;
            if (*p == '+' || *p == '-') {
                ++p;
            }
            if (*p < '0' || *p > '9') {
                return false;
            }
            while (*p >= '0' && *p <= '9') {
                ++p;
            }
        }
        if (p == start) {
            return false;
        }
        *cursor = p;
        return true;
    }
    return false;
}

static bool parse_json_uint_value(const char **cursor, uint64_t *result)
{
    const char *p = *cursor;
    const char *end;
    char *number;
    char *number_end;
    unsigned long long parsed;

    if (*p < '0' || *p > '9') {
        return false;
    }
    end = p;
    if (*end == '0') {
        ++end;
        if (*end >= '0' && *end <= '9') {
            return false;
        }
    } else {
        while (*end >= '0' && *end <= '9') {
            ++end;
        }
    }
    number = duplicate_range(p, (size_t)(end - p));
    if (number == NULL) {
        return false;
    }
    errno = 0;
    parsed = strtoull(number, &number_end, 10);
    if (errno == ERANGE || *number_end != '\0') {
        free(number);
        return false;
    }
    free(number);
    *result = (uint64_t)parsed;
    *cursor = end;
    return true;
}

static bool parse_json_bool_value(const char **cursor, bool *result)
{
    if (strncmp(*cursor, "true", 4U) == 0) {
        *cursor += 4;
        *result = true;
        return true;
    }
    if (strncmp(*cursor, "false", 5U) == 0) {
        *cursor += 5;
        *result = false;
        return true;
    }
    return false;
}

static bool parse_seed_value(const char **cursor, char **result)
{
    const char *p = *cursor;
    if (*p == '"') {
        return parse_json_string_value(cursor, result);
    }
    if (*p >= '0' && *p <= '9') {
        const char *start = p;
        uint64_t ignored;
        if (!parse_json_uint_value(&p, &ignored)) {
            return false;
        }
        *result = duplicate_range(start, (size_t)(p - start));
        if (*result == NULL) {
            return false;
        }
        *cursor = p;
        return true;
    }
    return false;
}

static bool parse_request_line(const char *line, Request *request)
{
    const char *p = line;
    bool ok = true;
    memset(request, 0, sizeof(*request));
    skip_json_space(&p);
    if (*p != '{') {
        return false;
    }
    ++p;
    skip_json_space(&p);
    if (*p != '}') {
        for (;;) {
            char *key = NULL;
            if (!parse_json_string_value(&p, &key)) {
                ok = false;
                break;
            }
            skip_json_space(&p);
            if (*p != ':') {
                free(key);
                ok = false;
                break;
            }
            ++p;
            skip_json_space(&p);
            if (strcmp(key, "op") == 0) {
                if (request->op != NULL || !parse_json_string_value(&p, &request->op)) {
                    ok = false;
                }
            } else if (strcmp(key, "mode") == 0) {
                if (request->mode != NULL || !parse_json_string_value(&p, &request->mode)) {
                    ok = false;
                }
            } else if (strcmp(key, "fen") == 0) {
                if (request->fen != NULL || !parse_json_string_value(&p, &request->fen)) {
                    ok = false;
                }
            } else if (strcmp(key, "move") == 0) {
                if (request->move != NULL || !parse_json_string_value(&p, &request->move)) {
                    ok = false;
                }
            } else if (strcmp(key, "seed") == 0) {
                if (request->seed != NULL || !parse_seed_value(&p, &request->seed)) {
                    ok = false;
                }
            } else if (strcmp(key, "depth") == 0) {
                if (request->has_depth || !parse_json_uint_value(&p, &request->depth)) {
                    ok = false;
                } else {
                    request->has_depth = true;
                }
            } else if (strcmp(key, "max_plies") == 0) {
                if (request->has_max_plies || !parse_json_uint_value(&p, &request->max_plies)) {
                    ok = false;
                } else {
                    request->has_max_plies = true;
                }
            } else if (strcmp(key, "samples") == 0) {
                if (request->has_samples || !parse_json_uint_value(&p, &request->samples)) {
                    ok = false;
                } else {
                    request->has_samples = true;
                }
            } else if (strcmp(key, "trace") == 0) {
                if (request->has_trace || !parse_json_bool_value(&p, &request->trace)) {
                    ok = false;
                } else {
                    request->has_trace = true;
                }
            } else if (!skip_json_value(&p)) {
                ok = false;
            }
            free(key);
            if (!ok) {
                break;
            }
            skip_json_space(&p);
            if (*p == '}') {
                ++p;
                break;
            }
            if (*p != ',') {
                ok = false;
                break;
            }
            ++p;
            skip_json_space(&p);
        }
    } else {
        ++p;
    }
    skip_json_space(&p);
    if (*p != '\0') {
        ok = false;
    }
    if (request->op == NULL) {
        ok = false;
    }
    if (!ok) {
        request_free(request);
    }
    return ok;
}

static void json_string(const char *value)
{
    const unsigned char *p = (const unsigned char *)value;
    putchar('"');
    while (*p != '\0') {
        switch (*p) {
        case '"': fputs("\\\"", stdout); break;
        case '\\': fputs("\\\\", stdout); break;
        case '\b': fputs("\\b", stdout); break;
        case '\f': fputs("\\f", stdout); break;
        case '\n': fputs("\\n", stdout); break;
        case '\r': fputs("\\r", stdout); break;
        case '\t': fputs("\\t", stdout); break;
        default:
            if (*p < 0x20U) {
                printf("\\u%04x", (unsigned)*p);
            } else {
                putchar((int)*p);
            }
            break;
        }
        ++p;
    }
    putchar('"');
}

static const char *side_name(int side)
{
    return side == WHITE ? "white" : "black";
}

static char piece_for_type(char type, int side)
{
    return side == WHITE ? type : (char)tolower((unsigned char)type);
}

static int piece_color(char piece)
{
    if (piece >= 'A' && piece <= 'Z') {
        return WHITE;
    }
    if (piece >= 'a' && piece <= 'z') {
        return BLACK;
    }
    return -1;
}

static char piece_type(char piece)
{
    return (char)toupper((unsigned char)piece);
}

static bool is_piece(char piece)
{
    return piece_color(piece) >= 0;
}

static int file_of(int square)
{
    return square & 7;
}

static int rank_of(int square)
{
    return square >> 3;
}

static int square_of(int file, int rank)
{
    return rank * 8 + file;
}

static bool in_bounds(int file, int rank)
{
    return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

static void square_name(int square, char output[3])
{
    output[0] = (char)('a' + file_of(square));
    output[1] = (char)('1' + rank_of(square));
    output[2] = '\0';
}

static void move_name(const Move *move, char output[7])
{
    char from[3];
    char to[3];
    square_name(move->from, from);
    square_name(move->to, to);
    output[0] = from[0];
    output[1] = from[1];
    output[2] = to[0];
    output[3] = to[1];
    if (move->promotion != '\0') {
        output[4] = move->promotion;
        output[5] = '\0';
    } else {
        output[4] = '\0';
    }
}

static bool parse_coordinate(const char *text, int *square)
{
    if (text == NULL || text[0] < 'a' || text[0] > 'h' || text[1] < '1' || text[1] > '8' || text[2] != '\0') {
        return false;
    }
    *square = square_of(text[0] - 'a', text[1] - '1');
    return true;
}

static bool parse_move_name(const char *text, Move *move)
{
    size_t length;
    char from[3];
    char to[3];
    if (text == NULL) {
        return false;
    }
    length = strlen(text);
    if (length != 4U && length != 5U) {
        return false;
    }
    from[0] = text[0]; from[1] = text[1]; from[2] = '\0';
    to[0] = text[2]; to[1] = text[3]; to[2] = '\0';
    if (!parse_coordinate(from, &move->from) || !parse_coordinate(to, &move->to)) {
        return false;
    }
    move->promotion = '\0';
    move->flags = 0U;
    if (length == 5U) {
        if (text[4] != 'q' && text[4] != 'r' && text[4] != 'b' && text[4] != 'n') {
            return false;
        }
        move->promotion = text[4];
    }
    return true;
}

static void position_empty(Position *position)
{
    memset(position->board, '.', sizeof(position->board));
    position->side = WHITE;
    position->castling = 0;
    position->en_passant = -1;
    position->halfmove = 0U;
    position->fullmove = 1U;
}

static int find_king(const Position *position, int side)
{
    char king = piece_for_type('K', side);
    int square;
    for (square = 0; square < BOARD_SIZE; ++square) {
        if (position->board[square] == king) {
            return square;
        }
    }
    return -1;
}

static bool square_attacked(const Position *position, int target, int by_side)
{
    int file = file_of(target);
    int rank = rank_of(target);
    int source_file;
    int source_rank;
    static const int knight_steps[8][2] = {
        {1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}
    };
    static const int king_steps[8][2] = {
        {1, 1}, {1, 0}, {1, -1}, {0, -1}, {-1, -1}, {-1, 0}, {-1, 1}, {0, 1}
    };
    static const int rook_steps[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    static const int bishop_steps[4][2] = {{1, 1}, {1, -1}, {-1, 1}, {-1, -1}};
    int i;

    source_rank = rank + (by_side == WHITE ? -1 : 1);
    for (source_file = file - 1; source_file <= file + 1; source_file += 2) {
        if (in_bounds(source_file, source_rank) &&
            position->board[square_of(source_file, source_rank)] == piece_for_type('P', by_side)) {
            return true;
        }
    }
    for (i = 0; i < 8; ++i) {
        source_file = file + knight_steps[i][0];
        source_rank = rank + knight_steps[i][1];
        if (in_bounds(source_file, source_rank) &&
            position->board[square_of(source_file, source_rank)] == piece_for_type('N', by_side)) {
            return true;
        }
    }
    for (i = 0; i < 8; ++i) {
        source_file = file + king_steps[i][0];
        source_rank = rank + king_steps[i][1];
        if (in_bounds(source_file, source_rank) &&
            position->board[square_of(source_file, source_rank)] == piece_for_type('K', by_side)) {
            return true;
        }
    }
    for (i = 0; i < 4; ++i) {
        int f = file + rook_steps[i][0];
        int r = rank + rook_steps[i][1];
        while (in_bounds(f, r)) {
            char piece = position->board[square_of(f, r)];
            if (piece != '.') {
                if (piece_color(piece) == by_side && (piece_type(piece) == 'R' || piece_type(piece) == 'Q')) {
                    return true;
                }
                break;
            }
            f += rook_steps[i][0];
            r += rook_steps[i][1];
        }
    }
    for (i = 0; i < 4; ++i) {
        int f = file + bishop_steps[i][0];
        int r = rank + bishop_steps[i][1];
        while (in_bounds(f, r)) {
            char piece = position->board[square_of(f, r)];
            if (piece != '.') {
                if (piece_color(piece) == by_side && (piece_type(piece) == 'B' || piece_type(piece) == 'Q')) {
                    return true;
                }
                break;
            }
            f += bishop_steps[i][0];
            r += bishop_steps[i][1];
        }
    }
    return false;
}

static bool in_check(const Position *position, int side)
{
    int king = find_king(position, side);
    return king >= 0 && square_attacked(position, king, side ^ 1);
}

static void add_move(MoveList *list, int from, int to, char promotion, unsigned flags)
{
    if (list->count >= MAX_MOVES) {
        return;
    }
    list->items[list->count].from = from;
    list->items[list->count].to = to;
    list->items[list->count].promotion = promotion;
    list->items[list->count].flags = flags;
    ++list->count;
}

static void add_pawn_move(MoveList *list, int from, int to, bool promotion, unsigned flags)
{
    static const char promotions[4] = {'q', 'r', 'b', 'n'};
    size_t i;
    if (!promotion) {
        add_move(list, from, to, '\0', flags);
        return;
    }
    for (i = 0U; i < 4U; ++i) {
        add_move(list, from, to, promotions[i], flags);
    }
}

static void apply_move_raw(const Position *position, const Move *move, Position *next)
{
    char moving = position->board[move->from];
    char captured = position->board[move->to];
    int capture_square = move->to;
    int rights = position->castling;
    bool is_capture = captured != '.';
    int side = position->side;

    *next = *position;
    next->board[move->from] = '.';
    if ((move->flags & MOVE_EN_PASSANT) != 0U) {
        capture_square = move->to + (side == WHITE ? -8 : 8);
        captured = next->board[capture_square];
        next->board[capture_square] = '.';
        is_capture = true;
    }
    if (piece_type(moving) == 'K') {
        rights &= side == WHITE ? ~(CASTLE_WK | CASTLE_WQ) : ~(CASTLE_BK | CASTLE_BQ);
    }
    if (piece_type(moving) == 'R') {
        if (move->from == square_of(0, 0)) rights &= ~CASTLE_WQ;
        if (move->from == square_of(7, 0)) rights &= ~CASTLE_WK;
        if (move->from == square_of(0, 7)) rights &= ~CASTLE_BQ;
        if (move->from == square_of(7, 7)) rights &= ~CASTLE_BK;
    }
    if (piece_type(captured) == 'R') {
        if (capture_square == square_of(0, 0)) rights &= ~CASTLE_WQ;
        if (capture_square == square_of(7, 0)) rights &= ~CASTLE_WK;
        if (capture_square == square_of(0, 7)) rights &= ~CASTLE_BQ;
        if (capture_square == square_of(7, 7)) rights &= ~CASTLE_BK;
    }

    next->board[move->to] = moving;
    if (move->promotion != '\0') {
        next->board[move->to] = piece_for_type((char)toupper((unsigned char)move->promotion), side);
    }
    if ((move->flags & MOVE_CASTLE) != 0U) {
        int rook_from = file_of(move->to) == 6 ? square_of(7, side == WHITE ? 0 : 7)
                                               : square_of(0, side == WHITE ? 0 : 7);
        int rook_to = file_of(move->to) == 6 ? square_of(5, side == WHITE ? 0 : 7)
                                             : square_of(3, side == WHITE ? 0 : 7);
        next->board[rook_to] = next->board[rook_from];
        next->board[rook_from] = '.';
    }
    next->castling = rights;
    next->en_passant = -1;
    if (piece_type(moving) == 'P' && abs(rank_of(move->to) - rank_of(move->from)) == 2) {
        next->en_passant = (move->from + move->to) / 2;
    }
    next->halfmove = (piece_type(moving) == 'P' || is_capture) ? 0U : position->halfmove + 1U;
    next->fullmove = position->fullmove + (side == BLACK ? 1U : 0U);
    next->side = side ^ 1;
}

static bool castle_path_available(const Position *position, bool king_side)
{
    int side = position->side;
    int rank = side == WHITE ? 0 : 7;
    int king_from = square_of(4, rank);
    int rook_from = square_of(king_side ? 7 : 0, rank);
    int transit = square_of(king_side ? 5 : 3, rank);
    int destination = square_of(king_side ? 6 : 2, rank);
    int right = side == WHITE ? (king_side ? CASTLE_WK : CASTLE_WQ)
                              : (king_side ? CASTLE_BK : CASTLE_BQ);
    Position test;

    if ((position->castling & right) == 0 ||
        position->board[king_from] != piece_for_type('K', side) ||
        position->board[rook_from] != piece_for_type('R', side)) {
        return false;
    }
    if (position->board[transit] != '.' || position->board[destination] != '.') {
        return false;
    }
    if (!king_side && position->board[square_of(1, rank)] != '.') {
        return false;
    }
    if (square_attacked(position, king_from, side ^ 1)) {
        return false;
    }
    test = *position;
    test.board[king_from] = '.';
    test.board[transit] = piece_for_type('K', side);
    if (square_attacked(&test, transit, side ^ 1)) {
        return false;
    }
    test.board[transit] = '.';
    test.board[destination] = piece_for_type('K', side);
    if (square_attacked(&test, destination, side ^ 1)) {
        return false;
    }
    return true;
}

static bool castle_through_check(const Position *position, bool king_side)
{
    int side = position->side;
    int rank = side == WHITE ? 0 : 7;
    int king_from = square_of(4, rank);
    int rook_from = square_of(king_side ? 7 : 0, rank);
    int transit = square_of(king_side ? 5 : 3, rank);
    int destination = square_of(king_side ? 6 : 2, rank);
    int right = side == WHITE ? (king_side ? CASTLE_WK : CASTLE_WQ)
                              : (king_side ? CASTLE_BK : CASTLE_BQ);
    Position test;

    if ((position->castling & right) == 0 ||
        position->board[king_from] != piece_for_type('K', side) ||
        position->board[rook_from] != piece_for_type('R', side) ||
        position->board[transit] != '.' || position->board[destination] != '.') {
        return false;
    }
    if (!king_side && position->board[square_of(1, rank)] != '.') return false;
    if (square_attacked(position, king_from, side ^ 1)) return true;
    test = *position;
    test.board[king_from] = '.';
    test.board[transit] = piece_for_type('K', side);
    if (square_attacked(&test, transit, side ^ 1)) return true;
    test.board[transit] = '.';
    test.board[destination] = piece_for_type('K', side);
    return square_attacked(&test, destination, side ^ 1);
}

static void generate_pseudo_moves(const Position *position, MoveList *list)
{
    static const int knight_steps[8][2] = {
        {1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}
    };
    static const int king_steps[8][2] = {
        {1, 1}, {1, 0}, {1, -1}, {0, -1}, {-1, -1}, {-1, 0}, {-1, 1}, {0, 1}
    };
    static const int rook_steps[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    static const int bishop_steps[4][2] = {{1, 1}, {1, -1}, {-1, 1}, {-1, -1}};
    int square;

    list->count = 0U;
    for (square = 0; square < BOARD_SIZE; ++square) {
        char piece = position->board[square];
        int side;
        int file;
        int rank;
        if (!is_piece(piece) || (side = piece_color(piece)) != position->side) {
            continue;
        }
        file = file_of(square);
        rank = rank_of(square);
        switch (piece_type(piece)) {
        case 'P': {
            int direction = side == WHITE ? 1 : -1;
            int start_rank = side == WHITE ? 1 : 6;
            int promotion_rank = side == WHITE ? 7 : 0;
            int next_rank = rank + direction;
            if (in_bounds(file, next_rank)) {
                int destination = square_of(file, next_rank);
                if (position->board[destination] == '.') {
                    add_pawn_move(list, square, destination, next_rank == promotion_rank, 0U);
                    if (rank == start_rank) {
                        int double_rank = rank + 2 * direction;
                        int double_destination = square_of(file, double_rank);
                        if (position->board[double_destination] == '.') {
                            add_move(list, square, double_destination, '\0', 0U);
                        }
                    }
                }
                {
                    int delta;
                    for (delta = -1; delta <= 1; delta += 2) {
                        int capture_file = file + delta;
                        if (in_bounds(capture_file, next_rank)) {
                            int capture = square_of(capture_file, next_rank);
                            char target = position->board[capture];
                            if (target != '.' && piece_color(target) != side && piece_type(target) != 'K') {
                                add_pawn_move(list, square, capture, next_rank == promotion_rank, 0U);
                            } else if (capture == position->en_passant && target == '.') {
                                int captured_square = capture + (side == WHITE ? -8 : 8);
                                if (position->board[captured_square] == piece_for_type('P', side ^ 1)) {
                                    add_move(list, square, capture, '\0', MOVE_EN_PASSANT);
                                }
                            }
                        }
                    }
                }
            }
            break;
        }
        case 'N': {
            int i;
            for (i = 0; i < 8; ++i) {
                int f = file + knight_steps[i][0];
                int r = rank + knight_steps[i][1];
                if (in_bounds(f, r)) {
                    char target = position->board[square_of(f, r)];
                    if (target == '.' || (piece_color(target) != side && piece_type(target) != 'K')) {
                        add_move(list, square, square_of(f, r), '\0', 0U);
                    }
                }
            }
            break;
        }
        case 'B':
        case 'R':
        case 'Q': {
            int first = piece_type(piece) == 'B' ? 0 : piece_type(piece) == 'R' ? 4 : 0;
            int last = piece_type(piece) == 'B' ? 4 : piece_type(piece) == 'R' ? 8 : 8;
            int i;
            for (i = first; i < last; ++i) {
                const int (*steps)[2] = i < 4 ? bishop_steps : rook_steps;
                int step = i < 4 ? i : i - 4;
                int f = file + steps[step][0];
                int r = rank + steps[step][1];
                while (in_bounds(f, r)) {
                    int destination = square_of(f, r);
                    char target = position->board[destination];
                    if (target == '.') {
                        add_move(list, square, destination, '\0', 0U);
                    } else {
                        if (piece_color(target) != side && piece_type(target) != 'K') {
                            add_move(list, square, destination, '\0', 0U);
                        }
                        break;
                    }
                    f += steps[step][0];
                    r += steps[step][1];
                }
            }
            break;
        }
        case 'K': {
            int i;
            for (i = 0; i < 8; ++i) {
                int f = file + king_steps[i][0];
                int r = rank + king_steps[i][1];
                if (in_bounds(f, r)) {
                    char target = position->board[square_of(f, r)];
                    if (target == '.' || (piece_color(target) != side && piece_type(target) != 'K')) {
                        add_move(list, square, square_of(f, r), '\0', 0U);
                    }
                }
            }
            if (castle_path_available(position, true)) {
                add_move(list, square, square_of(6, side == WHITE ? 0 : 7), '\0', MOVE_CASTLE);
            }
            if (castle_path_available(position, false)) {
                add_move(list, square, square_of(2, side == WHITE ? 0 : 7), '\0', MOVE_CASTLE);
            }
            break;
        }
        default:
            break;
        }
    }
}

static int move_compare(const void *left_pointer, const void *right_pointer)
{
    const Move *left = (const Move *)left_pointer;
    const Move *right = (const Move *)right_pointer;
    static const char order[] = "qrbn";
    int left_promotion = left->promotion == '\0' ? 4 : (int)(strchr(order, left->promotion) - order);
    int right_promotion = right->promotion == '\0' ? 4 : (int)(strchr(order, right->promotion) - order);
    if (left->from != right->from) return left->from - right->from;
    if (left->to != right->to) return left->to - right->to;
    return left_promotion - right_promotion;
}

static size_t generate_legal_moves(const Position *position, MoveList *legal)
{
    MoveList pseudo;
    size_t i;
    legal->count = 0U;
    generate_pseudo_moves(position, &pseudo);
    for (i = 0U; i < pseudo.count; ++i) {
        Position next;
        apply_move_raw(position, &pseudo.items[i], &next);
        if (!in_check(&next, position->side)) {
            legal->items[legal->count++] = pseudo.items[i];
        }
    }
    qsort(legal->items, legal->count, sizeof(legal->items[0]), move_compare);
    return legal->count;
}

static bool has_legal_en_passant(const Position *position)
{
    int file;
    int rank;
    int source_rank;
    int delta;
    if (position->en_passant < 0) {
        return false;
    }
    file = file_of(position->en_passant);
    rank = rank_of(position->en_passant);
    source_rank = rank + (position->side == WHITE ? -1 : 1);
    if (!in_bounds(file, source_rank)) {
        return false;
    }
    for (delta = -1; delta <= 1; delta += 2) {
        int source_file = file + delta;
        Move move;
        Position next;
        if (!in_bounds(source_file, source_rank)) {
            continue;
        }
        move.from = square_of(source_file, source_rank);
        move.to = position->en_passant;
        move.promotion = '\0';
        move.flags = MOVE_EN_PASSANT;
        if (position->board[move.from] == piece_for_type('P', position->side) &&
            position->board[move.to] == '.' &&
            position->board[move.to + (position->side == WHITE ? -8 : 8)] == piece_for_type('P', position->side ^ 1)) {
            apply_move_raw(position, &move, &next);
            if (!in_check(&next, position->side)) {
                return true;
            }
        }
    }
    return false;
}

static void append_text(char *output, size_t *length, const char *value)
{
    size_t value_length = strlen(value);
    if (*length + value_length + 1U < KEY_SIZE) {
        memcpy(output + *length, value, value_length);
        *length += value_length;
        output[*length] = '\0';
    }
}

static void position_key(const Position *position, char output[KEY_SIZE])
{
    size_t length = 0U;
    int rank;
    int file;
    char square[3];
    char rights[5];
    size_t rights_length = 0U;
    output[0] = '\0';
    for (rank = 7; rank >= 0; --rank) {
        int empty = 0;
        for (file = 0; file < 8; ++file) {
            char piece = position->board[square_of(file, rank)];
            if (piece == '.') {
                ++empty;
            } else {
                if (empty > 0) {
                    output[length++] = (char)('0' + empty);
                    empty = 0;
                }
                output[length++] = piece;
            }
        }
        if (empty > 0) output[length++] = (char)('0' + empty);
        if (rank > 0) output[length++] = '/';
    }
    output[length] = '\0';
    append_text(output, &length, position->side == WHITE ? " w " : " b ");
    if ((position->castling & CASTLE_WK) != 0) rights[rights_length++] = 'K';
    if ((position->castling & CASTLE_WQ) != 0) rights[rights_length++] = 'Q';
    if ((position->castling & CASTLE_BK) != 0) rights[rights_length++] = 'k';
    if ((position->castling & CASTLE_BQ) != 0) rights[rights_length++] = 'q';
    rights[rights_length] = '\0';
    append_text(output, &length, rights_length == 0U ? "- " : rights);
    if (rights_length > 0U) append_text(output, &length, " ");
    if (position->en_passant >= 0 && has_legal_en_passant(position)) {
        square_name(position->en_passant, square);
        append_text(output, &length, square);
    } else {
        append_text(output, &length, "-");
    }
}

static bool validate_position(const Position *position)
{
    int white_king = 0;
    int black_king = 0;
    int square;
    int white_square;
    int black_square;
    for (square = 0; square < BOARD_SIZE; ++square) {
        char piece = position->board[square];
        if (piece == 'K') ++white_king;
        if (piece == 'k') ++black_king;
        if (piece_type(piece) == 'P' && (rank_of(square) == 0 || rank_of(square) == 7)) {
            return false;
        }
    }
    if (white_king != 1 || black_king != 1) {
        return false;
    }
    white_square = find_king(position, WHITE);
    black_square = find_king(position, BLACK);
    if (abs(file_of(white_square) - file_of(black_square)) <= 1 &&
        abs(rank_of(white_square) - rank_of(black_square)) <= 1) {
        return false;
    }
    if (in_check(position, WHITE) && in_check(position, BLACK)) {
        return false;
    }
    if (in_check(position, position->side ^ 1)) {
        return false;
    }
    return true;
}

static bool parse_decimal_u64(const char *text, uint64_t *value, bool require_nonzero)
{
    const char *p = text;
    char *end;
    unsigned long long parsed;
    if (text == NULL || *text == '\0') return false;
    while (*p != '\0') {
        if (*p < '0' || *p > '9') return false;
        ++p;
    }
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno == ERANGE || *end != '\0' || (require_nonzero && parsed == 0U)) return false;
    *value = (uint64_t)parsed;
    return true;
}

static bool parse_fen(const char *fen, Position *position)
{
    char *copy;
    char *fields[7] = {NULL, NULL, NULL, NULL, NULL, NULL, NULL};
    char *token;
    int field_count = 0;
    int rank = 7;
    int file = 0;
    size_t i;

    if (fen == NULL) {
        fen = INITIAL_FEN;
    }
    copy = duplicate_string(fen);
    if (copy == NULL) {
        return false;
    }
    token = strtok(copy, " \t\r\n");
    while (token != NULL && field_count < 7) {
        fields[field_count++] = token;
        token = strtok(NULL, " \t\r\n");
    }
    if (token != NULL || field_count != 6) {
        free(copy);
        return false;
    }
    position_empty(position);
    for (i = 0U; fields[0][i] != '\0'; ++i) {
        char value = fields[0][i];
        if (value == '/') {
            if (file != 8 || rank == 0) {
                free(copy);
                return false;
            }
            --rank;
            file = 0;
        } else if (value >= '1' && value <= '8') {
            file += value - '0';
            if (file > 8) {
                free(copy);
                return false;
            }
        } else if (strchr("PNBRQKpnbrqk", value) != NULL && file < 8 && rank >= 0) {
            position->board[square_of(file, rank)] = value;
            ++file;
        } else {
            free(copy);
            return false;
        }
    }
    if (rank != 0 || file != 8) {
        free(copy);
        return false;
    }
    if (strcmp(fields[1], "w") == 0) {
        position->side = WHITE;
    } else if (strcmp(fields[1], "b") == 0) {
        position->side = BLACK;
    } else {
        free(copy);
        return false;
    }
    if (strcmp(fields[2], "-") != 0) {
        for (i = 0U; fields[2][i] != '\0'; ++i) {
            int bit = fields[2][i] == 'K' ? CASTLE_WK : fields[2][i] == 'Q' ? CASTLE_WQ
                     : fields[2][i] == 'k' ? CASTLE_BK : fields[2][i] == 'q' ? CASTLE_BQ : 0;
            if (bit == 0 || (position->castling & bit) != 0) {
                free(copy);
                return false;
            }
            position->castling |= bit;
        }
    }
    if (strcmp(fields[3], "-") != 0) {
        if (strlen(fields[3]) != 2U || !parse_coordinate(fields[3], &position->en_passant)) {
            free(copy);
            return false;
        }
        if (rank_of(position->en_passant) != (position->side == WHITE ? 5 : 2) ||
            position->board[position->en_passant] != '.') {
            free(copy);
            return false;
        }
        {
            int captured = position->en_passant + (position->side == WHITE ? -8 : 8);
            if (captured < 0 || captured >= BOARD_SIZE ||
                position->board[captured] != piece_for_type('P', position->side ^ 1)) {
                free(copy);
                return false;
            }
            {
                int origin = position->en_passant + (position->side == WHITE ? 8 : -8);
                if (origin < 0 || origin >= BOARD_SIZE || position->board[origin] != '.') {
                    free(copy);
                    return false;
                }
            }
        }
    }
    if (!parse_decimal_u64(fields[4], &position->halfmove, false) ||
        !parse_decimal_u64(fields[5], &position->fullmove, true)) {
        free(copy);
        return false;
    }
    free(copy);
    return validate_position(position);
}

static bool history_push(History *history, const char *key)
{
    if (history->count == history->capacity) {
        size_t next_capacity = history->capacity == 0U ? 64U : history->capacity * 2U;
        char (*next)[KEY_SIZE] = (char (*)[KEY_SIZE])realloc(history->keys, next_capacity * sizeof(*next));
        if (next == NULL) {
            return false;
        }
        history->keys = next;
        history->capacity = next_capacity;
    }
    strncpy(history->keys[history->count], key, KEY_SIZE - 1U);
    history->keys[history->count][KEY_SIZE - 1U] = '\0';
    ++history->count;
    return true;
}

static uint64_t history_occurrences(const History *history, const char *key)
{
    uint64_t count = 0U;
    size_t i;
    for (i = 0U; i < history->count; ++i) {
        if (strcmp(history->keys[i], key) == 0) {
            ++count;
        }
    }
    return count;
}

static bool ledger_push(MoveLedger *ledger, const Move *move)
{
    char name[7];
    char *copy;
    if (ledger->count == ledger->capacity) {
        size_t next_capacity = ledger->capacity == 0U ? 64U : ledger->capacity * 2U;
        char **next = (char **)realloc(ledger->items, next_capacity * sizeof(*next));
        if (next == NULL) {
            return false;
        }
        ledger->items = next;
        ledger->capacity = next_capacity;
    }
    move_name(move, name);
    copy = duplicate_string(name);
    if (copy == NULL) {
        return false;
    }
    ledger->items[ledger->count++] = copy;
    return true;
}

static void history_free(History *history)
{
    free(history->keys);
    memset(history, 0, sizeof(*history));
}

static void ledger_free(MoveLedger *ledger)
{
    size_t i;
    for (i = 0U; i < ledger->count; ++i) {
        free(ledger->items[i]);
    }
    free(ledger->items);
    memset(ledger, 0, sizeof(*ledger));
}

static void session_free(Session *session)
{
    history_free(&session->history);
    ledger_free(&session->ledger);
    memset(session, 0, sizeof(*session));
}

static bool session_init(Session *session, int mode, const char *fen, uint64_t seed)
{
    char key[KEY_SIZE];
    memset(session, 0, sizeof(*session));
    if (!parse_fen(fen, &session->position)) {
        return false;
    }
    session->mode = mode;
    session->seed = seed;
    session->initialized = true;
    position_key(&session->position, key);
    if (!history_push(&session->history, key)) {
        session_free(session);
        return false;
    }
    return true;
}

static bool dead_position(const Position *position)
{
    int non_king = 0;
    char only_minor = '\0';
    int square;
    for (square = 0; square < BOARD_SIZE; ++square) {
        char piece = position->board[square];
        char type = piece_type(position->board[square]);
        if (!is_piece(piece) || type == 'K') continue;
        ++non_king;
        only_minor = type;
        if (type != 'B' && type != 'N') return false;
    }
    return non_king == 0 || (non_king == 1 && (only_minor == 'B' || only_minor == 'N'));
}

static Evaluation evaluate_position(const Session *session)
{
    Evaluation evaluation;
    MoveList legal;
    char key[KEY_SIZE];
    uint64_t repetition = 0U;
    bool checked = in_check(&session->position, session->position.side);
    evaluation.terminal = false;
    evaluation.status = "active";
    evaluation.reason = NULL;
    evaluation.result = NULL;
    evaluation.winner = -1;
    evaluation.checked_color = checked ? session->position.side : -1;
    generate_legal_moves(&session->position, &legal);
    if (legal.count == 0U) {
        evaluation.terminal = true;
        if (checked) {
            evaluation.status = "terminal";
            evaluation.reason = "checkmate";
            evaluation.winner = session->position.side ^ 1;
            evaluation.result = evaluation.winner == WHITE ? "1-0" : "0-1";
        } else {
            evaluation.status = "terminal";
            evaluation.reason = "stalemate";
            evaluation.result = "1/2-1/2";
        }
        return evaluation;
    }
    if (dead_position(&session->position)) {
        evaluation.terminal = true;
        evaluation.status = "terminal";
        evaluation.reason = "dead_position";
        evaluation.result = "1/2-1/2";
        return evaluation;
    }
    if (session->mode == MODE_ALL) {
        position_key(&session->position, key);
        repetition = history_occurrences(&session->history, key);
        if (repetition >= 5U) {
            evaluation.terminal = true;
            evaluation.status = "terminal";
            evaluation.reason = "fivefold_repetition";
            evaluation.result = "1/2-1/2";
            return evaluation;
        }
        if (session->position.halfmove >= 150U) {
            evaluation.terminal = true;
            evaluation.status = "terminal";
            evaluation.reason = "seventy_five_move";
            evaluation.result = "1/2-1/2";
            return evaluation;
        }
    }
    return evaluation;
}

static void claimable_draws(const Session *session, bool *threefold, bool *fifty)
{
    char key[KEY_SIZE];
    Evaluation evaluation;
    MoveList legal;
    size_t i;
    *threefold = false;
    *fifty = false;
    if (session->mode != MODE_ALL) {
        return;
    }
    evaluation = evaluate_position(session);
    if (evaluation.terminal) {
        return;
    }
    position_key(&session->position, key);
    *threefold = history_occurrences(&session->history, key) >= 3U;
    *fifty = session->position.halfmove >= 100U;
    if (*threefold && *fifty) return;

    generate_legal_moves(&session->position, &legal);
    for (i = 0U; i < legal.count && (!*threefold || !*fifty); ++i) {
        Position candidate;
        apply_move_raw(&session->position, &legal.items[i], &candidate);
        if (!*threefold) {
            position_key(&candidate, key);
            *threefold = history_occurrences(&session->history, key) + 1U >= 3U;
        }
        if (!*fifty) {
            *fifty = candidate.halfmove >= 100U;
        }
    }
}

static bool parse_seed_text(const char *text, uint64_t *seed)
{
    const char *p = text;
    char *end;
    unsigned long long value;
    if (text == NULL || *text == '\0') {
        return false;
    }
    while (*p != '\0') {
        if (*p < '0' || *p > '9') return false;
        ++p;
    }
    errno = 0;
    value = strtoull(text, &end, 10);
    if (errno == ERANGE || *end != '\0') {
        return false;
    }
    *seed = (uint64_t)value;
    return true;
}

static bool parse_mode_text(const char *text, int *mode)
{
    if (text == NULL || strcmp(text, "all-rules-enabled") == 0) {
        *mode = MODE_ALL;
        return true;
    }
    if (strcmp(text, "basic") == 0) {
        *mode = MODE_BASIC;
        return true;
    }
    return false;
}

static bool same_move_identity(const Move *left, const Move *right)
{
    return left->from == right->from && left->to == right->to && left->promotion == right->promotion;
}

static bool pseudo_contains(const Position *position, const Move *requested)
{
    MoveList pseudo;
    size_t i;
    generate_pseudo_moves(position, &pseudo);
    for (i = 0U; i < pseudo.count; ++i) {
        if (same_move_identity(&pseudo.items[i], requested)) return true;
    }
    return false;
}

static bool aligned_for_slider(int from, int to, int *file_step, int *rank_step)
{
    int df = file_of(to) - file_of(from);
    int dr = rank_of(to) - rank_of(from);
    if (df == 0 && dr != 0) {
        *file_step = 0;
        *rank_step = dr > 0 ? 1 : -1;
        return true;
    }
    if (dr == 0 && df != 0) {
        *file_step = df > 0 ? 1 : -1;
        *rank_step = 0;
        return true;
    }
    if (abs(df) == abs(dr) && df != 0) {
        *file_step = df > 0 ? 1 : -1;
        *rank_step = dr > 0 ? 1 : -1;
        return true;
    }
    return false;
}

static const char *classify_move_error(const Position *position, const Move *requested)
{
    char piece = position->board[requested->from];
    char target = position->board[requested->to];
    int fstep;
    int rstep;
    if (piece == '.') return "E_EMPTY_SOURCE";
    if (piece_color(piece) != position->side) return "E_WRONG_TURN";
    if (target != '.' && piece_color(target) == position->side) return "E_OWN_PIECE_ON_DESTINATION";
    if (piece_type(piece) == 'P' && (rank_of(requested->to) == 0 || rank_of(requested->to) == 7) &&
        requested->promotion == '\0') {
        return "E_INVALID_PROMOTION";
    }
    if (piece_type(piece) == 'K' && requested->from == square_of(4, position->side == WHITE ? 0 : 7) &&
        (requested->to == square_of(6, position->side == WHITE ? 0 : 7) ||
         requested->to == square_of(2, position->side == WHITE ? 0 : 7))) {
        return (requested->to == square_of(6, position->side == WHITE ? 0 : 7) &&
                castle_through_check(position, true)) ||
                       (requested->to == square_of(2, position->side == WHITE ? 0 : 7) &&
                        castle_through_check(position, false))
                   ? "E_CASTLE_THROUGH_CHECK" : "E_CASTLE_UNAVAILABLE";
    }
    if (piece_type(piece) == 'P' && requested->to == position->en_passant && target == '.') {
        if (pseudo_contains(position, requested)) return "E_SELF_CHECK";
        return "E_EN_PASSANT_UNAVAILABLE";
    }
    if (pseudo_contains(position, requested)) {
        return "E_SELF_CHECK";
    }
    if (piece_type(piece) == 'B' || piece_type(piece) == 'R' || piece_type(piece) == 'Q') {
        if (aligned_for_slider(requested->from, requested->to, &fstep, &rstep)) {
            int file = file_of(requested->from) + fstep;
            int rank = rank_of(requested->from) + rstep;
            while (file != file_of(requested->to) || rank != rank_of(requested->to)) {
                if (position->board[square_of(file, rank)] != '.') return "E_PATH_BLOCKED";
                file += fstep;
                rank += rstep;
            }
        }
    }
    return "E_ILLEGAL_GEOMETRY";
}

static const char *play_move(Session *session, const char *text)
{
    Move requested;
    MoveList legal;
    Move selected;
    Position next;
    char key[KEY_SIZE];
    size_t i;
    if (!parse_move_name(text, &requested)) {
        return "E_INVALID_MOVE_SYNTAX";
    }
    generate_legal_moves(&session->position, &legal);
    for (i = 0U; i < legal.count; ++i) {
        if (same_move_identity(&legal.items[i], &requested)) {
            selected = legal.items[i];
            apply_move_raw(&session->position, &selected, &next);
            position_key(&next, key);
            if (!history_push(&session->history, key) || !ledger_push(&session->ledger, &selected)) {
                return "E_INTERNAL";
            }
            session->position = next;
            return NULL;
        }
    }
    return classify_move_error(&session->position, &requested);
}

static uint64_t splitmix64_next(uint64_t *state)
{
    uint64_t value;
    *state += UINT64_C(0x9E3779B97F4A7C15);
    value = *state;
    value = (value ^ (value >> 30)) * UINT64_C(0xBF58476D1CE4E5B9);
    value = (value ^ (value >> 27)) * UINT64_C(0x94D049BB133111EB);
    return value ^ (value >> 31);
}

static const char *piece_type_name(char piece)
{
    switch (piece_type(piece)) {
    case 'K': return "king";
    case 'Q': return "queen";
    case 'R': return "rook";
    case 'B': return "bishop";
    case 'N': return "knight";
    default: return "pawn";
    }
}

static void write_move_array(const MoveList *moves)
{
    size_t i;
    putchar('[');
    for (i = 0U; i < moves->count; ++i) {
        char name[7];
        if (i > 0U) putchar(',');
        move_name(&moves->items[i], name);
        json_string(name);
    }
    putchar(']');
}

static void write_outcome(const Evaluation *evaluation)
{
    if (!evaluation->terminal) {
        fputs("null", stdout);
        return;
    }
    fputs("{\"reason\":", stdout);
    json_string(evaluation->reason);
    fputs(",\"result\":", stdout);
    json_string(evaluation->result);
    if (evaluation->winner >= 0) {
        fputs(",\"winner\":", stdout);
        json_string(side_name(evaluation->winner));
    }
    putchar('}');
}

static void write_repetition_counts(const Session *session)
{
    size_t i;
    bool first = true;
    putchar('{');
    if (session->mode == MODE_ALL) {
        for (i = 0U; i < session->history.count; ++i) {
            size_t prior;
            bool seen = false;
            for (prior = 0U; prior < i; ++prior) {
                if (strcmp(session->history.keys[prior], session->history.keys[i]) == 0) {
                    seen = true;
                    break;
                }
            }
            if (!seen) {
                if (!first) putchar(',');
                first = false;
                json_string(session->history.keys[i]);
                putchar(':');
                printf("%" PRIu64, history_occurrences(&session->history, session->history.keys[i]));
            }
        }
    }
    putchar('}');
}

static void write_state_object(const Session *session)
{
    Evaluation evaluation = evaluate_position(session);
    bool threefold;
    bool fifty;
    int square;
    char rights[5];
    size_t rights_length = 0U;
    claimable_draws(session, &threefold, &fifty);

    fputs("{\"mode\":", stdout);
    json_string(session->mode == MODE_ALL ? "all-rules-enabled" : "basic");
    fputs(",\"board\":[", stdout);
    for (square = 0; square < BOARD_SIZE; ++square) {
        char piece = session->position.board[square];
        if (square > 0) putchar(',');
        if (piece == '.') {
            fputs("null", stdout);
        } else {
            fputs("{\"color\":", stdout);
            json_string(piece_color(piece) == WHITE ? "white" : "black");
            fputs(",\"type\":", stdout);
            json_string(piece_type_name(piece));
            putchar('}');
        }
    }
    fputs("],\"side_to_move\":", stdout);
    json_string(side_name(session->position.side));
    fputs(",\"castling_rights\":", stdout);
    if ((session->position.castling & CASTLE_WK) != 0) rights[rights_length++] = 'K';
    if ((session->position.castling & CASTLE_WQ) != 0) rights[rights_length++] = 'Q';
    if ((session->position.castling & CASTLE_BK) != 0) rights[rights_length++] = 'k';
    if ((session->position.castling & CASTLE_BQ) != 0) rights[rights_length++] = 'q';
    rights[rights_length] = '\0';
    json_string(rights_length == 0U ? "-" : rights);
    fputs(",\"en_passant_target\":", stdout);
    if (session->position.en_passant < 0) {
        fputs("null", stdout);
    } else {
        char target[3];
        square_name(session->position.en_passant, target);
        json_string(target);
    }
    fputs(",\"halfmove_clock\":", stdout);
    printf("%" PRIu64, session->position.halfmove);
    fputs(",\"fullmove_number\":", stdout);
    printf("%" PRIu64, session->position.fullmove);
    fputs(",\"status\":", stdout);
    json_string(evaluation.status);
    fputs(",\"check\":", stdout);
    if (evaluation.checked_color < 0) fputs("null", stdout);
    else json_string(side_name(evaluation.checked_color));
    fputs(",\"outcome\":", stdout);
    write_outcome(&evaluation);
    fputs(",\"claimable_draws\":[", stdout);
    if (threefold) json_string("threefold_repetition");
    if (threefold && fifty) putchar(',');
    if (fifty) json_string("fifty_move");
    fputs("],\"repetition_counts\":", stdout);
    write_repetition_counts(session);
    fputs(",\"moves\":[", stdout);
    for (square = 0; (size_t)square < session->ledger.count; ++square) {
        if (square > 0) putchar(',');
        json_string(session->ledger.items[square]);
    }
    putchar(']');
    putchar('}');
}

static void print_success_prefix(const char *op)
{
    fputs("{\"ok\":true,\"op\":", stdout);
    json_string(op);
}

static void print_error(const char *op, const char *code, const Session *session)
{
    fputs("{\"ok\":false,\"op\":", stdout);
    json_string(op == NULL ? "invalid" : op);
    fputs(",\"error\":{\"code\":", stdout);
    json_string(code);
    putchar('}');
    if (session != NULL && session->initialized) {
        fputs(",\"state\":", stdout);
        write_state_object(session);
    }
    putchar('}');
    putchar('\n');
}

static uint64_t perft_nodes(const Position *position, uint64_t depth)
{
    MoveList legal;
    uint64_t total = 0U;
    size_t i;
    if (depth == 0U) {
        return 1U;
    }
    generate_legal_moves(position, &legal);
    for (i = 0U; i < legal.count; ++i) {
        Position next;
        apply_move_raw(position, &legal.items[i], &next);
        total += perft_nodes(&next, depth - 1U);
    }
    return total;
}

static void write_decimal_seed(uint64_t seed)
{
    char buffer[32];
    snprintf(buffer, sizeof(buffer), "%" PRIu64, seed);
    json_string(buffer);
}

static bool resolve_mode_and_seed(const Request *request, int default_mode, uint64_t default_seed,
                                  int *mode, uint64_t *seed)
{
    if (request->mode != NULL && !parse_mode_text(request->mode, mode)) {
        return false;
    }
    if (request->mode == NULL) {
        *mode = default_mode;
    }
    if (request->seed != NULL && !parse_seed_text(request->seed, seed)) {
        return false;
    }
    if (request->seed == NULL) {
        *seed = default_seed;
    }
    return true;
}

static bool position_for_request(const Request *request, const Session *session, Position *position)
{
    if (request->fen != NULL) {
        return parse_fen(request->fen, position);
    }
    if (session == NULL || !session->initialized) {
        return parse_fen(NULL, position);
    }
    *position = session->position;
    return true;
}

static void handle_new(const Request *request, Session *session)
{
    int mode;
    uint64_t seed;
    Session replacement;
    if (!resolve_mode_and_seed(request, MODE_ALL, 1U, &mode, &seed)) {
        print_error("new", "E_INVALID_REQUEST", session);
        return;
    }
    if (!session_init(&replacement, mode, request->fen, seed)) {
        print_error("new", "E_INVALID_FEN", session);
        return;
    }
    session_free(session);
    *session = replacement;
    print_success_prefix("new");
    fputs(",\"state\":", stdout);
    write_state_object(session);
    fputs("}\n", stdout);
}

static void handle_state(const Session *session)
{
    if (!session->initialized) {
        print_error("state", "E_NO_SESSION", session);
        return;
    }
    print_success_prefix("state");
    fputs(",\"state\":", stdout);
    write_state_object(session);
    fputs("}\n", stdout);
}

static void handle_legal_moves(const Session *session)
{
    MoveList legal;
    if (!session->initialized) {
        print_error("legal_moves", "E_NO_SESSION", session);
        return;
    }
    generate_legal_moves(&session->position, &legal);
    print_success_prefix("legal_moves");
    fputs(",\"moves\":", stdout);
    write_move_array(&legal);
    fputs(",\"state\":", stdout);
    write_state_object(session);
    fputs("}\n", stdout);
}

static void handle_play(const Request *request, Session *session)
{
    const char *error;
    Evaluation evaluation;
    if (!session->initialized) {
        print_error("play", "E_NO_SESSION", session);
        return;
    }
    evaluation = evaluate_position(session);
    if (evaluation.terminal) {
        print_error("play", "E_GAME_OVER", session);
        return;
    }
    if (request->move == NULL) {
        print_error("play", "E_INVALID_REQUEST", session);
        return;
    }
    error = play_move(session, request->move);
    if (error != NULL) {
        print_error("play", error, session);
        return;
    }
    print_success_prefix("play");
    fputs(",\"move\":", stdout);
    json_string(request->move);
    fputs(",\"state\":", stdout);
    write_state_object(session);
    fputs("}\n", stdout);
}

static void handle_perft(const Request *request, const Session *session)
{
    Position position;
    uint64_t nodes;
    if (!request->has_depth) {
        print_error("perft", "E_INVALID_REQUEST", session);
        return;
    }
    if (!position_for_request(request, session, &position)) {
        print_error("perft", "E_INVALID_FEN", session);
        return;
    }
    nodes = perft_nodes(&position, request->depth);
    print_success_prefix("perft");
    fputs(",\"depth\":", stdout);
    printf("%" PRIu64, request->depth);
    fputs(",\"nodes\":", stdout);
    printf("%" PRIu64, nodes);
    fputs("}\n", stdout);
}

static void handle_sample(const Request *request, const Session *session)
{
    Position position;
    MoveList legal;
    uint64_t seed;
    uint64_t initial_seed;
    uint64_t counts[MAX_MOVES];
    uint64_t i;
    size_t j;
    if (!request->has_samples) {
        print_error("sample", "E_INVALID_REQUEST", session);
        return;
    }
    if (!position_for_request(request, session, &position)) {
        print_error("sample", "E_INVALID_FEN", session);
        return;
    }
    if (request->seed != NULL && !parse_seed_text(request->seed, &seed)) {
        print_error("sample", "E_INVALID_REQUEST", session);
        return;
    }
    if (request->seed == NULL) seed = 1U;
    initial_seed = seed;
    generate_legal_moves(&position, &legal);
    memset(counts, 0, sizeof(counts));
    for (i = 0U; i < request->samples; ++i) {
        if (legal.count > 0U) {
            uint64_t selected = splitmix64_next(&seed) % (uint64_t)legal.count;
            ++counts[selected];
        }
    }
    print_success_prefix("sample");
    fputs(",\"moves\":", stdout);
    write_move_array(&legal);
    fputs(",\"counts\":{", stdout);
    for (j = 0U; j < legal.count; ++j) {
        char name[7];
        if (j > 0U) putchar(',');
        move_name(&legal.items[j], name);
        json_string(name);
        putchar(':');
        printf("%" PRIu64, counts[j]);
    }
    fputs("},\"sequence\":[", stdout);
    seed = initial_seed;
    for (i = 0U; i < request->samples && legal.count > 0U; ++i) {
        uint64_t selected = splitmix64_next(&seed) % (uint64_t)legal.count;
        char name[7];
        if (i > 0U) putchar(',');
        move_name(&legal.items[selected], name);
        json_string(name);
    }
    fputs("],\"samples\":", stdout);
    printf("%" PRIu64, request->samples);
    fputs(",\"seed\":", stdout);
    write_decimal_seed(initial_seed);
    fputs("}\n", stdout);
}

static void handle_run(const Request *request, Session *session)
{
    Session game;
    int mode;
    uint64_t seed;
    uint64_t max_plies;
    uint64_t rng;
    uint64_t plies = 0U;
    const char *termination = NULL;
    const char *result = "*";
    bool trace = true;

    if (!resolve_mode_and_seed(request, MODE_ALL, 1U, &mode, &seed)) {
        print_error("run", "E_INVALID_REQUEST", session);
        return;
    }
    max_plies = request->has_max_plies ? request->max_plies : 600U;
    if (request->has_trace) trace = request->trace;
    if (!session_init(&game, mode, request->fen, seed)) {
        print_error("run", "E_INVALID_FEN", session);
        return;
    }
    rng = seed;
    for (;;) {
        Evaluation evaluation = evaluate_position(&game);
        MoveList legal;
        if (evaluation.terminal) {
            termination = evaluation.reason;
            result = evaluation.result;
            break;
        }
        if (plies >= max_plies) {
            termination = "max_plies";
            result = "*";
            break;
        }
        generate_legal_moves(&game.position, &legal);
        if (legal.count == 0U) {
            termination = "stalemate";
            result = "1/2-1/2";
            break;
        }
        {
            uint64_t selected = splitmix64_next(&rng) % (uint64_t)legal.count;
            Position next;
            char key[KEY_SIZE];
            apply_move_raw(&game.position, &legal.items[selected], &next);
            position_key(&next, key);
            if (!history_push(&game.history, key) || !ledger_push(&game.ledger, &legal.items[selected])) {
                session_free(&game);
                print_error("run", "E_INTERNAL", session);
                return;
            }
            game.position = next;
            ++plies;
        }
    }
    print_success_prefix("run");
    fputs(",\"seed\":", stdout);
    write_decimal_seed(seed);
    fputs(",\"moves\":[", stdout);
    if (trace) {
        size_t i;
        for (i = 0U; i < game.ledger.count; ++i) {
            if (i > 0U) putchar(',');
            json_string(game.ledger.items[i]);
        }
    }
    fputs("],\"plies\":", stdout);
    printf("%" PRIu64, plies);
    fputs(",\"termination\":", stdout);
    json_string(termination);
    fputs(",\"result\":", stdout);
    json_string(result);
    fputs(",\"final\":", stdout);
    write_state_object(&game);
    fputs("}\n", stdout);
    session_free(&game);
}

static void handle_request(const Request *request, Session *session)
{
    if (strcmp(request->op, "new") == 0) {
        handle_new(request, session);
    } else if (strcmp(request->op, "state") == 0) {
        handle_state(session);
    } else if (strcmp(request->op, "legal_moves") == 0) {
        handle_legal_moves(session);
    } else if (strcmp(request->op, "play") == 0) {
        handle_play(request, session);
    } else if (strcmp(request->op, "perft") == 0) {
        handle_perft(request, session);
    } else if (strcmp(request->op, "run") == 0) {
        handle_run(request, session);
    } else if (strcmp(request->op, "sample") == 0) {
        handle_sample(request, session);
    } else {
        print_error(request->op, "E_UNKNOWN_OPERATION", session);
    }
}

static char *read_input_line(void)
{
    char *line = NULL;
    size_t length = 0U;
    size_t capacity = 0U;
    int value;
    for (;;) {
        value = fgetc(stdin);
        if (value == EOF) {
            if (length == 0U) {
                free(line);
                return NULL;
            }
            break;
        }
        if (value == '\n') {
            break;
        }
        if (length + 1U >= capacity) {
            size_t next_capacity = capacity == 0U ? 256U : capacity * 2U;
            char *next = (char *)realloc(line, next_capacity);
            if (next == NULL) {
                free(line);
                return NULL;
            }
            line = next;
            capacity = next_capacity;
        }
        line[length++] = (char)value;
    }
    if (length > 0U && line[length - 1U] == '\r') {
        --length;
    }
    if (line == NULL) {
        line = duplicate_string("");
        if (line == NULL) return NULL;
    } else {
        line[length] = '\0';
    }
    return line;
}

int main(void)
{
    Session session;
    char *line;
    memset(&session, 0, sizeof(session));
    while ((line = read_input_line()) != NULL) {
        Request request;
        if (!parse_request_line(line, &request)) {
            print_error("invalid", "E_INVALID_REQUEST", &session);
        } else {
            handle_request(&request, &session);
            request_free(&request);
        }
        free(line);
        fflush(stdout);
    }
    session_free(&session);
    return 0;
}
