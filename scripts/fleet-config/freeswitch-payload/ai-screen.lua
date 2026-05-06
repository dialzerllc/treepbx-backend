--[[
ai-screen.lua — AI-screened campaign call.

After avmd classifies, plays a probe prompt, captures the called party's
response, POSTs the audio to ctl02. ctl02 runs STT + LLM verdict, returns
{decision: bridge|hangup}. We bridge to the agent only on a positive
verdict; otherwise hang up with amd_result=machine so events.ts frees the
agent immediately and an audit row is written.

Channel vars consumed (set by dialer at originate):
  ai_probe_audio_url   Pre-rendered probe TTS audio (R2 presigned).
  ai_probe_text        Plain text of the probe — passed to LLM as context.
  ai_eval_prompt       LLM system prompt; empty = backend default.
  ai_record_seconds    Capture window for response audio (default 4).
  ai_callback_url      Full URL to ctl02's /api/v1/internal/ai-probe.
  ai_callback_token    Bearer token for ctl02 (BOOTSTRAP_TOKEN).
  ai_call_id           treepbx call.id (UUID) — used for audit row + R2 key.
  amd_timeout_ms       avmd classification window (default 3500ms).
  amd_action           Action when MACHINE — same vocab as amd-screen.lua.
  amd_bridge_target    Agent endpoint for HUMAN — e.g. user/agent123.

Channel vars set by this script:
  amd_result           'human' | 'machine' | 'unknown' — read by events.ts.
  ai_probe_transcript  STT output, copied from ctl02 response for hangup_complete log.
]]

local function v(name, default)
  local x = session:getVariable(name)
  if x == nil or x == '' then return default end
  return x
end

local function vint(name, default)
  local x = tonumber(session:getVariable(name) or '')
  return x or default
end

local function url_to_play(u)
  if not u or u == '' then return nil end
  if u:match('^http_cache://') then return u end
  if u:match('^https?://') then return 'http_cache://' .. u end
  return u
end

local function shellquote(s)
  -- Single-quote-wrap with embedded-quote escaping for safe curl args.
  return "'" .. tostring(s or ''):gsub("'", "'\\''") .. "'"
end

if not session:ready() then return end
session:answer()

local probe_url   = url_to_play(v('ai_probe_audio_url'))
local probe_text  = v('ai_probe_text', '')
local eval_prompt = v('ai_eval_prompt', '')
local record_sec  = vint('ai_record_seconds', 4)
local callback    = v('ai_callback_url')
local cb_token    = v('ai_callback_token')
local call_id     = v('ai_call_id')
local amd_timeout = vint('amd_timeout_ms', 3500)
local amd_action  = v('amd_action', 'hangup')
local bridge_to   = v('amd_bridge_target')

if not (probe_url and callback and cb_token and call_id and bridge_to and bridge_to ~= '') then
  freeswitch.consoleLog('ERR', '[ai-screen] missing required channel vars\n')
  session:setVariable('amd_result', 'unknown')
  session:hangup('SERVICE_UNAVAILABLE')
  return
end

-- avmd pre-screen — cheap path: if avmd is confident it's a machine, skip
-- the LLM round-trip entirely.
session:execute('avmd_start', '')
local waited = 0
local step = 100
while waited < amd_timeout do
  if not session:ready() then
    session:setVariable('amd_result', 'unknown')
    return
  end
  local d = session:getVariable('avmd_detect')
  if d == 'TRUE' or d == 'FALSE' then break end
  session:sleep(step)
  waited = waited + step
end
local avmd_machine = (session:getVariable('avmd_detect') == 'TRUE')
session:execute('avmd_stop', '')

if avmd_machine then
  session:setVariable('amd_result', 'machine')
  if amd_action == 'hangup' then
    session:hangup('MACHINE_DETECTED')
  else
    -- Reuse the MACHINE branches in amd-screen.lua for transfer/voicemail/play_message.
    session:execute('lua', 'amd-screen.lua')
  end
  return
end

-- HUMAN or NOTSURE per avmd → run the AI probe.

-- 1. Play the probe prompt.
session:streamFile(probe_url)
if not session:ready() then return end

-- 2. Record N seconds of response. record_session(file, max_secs) is
--    non-blocking, so we sleep then stop explicitly.
local fs_uuid = session:getVariable('uuid') or 'unknown'
local local_path = '/tmp/' .. fs_uuid .. '-probe.wav'
session:execute('record_session', local_path .. ' ' .. tostring(record_sec))
session:sleep(record_sec * 1000 + 200)
session:execute('stop_record_session', local_path)

-- 3. Upload to ctl02 in one multipart request. ctl02 handles R2 storage,
--    STT, LLM, and writes the amd_decisions audit row, returning the
--    verdict synchronously.
local cmd = table.concat({
  "curl -sS -m 8 -X POST",
  "-H " .. shellquote('Authorization: Bearer ' .. cb_token),
  "-F " .. shellquote('file=@' .. local_path),
  "-F " .. shellquote('call_id=' .. call_id),
  "-F " .. shellquote('probe_text=' .. probe_text),
  (eval_prompt ~= '') and ("-F " .. shellquote('eval_prompt=' .. eval_prompt)) or '',
  shellquote(callback),
}, ' ')
local handle = io.popen(cmd, 'r')
local resp = handle and handle:read('*a') or ''
if handle then handle:close() end
os.execute('rm -f ' .. local_path)

-- 4. Parse verdict (lazy match — backend returns JSON we control).
local is_human = true
if resp:match('"is_human"%s*:%s*false') or resp:match('"decision"%s*:%s*"hangup"') then
  is_human = false
end
local transcript = resp:match('"transcript"%s*:%s*"(.-)"')
if transcript then session:setVariable('ai_probe_transcript', transcript) end

if is_human then
  session:setVariable('amd_result', 'human')
  session:execute('bridge', bridge_to)
  return
end

session:setVariable('amd_result', 'machine')
session:hangup('MACHINE_DETECTED')
