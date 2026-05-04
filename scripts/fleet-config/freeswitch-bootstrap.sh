#!/bin/bash
# FreeSWITCH role bootstrap — applies the canonical TreePBX config to a fleet
# fs node. Idempotent: safe to re-run after image rebuild, drift detection,
# or ad-hoc manual changes. Run from ctl02 over SSH.
#
# Usage:  freeswitch-bootstrap.sh <fs-node-public-ip>
#
# Env (consumed via /opt/tpbx/.env or shell):
#   FREESWITCH_ESL_PASSWORD  ESL pw shared between control plane and fleet
#   SSH_PRIVATE_KEY_PATH     ssh key with root@<fs-node> trust
#
# What it does:
#   1. Mark the safarov fs container's external profile auth-calls=false
#   2. Apply ACL "sip-proxy-allow" with current sip_proxy + FIP CIDRs
#   3. Drop a permissive test-inbound dialplan into public/ (matches anything,
#      answers, plays welcome, then echo() — proves the path end-to-end)
#   4. fs_cli reloadacl + sofia profile external restart
#
# Re-running is safe because every change is `cat >` (overwrite) or
# idempotent ESL command.

set -euo pipefail

FS_IP="${1:-}"
[ -z "$FS_IP" ] && { echo "usage: $0 <fs-node-ip>"; exit 1; }

# Source ctl02 .env so we get the rotated ESL password
[ -f /opt/tpbx/.env ] && set -a && . /opt/tpbx/.env && set +a
ESL_PW="${FREESWITCH_ESL_PASSWORD:-ClueCon}"
SSH_KEY="${SSH_PRIVATE_KEY_PATH:-/opt/tpbx/secrets/ssh_key}"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=5"

# sip_proxy IPs that may dispatch into FS. We include BOTH the FIP (the
# advertised SIP endpoint, stored as public_ip in media_nodes) AND the
# underlying server's primary IPv4 — kamailio listens on 0.0.0.0 and the
# kernel picks src by route, so replies/forwards from kamailio appear with
# the server's primary IP, not the FIP. FS ACL must match either to accept
# dispatches.
mapfile -t SIP_PROXY_FIPS < <(psql "$DATABASE_URL" -At -c \
  "SELECT public_ip FROM media_nodes WHERE service_type='sip_proxy' AND state IN ('active','provisioning') ORDER BY hetzner_id;" 2>/dev/null || true)
mapfile -t SIP_PROXY_HETZNER_IDS < <(psql "$DATABASE_URL" -At -c \
  "SELECT hetzner_id FROM media_nodes WHERE service_type='sip_proxy' AND state IN ('active','provisioning') ORDER BY hetzner_id;" 2>/dev/null || true)
SIP_PROXY_IPS=("${SIP_PROXY_FIPS[@]}")
if [ -n "${HETZNER_API_TOKEN:-}" ] && [ "${#SIP_PROXY_HETZNER_IDS[@]}" -gt 0 ]; then
  for id in "${SIP_PROXY_HETZNER_IDS[@]}"; do
    pip=$(curl -s -H "Authorization: Bearer $HETZNER_API_TOKEN" \
      "https://api.hetzner.cloud/v1/servers/$id" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['server']['public_net']['ipv4']['ip'])" 2>/dev/null || true)
    [ -n "$pip" ] && SIP_PROXY_IPS+=("$pip")
  done
fi
[ "${#SIP_PROXY_IPS[@]}" -eq 0 ] && {
  echo "[fs-bootstrap] WARN: no sip_proxy IPs resolved, ACL will be empty (default-deny)"
}

# Snapshot config hashes before any in-container edits. We use these later to
# skip `sofia profile {external,internal} restart` when nothing actually
# changed. A profile restart drops every active SIP-WS connection (softphones
# observe a 1006 close), so re-runs of this script — /rebootstrap fan-out,
# bootstrap retries on transient SSH/docker races, idempotent re-applies —
# would otherwise disconnect every agent for no gain.
HASH_BEFORE=$(ssh $SSH_OPTS root@"$FS_IP" "docker exec fs sh -c 'sha256sum /etc/freeswitch/sip_profiles/external.xml /etc/freeswitch/sip_profiles/internal.xml /etc/freeswitch/vars.xml 2>/dev/null'" || echo "")

