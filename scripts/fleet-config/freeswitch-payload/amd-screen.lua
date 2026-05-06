--[[
amd-screen.lua — answering-machine screen for predictive/progressive/preview
campaigns. Runs after answer, classifies HUMAN vs MACHINE, then either bridges
to the agent (HUMAN) or applies the configured amd_action (MACHINE).

This is the NON-broadcast AMD path. Broadcast campaigns use voice-broadcast.lua
instead, which has its own playback/DTMF flow rather than a bridge target.

Channel vars consumed (set by dialer at originate):
  amd_timeout_ms        How long to wait for avmd_detect (default 3500ms).
  amd_action            'hangup' | 'leave_voicemail' | 'transfer' | 'play_message'.
                        Applied only when classified MACHINE.
  amd_bridge_target     FreeSWITCH endpoint for HUMAN — typically 'user/<sipUsername>'.
                        Required.
  amd_transfer_target   PSTN destination when amd_action=transfer.
  amd_audio_url         R2/HTTPS URL when amd_action=play_message.
  amd_vm_url            R2/HTTPS URL when amd_action=leave_voicemail.

Channel vars set by this script (read by events.ts on hangup):
  amd_result            'human' | 'machine' | 'unknown'.
                        events.ts uses this to free the agent immediately
                        when machine, instead of running a wrap-up timer.
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

if not session:ready() then return end

session:answer()

local timeout      = vint('amd_timeout_ms', 3500)
local action       = v('amd_action', 'hangup')
local bridge_to    = v('amd_bridge_target')
local xfer_target  = v('amd_transfer_target')
local audio_url    = url_to_play(v('amd_audio_url'))
local vm_url       = url_to_play(v('amd_vm_url'))

if not bridge_to or bridge_to == '' then
  freeswitch.consoleLog('ERR', '[amd-screen] missing amd_bridge_target — cannot bridge HUMAN calls\n')
  session:setVariable('amd_result', 'unknown')
  session:hangup('SERVICE_UNAVAILABLE')
  return
end

-- Classification phase.
session:execute('avmd_start', '')
local waited = 0
local step = 100
local detect = nil
while waited < timeout do
  if not session:ready() then
    session:setVariable('amd_result', 'unknown')
    return
  end
  detect = session:getVariable('avmd_detect')
  if detect == 'TRUE' or detect == 'FALSE' then break end
  session:sleep(step)
  waited = waited + step
end
local is_machine = (detect == 'TRUE')

if not is_machine then
  -- HUMAN or NOTSURE — bridge to the agent. Treating NOTSURE as human is the
  -- safer default; misrouting a real customer to the AMD action (hangup or
  -- voicemail-drop) is the worse failure mode for a live-agent campaign.
  session:execute('avmd_stop', '')
  session:setVariable('amd_result', 'human')
  session:execute('bridge', bridge_to)
  return
end

-- MACHINE branch.
session:execute('avmd_stop', '')
session:setVariable('amd_result', 'machine')

if action == 'hangup' then
  session:hangup('MACHINE_DETECTED')
  return
end

if action == 'transfer' then
  if not xfer_target or xfer_target == '' then
    session:hangup('MACHINE_DETECTED')
    return
  end
  session:execute('bridge', 'sofia/gateway/${default_outbound_gateway}/' .. xfer_target)
  return
end

if action == 'play_message' then
  if audio_url then session:streamFile(audio_url) end
  session:hangup('MACHINE_DETECTED')
  return
end

if action == 'leave_voicemail' then
  if not vm_url then
    session:hangup('MACHINE_DETECTED')
    return
  end
  -- Re-arm avmd to listen for the actual voicemail beep before dropping our
  -- message. Cap the wait at 30s — most outgoing greetings finish well before.
  session:execute('avmd_start', '')
  local w = 0
  local s = 250
  while w < 30000 do
    if not session:ready() then return end
    if session:getVariable('avmd_beep_status') == 'DETECTED' then break end
    session:sleep(s)
    w = w + s
  end
  session:execute('avmd_stop', '')
  if not session:ready() then return end
  session:streamFile(vm_url)
  session:hangup('NORMAL_CLEARING')
  return
end

-- Unknown action — fail safe by hanging up.
session:hangup('MACHINE_DETECTED')
