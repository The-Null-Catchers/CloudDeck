#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run the proxy-helper installer as root.' >&2
  exit 1
fi
: "${CLOUDDECK_PROXY_HELPER_BIN:?Set CLOUDDECK_PROXY_HELPER_BIN to a locally built helper binary}"

if [ ! -f "$CLOUDDECK_PROXY_HELPER_BIN" ]; then
  echo 'Proxy helper binary not found.' >&2
  exit 1
fi
if ! id clouddeck >/dev/null 2>&1; then
  echo 'Install and pair clouddeck-agent first so the clouddeck service account exists.' >&2
  exit 1
fi

install -m 0755 "$CLOUDDECK_PROXY_HELPER_BIN" /usr/local/bin/clouddeck-proxy-helper
install -d -o root -g root -m 0755 /etc/clouddeck-proxy-helper
install -d -o root -g root -m 0755 /etc/caddy/clouddeck.d
install -d -o root -g root -m 0755 /etc/nginx/conf.d

cat > /etc/systemd/system/clouddeck-proxy-helper.service <<'UNIT'
[Unit]
Description=CloudDeck constrained reverse-proxy helper
After=network.target

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/local/bin/clouddeck-proxy-helper
Restart=on-failure
RestartSec=3
RuntimeDirectory=clouddeck-proxy-helper
RuntimeDirectoryMode=0755
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX
ReadWritePaths=-/etc/caddy/clouddeck.d -/etc/nginx/conf.d /run/clouddeck-proxy-helper
UMask=0022

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now clouddeck-proxy-helper

printf '%s\n' 'CloudDeck proxy helper installed.'
printf '%s\n' 'For Caddy, add this line once to /etc/caddy/Caddyfile before applying CloudDeck domains:'
printf '%s\n' '  import /etc/caddy/clouddeck.d/*'
printf '%s\n' 'The helper refuses Caddy changes until that import is present.'
