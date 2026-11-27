package main

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// No root access or real pairing: every mutating installer dependency is a stub.
func TestInstallerValidatesBeforePairingAndKeepsSecretsOutOfArgv(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(testEncryptionKey())
	cases := []struct{ name, key, version, missing, want string }{
		{name: "valid default", key: key, want: "PAIR_STUB"},
		{name: "valid upper bound", key: key, version: "4294967295", want: "PAIR_STUB"},
		{name: "bad alphabet", key: "secret!", want: "encoding"},
		{name: "bad padding", key: key + "=", want: "encoding"},
		{name: "short key", key: base64.StdEncoding.EncodeToString(make([]byte, 31)), want: "32 bytes"},
		{name: "long key", key: base64.StdEncoding.EncodeToString(make([]byte, 33)), want: "32 bytes"},
		{name: "zero version", key: key, version: "0", want: "version"},
		{name: "negative version", key: key, version: "-1", want: "version"},
		{name: "fractional version", key: key, version: "1.5", want: "version"},
		{name: "overflow version", key: key, version: "4294967296", want: "version"},
		{name: "huge version", key: key, version: strings.Repeat("9", 100), want: "version"},
		{name: "missing key", missing: "CLOUDDECK_BACKUP_ENCRYPTION_KEY", want: "Set CLOUDDECK_BACKUP_ENCRYPTION_KEY"},
		{name: "missing URL", key: key, missing: "CLOUDDECK_API_URL", want: "Set CLOUDDECK_API_URL"},
		{name: "missing server", key: key, missing: "CLOUDDECK_SERVER_ID", want: "Set CLOUDDECK_SERVER_ID"},
		{name: "missing token", key: key, missing: "CLOUDDECK_PAIRING_TOKEN", want: "Set CLOUDDECK_PAIRING_TOKEN"},
		{name: "missing binary", key: key, missing: "CLOUDDECK_AGENT_BIN", want: "Set CLOUDDECK_AGENT_BIN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			marker := filepath.Join(dir, "paired")
			scripts := map[string]string{
				"id":      "#!/bin/sh\nif [ \"$1\" = -u ]; then echo 0; fi\n",
				"install": "#!/bin/sh\nexit 0\n",
				"runuser": `#!/bin/sh
for arg do
 case "$arg" in *"$CLOUDDECK_PAIRING_TOKEN"*|*"$CLOUDDECK_BACKUP_ENCRYPTION_KEY"*) echo SECRET_IN_ARGV; exit 98;; esac
done
[ "$CLOUDDECK_PAIRING_TOKEN" = 'test-only-pair-token' ] || exit 99
[ "$CLOUDDECK_CREDENTIAL_FILE" = /var/lib/clouddeck-agent/credential.json ] || exit 99
printf paired > "$PAIR_MARKER"
echo PAIR_STUB
exit 97
`,
			}
			for name, script := range scripts {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			env := map[string]string{
				"PATH": dir + ":" + os.Getenv("PATH"), "PAIR_MARKER": marker,
				"CLOUDDECK_API_URL": "https://example.invalid", "CLOUDDECK_SERVER_ID": "11111111-1111-4111-8111-111111111111",
				"CLOUDDECK_PAIRING_TOKEN": "test-only-pair-token", "CLOUDDECK_AGENT_BIN": filepath.Join(dir, "id"),
				"CLOUDDECK_BACKUP_ENCRYPTION_KEY": tc.key, "CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION": tc.version,
			}
			delete(env, tc.missing)
			cmd := exec.Command("sh", "install.sh")
			for name, value := range env {
				cmd.Env = append(cmd.Env, name+"="+value)
			}
			output, err := cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(output), tc.want) {
				t.Fatalf("unexpected result: %v %s", err, output)
			}
			if strings.Contains(string(output), "SECRET_IN_ARGV") || strings.Contains(string(output), "test-only-pair-token") || strings.Contains(string(output), key) {
				t.Fatal("secret exposed")
			}
			_, statErr := os.Stat(marker)
			if (tc.want == "PAIR_STUB") != (statErr == nil) {
				t.Fatalf("unexpected pairing attempt: %v", statErr)
			}
		})
	}
}
