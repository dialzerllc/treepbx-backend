import { eslClient } from './client';

export function originate(destination: string, callerId: string, context = 'default', extension = 'park') {
  eslClient.bgapi(`originate {origination_caller_id_number=${callerId}}sofia/gateway/default/${destination} ${extension} XML ${context}`);
}

export function hangup(uuid: string, cause = 'NORMAL_CLEARING') {
  eslClient.api(`uuid_kill ${uuid} ${cause}`);
}

export function hold(uuid: string) {
  eslClient.api(`uuid_hold ${uuid}`);
}

export function unhold(uuid: string) {
  eslClient.api(`uuid_hold off ${uuid}`);
}

export function transfer(uuid: string, destination: string, context = 'default') {
  eslClient.api(`uuid_transfer ${uuid} ${destination} XML ${context}`);
}

export function bridge(uuid: string, targetUuid: string) {
  eslClient.api(`uuid_bridge ${uuid} ${targetUuid}`);
}

export function record(uuid: string, path: string) {
  eslClient.api(`uuid_record ${uuid} start ${path}`);
}

export function stopRecord(uuid: string) {
  eslClient.api(`uuid_record ${uuid} stop all`);
}

export function eavesdrop(uuid: string, targetUuid: string) {
  eslClient.api(`uuid_bridge ${uuid} ${targetUuid}`);
}

export function whisper(uuid: string, targetUuid: string) {
  eslClient.api(`uuid_broadcast ${targetUuid} eavesdrop::${uuid} aleg`);
}

export function mute(uuid: string) {
  eslClient.api(`uuid_audio ${uuid} start write mute`);
}

export function unmute(uuid: string) {
  eslClient.api(`uuid_audio ${uuid} stop`);
}
