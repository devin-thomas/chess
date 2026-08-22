//! Standalone dependency-free chess engine and JSON Lines command line interface.
//!
//! The protocol and rule model intentionally mirror `python/chess_cpu.py`.
//! The source is compiled directly with `rustc --edition=2021 -O`.

use std::collections::BTreeMap;
use std::fmt::Write as FmtWrite;
use std::io::{self, BufRead, Write};

const SPLITMIX_INCREMENT: u64 = 0x9E37_79B9_7F4A_7C15;
const SPLITMIX_MULTIPLIER_1: u64 = 0xBF58_476D_1CE4_E5B9;
const SPLITMIX_MULTIPLIER_2: u64 = 0x94D0_49BB_1331_11EB;

const CASTLE_WK: u8 = 1;
const CASTLE_WQ: u8 = 2;
const CASTLE_BK: u8 = 4;
const CASTLE_BQ: u8 = 8;

#[derive(Clone, Debug)]
enum JsonValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

impl JsonValue {
    fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::String(value) => Some(value),
            _ => None,
        }
    }
}

struct JsonParser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, position: 0 }
    }

    fn parse(mut self) -> Result<JsonValue, String> {
        self.skip_whitespace();
        let value = self.parse_value()?;
        self.skip_whitespace();
        if self.position != self.input.len() {
            return Err("trailing characters after JSON value".to_string());
        }
        Ok(value)
    }

    fn skip_whitespace(&mut self) {
        while let Some(byte) = self.input.as_bytes().get(self.position) {
            if matches!(byte, b' ' | b'\n' | b'\r' | b'\t') {
                self.position += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_whitespace();
        match self.input.as_bytes().get(self.position).copied() {
            Some(b'n') => self.parse_literal(b"null", JsonValue::Null),
            Some(b't') => self.parse_literal(b"true", JsonValue::Bool(true)),
            Some(b'f') => self.parse_literal(b"false", JsonValue::Bool(false)),
            Some(b'"') => Ok(JsonValue::String(self.parse_string()?)),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-' | b'0'..=b'9') => Ok(JsonValue::Number(self.parse_number()?)),
            _ => Err("expected a JSON value".to_string()),
        }
    }

    fn parse_literal(&mut self, literal: &[u8], value: JsonValue) -> Result<JsonValue, String> {
        let end = self.position + literal.len();
        if self.input.as_bytes().get(self.position..end) == Some(literal) {
            self.position = end;
            Ok(value)
        } else {
            Err("invalid JSON literal".to_string())
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        if self.input.as_bytes().get(self.position) != Some(&b'"') {
            return Err("expected JSON string".to_string());
        }
        self.position += 1;
        let mut value = String::new();
        while self.position < self.input.len() {
            let byte = self.input.as_bytes()[self.position];
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(value);
                }
                b'\\' => {
                    self.position += 1;
                    let escape = *self
                        .input
                        .as_bytes()
                        .get(self.position)
                        .ok_or_else(|| "unterminated JSON escape".to_string())?;
                    self.position += 1;
                    match escape {
                        b'"' => value.push('"'),
                        b'\\' => value.push('\\'),
                        b'/' => value.push('/'),
                        b'b' => value.push('\u{0008}'),
                        b'f' => value.push('\u{000c}'),
                        b'n' => value.push('\n'),
                        b'r' => value.push('\r'),
                        b't' => value.push('\t'),
                        b'u' => {
                            let first = self.parse_hex_quad()?;
                            if (0xD800..=0xDBFF).contains(&first) {
                                if self.input.as_bytes().get(self.position..self.position + 2)
                                    != Some(b"\\u")
                                {
                                    return Err("unpaired JSON high surrogate".to_string());
                                }
                                self.position += 2;
                                let second = self.parse_hex_quad()?;
                                if !(0xDC00..=0xDFFF).contains(&second) {
                                    return Err("invalid JSON surrogate pair".to_string());
                                }
                                let codepoint = 0x1_0000
                                    + ((first as u32 - 0xD800) << 10)
                                    + (second as u32 - 0xDC00);
                                value
                                    .push(char::from_u32(codepoint).ok_or_else(|| {
                                        "invalid JSON Unicode escape".to_string()
                                    })?);
                            } else if (0xDC00..=0xDFFF).contains(&first) {
                                return Err("unpaired JSON low surrogate".to_string());
                            } else {
                                value
                                    .push(char::from_u32(first as u32).ok_or_else(|| {
                                        "invalid JSON Unicode escape".to_string()
                                    })?);
                            }
                        }
                        _ => return Err("invalid JSON escape".to_string()),
                    }
                }
                0..=0x1F => return Err("unescaped control character in JSON string".to_string()),
                _ => {
                    let character = self.input[self.position..]
                        .chars()
                        .next()
                        .ok_or_else(|| "invalid UTF-8 in JSON string".to_string())?;
                    value.push(character);
                    self.position += character.len_utf8();
                }
            }
        }
        Err("unterminated JSON string".to_string())
    }

    fn parse_hex_quad(&mut self) -> Result<u16, String> {
        let mut value = 0u16;
        for _ in 0..4 {
            let byte = *self
                .input
                .as_bytes()
                .get(self.position)
                .ok_or_else(|| "short JSON Unicode escape".to_string())?;
            self.position += 1;
            value = value
                .checked_mul(16)
                .and_then(|current| current.checked_add(hex_value(byte)?))
                .ok_or_else(|| "invalid JSON Unicode escape".to_string())?;
        }
        Ok(value)
    }

    fn parse_array(&mut self) -> Result<JsonValue, String> {
        self.position += 1;
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.input.as_bytes().get(self.position) == Some(&b']') {
            self.position += 1;
            return Ok(JsonValue::Array(values));
        }
        loop {
            values.push(self.parse_value()?);
            self.skip_whitespace();
            match self.input.as_bytes().get(self.position).copied() {
                Some(b',') => {
                    self.position += 1;
                    self.skip_whitespace();
                }
                Some(b']') => {
                    self.position += 1;
                    return Ok(JsonValue::Array(values));
                }
                _ => return Err("expected comma or closing bracket in JSON array".to_string()),
            }
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue, String> {
        self.position += 1;
        self.skip_whitespace();
        let mut values = BTreeMap::new();
        if self.input.as_bytes().get(self.position) == Some(&b'}') {
            self.position += 1;
            return Ok(JsonValue::Object(values));
        }
        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.skip_whitespace();
            if self.input.as_bytes().get(self.position) != Some(&b':') {
                return Err("expected colon in JSON object".to_string());
            }
            self.position += 1;
            let value = self.parse_value()?;
            values.insert(key, value);
            self.skip_whitespace();
            match self.input.as_bytes().get(self.position).copied() {
                Some(b',') => {
                    self.position += 1;
                    self.skip_whitespace();
                }
                Some(b'}') => {
                    self.position += 1;
                    return Ok(JsonValue::Object(values));
                }
                _ => return Err("expected comma or closing brace in JSON object".to_string()),
            }
        }
    }

    fn parse_number(&mut self) -> Result<String, String> {
        let start = self.position;
        if self.input.as_bytes().get(self.position) == Some(&b'-') {
            self.position += 1;
        }
        match self.input.as_bytes().get(self.position).copied() {
            Some(b'0') => {
                self.position += 1;
                if matches!(self.input.as_bytes().get(self.position), Some(b'0'..=b'9')) {
                    return Err("leading zero in JSON number".to_string());
                }
            }
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.input.as_bytes().get(self.position), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err("invalid JSON number".to_string()),
        }
        if self.input.as_bytes().get(self.position) == Some(&b'.') {
            self.position += 1;
            let fraction_start = self.position;
            while matches!(self.input.as_bytes().get(self.position), Some(b'0'..=b'9')) {
                self.position += 1;
            }
            if self.position == fraction_start {
                return Err("JSON number has an empty fraction".to_string());
            }
        }
        if matches!(self.input.as_bytes().get(self.position), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.input.as_bytes().get(self.position), Some(b'+' | b'-')) {
                self.position += 1;
            }
            let exponent_start = self.position;
            while matches!(self.input.as_bytes().get(self.position), Some(b'0'..=b'9')) {
                self.position += 1;
            }
            if self.position == exponent_start {
                return Err("JSON number has an empty exponent".to_string());
            }
        }
        Ok(self.input[start..self.position].to_string())
    }
}