# 1+2. external profile config — auth-calls off + ACL bound
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs sh -c '
  CFG=/etc/freeswitch/sip_profiles/external.xml
  # Disable digest auth on external profile (ACL handles trust by source IP)
  sed -i \"s|<param name=\\\"auth-calls\\\" value=\\\"true\\\"/>|<param name=\\\"auth-calls\\\" value=\\\"false\\\"/>|\" \$CFG
  # Bind apply-inbound-acl line idempotently
  grep -q \"apply-inbound-acl.*sip-proxy-allow\" \$CFG || \
    sed -i \"/<param name=\\\"auth-calls\\\" value=/a \\\\    <param name=\\\"apply-inbound-acl\\\" value=\\\"sip-proxy-allow\\\"/>\" \$CFG
'"

# 3a. Build acl.conf.xml — sip-proxy-allow (for inbound from kamailio) and
# esl-allow (for ctl02 backend → mod_event_socket on this node). The ESL
# socket binds dual-stack and reports peer IPs as ::ffff:x.x.x.x, so esl-allow
# must list both v4 + v4-mapped-v6 to actually match.
ACL_TMP="$(mktemp /tmp/acl.XXXXXX.xml)"
ESL_PEER="${ESL_PEER_IP:-5.161.127.127}"
{
  echo '<configuration name="acl.conf" description="Network Lists">'
  echo '  <network-lists>'
  echo '    <list name="sip-proxy-allow" default="deny">'
  for ip in "${SIP_PROXY_IPS[@]}"; do
    echo "      <node type=\"allow\" cidr=\"$ip/32\"/>"
  done
  echo '    </list>'
  echo '    <list name="esl-allow" default="deny">'
  echo '      <node type="allow" cidr="127.0.0.0/8"/>'
  echo "      <node type=\"allow\" cidr=\"${ESL_PEER}/32\"/>"
  echo '      <node type="allow" cidr="::ffff:127.0.0.0/104"/>'
  echo "      <node type=\"allow\" cidr=\"::ffff:${ESL_PEER}/128\"/>"
  echo '    </list>'
  echo '  </network-lists>'
  echo '</configuration>'
} > "$ACL_TMP"
scp $SSH_OPTS "$ACL_TMP" root@"$FS_IP":/tmp/acl.conf.xml >/dev/null
ssh $SSH_OPTS root@"$FS_IP" 'docker cp /tmp/acl.conf.xml fs:/etc/freeswitch/autoload_configs/acl.conf.xml'
rm -f "$ACL_TMP"

# 3a-bis. event_socket.conf.xml — bind 8021 + apply esl-allow ACL. FS image
# default is loopback-only ESL, which blocks ctl02. Always rewrite cleanly so
# we don't accumulate sed comment-fragments on re-bootstrap.
ESL_PW_LOCAL="${FREESWITCH_ESL_PASSWORD:-ClueCon}"
ES_TMP="$(mktemp /tmp/esock.XXXXXX.xml)"
cat > "$ES_TMP" <<EOF
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="nat-map" value="false"/>
    <param name="listen-ip" value="0.0.0.0"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="${ESL_PW_LOCAL}"/>
    <param name="apply-inbound-acl" value="esl-allow"/>
  </settings>
</configuration>
EOF
scp $SSH_OPTS "$ES_TMP" root@"$FS_IP":/tmp/event_socket.conf.xml >/dev/null
ssh $SSH_OPTS root@"$FS_IP" 'docker cp /tmp/event_socket.conf.xml fs:/etc/freeswitch/autoload_configs/event_socket.conf.xml'
rm -f "$ES_TMP"

