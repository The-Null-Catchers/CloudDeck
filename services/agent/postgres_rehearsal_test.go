package main

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Opt-in integration test. The fixed loopback database/role must be provisioned
// by the operator in a disposable cluster; it never accepts a remote hostname.
func TestDisposablePostgresEncryptedRecovery(t *testing.T) {
	if os.Getenv("CLOUDDECK_PG_REHEARSAL") != "1" {
		t.Skip("requires explicit disposable PostgreSQL rehearsal")
	}
	port, err := strconv.Atoi(os.Getenv("CLOUDDECK_PG_REHEARSAL_PORT"))
	if err != nil || port < 1024 || port > 65535 {
		t.Fatal("set a nonprivileged disposable PostgreSQL port")
	}
	password := os.Getenv("CLOUDDECK_PG_REHEARSAL_PASSWORD")
	config := &databaseBackupConfig{Host: "127.0.0.1", Port: port, Username: "clouddeck_recovery", Password: password, SSLMode: "disable"}
	if err := validateDatabaseBackupConfig("postgres", "clouddeck_recovery", config); err != nil {
		t.Fatal("invalid disposable PostgreSQL configuration")
	}
	dir := t.TempDir()
	credentials := filepath.Join(dir, ".pgpass")
	if err := writeCredentialFile(credentials, "127.0.0.1:"+strconv.Itoa(port)+":clouddeck_recovery:clouddeck_recovery:"+pgpassEscape(password)+"\n"); err != nil {
		t.Fatal(err)
	}
	query := func(sql string) string {
		t.Helper()
		cmd := exec.Command("/usr/bin/psql", "-X", "-h", "127.0.0.1", "-p", strconv.Itoa(port), "-U", "clouddeck_recovery", "-d", "clouddeck_recovery", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql)
		cmd.Env = commandEnvironment("PGPASSFILE="+credentials, "PGSSLMODE=disable")
		output, err := cmd.Output()
		if err != nil {
			t.Fatal("disposable database query failed")
		}
		return strings.TrimSpace(string(output))
	}
	query("DROP TABLE IF EXISTS recovery_fixture; CREATE TABLE recovery_fixture(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO recovery_fixture SELECT i,'synthetic-'||i FROM generate_series(1,100) i;")
	want := query("SELECT count(*)||':'||md5(string_agg(id||':'||value,',' ORDER BY id)) FROM recovery_fixture")
	backups := t.TempDir()
	t.Setenv("CLOUDDECK_BACKUP_DIR", backups)
	key := base64.StdEncoding.EncodeToString(testEncryptionKey())
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", key)
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "1")
	const id = "60606060-6060-4060-8060-606060606060"
	start := time.Now()
	backup, err := executeBackup(context.Background(), backupExecutePayload{BackupID: id, Kind: "postgres", Source: "clouddeck_recovery", TargetType: "local", Database: config})
	if err != nil {
		t.Fatal(err)
	}
	backupDuration := time.Since(start)
	query("UPDATE recovery_fixture SET value='current';")
	current := query("SELECT count(*)||':'||md5(string_agg(id||':'||value,',' ORDER BY id)) FROM recovery_fixture")
	restore := databaseRestorePayload{BackupID: id, Kind: "postgres", DatabaseName: "clouddeck_recovery", TargetType: "local", StorageKey: backup.StorageKey, ExpectedSHA256: backup.SHA256, Database: config}
	bad := *config
	bad.Password = "synthetic-wrong-password"
	restore.Database = &bad
	if err := restoreDatabase(context.Background(), restore); err == nil {
		t.Fatal("wrong database credentials accepted")
	}
	if got := query("SELECT count(*)||':'||md5(string_agg(id||':'||value,',' ORDER BY id)) FROM recovery_fixture"); got != current {
		t.Fatal("failed restore changed database")
	}
	restore.Database = config
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := restoreDatabase(cancelled, restore); err == nil {
		t.Fatal("cancelled restore accepted")
	}
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "2")
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("N", 32))))
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V1", key)
	start = time.Now()
	if err := restoreDatabase(context.Background(), restore); err != nil {
		t.Fatal(err)
	}
	restoreDuration := time.Since(start)
	got := query("SELECT count(*)||':'||md5(string_agg(id||':'||value,',' ORDER BY id)) FROM recovery_fixture")
	if got != want {
		t.Fatalf("restored data differs: %s != %s", got, want)
	}
	entries, err := os.ReadDir(backups)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != backup.StorageKey {
		t.Fatal("plaintext or credential staging remains")
	}
	t.Logf("backup=%s restore=%s rows_and_content_hash=%s archive_bytes=%d plaintext_sha256=%s cipher_sha256=%s objects=1 historical_key_version=1", backupDuration, restoreDuration, got, backup.SizeBytes, backup.SHA256, backup.Encryption.CipherSHA256)
}
