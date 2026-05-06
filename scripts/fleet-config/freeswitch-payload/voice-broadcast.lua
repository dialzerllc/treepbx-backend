--[[
voice-broadcast.lua — orchestrates a voice broadcast call after answer.

Channel vars consumed (set by the dialer before originate):
  bcast_audio_url        HTTP(S) URL of the human-branch audio (R2 presigned).
  bcast_amd_enabled      'true' | 'false'  (default false).
  bcast_amd_timeout_ms   integer ms to wait for avmd to classify (default 3500).
  bcast_amd_action       'hangup' | 'leave_voicemail' | 'transfer'.
  bcast_vm_url           HTTP(S) URL for amd_action=leave_voicemail.
  bcast_amd_xfer_target  External destination when amd_action=transfer.
  bcast_xfer_enabled     'true' | 'false' — arm DTMF press-1 transfer on HUMAN.
  bcast_xfer_target      External destination for press-1 transfer.
  bcast_xfer_digit       Digit that triggers transfer (default '1').

Channel vars set by this script (read off in CHANNEL_HANGUP_COMPLETE for dispo):
  bcast_outcome          One of: human_played, dtmf_transferred, machine_dropped,
                         machine_voicemail, no_classification, error.
  bcast_amd_result       Mirrors avmd_detect (TRUE = machine, FALSE = human).
]]

local function v(name, default)
  local x = session:getVariable(name)
  if x == nil or x == '' then return default end
  return x
end

local function vbool(name, default)
  local x = session:getVariable(name)
  if x == 'true' then return true end
  if x == 'false' then return false end
  return default
end

local function vint(name, default)
  local x = tonumber(session:getVariable(name) or '')
  return x or default
end

local function url_to_play(u)
  -- mod_http_cache plays HTTP(S) URLs by prefixing with http_cache://.
  if not u or u == '' then return nil end
  if u:match('^http_cache://') then return u end
  if u:match('^https?://') then return 'http_cache://' .. u end
  return u
end

local function set_outcome(o)
  session:setVariable('bcast_outcome', o)
end

if not session:ready() then return end

session:answer()
session:setVariable('hangup_after_bridge', 'true')

local audio_url   = url_to_play(v('bcast_audio_url'))
local vm_url      = url_to_play(v('bcast_vm_url'))
local amd_on      = vbool('bcast_amd_enabled', false)
local amd_timeout = vint('bcast_amd_timeout_ms', 3500)
local amd_action  = v('bcast_amd_action', 'hangup')
local xfer_on     = vbool('bcast_xfer_enabled', false)
local xfer_dest   = v('bcast_xfer_target')
local xfer_digit  = v('bcast_xfer_digit', '1')

if not audio_url then
  freeswitch.consoleLog('ERR', '[voice-broadcast] missing bcast_audio_url\n')
  set_outcome('error')
  session:hangup()
  return
end

-- AMD classification phase (runs only if enabled).
local is_machine = false
if amd_on then
  session:execute('avmd_start', '')
  local waited = 0
  local step = 100
  while waited < amd_timeout do
    if not session:ready() then
      set_outcome('error')
      return
    end
    local detect = session:getVariable('avmd_detect')
    if detect == 'TRUE' then
      is_machine = true
      break
    end
    if detect == 'FALSE' then
      break
    end
    session:sleep(step)
    waited = waited + step
  end
  session:setVariable('bcast_amd_result', session:getVariable('avmd_detect') or 'NOTSURE')
end

if is_machine then
  session:execute('avmd_stop', '')
  if amd_action == 'hangup' then
    set_outcome('machine_dropped')
    session:hangup()
    return
  elseif amd_action == 'leave_voicemail' then
    if not vm_url then
      set_outcome('machine_dropped')
      session:hangup()
      return
    end
    -- Wait for the outgoing greeting + beep before playing our message.
    -- mod_avmd fires avmd::beep and sets avmd_beep_status when it hears one.
    -- Bound the wait at 30s — voicemail prompts can run long but we don't
    -- want to camp forever on a stuck channel.
    session:execute('avmd_start', '')
    local waited = 0
    local step = 250
    local beep_seen = false
    while waited < 30000 do
      if not session:ready() then break end
      if session:getVariable('avmd_beep_status') == 'DETECTED' then
        beep_seen = true
        break
      end
      session:sleep(step)
      waited = waited + step
    end
    session:execute('avmd_stop', '')
    if not session:ready() then return end
    -- Whether or not we saw the beep, drop the message — for many machines
    -- avmd misses the beep but the greeting has ended by 30s anyway.
    session:streamFile(vm_url)
    set_outcome(beep_seen and 'machine_voicemail' or 'machine_voicemail_noBeep')
    session:hangup()
    return
  elseif amd_action == 'transfer' then
    local tgt = v('bcast_amd_xfer_target')
    if not tgt then
      set_outcome('machine_dropped')
      session:hangup()
      return
    end
    set_outcome('amd_transferred')
    session:execute('bridge', 'sofia/gateway/${default_outbound_gateway}/' .. tgt)
    return
  else
    set_outcome('machine_dropped')
    session:hangup()
    return
  end
end

-- HUMAN branch (or AMD disabled / NOTSURE).
session:execute('avmd_stop', '')

if xfer_on and xfer_dest and xfer_dest ~= '' then
  -- Arm DTMF capture before playback. bind_meta_app on a single digit lets us
  -- catch the keypress mid-playback and trigger transfer.
  session:execute('bind_meta_app', xfer_digit .. ' a s execute_extension::voice-broadcast-xfer XML default')
  session:setVariable('bcast_xfer_target_resolved', xfer_dest)
end

session:streamFile(audio_url)

-- After playback, give caller 5s to press the DTMF digit if they didn't during.
if xfer_on and xfer_dest and xfer_dest ~= '' then
  local d = session:getDigits(1, xfer_digit, 5000)
  if d == xfer_digit then
    set_outcome('dtmf_transferred')
    session:execute('bridge', 'sofia/gateway/${default_outbound_gateway}/' .. xfer_dest)
    return
  end
end

set_outcome('human_played')
session:hangup()
