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

# sip_proxy IPs that may dispatch into FS (server IPs + their floating IPs).
# Keep this list in sync if you add new sip_proxy nodes.
SIP_PROXY_IPS=(49.12.211.175 167.235.242.88 5.75.209.160 5.75.212.16)

# 1+2. external profile config — auth-calls off + ACL bound
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs sh -c '
  CFG=/etc/freeswitch/sip_profiles/external.xml
  # Disable digest auth on external profile (ACL handles trust by source IP)
  sed -i \"s|<param name=\\\"auth-calls\\\" value=\\\"true\\\"/>|<param name=\\\"auth-calls\\\" value=\\\"false\\\"/>|\" \$CFG
  # Bind apply-inbound-acl line idempotently
  grep -q \"apply-inbound-acl.*sip-proxy-allow\" \$CFG || \
    sed -i \"/<param name=\\\"auth-calls\\\" value=/a \\\\    <param name=\\\"apply-inbound-acl\\\" value=\\\"sip-proxy-allow\\\"/>\" \$CFG
'"

# 3a. Build acl.conf.xml from the SIP_PROXY_IPS list and copy in
ACL_TMP="$(mktemp /tmp/acl.XXXXXX.xml)"
{
  echo '<configuration name="acl.conf" description="Network Lists">'
  echo '  <network-lists>'
  echo '    <list name="sip-proxy-allow" default="deny">'
  for ip in "${SIP_PROXY_IPS[@]}"; do
    echo "      <node type=\"allow\" cidr=\"$ip/32\"/>"
  done
  echo '    </list>'
  echo '  </network-lists>'
  echo '</configuration>'
} > "$ACL_TMP"
scp $SSH_OPTS "$ACL_TMP" root@"$FS_IP":/tmp/acl.conf.xml >/dev/null
ssh $SSH_OPTS root@"$FS_IP" 'docker cp /tmp/acl.conf.xml fs:/etc/freeswitch/autoload_configs/acl.conf.xml'
rm -f "$ACL_TMP"

# 3b. test-inbound dialplan — accepts any destination_number, answers, plays
# the bundled IVR welcome prompt, then echoes. Sufficient to prove the inbound
# path works end-to-end. Replace with real routing logic later.
DP_TMP="$(mktemp /tmp/dialplan.XXXXXX.xml)"
cat > "$DP_TMP" <<'XML'
<include>
  <extension name="treepbx-test-inbound">
    <condition field="destination_number" expression="^.+$">
      <action application="answer"/>
      <action application="sleep" data="500"/>
      <action application="playback" data="ivr/ivr-welcome.wav"/>
      <action application="echo"/>
      <action application="hangup"/>
    </condition>
  </extension>
</include>
XML
scp $SSH_OPTS "$DP_TMP" root@"$FS_IP":/tmp/00_test-inbound.xml >/dev/null
ssh $SSH_OPTS root@"$FS_IP" 'docker cp /tmp/00_test-inbound.xml fs:/etc/freeswitch/dialplan/public/00_test-inbound.xml'
rm -f "$DP_TMP"

# 4. Reload — reloadacl applies the new ACL; restart external profile picks up auth-calls=false.
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'reloadacl' >/dev/null"
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'reloadxml'  >/dev/null"
ssh $SSH_OPTS root@"$FS_IP" "docker exec fs fs_cli -p $ESL_PW -x 'sofia profile external restart' >/dev/null"

echo "[fs-bootstrap] $FS_IP — external profile + ACL + dialplan applied"