fn hex_value(byte: u8) -> Option<u16> {
    match byte {
        b'0'..=b'9' => Some((byte - b'0') as u16),
        b'a'..=b'f' => Some((byte - b'a' + 10) as u16),
        b'A'..=b'F' => Some((byte - b'A' + 10) as u16),
        _ => None,
    }
}

fn write_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                let _ = write!(output, "\\u{:04x}", character as u32);
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

fn serialize_json(value: &JsonValue, output: &mut String) {
    match value {
        JsonValue::Null => output.push_str("null"),
        JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        JsonValue::Number(value) => output.push_str(value),
        JsonValue::String(value) => write_json_string(output, value),
        JsonValue::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                serialize_json(value, output);
            }
            output.push(']');
        }
        JsonValue::Object(values) => {
            output.push('{');
            for (index, (key, value)) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_json_string(output, key);
                output.push(':');
                serialize_json(value, output);
            }
            output.push('}');
        }
    }
}

fn json_string(value: impl Into<String>) -> JsonValue {
    JsonValue::String(value.into())
}

fn json_number(value: impl ToString) -> JsonValue {
    JsonValue::Number(value.to_string())
}

fn json_array(values: Vec<JsonValue>) -> JsonValue {
    JsonValue::Array(values)
}

fn json_object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut object = BTreeMap::new();
    for (key, value) in entries {
        object.insert(key.to_string(), value);
    }
    JsonValue::Object(object)
}

#[derive(Clone, Debug)]
struct ProtocolError {
    code: String,
    message: String,
    details: Option<JsonValue>,
}

impl ProtocolError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Color {
    White,
    Black,
}

fn opposite(color: Color) -> Color {
    match color {
        Color::White => Color::Black,
        Color::Black => Color::White,
    }
}

