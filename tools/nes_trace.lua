-- FCEUX trace reader for retro/nes_replay_main.c.
-- The ROM publishes a fixed-format state record at CPU address $7000.

local base = 0x7000
local records = {}
local last_event = -1

local function byte(offset)
  return memory.readbyte(base + offset)
end

local function word(offset)
  return byte(offset) + 256 * byte(offset + 1) + 65536 * byte(offset + 2) + 16777216 * byte(offset + 3)
end

local function json_string(value)
  return '"' .. value:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
end

local function board_fen()
  local rows = {}
  for rank = 7, 0, -1 do
    local row = ''
    local empty = 0
    for file = 0, 7 do
      local piece = byte(16 + rank * 8 + file)
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

local function rights_text()
  local rights = ''
  if bit.band(byte(6), 1) ~= 0 then rights = rights .. 'K' end
  if bit.band(byte(6), 2) ~= 0 then rights = rights .. 'Q' end
  if bit.band(byte(6), 4) ~= 0 then rights = rights .. 'k' end
  if bit.band(byte(6), 8) ~= 0 then rights = rights .. 'q' end
  return rights == '' and '-' or rights
end

local function ep_text()
  local ep = byte(7)
  if ep == 255 then return '-' end
  return string.char(string.byte('a') + ep % 8) .. tostring(1 + math.floor(ep / 8))
end

local function capture()
  return {
    event = byte(0), command = byte(1), valid = byte(2), ply = byte(3), move_count = byte(4),
    side = byte(5) == 0 and 'white' or 'black', rights = rights_text(), ep = ep_text(),
    halfmove = word(8), fullmove = word(12), board = board_fen(), error = byte(80),
    demo_stage = byte(81), done = byte(82) ~= 0,
  }
end

for _ = 1, 600 do
  local event = byte(0)
  if event ~= last_event and event ~= 0 then
    last_event = event
    records[#records + 1] = capture()
    if byte(82) ~= 0 then break end
  end
  emu.frameadvance()
end

local output = io.open('build/nes-replay-trace.json', 'w')
if output == nil then error('cannot open build/nes-replay-trace.json') end
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
