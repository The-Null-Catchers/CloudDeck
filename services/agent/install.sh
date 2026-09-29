#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run the installer as root.' >&2
  exit 1
fi
: "${CLOUDDECK_API_URL:?Set CLOUDDECK_API_URL}"
: "${CLOUDDECK_SERVER_ID:?Set CLOUDDECK_SERVER_ID}"
: "${CLOUDDECK_PAIRING_TOKEN:?Set CLOUDDECK_PAIRING_TOKEN}"
: "${CLOUDDECK_AGENT_BIN:?Set CLOUDDECK_AGENT_BIN to a locally built binary}"

case "$CLOUDDECK_API_URL" in
  https://*) ;;
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo 'Use an HTTPS API URL outside localhost.' >&2; exit 1 ;;
esac
case "$CLOUDDECK_API_URL" in
  *[!a-zA-Z0-9.:/_-]* ) echo 'API URL contains unsupported characters.' >&2; exit 1 ;;
esac
case "$CLOUDDECK_SERVER_ID" in
  ????????-????-????-????-????????????) ;;
  *) echo 'Invalid server ID.' >&2; exit 1 ;;
esac
if [ ! -f "$CLOUDDECK_AGENT_BIN" ]; then
  echo 'Agent binary not found.' >&2
  exit 1
fi

if ! id clouddeck >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin clouddeck
fi
install -m 0755 "$CLOUDDECK_AGENT_BIN" /usr/local/bin/clouddeck-agent
install -d -o clouddeck -g clouddeck -m 0700 /var/lib/clouddeck-agent
install -d -o root -g root -m 0755 /etc/clouddeck-agent

# The short-lived pairing token exists only in this process environment.
runuser -u clouddeck -- env CLOUDDECK_API_URL="$CLOUDDECK_API_URL" CLOUDDECK_SERVER_ID="$CLOUDDECK_SERVER_ID" CLOUDDECK_PAIRING_TOKEN="$CLOUDDECK_PAIRING_TOKEN" CLOUDDECK_CREDENTIAL_FILE=/var/lib/clouddeck-agent/credential.json /usr/local/bin/clouddeck-agent --pair-only
unset CLOUDDECK_PAIRING_TOKEN

config_tmp=$(mktemp /etc/clouddeck-agent/agent.env.XXXXXX)
trap 'rm -f "$config_tmp"' EXIT HUP INT TERM
printf 'CLOUDDECK_API_URL=%s\nCLOUDDECK_SERVER_ID=%s\nCLOUDDECK_CREDENTIAL_FILE=/var/lib/clouddeck-agent/credential.json\n' "$CLOUDDECK_API_URL" "$CLOUDDECK_SERVER_ID" > "$config_tmp"
chmod 0600 "$config_tmp"
mv "$config_tmp" /etc/clouddeck-agent/agent.env
trap - EXIT HUP INT TERM

cat > /etc/systemd/system/clouddeck-agent.service <<'UNIT'
[Unit]
Description=CloudDeck outbound monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=clouddeck
Group=clouddeck
EnvironmentFile=/etc/clouddeck-agent/agent.env
ExecStart=/usr/local/bin/clouddeck-agent
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/clouddeck-agent
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now clouddeck-agent
printf 'CloudDeck agent paired and started. Check: systemctl status clouddeck-agent\n'