fn side_name(color: Color) -> &'static str {
    match color {
        Color::White => "white",
        Color::Black => "black",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Piece {
    color: Color,
    kind: char,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChessMove {
    source: u8,
    target: u8,
    promotion: Option<char>,
}

impl ChessMove {
    fn uci(self) -> String {
        let mut value = format!("{}{}", square_name(self.source), square_name(self.target));
        if let Some(promotion) = self.promotion {
            value.push(promotion);
        }
        value
    }
}

#[derive(Clone)]
struct Position {
    board: [Option<Piece>; 64],
    side_to_move: Color,
    castling: u8,
    en_passant: Option<u8>,
    halfmove: u64,
    fullmove: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Basic,
    AllRules,
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Basic => "basic",
        Mode::AllRules => "all-rules-enabled",
    }
}

fn coordinates(square: u8) -> (i32, i32) {
    ((square % 8) as i32, (square / 8) as i32)
}

fn in_bounds(file: i32, rank: i32) -> bool {
    (0..8).contains(&file) && (0..8).contains(&rank)
}

fn index_at(file: i32, rank: i32) -> u8 {
    (rank * 8 + file) as u8
}

fn square_index(value: &str) -> Result<u8, ()> {
    let bytes = value.as_bytes();
    if bytes.len() != 2 || !(b'a'..=b'h').contains(&bytes[0]) || !(b'1'..=b'8').contains(&bytes[1])
    {
        return Err(());
    }
    Ok((bytes[1] - b'1') * 8 + (bytes[0] - b'a'))
}

fn square_name(square: u8) -> String {
    let mut value = String::with_capacity(2);
    value.push((b'a' + square % 8) as char);
    value.push((b'1' + square / 8) as char);
    value
}

fn initial_position() -> Position {
    let mut board = [None; 64];
    let back_rank = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (file, kind) in back_rank.into_iter().enumerate() {
        board[index_at(file as i32, 0) as usize] = Some(Piece {
            color: Color::White,
            kind,
        });
        board[index_at(file as i32, 1) as usize] = Some(Piece {
            color: Color::White,
            kind: 'p',
        });
        board[index_at(file as i32, 6) as usize] = Some(Piece {
            color: Color::Black,
            kind: 'p',
        });
        board[index_at(file as i32, 7) as usize] = Some(Piece {
            color: Color::Black,
            kind,
        });
    }
    Position {
        board,
        side_to_move: Color::White,
        castling: CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ,
        en_passant: None,
        halfmove: 0,
        fullmove: 1,
    }
}

fn castling_text(castling: u8) -> String {
    let mut value = String::new();
    if castling & CASTLE_WK != 0 {
        value.push('K');
    }
    if castling & CASTLE_WQ != 0 {
        value.push('Q');
    }
    if castling & CASTLE_BK != 0 {
        value.push('k');
    }
    if castling & CASTLE_BQ != 0 {
        value.push('q');
    }
    if value.is_empty() {
        "-".to_string()
    } else {
        value
    }
}

fn piece_to_fen(piece: Piece) -> char {
    if piece.color == Color::White {
        piece.kind.to_ascii_uppercase()
    } else {
        piece.kind
    }
}

fn board_fen(board: &[Option<Piece>; 64]) -> String {
    let mut ranks = Vec::with_capacity(8);
    for rank in (0..8).rev() {
        let mut text = String::new();
        let mut empty = 0;
        for file in 0..8 {
            match board[index_at(file, rank) as usize] {
                None => empty += 1,
                Some(piece) => {
                    if empty > 0 {
                        text.push(char::from_digit(empty, 10).unwrap());
                        empty = 0;
                    }
                    text.push(piece_to_fen(piece));
                }
            }
        }
        if empty > 0 {
            text.push(char::from_digit(empty, 10).unwrap());
        }
        ranks.push(text);
    }
    ranks.join("/")
}

fn fen_piece(character: char) -> Result<Piece, ProtocolError> {
    let kind = character.to_ascii_lowercase();
    if !matches!(kind, 'p' | 'n' | 'b' | 'r' | 'q' | 'k') {
        return Err(ProtocolError::new("E_INVALID_FEN", "invalid FEN piece"));
    }
    Ok(Piece {
        color: if character.is_ascii_uppercase() {
            Color::White
        } else {
            Color::Black
        },
        kind,
    })
}

fn parse_plain_u64(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()
}

fn find_king(board: &[Option<Piece>; 64], color: Color) -> Option<u8> {
    board.iter().enumerate().find_map(|(square, piece)| {
        if piece.is_some_and(|piece| piece.color == color && piece.kind == 'k') {
            Some(square as u8)
        } else {
            None
        }
    })
}

fn is_square_attacked(board: &[Option<Piece>; 64], target: u8, by_color: Color) -> bool {
    const KNIGHT_STEPS: [(i32, i32); 8] = [
        (1, 2),
        (2, 1),
        (2, -1),
        (1, -2),
        (-1, -2),
        (-2, -1),
        (-2, 1),
        (-1, 2),
    ];
    const KING_STEPS: [(i32, i32); 8] = [
        (1, 1),
        (1, 0),
        (1, -1),
        (0, -1),
        (-1, -1),
        (-1, 0),
        (-1, 1),
        (0, 1),
    ];
    const ORTHOGONAL_STEPS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
    const DIAGONAL_STEPS: [(i32, i32); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

    let (target_file, target_rank) = coordinates(target);
    let pawn_source_rank = target_rank + if by_color == Color::White { -1 } else { 1 };
    if (0..8).contains(&pawn_source_rank) {
        for source_file in [target_file - 1, target_file + 1] {
            if (0..8).contains(&source_file)
                && board[index_at(source_file, pawn_source_rank) as usize]
                    .is_some_and(|piece| piece.color == by_color && piece.kind == 'p')
            {
                return true;
            }
        }
    }
    for (file_delta, rank_delta) in KNIGHT_STEPS {
        let file = target_file + file_delta;
        let rank = target_rank + rank_delta;
        if in_bounds(file, rank)
            && board[index_at(file, rank) as usize]
                .is_some_and(|piece| piece.color == by_color && piece.kind == 'n')
        {
            return true;
        }
    }
    for (file_delta, rank_delta) in KING_STEPS {
        let file = target_file + file_delta;
        let rank = target_rank + rank_delta;
        if in_bounds(file, rank)
            && board[index_at(file, rank) as usize]
                .is_some_and(|piece| piece.color == by_color && piece.kind == 'k')
        {
            return true;
        }
    }
    for (file_delta, rank_delta) in ORTHOGONAL_STEPS {
        let mut file = target_file + file_delta;
        let mut rank = target_rank + rank_delta;
        while in_bounds(file, rank) {
            if let Some(piece) = board[index_at(file, rank) as usize] {
                if piece.color == by_color && matches!(piece.kind, 'r' | 'q') {
                    return true;
                }
                break;
            }
            file += file_delta;
            rank += rank_delta;
        }
    }
    for (file_delta, rank_delta) in DIAGONAL_STEPS {
        let mut file = target_file + file_delta;
        let mut rank = target_rank + rank_delta;
        while in_bounds(file, rank) {
            if let Some(piece) = board[index_at(file, rank) as usize] {
                if piece.color == by_color && matches!(piece.kind, 'b' | 'q') {
                    return true;
                }
                break;
            }
            file += file_delta;
            rank += rank_delta;
        }
    }
    false
}

fn in_check(position: &Position, color: Color) -> bool {
    find_king(&position.board, color)
        .map(|king| is_square_attacked(&position.board, king, opposite(color)))
        .unwrap_or(true)
}

fn parse_fen(value: &str) -> Result<Position, ProtocolError> {
    if value == "startpos" {
        return Ok(initial_position());
    }
    let mut fields: Vec<&str> = value.split_whitespace().collect();
    if fields.len() == 4 {
        fields.push("0");
        fields.push("1");
    } else if fields.len() == 5 {
        fields.push("1");
    }
    if fields.len() != 6 {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "fen must have four, five, or six fields",
        ));
    }
    let ranks: Vec<&str> = fields[0].split('/').collect();
    if ranks.len() != 8 {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "fen board must have eight ranks",
        ));
    }
    let mut board = [None; 64];
    for (fen_rank, rank_text) in ranks.iter().enumerate() {
        let rank = 7 - fen_rank as i32;
        let mut file = 0i32;
        for character in rank_text.chars() {
            if ('1'..='8').contains(&character) {
                file += character.to_digit(10).unwrap() as i32;
            } else if matches!(
                character,
                'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
            ) {
                if file >= 8 {
                    return Err(ProtocolError::new(
                        "E_INVALID_FEN",
                        "fen rank contains too many squares",
                    ));
                }
                board[index_at(file, rank) as usize] = Some(fen_piece(character)?);
                file += 1;
            } else {
                return Err(ProtocolError::new(
                    "E_INVALID_FEN",
                    "invalid FEN board character",
                ));
            }
        }
        if file != 8 {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "fen rank does not contain eight squares",
            ));
        }
    }
    let side_to_move = match fields[1] {
        "w" => Color::White,
        "b" => Color::Black,
        _ => {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "fen side-to-move must be w or b",
            ))
        }
    };
    let mut castling = 0u8;
    if fields[2] != "-" {
        if fields[2].is_empty() {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "invalid FEN castling rights",
            ));
        }
        for character in fields[2].chars() {
            let bit = match character {
                'K' => CASTLE_WK,
                'Q' => CASTLE_WQ,
                'k' => CASTLE_BK,
                'q' => CASTLE_BQ,
                _ => {
                    return Err(ProtocolError::new(
                        "E_INVALID_FEN",
                        "invalid FEN castling rights",
                    ))
                }
            };
            if castling & bit != 0 {
                return Err(ProtocolError::new(
                    "E_INVALID_FEN",
                    "invalid FEN castling rights",
                ));
            }
            castling |= bit;
        }
    }
    let en_passant = if fields[3] == "-" {
        None
    } else {
        let target = square_index(fields[3])
            .map_err(|_| ProtocolError::new("E_INVALID_FEN", "invalid FEN en-passant square"))?;
        let (_, target_rank) = coordinates(target);
        let expected_rank = if side_to_move == Color::White { 5 } else { 2 };
        if target_rank != expected_rank || board[target as usize].is_some() {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "FEN en-passant square is incompatible with side to move",
            ));
        }
        let (_, target_rank) = coordinates(target);
        let captured_rank = target_rank + if side_to_move == Color::White { -1 } else { 1 };
        let origin_rank = target_rank + if side_to_move == Color::White { 1 } else { -1 };
        if !in_bounds((target % 8) as i32, captured_rank)
            || !in_bounds((target % 8) as i32, origin_rank)
        {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "invalid FEN en-passant square",
            ));
        }
        let captured = board[index_at((target % 8) as i32, captured_rank) as usize];
        if captured
            != Some(Piece {
                color: opposite(side_to_move),
                kind: 'p',
            })
        {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "FEN en-passant square has no opposing pawn",
            ));
        }
        if board[index_at((target % 8) as i32, origin_rank) as usize].is_some() {
            return Err(ProtocolError::new(
                "E_INVALID_FEN",
                "FEN en-passant square has an occupied pawn origin",
            ));
        }
        Some(target)
    };
    let halfmove = parse_plain_u64(fields[4]);
    let fullmove = parse_plain_u64(fields[5]);
    if halfmove.is_none() || fullmove.is_none() || fullmove == Some(0) {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "FEN move counters are out of range",
        ));
    }
    let position = Position {
        board,
        side_to_move,
        castling,
        en_passant,
        halfmove: halfmove.unwrap(),
        fullmove: fullmove.unwrap(),
    };
    let white_kings = position
        .board
        .iter()
        .filter(|piece| piece.is_some_and(|piece| piece.color == Color::White && piece.kind == 'k'))
        .count();
    let black_kings = position
        .board
        .iter()
        .filter(|piece| piece.is_some_and(|piece| piece.color == Color::Black && piece.kind == 'k'))
        .count();
    if white_kings != 1 || black_kings != 1 {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "FEN must contain exactly one king per side",
        ));
    }
    if position.board.iter().enumerate().any(|(square, piece)| {
        piece.is_some_and(|piece| piece.kind == 'p' && matches!(square / 8, 0 | 7))
    }) {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "FEN cannot place a pawn on the first or eighth rank",
        ));
    }
    let white_king = find_king(&position.board, Color::White).unwrap();
    let black_king = find_king(&position.board, Color::Black).unwrap();
    let (white_file, white_rank) = coordinates(white_king);
    let (black_file, black_rank) = coordinates(black_king);
    if (white_file - black_file)
        .abs()
        .max((white_rank - black_rank).abs())
        <= 1
    {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "FEN kings cannot be adjacent",
        ));
    }
    let white_attacks_black = is_square_attacked(&position.board, black_king, Color::White);
    let black_attacks_white = is_square_attacked(&position.board, white_king, Color::Black);
    if white_attacks_black && black_attacks_white {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "FEN cannot have both kings in check",
        ));
    }
    if side_to_move == Color::White && white_attacks_black {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "the non-moving king cannot be in check",
        ));
    }
    if side_to_move == Color::Black && black_attacks_white {
        return Err(ProtocolError::new(
            "E_INVALID_FEN",
            "the non-moving king cannot be in check",
        ));
    }
    Ok(position)
}