# 3b. Public dialplan — default-deny with a single smoke-test extension.
#  - 9999  → answer + dial-tone + echo (smoke test, used by ops/CI)
#  - else  → 503 UNALLOCATED_NUMBER
# Replace the catch-all stub below with real DID → tenant routing logic.
DP_TMP="$(mktemp /tmp/dialplan.XXXXXX.xml)"
cat > "$DP_TMP" <<'XML'
<include>
  <extension name="treepbx-smoke-9999">
    <condition field="destination_number" expression="^9999$">
      <action application="answer"/>
      <action application="sleep" data="500"/>
      <action application="playback" data="tone_stream://%(2000,500,350,440);loops=2"/>
      <action application="echo"/>
      <action application="hangup"/>
    </condition>
  </extension>

  <!-- TODO: real DID router goes here. e.g. lookup destination_number in
       tenant DIDs table, set ${tenant_route}, then bridge() to the right
       sofia gateway / extension / IVR. Until that's wired, anything not
       9999 falls through to the catch-all below and is rejected cleanly. -->

  <extension name="treepbx-unrouted-default">
    <condition field="destination_number" expression="^.+$">
      <action application="log" data="WARNING [unrouted] DID=${destination_number} from=${network_addr}"/>
      <action application="hangup" data="UNALLOCATED_NUMBER"/>
    </condition>
  </extension>
</include>
XML
scp $SSH_OPTS "$DP_TMP" root@"$FS_IP":/tmp/00_test-inbound.xml >/dev/null
ssh $SSH_OPTS root@"$FS_IP" 'docker cp /tmp/00_test-inbound.xml fs:/etc/freeswitch/dialplan/public/00_test-inbound.xml'
rm -f "$DP_TMP"

# 3c. Outbound dialplan for registered softphone users (default context).
# Any 4+ digit destination → bridge to ${default_outbound_gateway} (set in
# vars.xml, currently sim-pstn). Codec pinned to G.711 because most carriers
# reject L16/opus over UDP SIP.
OUT_TMP="$(mktemp /tmp/outbound.XXXXXX.xml)"
cat > "$OUT_TMP" <<'XML'
<include>
  <extension name="treepbx-outbound" continue="false">
    <condition field="destination_number" expression="^(\+?\d{4,})$">
      <action application="set" data="hangup_after_bridge=true"/>
      <action application="bridge" data="[absolute_codec_string=PCMU,PCMA]sofia/gateway/${default_outbound_gateway}/$1"/>
    </condition>
  </extension>
</include>
XML
scp $SSH_OPTS "$OUT_TMP" root@"$FS_IP":/tmp/01_outbound.xml >/dev/null
ssh $SSH_OPTS root@"$FS_IP" 'docker cp /tmp/01_outbound.xml fs:/etc/freeswitch/dialplan/default/01_outbound.xml'
rm -f "$OUT_TMP"

# 3d. SIP-over-WebSocket setup. The internal profile already binds ws:5066
# / wss:7443 by default; we just need:
#   - SIP realm/domain = canonical hostname (so MD5 auth realm matches)
#   - default_password = the shared softphone password the FE sends
#   - default_outbound_gateway = first active outbound carrier (sim-pstn for now)
#   - internal profile context = default (so registered users → default dialplan,
#     not the public/test-DID context)
SIP_REALM="${SIP_REALM:-app.treepbx.com}"
SOFTPHONE_PW="${SOFTPHONE_PASSWORD:-Tr33PBX!s3cur3#2026xK9m}"
DEFAULT_GW="${DEFAULT_OUTBOUND_GATEWAY:-sim-pstn}"
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs sh -c '
  sed -i \"s|domain=\\\$\\\${local_ip_v4}|domain=$SIP_REALM|\" /etc/freeswitch/vars.xml || true
  sed -i \"s|^.*data=\\\"default_password=.*|  <X-PRE-PROCESS cmd=\\\"set\\\" data=\\\"default_password=$SOFTPHONE_PW\\\"/>|\" /etc/freeswitch/vars.xml
  grep -q default_outbound_gateway /etc/freeswitch/vars.xml || \
    sed -i \"/default_password=/a \\  <X-PRE-PROCESS cmd=\\\"set\\\" data=\\\"default_outbound_gateway=$DEFAULT_GW\\\"/>\" /etc/freeswitch/vars.xml
  sed -i \"s|<param name=\\\"context\\\" value=\\\"public\\\"/>|<param name=\\\"context\\\" value=\\\"default\\\"/>|\" /etc/freeswitch/sip_profiles/internal.xml
  # The default \"domains\" inbound ACL gates registrations by source-IP CIDRs
  # declared on directory entries — but our directory has none, so REGISTERs
  # from the Caddy proxy (ctl02) get 403\xe2\x80\x99d at L3 before digest auth runs. Disable
  # source-IP gating; digest auth + directory password remains the trust gate.
  sed -i \"s|<param name=\\\"apply-inbound-acl\\\" value=\\\"domains\\\"/>|<!-- apply-inbound-acl removed: digest auth + directory password gate registration -->|\" /etc/freeswitch/sip_profiles/internal.xml
