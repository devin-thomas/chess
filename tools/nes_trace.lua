-- FCEUX trace reader for retro/nes_replay_main.c.
-- The ROM publishes a fixed-format state record at CPU address $7000.

local base = 0x7000
local history_base = base + 84
local record_bytes = 83
local history_count_offset = 83
local records = {}

local function byte(offset)
  return memory.readbyte(base + offset)
end

local function record_byte(record, offset)
  return memory.readbyte(history_base + record * record_bytes + offset)
end

local function record_word(record, offset)
  return record_byte(record, offset) + 256 * record_byte(record, offset + 1) +
    65536 * record_byte(record, offset + 2) + 16777216 * record_byte(record, offset + 3)
end

local function json_string(value)
  return '"' .. value:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
end

local function board_fen(record)
  local rows = {}
  for rank = 7, 0, -1 do
    local row = ''
    local empty = 0
    for file = 0, 7 do
      local piece = record_byte(record, 16 + rank * 8 + file)
      local names = {[0] = '', [1] = 'P', [2] = 'N', [3] = 'B', [4] = 'R', [5] = 'Q', [6] = 'K',
        [9] = 'p', [10] = 'n', [11] = 'b', [12] = 'r', [13] = 'q', [14] = 'k'}
      local symbol = names[piece] or '?'
      if symbol == '' then
        empty = empty + 1
      else
        if empty > 0 then row = row .. tostring(empty); empty = 0 end
        row = row .. symbol
      end
    end
    if empty > 0 then row = row .. tostring(empty) end
    rows[#rows + 1] = row
  end
  return table.concat(rows, '/')
end

local function rights_text(record)
  local rights = ''
  if bit.band(record_byte(record, 6), 1) ~= 0 then rights = rights .. 'K' end
  if bit.band(record_byte(record, 6), 2) ~= 0 then rights = rights .. 'Q' end
  if bit.band(record_byte(record, 6), 4) ~= 0 then rights = rights .. 'k' end
  if bit.band(record_byte(record, 6), 8) ~= 0 then rights = rights .. 'q' end
  return rights == '' and '-' or rights
end

local function ep_text(record)
  local ep = record_byte(record, 7)
  if ep == 255 then return '-' end
  return string.char(string.byte('a') + ep % 8) .. tostring(1 + math.floor(ep / 8))
end

local function capture(record)
  return {
    event = record_byte(record, 0), command = record_byte(record, 1), valid = record_byte(record, 2),
    ply = record_byte(record, 3), move_count = record_byte(record, 4),
    side = record_byte(record, 5) == 0 and 'white' or 'black', rights = rights_text(record), ep = ep_text(record),
    halfmove = record_word(record, 8), fullmove = record_word(record, 12), board = board_fen(record),
    error = record_byte(record, 80), demo_stage = record_byte(record, 81), done = record_byte(record, 82) ~= 0,
  }
end

local saw_reset = false
for _ = 1, 600 do
  local history_count = byte(history_count_offset)
  if not saw_reset then
    -- Cartridge RAM can retain a prior run. Wait for the ROM's reset marker
    -- before accepting a completion flag from that stale state.
    saw_reset = history_count == 0
  elseif history_count >= 6 and byte(82) ~= 0 then
    for record = 0, 5 do
      records[#records + 1] = capture(record)
    end
    break
  end
  emu.frameadvance()
end

local trace_path = os.getenv('NES_TRACE_OUTPUT') or 'build/nes-replay-trace.json'
local output = io.open(trace_path, 'w')
if output == nil then error('cannot open ' .. trace_path) end
output:write('{"schema_version":1,"profile":"cc65-fceux","trace_base":"0x7000","records":[\n')
for index, record in ipairs(records) do
  output:write('  {')
  local fields = {
    '"event":' .. record.event, '"command":' .. record.command, '"valid":' .. record.valid,
    '"ply":' .. record.ply, '"move_count":' .. record.move_count,
    '"side":' .. json_string(record.side), '"rights":' .. json_string(record.rights),
    '"ep":' .. json_string(record.ep), '"halfmove":' .. record.halfmove,
    '"fullmove":' .. record.fullmove, '"board":' .. json_string(record.board),
    '"error":' .. record.error, '"demo_stage":' .. record.demo_stage,
    '"done":' .. tostring(record.done),
  }
  output:write(table.concat(fields, ','))
  output:write(index == #records and '}\n' or '},\n')
end
output:write(']}\n')
output:close()
print('NES_TRACE records=' .. tostring(#records))