fn remove_rook_right(castling: &mut u8, square: u8) {
    match square {
        0 => *castling &= !CASTLE_WQ,
        7 => *castling &= !CASTLE_WK,
        56 => *castling &= !CASTLE_BQ,
        63 => *castling &= !CASTLE_BK,
        _ => {}
    }
}

fn is_en_passant_move(position: &Position, movement: ChessMove) -> bool {
    let piece = match position.board[movement.source as usize] {
        Some(piece) => piece,
        None => return false,
    };
    if piece.kind != 'p'
        || position.en_passant != Some(movement.target)
        || position.board[movement.target as usize].is_some()
    {
        return false;
    }
    let (source_file, source_rank) = coordinates(movement.source);
    let (target_file, target_rank) = coordinates(movement.target);
    let direction = if piece.color == Color::White { 1 } else { -1 };
    if target_rank - source_rank != direction || (target_file - source_file).abs() != 1 {
        return false;
    }
    let captured_rank = target_rank - direction;
    if !in_bounds(target_file, captured_rank) {
        return false;
    }
    position.board[index_at(target_file, captured_rank) as usize]
        == Some(Piece {
            color: opposite(piece.color),
            kind: 'p',
        })
}

fn apply_unchecked(position: &Position, movement: ChessMove) -> Position {
    let moving =
        position.board[movement.source as usize].expect("unchecked move has a source piece");
    let mut next = position.clone();
    let mut captured = next.board[movement.target as usize];
    let is_ep = is_en_passant_move(position, movement);
    if is_ep {
        let (_, target_rank) = coordinates(movement.target);
        let captured_rank = target_rank + if moving.color == Color::White { -1 } else { 1 };
        let captured_square = index_at((movement.target % 8) as i32, captured_rank);
        captured = next.board[captured_square as usize];
        next.board[captured_square as usize] = None;
    }
    next.board[movement.source as usize] = None;
    next.board[movement.target as usize] = Some(Piece {
        color: moving.color,
        kind: movement.promotion.unwrap_or(moving.kind),
    });
    let (source_file, source_rank) = coordinates(movement.source);
    let (target_file, target_rank) = coordinates(movement.target);
    if moving.kind == 'k' && source_rank == target_rank && (target_file - source_file).abs() == 2 {
        let (rook_source, rook_target) = if target_file == 6 {
            (index_at(7, source_rank), index_at(5, source_rank))
        } else {
            (index_at(0, source_rank), index_at(3, source_rank))
        };
        next.board[rook_target as usize] = next.board[rook_source as usize];
        next.board[rook_source as usize] = None;
    }
    if moving.kind == 'k' {
        next.castling &= if moving.color == Color::White {
            !(CASTLE_WK | CASTLE_WQ)
        } else {
            !(CASTLE_BK | CASTLE_BQ)
        };
    } else if moving.kind == 'r' {
        remove_rook_right(&mut next.castling, movement.source);
    }
    if captured.is_some_and(|piece| piece.kind == 'r') {
        remove_rook_right(&mut next.castling, movement.target);
    }
    next.en_passant = None;
    if moving.kind == 'p' && (target_rank - source_rank).abs() == 2 {
        next.en_passant = Some(index_at(source_file, (source_rank + target_rank) / 2));
    }
    next.halfmove = if moving.kind == 'p' || captured.is_some() {
        0
    } else {
        position.halfmove + 1
    };
    next.side_to_move = opposite(position.side_to_move);
    next.fullmove = position.fullmove + u64::from(moving.color == Color::Black);
    next
}

fn append_pawn_moves(position: &Position, source: u8, moves: &mut Vec<ChessMove>) {
    let piece = position.board[source as usize].expect("pawn source exists");
    let (source_file, source_rank) = coordinates(source);
    let direction = if piece.color == Color::White { 1 } else { -1 };
    let final_rank = if piece.color == Color::White { 7 } else { 0 };
    let one_rank = source_rank + direction;
    if in_bounds(source_file, one_rank) {
        let one = index_at(source_file, one_rank);
        if position.board[one as usize].is_none() {
            if one_rank == final_rank {
                for promotion in ['q', 'r', 'b', 'n'] {
                    moves.push(ChessMove {
                        source,
                        target: one,
                        promotion: Some(promotion),
                    });
                }
            } else {
                moves.push(ChessMove {
                    source,
                    target: one,
                    promotion: None,
                });
            }
            let start_rank = if piece.color == Color::White { 1 } else { 6 };
            let two_rank = source_rank + 2 * direction;
            if source_rank == start_rank
                && position.board[index_at(source_file, two_rank) as usize].is_none()
            {
                moves.push(ChessMove {
                    source,
                    target: index_at(source_file, two_rank),
                    promotion: None,
                });
            }
        }
    }
    let capture_rank = source_rank + direction;
    if !(0..8).contains(&capture_rank) {
        return;
    }
    for target_file in [source_file - 1, source_file + 1] {
        if !(0..8).contains(&target_file) {
            continue;
        }
        let target = index_at(target_file, capture_rank);
        if let Some(target_piece) = position.board[target as usize] {
            if target_piece.color != piece.color && target_piece.kind != 'k' {
                if capture_rank == final_rank {
                    for promotion in ['q', 'r', 'b', 'n'] {
                        moves.push(ChessMove {
                            source,
                            target,
                            promotion: Some(promotion),
                        });
                    }
                } else {
                    moves.push(ChessMove {
                        source,
                        target,
                        promotion: None,
                    });
                }
            }
        } else if position.en_passant == Some(target) {
            let movement = ChessMove {
                source,
                target,
                promotion: None,
            };
            if is_en_passant_move(position, movement) {
                moves.push(movement);
            }
        }
    }
}

fn append_sliding_moves(
    position: &Position,
    source: u8,
    moves: &mut Vec<ChessMove>,
    directions: &[(i32, i32)],
) {
    let piece = position.board[source as usize].expect("sliding source exists");
    let (source_file, source_rank) = coordinates(source);
    for &(file_delta, rank_delta) in directions {
        let mut file = source_file + file_delta;
        let mut rank = source_rank + rank_delta;
        while in_bounds(file, rank) {
            let target = index_at(file, rank);
            match position.board[target as usize] {
                None => moves.push(ChessMove {
                    source,
                    target,
                    promotion: None,
                }),
                Some(target_piece) => {
                    if target_piece.color != piece.color && target_piece.kind != 'k' {
                        moves.push(ChessMove {
                            source,
                            target,
                            promotion: None,
                        });
                    }
                    break;
                }
            }
            file += file_delta;
            rank += rank_delta;
        }
    }
}

fn castle_basic_available(position: &Position, movement: ChessMove) -> bool {
    let piece = match position.board[movement.source as usize] {
        Some(piece) => piece,
        None => return false,
    };
    if piece.kind != 'k' || piece.color != position.side_to_move {
        return false;
    }
    let (source_file, source_rank) = coordinates(movement.source);
    let (target_file, target_rank) = coordinates(movement.target);
    if source_file != 4 || target_rank != source_rank || !matches!(target_file, 2 | 6) {
        return false;
    }
    let (right, rook_file) = match source_rank {
        0 => (
            if target_file == 6 {
                CASTLE_WK
            } else {
                CASTLE_WQ
            },
            if target_file == 6 { 7 } else { 0 },
        ),
        7 => (
            if target_file == 6 {
                CASTLE_BK
            } else {
                CASTLE_BQ
            },
            if target_file == 6 { 7 } else { 0 },
        ),
        _ => return false,
    };
    if position.castling & right == 0 {
        return false;
    }
    let rook_square = index_at(rook_file, source_rank);
    if position.board[rook_square as usize]
        != Some(Piece {
            color: piece.color,
            kind: 'r',
        })
    {
        return false;
    }
    let path_files: &[i32] = if target_file == 6 {
        &[5, 6]
    } else {
        &[1, 2, 3]
    };
    path_files
        .iter()
        .all(|file| position.board[index_at(*file, source_rank) as usize].is_none())
}