'"

# 4. UFW: allow 5060 + 5080 from each sip_proxy IP (FIP and primary). RTP
# range stays open since RTP arrives from arbitrary peer IPs and the trust
# decision lives at the SIP layer (only ACL'd peers ever negotiated SDP).
ssh $SSH_OPTS root@"$FS_IP" "
  ufw --force enable >/dev/null 2>&1 || true
  for ip in ${SIP_PROXY_IPS[@]}; do
    ufw allow from \$ip to any port 5060 >/dev/null 2>&1 || true
    ufw allow from \$ip to any port 5080 >/dev/null 2>&1 || true
  done
  # SIP-WS for softphones — only ctl02 reaches it (Caddy reverse-proxies).
  ufw allow from 5.161.127.127 to any port 5066 proto tcp >/dev/null 2>&1 || true
  # RTP — keep open from anywhere; SDP gate happens via ACL at signaling.
  ufw allow 16384:32768/udp >/dev/null 2>&1 || true
"

# 5. Reload — reloadacl + reloadxml are cheap and don't disconnect anything,
#    so always run them. Profile restarts are gated by hash diff so a no-op
#    re-bootstrap doesn't sever live softphone WS connections.
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'reloadacl' >/dev/null"
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'reloadxml'  >/dev/null"

HASH_AFTER=$(ssh $SSH_OPTS root@"$FS_IP" "docker exec fs sh -c 'sha256sum /etc/freeswitch/sip_profiles/external.xml /etc/freeswitch/sip_profiles/internal.xml /etc/freeswitch/vars.xml 2>/dev/null'" || echo "")

ext_before=$(printf '%s\n' "$HASH_BEFORE" | awk '/external\.xml$/{print $1}')
ext_after=$(printf  '%s\n' "$HASH_AFTER"  | awk '/external\.xml$/{print $1}')
int_before=$(printf '%s\n' "$HASH_BEFORE" | awk '/internal\.xml$/{print $1}')
int_after=$(printf  '%s\n' "$HASH_AFTER"  | awk '/internal\.xml$/{print $1}')
vars_before=$(printf '%s\n' "$HASH_BEFORE" | awk '/vars\.xml$/{print $1}')
vars_after=$(printf  '%s\n' "$HASH_AFTER"  | awk '/vars\.xml$/{print $1}')

if [ "$ext_before" != "$ext_after" ]; then
  ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'sofia profile external restart' >/dev/null"
  echo "[fs-bootstrap] external profile restarted (config changed)"
else
  echo "[fs-bootstrap] external profile unchanged — skipping restart"
fi

# vars.xml is shared, but the softphone-relevant settings inside it (realm,
# default_password, default_outbound_gateway) flow through the internal
# profile, so a vars.xml change still requires an internal restart.
if [ "$int_before" != "$int_after" ] || [ "$vars_before" != "$vars_after" ]; then
  ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'sofia profile internal restart' >/dev/null"
  echo "[fs-bootstrap] internal profile restarted (config changed) — softphones will reconnect"
else
  echo "[fs-bootstrap] internal profile unchanged — skipping restart, softphones stay connected"
fi

echo "[fs-bootstrap] $FS_IP — external profile + ACL + dialplan applied"