fn castle_is_safe(position: &Position, movement: ChessMove) -> bool {
    if !castle_basic_available(position, movement) {
        return false;
    }
    let color = position.side_to_move;
    let enemy = opposite(color);
    if in_check(position, color) {
        return false;
    }
    let (_, source_rank) = coordinates(movement.source);
    let (target_file, _) = coordinates(movement.target);
    let transit_file = if target_file == 6 { 5 } else { 3 };
    for file in [transit_file, target_file] {
        let mut transit = position.clone();
        transit.board[movement.source as usize] = None;
        let square = index_at(file, source_rank);
        transit.board[square as usize] = Some(Piece { color, kind: 'k' });
        if is_square_attacked(&transit.board, square, enemy) {
            return false;
        }
    }
    true
}

fn generate_pseudo_moves(position: &Position, include_attacked_castles: bool) -> Vec<ChessMove> {
    const KNIGHT_STEPS: [(i32, i32); 8] = [
        (1, 2),
        (2, 1),
        (2, -1),
        (1, -2),
        (-1, -2),
        (-2, -1),
        (-2, 1),
        (-1, 2),
    ];
    const KING_STEPS: [(i32, i32); 8] = [
        (1, 1),
        (1, 0),
        (1, -1),
        (0, -1),
        (-1, -1),
        (-1, 0),
        (-1, 1),
        (0, 1),
    ];
    const ORTHOGONAL_STEPS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
    const DIAGONAL_STEPS: [(i32, i32); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

    let color = position.side_to_move;
    let mut moves = Vec::new();
    for source in 0..64u8 {
        let piece = match position.board[source as usize] {
            Some(piece) if piece.color == color => piece,
            _ => continue,
        };
        let (source_file, source_rank) = coordinates(source);
        match piece.kind {
            'p' => append_pawn_moves(position, source, &mut moves),
            'n' => {
                for (file_delta, rank_delta) in KNIGHT_STEPS {
                    let file = source_file + file_delta;
                    let rank = source_rank + rank_delta;
                    if !in_bounds(file, rank) {
                        continue;
                    }
                    let target = index_at(file, rank);
                    if position.board[target as usize].map_or(true, |target_piece| {
                        target_piece.color != color && target_piece.kind != 'k'
                    }) {
                        moves.push(ChessMove {
                            source,
                            target,
                            promotion: None,
                        });
                    }
                }
            }
            'b' => append_sliding_moves(position, source, &mut moves, &DIAGONAL_STEPS),
            'r' => append_sliding_moves(position, source, &mut moves, &ORTHOGONAL_STEPS),
            'q' => {
                append_sliding_moves(position, source, &mut moves, &ORTHOGONAL_STEPS);
                append_sliding_moves(position, source, &mut moves, &DIAGONAL_STEPS);
            }
            'k' => {
                for (file_delta, rank_delta) in KING_STEPS {
                    let file = source_file + file_delta;
                    let rank = source_rank + rank_delta;
                    if !in_bounds(file, rank) {
                        continue;
                    }
                    let target = index_at(file, rank);
                    if position.board[target as usize].map_or(true, |target_piece| {
                        target_piece.color != color && target_piece.kind != 'k'
                    }) {
                        moves.push(ChessMove {
                            source,
                            target,
                            promotion: None,
                        });
                    }
                }
                for target_file in [2, 6] {
                    let movement = ChessMove {
                        source,
                        target: index_at(target_file, source_rank),
                        promotion: None,
                    };
                    if castle_basic_available(position, movement)
                        && (include_attacked_castles || castle_is_safe(position, movement))
                    {
                        moves.push(movement);
                    }
                }
            }
            _ => {}
        }
    }
    moves
}

fn promotion_order(promotion: Option<char>) -> u8 {
    match promotion {
        Some('q') => 0,
        Some('r') => 1,
        Some('b') => 2,
        Some('n') => 3,
        _ => 99,
    }
}

fn generate_legal_moves(position: &Position) -> Vec<ChessMove> {
    let color = position.side_to_move;
    let mut legal = Vec::new();
    for movement in generate_pseudo_moves(position, false) {
        let candidate = apply_unchecked(position, movement);
        if !in_check(&candidate, color) {
            legal.push(movement);
        }
    }
    legal.sort_by_key(|movement| {
        (
            movement.source,
            movement.target,
            promotion_order(movement.promotion),
        )
    });
    legal
}

fn effective_en_passant(position: &Position) -> Option<u8> {
    let target = position.en_passant?;
    if generate_legal_moves(position)
        .into_iter()
        .any(|movement| movement.target == target && is_en_passant_move(position, movement))
    {
        Some(target)
    } else {
        None
    }
}

fn position_key(position: &Position) -> String {
    let ep = effective_en_passant(position)
        .map(square_name)
        .unwrap_or_else(|| "-".to_string());
    format!(
        "{} {} {} {}",
        board_fen(&position.board),
        if position.side_to_move == Color::White {
            "w"
        } else {
            "b"
        },
        castling_text(position.castling),
        ep
    )
}

fn is_dead_position(position: &Position) -> bool {
    let mut non_kings = 0usize;
    for piece in position.board.iter().flatten() {
        if piece.kind == 'k' {
            continue;
        }
        if matches!(piece.kind, 'p' | 'r' | 'q') {
            return false;
        }
        non_kings += 1;
    }
    non_kings <= 1
}

fn result_for_winner(color: Color) -> &'static str {
    if color == Color::White {
        "1-0"
    } else {
        "0-1"
    }
}

struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(SPLITMIX_INCREMENT);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(SPLITMIX_MULTIPLIER_1);
        value = (value ^ (value >> 27)).wrapping_mul(SPLITMIX_MULTIPLIER_2);
        value ^ (value >> 31)
    }
}

#[derive(Clone)]
struct Outcome {
    reason: String,
    result: String,
    winner: Option<Color>,
}

#[derive(Clone)]
struct Game {
    mode: Mode,
    position: Position,
    moves: Vec<String>,
    repetition_counts: BTreeMap<String, u64>,
    status: String,
    check: Option<Color>,
    outcome: Option<Outcome>,
    claimable_draws: Vec<String>,
}

impl Game {
    fn new(mode: Mode, position: Position, _seed: u64) -> Self {
        let mut game = Self {
            mode,
            position,
            moves: Vec::new(),
            repetition_counts: BTreeMap::new(),
            status: "active".to_string(),
            check: None,
            outcome: None,
            claimable_draws: Vec::new(),
        };
        if mode == Mode::AllRules {
            game.repetition_counts
                .insert(position_key(&game.position), 1);
        }
        game.refresh();
        game
    }

    fn raw_legal_moves(&self) -> Vec<ChessMove> {
        generate_legal_moves(&self.position)
    }

    fn legal_moves(&self) -> Vec<ChessMove> {
        if self.status != "active" {
            Vec::new()
        } else {
            self.raw_legal_moves()
        }
    }

    fn refresh(&mut self) {
        let side = self.position.side_to_move;
        self.check = if in_check(&self.position, side) {
            Some(side)
        } else {
            None
        };
        let legal = self.raw_legal_moves();
        self.outcome = None;
        if legal.is_empty() {
            if self.check.is_some() {
                let winner = opposite(side);
                self.outcome = Some(Outcome {
                    reason: "checkmate".to_string(),
                    result: result_for_winner(winner).to_string(),
                    winner: Some(winner),
                });
            } else {
                self.outcome = Some(Outcome {
                    reason: "stalemate".to_string(),
                    result: "1/2-1/2".to_string(),
                    winner: None,
                });
            }
        } else if is_dead_position(&self.position) {
            self.outcome = Some(Outcome {
                reason: "dead_position".to_string(),
                result: "1/2-1/2".to_string(),
                winner: None,
            });
        } else if self.mode == Mode::AllRules {
            let key = position_key(&self.position);
            if self.repetition_counts.get(&key).copied().unwrap_or(0) >= 5 {
                self.outcome = Some(Outcome {
                    reason: "fivefold_repetition".to_string(),
                    result: "1/2-1/2".to_string(),
                    winner: None,
                });
            } else if self.position.halfmove >= 150 {
                self.outcome = Some(Outcome {
                    reason: "seventy_five_move".to_string(),
                    result: "1/2-1/2".to_string(),
                    winner: None,
                });
            }
        }
        self.status = if self.outcome.is_some() {
            "terminal"
        } else {
            "active"
        }
        .to_string();
        self.claimable_draws = if self.status == "active" {
            self.compute_claimable_draws()
        } else {
            Vec::new()
        };
    }

    fn compute_claimable_draws(&self) -> Vec<String> {
        if self.mode != Mode::AllRules {
            return Vec::new();
        }
        let mut claimable = Vec::new();
        let current_key = position_key(&self.position);
        if self
            .repetition_counts
            .get(&current_key)
            .copied()
            .unwrap_or(0)
            >= 3
        {
            claimable.push("threefold_repetition".to_string());
        }
        if self.position.halfmove >= 100 {
            claimable.push("fifty_move".to_string());
        }
        for movement in self.raw_legal_moves() {
            let candidate = apply_unchecked(&self.position, movement);
            if !claimable
                .iter()
                .any(|value| value == "threefold_repetition")
            {
                let key = position_key(&candidate);
                if self.repetition_counts.get(&key).copied().unwrap_or(0) + 1 >= 3 {
                    claimable.push("threefold_repetition".to_string());
                }
            }
            if !claimable.iter().any(|value| value == "fifty_move") && candidate.halfmove >= 100 {
                claimable.push("fifty_move".to_string());
            }
            if claimable.len() == 2 {
                break;
            }
        }
        claimable
    }

    fn commit(&mut self, movement: ChessMove) {
        self.position = apply_unchecked(&self.position, movement);
        self.moves.push(movement.uci());
        if self.mode == Mode::AllRules {
            let key = position_key(&self.position);
            *self.repetition_counts.entry(key).or_insert(0) += 1;
        }
        self.refresh();
    }

    fn state_json(&self) -> JsonValue {
        let board = self
            .position
            .board
            .iter()
            .map(|piece| match piece {
                None => JsonValue::Null,
                Some(piece) => json_object(vec![
                    ("color", json_string(side_name(piece.color))),
                    ("type", json_string(piece_type_name(piece.kind))),
                ]),
            })
            .collect();
        let outcome = match &self.outcome {
            None => JsonValue::Null,
            Some(outcome) => {
                let mut entries = vec![
                    ("reason", json_string(outcome.reason.clone())),
                    ("result", json_string(outcome.result.clone())),
                ];
                if let Some(winner) = outcome.winner {
                    entries.push(("winner", json_string(side_name(winner))));
                }
                json_object(entries)
            }
        };
        let repetition_counts = if self.mode == Mode::AllRules {
            JsonValue::Object(
                self.repetition_counts
                    .iter()
                    .map(|(key, count)| (key.clone(), json_number(*count)))
                    .collect(),
            )
        } else {
            JsonValue::Object(BTreeMap::new())
        };
        json_object(vec![
            ("mode", json_string(mode_name(self.mode))),
            ("board", json_array(board)),
            (
                "side_to_move",
                json_string(side_name(self.position.side_to_move)),
            ),
            (
                "castling_rights",
                json_string(castling_text(self.position.castling)),
            ),
            (
                "en_passant_target",
                self.position
                    .en_passant
                    .map(square_name)
                    .map(json_string)
                    .unwrap_or(JsonValue::Null),
            ),
            ("halfmove_clock", json_number(self.position.halfmove)),
            ("fullmove_number", json_number(self.position.fullmove)),
            ("status", json_string(self.status.clone())),
            (
                "check",
                self.check
                    .map(side_name)
                    .map(json_string)
                    .unwrap_or(JsonValue::Null),
            ),
            ("outcome", outcome),
            (
                "claimable_draws",
                json_array(
                    self.claimable_draws
                        .iter()
                        .cloned()
                        .map(json_string)
                        .collect(),
                ),
            ),
            ("repetition_counts", repetition_counts),
            (
                "moves",
                json_array(self.moves.iter().cloned().map(json_string).collect()),
            ),
        ])
    }
}

fn piece_type_name(kind: char) -> &'static str {
    match kind {
        'k' => "king",
        'q' => "queen",
        'r' => "rook",
        'b' => "bishop",
        'n' => "knight",
        _ => "pawn",
    }
}

fn decimal_mod_u64(value: &str) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    let bytes = value.as_bytes();
    let (negative, digits) = match bytes[0] {
        b'+' => (false, &value[1..]),
        b'-' => (true, &value[1..]),
        _ => (false, value),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let mut result = 0u64;
    for byte in digits.bytes() {
        result = result.wrapping_mul(10).wrapping_add(u64::from(byte - b'0'));
    }
    Some(if negative {
        0u64.wrapping_sub(result)
    } else {
        result
    })
}

fn parse_mode(value: Option<&JsonValue>, default: Mode) -> Result<Mode, ProtocolError> {
    match value {
        None | Some(JsonValue::Null) => Ok(default),
        Some(JsonValue::String(value)) if value == "basic" => Ok(Mode::Basic),
        Some(JsonValue::String(value)) if value == "all-rules-enabled" => Ok(Mode::AllRules),
        _ => Err(ProtocolError::new(
            "E_INVALID_REQUEST",
            "mode must be basic or all-rules-enabled",
        )),
    }
}

fn parse_seed(value: Option<&JsonValue>, default: u64) -> Result<u64, ProtocolError> {
    match value {
        None | Some(JsonValue::Null) => Ok(default),
        Some(JsonValue::Number(value)) | Some(JsonValue::String(value)) => decimal_mod_u64(value)
            .ok_or_else(|| {
                ProtocolError::new(
                    "E_INVALID_REQUEST",
                    "seed must be a decimal integer or string",
                )
            }),
        _ => Err(ProtocolError::new(
            "E_INVALID_REQUEST",
            "seed must be a decimal integer or string",
        )),
    }
}

fn parse_nonnegative(value: Option<&JsonValue>, field: &str) -> Result<u64, ProtocolError> {
    let value = match value {
        Some(value) => value,
        None => {
            return Err(ProtocolError::new(
                "E_INVALID_REQUEST",
                format!("{} must be a non-negative integer", field),
            ))
        }
    };
    let text = match value {
        JsonValue::Number(value) if !value.starts_with('+') => value,
        _ => {
            return Err(ProtocolError::new(
                "E_INVALID_REQUEST",
                format!("{} must be a non-negative integer", field),
            ))
        }
    };
    let parsed = decimal_mod_u64(text);
    if text.starts_with('-') {
        if text[1..].bytes().all(|byte| byte == b'0') {
            return Ok(0);
        }
        return Err(ProtocolError::new(
            "E_INVALID_REQUEST",
            format!("{} must be a non-negative integer", field),
        ));
    }
    parsed.ok_or_else(|| {
        ProtocolError::new(
            "E_INVALID_REQUEST",
            format!("{} must be a non-negative integer", field),
        )
    })
}

fn parse_uci(value: Option<&JsonValue>) -> Result<ChessMove, ProtocolError> {
    let text = value.and_then(JsonValue::as_str).ok_or_else(|| {
        ProtocolError::new(
            "E_INVALID_MOVE_SYNTAX",
            "move must use lowercase coordinate notation",
        )
    })?;
    let bytes = text.as_bytes();
    if !(bytes.len() == 4 || bytes.len() == 5)
        || !(b'a'..=b'h').contains(&bytes[0])
        || !(b'1'..=b'8').contains(&bytes[1])
        || !(b'a'..=b'h').contains(&bytes[2])
        || !(b'1'..=b'8').contains(&bytes[3])
        || (bytes.len() == 5 && !matches!(bytes[4], b'q' | b'r' | b'b' | b'n'))
    {
        return Err(ProtocolError::new(
            "E_INVALID_MOVE_SYNTAX",
            "move must use lowercase coordinate notation",
        ));
    }
    Ok(ChessMove {
        source: square_index(&text[0..2]).unwrap(),
        target: square_index(&text[2..4]).unwrap(),
        promotion: if bytes.len() == 5 {
            Some(bytes[4] as char)
        } else {
            None
        },
    })
}

fn path_is_blocked(position: &Position, source: u8, target: u8) -> bool {
    let (source_file, source_rank) = coordinates(source);
    let (target_file, target_rank) = coordinates(target);
    let file_delta = target_file - source_file;
    let rank_delta = target_rank - source_rank;
    let step_file = file_delta.signum();
    let step_rank = rank_delta.signum();
    let file_steps = file_delta.abs();
    let rank_steps = rank_delta.abs();
    if !(file_delta == 0 || rank_delta == 0 || file_steps == rank_steps) {
        return false;
    }
    let mut file = source_file + step_file;
    let mut rank = source_rank + step_rank;
    while (file, rank) != (target_file, target_rank) {
        if position.board[index_at(file, rank) as usize].is_some() {
            return true;
        }
        file += step_file;
        rank += step_rank;
    }
    false
}

fn castle_shape(position: &Position, movement: ChessMove) -> bool {
    let piece = match position.board[movement.source as usize] {
        Some(piece) => piece,
        None => return false,
    };
    if piece.kind != 'k' {
        return false;
    }
    let (source_file, source_rank) = coordinates(movement.source);
    let (target_file, target_rank) = coordinates(movement.target);
    source_file == 4 && target_rank == source_rank && matches!(target_file, 2 | 6)
}

fn en_passant_shape(position: &Position, movement: ChessMove) -> bool {
    let piece = match position.board[movement.source as usize] {
        Some(piece) => piece,
        None => return false,
    };
    if piece.kind != 'p' {
        return false;
    }
    let (source_file, source_rank) = coordinates(movement.source);
    let (target_file, target_rank) = coordinates(movement.target);
    let direction = if piece.color == Color::White { 1 } else { -1 };
    position.en_passant == Some(movement.target)
        && position.board[movement.target as usize].is_none()
        && target_rank - source_rank == direction
        && (target_file - source_file).abs() == 1
}

fn validate_move(game: &Game, movement: ChessMove) -> Result<(), ProtocolError> {
    let position = &game.position;
    let piece = position.board[movement.source as usize]
        .ok_or_else(|| ProtocolError::new("E_EMPTY_SOURCE", "source square is empty"))?;
    if piece.color != position.side_to_move {
        return Err(ProtocolError::new(
            "E_WRONG_TURN",
            "source piece belongs to the other side",
        ));
    }
    if position.board[movement.target as usize].is_some_and(|target| target.color == piece.color) {
        return Err(ProtocolError::new(
            "E_OWN_PIECE_ON_DESTINATION",
            "destination contains a friendly piece",
        ));
    }
    let target_rank = movement.target / 8;
    let reaches_promotion_rank = piece.kind == 'p' && matches!(target_rank, 0 | 7);
    if reaches_promotion_rank != movement.promotion.is_some() {
        return Err(ProtocolError::new(
            "E_INVALID_PROMOTION",
            "promotion is mandatory only on the final rank",
        ));
    }
    if movement.promotion.is_some() && piece.kind != 'p' {
        return Err(ProtocolError::new(
            "E_INVALID_PROMOTION",
            "only a pawn may promote",
        ));
    }
    let legal = game.raw_legal_moves();
    if legal.contains(&movement) {
        return Ok(());
    }
    if castle_shape(position, movement) {
        if !castle_basic_available(position, movement) {
            return Err(ProtocolError::new(
                "E_CASTLE_UNAVAILABLE",
                "castling rights, rook, or path are unavailable",
            ));
        }
        return Err(ProtocolError::new(
            "E_CASTLE_THROUGH_CHECK",
            "the king is in, through, or into check while castling",
        ));
    }
    if en_passant_shape(position, movement) {
        if is_en_passant_move(position, movement)
            && generate_pseudo_moves(position, true).contains(&movement)
        {
            return Err(ProtocolError::new(
                "E_SELF_CHECK",
                "en-passant move would leave the king in check",
            ));
        }
        return Err(ProtocolError::new(
            "E_EN_PASSANT_UNAVAILABLE",
            "en-passant capture is unavailable",
        ));
    }
    if generate_pseudo_moves(position, true).contains(&movement) {
        return Err(ProtocolError::new(
            "E_SELF_CHECK",
            "move would leave the king in check",
        ));
    }
    let (source_file, source_rank) = coordinates(movement.source);
    let (target_file, target_rank) = coordinates(movement.target);
    let file_delta = (target_file - source_file).abs();
    let rank_delta = (target_rank - source_rank).abs();
    let aligned = match piece.kind {
        'b' => file_delta == rank_delta && file_delta > 0,
        'r' => (file_delta == 0) != (rank_delta == 0),
        'q' => {
            (file_delta == rank_delta && file_delta > 0) || ((file_delta == 0) != (rank_delta == 0))
        }
        _ => false,
    };
    if aligned && path_is_blocked(position, movement.source, movement.target) {
        return Err(ProtocolError::new(
            "E_PATH_BLOCKED",
            "a piece blocks the move path",
        ));
    }
    Err(ProtocolError::new(
        "E_ILLEGAL_GEOMETRY",
        "piece cannot move that way",
    ))
}

fn perft(position: &Position, depth: u64) -> u64 {
    if depth == 0 {
        return 1;
    }
    let legal = generate_legal_moves(position);
    if depth == 1 {
        return legal.len() as u64;
    }
    legal
        .into_iter()
        .map(|movement| perft(&apply_unchecked(position, movement), depth - 1))
        .sum()
}

fn run_game(mode: Mode, position: Position, seed: u64, max_plies: u64, trace: bool) -> JsonValue {
    let mut game = Game::new(mode, position, seed);
    let mut rng = SplitMix64::new(seed);
    let mut committed = Vec::new();
    while game.status == "active" && (committed.len() as u64) < max_plies {
        let legal = game.raw_legal_moves();
        if legal.is_empty() {
            break;
        }
        let selected = legal[(rng.next_u64() % legal.len() as u64) as usize];
        game.commit(selected);
        committed.push(selected.uci());
    }
    let (termination, result) = match &game.outcome {
        Some(outcome) => (outcome.reason.clone(), outcome.result.clone()),
        None => ("max_plies".to_string(), "*".to_string()),
    };
    json_object(vec![
        ("ok", JsonValue::Bool(true)),
        ("op", json_string("run")),
        ("seed", json_string(seed.to_string())),
        (
            "moves",
            json_array(if trace {
                committed.into_iter().map(json_string).collect()
            } else {
                Vec::new()
            }),
        ),
        ("plies", json_number(game.moves.len())),
        ("termination", json_string(termination)),
        ("result", json_string(result)),
        ("final", game.state_json()),
    ])
}

fn root_position(
    session: Option<&Game>,
    fen: Option<&JsonValue>,
) -> Result<Position, ProtocolError> {
    match fen {
        Some(JsonValue::String(value)) => parse_fen(value),
        Some(JsonValue::Null) | None => Ok(session
            .map(|game| game.position.clone())
            .unwrap_or_else(initial_position)),
        Some(_) => Err(ProtocolError::new("E_INVALID_FEN", "fen must be a string")),
    }
}

fn required_fen(value: Option<&JsonValue>) -> Result<Position, ProtocolError> {
    match value {
        Some(JsonValue::String(value)) => parse_fen(value),
        _ => Err(ProtocolError::new("E_INVALID_FEN", "fen must be a string")),
    }
}

fn error_response(op: JsonValue, error: ProtocolError, session: Option<&Game>) -> JsonValue {
    let mut entries = vec![
        ("ok", JsonValue::Bool(false)),
        ("op", op),
        ("error", {
            let mut error_entries = vec![
                ("code", json_string(error.code)),
                ("message", json_string(error.message)),
            ];
            if let Some(details) = error.details {
                error_entries.push(("details", details));
            }
            json_object(error_entries)
        }),
    ];
    if let Some(game) = session {
        entries.push(("state", game.state_json()));
    }
    json_object(entries)
}

fn success(op: &str, entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut all = vec![("ok", JsonValue::Bool(true)), ("op", json_string(op))];
    all.extend(entries);
    json_object(all)
}

fn handle_request(request: JsonValue, session: &mut Option<Game>) -> JsonValue {
    let object = match &request {
        JsonValue::Object(object) => object,
        _ => {
            return error_response(
                JsonValue::Null,
                ProtocolError::new("E_INVALID_REQUEST", "request must be a JSON object"),
                session.as_ref(),
            )
        }
    };
    let op_value = object.get("op").cloned().unwrap_or(JsonValue::Null);
    let op = match object.get("op").and_then(JsonValue::as_str) {
        Some(op) => op,
        None => {
            return error_response(
                op_value,
                ProtocolError::new("E_INVALID_REQUEST", "request op must be a string"),
                session.as_ref(),
            )
        }
    };
    match op {
        "new" => {
            let mode = match parse_mode(object.get("mode"), Mode::AllRules) {
                Ok(mode) => mode,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let seed = match parse_seed(object.get("seed"), 1) {
                Ok(seed) => seed,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let position = if object.contains_key("fen") {
                match required_fen(object.get("fen")) {
                    Ok(position) => position,
                    Err(error) => return error_response(json_string(op), error, session.as_ref()),
                }
            } else {
                initial_position()
            };
            let game = Game::new(mode, position, seed);
            let state = game.state_json();
            *session = Some(game);
            success(op, vec![("state", state)])
        }
        "state" => match session.as_ref() {
            Some(game) => success(op, vec![("state", game.state_json())]),
            None => error_response(
                json_string(op),
                ProtocolError::new("E_NO_SESSION", "create a session with the new operation"),
                None,
            ),
        },
        "legal_moves" => match session.as_ref() {
            Some(game) => {
                let moves = game
                    .legal_moves()
                    .into_iter()
                    .map(|movement| json_string(movement.uci()))
                    .collect();
                success(op, vec![("moves", json_array(moves))])
            }
            None => error_response(
                json_string(op),
                ProtocolError::new("E_NO_SESSION", "create a session with the new operation"),
                None,
            ),
        },
        "play" => {
            let game = match session.as_mut() {
                Some(game) => game,
                None => {
                    return error_response(
                        json_string(op),
                        ProtocolError::new(
                            "E_NO_SESSION",
                            "create a session with the new operation",
                        ),
                        None,
                    )
                }
            };
            if game.status != "active" {
                return error_response(
                    json_string(op),
                    ProtocolError::new("E_GAME_OVER", "the game is already over"),
                    Some(game),
                );
            }
            let movement = match parse_uci(object.get("move")) {
                Ok(movement) => movement,
                Err(error) => return error_response(json_string(op), error, Some(game)),
            };
            if let Err(error) = validate_move(game, movement) {
                return error_response(json_string(op), error, Some(game));
            }
            let move_name = movement.uci();
            game.commit(movement);
            success(
                op,
                vec![
                    ("move", json_string(move_name)),
                    ("state", game.state_json()),
                ],
            )
        }
        "perft" => {
            let depth = match parse_nonnegative(object.get("depth"), "depth") {
                Ok(depth) => depth,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let position = match root_position(session.as_ref(), object.get("fen")) {
                Ok(position) => position,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            success(
                op,
                vec![
                    ("depth", json_number(depth)),
                    ("nodes", json_number(perft(&position, depth))),
                ],
            )
        }
        "run" => {
            let mode = match parse_mode(object.get("mode"), Mode::AllRules) {
                Ok(mode) => mode,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let seed = match parse_seed(object.get("seed"), 1) {
                Ok(seed) => seed,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let max_plies = match object.get("max_plies") {
                None => 600,
                Some(value) => match parse_nonnegative(Some(value), "max_plies") {
                    Ok(value) => value,
                    Err(error) => return error_response(json_string(op), error, session.as_ref()),
                },
            };
            let trace = match object.get("trace") {
                None => true,
                Some(JsonValue::Bool(value)) => *value,
                _ => {
                    return error_response(
                        json_string(op),
                        ProtocolError::new("E_INVALID_REQUEST", "trace must be boolean"),
                        session.as_ref(),
                    )
                }
            };
            let position = if object.contains_key("fen") {
                match required_fen(object.get("fen")) {
                    Ok(position) => position,
                    Err(error) => return error_response(json_string(op), error, session.as_ref()),
                }
            } else {
                initial_position()
            };
            run_game(mode, position, seed, max_plies, trace)
        }
        "sample" => {
            let samples = match parse_nonnegative(object.get("samples"), "samples") {
                Ok(samples) => samples,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let seed = match parse_seed(object.get("seed"), 1) {
                Ok(seed) => seed,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let position = match root_position(session.as_ref(), object.get("fen")) {
                Ok(position) => position,
                Err(error) => return error_response(json_string(op), error, session.as_ref()),
            };
            let legal = generate_legal_moves(&position);
            let move_names: Vec<String> = legal.iter().map(|movement| movement.uci()).collect();
            let mut counts = vec![0u64; legal.len()];
            let mut sequence = Vec::new();
            let mut rng = SplitMix64::new(seed);
            for _ in 0..samples {
                if !legal.is_empty() {
                    let index = (rng.next_u64() % legal.len() as u64) as usize;
                    counts[index] += 1;
                    sequence.push(move_names[index].clone());
                }
            }
            let count_object = JsonValue::Object(
                move_names
                    .iter()
                    .zip(counts)
                    .map(|(movement, count)| (movement.clone(), json_number(count)))
                    .collect(),
            );
            success(
                op,
                vec![
                    (
                        "moves",
                        json_array(move_names.into_iter().map(json_string).collect()),
                    ),
                    ("counts", count_object),
                    (
                        "sequence",
                        json_array(sequence.into_iter().map(json_string).collect()),
                    ),
                    ("samples", json_number(samples)),
                    ("seed", json_string(seed.to_string())),
                ],
            )
        }
        _ => error_response(
            json_string(op),
            ProtocolError::new(
                "E_UNKNOWN_OPERATION",
                format!("unsupported operation: {}", op),
            ),
            session.as_ref(),
        ),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let mut session: Option<Game> = None;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("input error: {}", error);
                break;
            }
        }
        if line.trim().is_empty() {
            continue;
        }
        let response = match JsonParser::new(line.trim_end_matches(['\r', '\n'])).parse() {
            Ok(request) => handle_request(request, &mut session),
            Err(error) => error_response(
                JsonValue::Null,
                ProtocolError::new("E_INVALID_REQUEST", format!("invalid JSON: {}", error)),
                session.as_ref(),
            ),
        };
        let mut serialized = String::new();
        serialize_json(&response, &mut serialized);
        if writeln!(writer, "{}", serialized).is_err() || writer.flush().is_err() {
            break;
        }
    }
}
