package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirectoryRestoreReplacesContentsFromVerifiedBackup(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "app-data")
	if err := os.MkdirAll(filepath.Join(source, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "value.txt"), []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	backupDir := t.TempDir()
	t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS", root)
	t.Setenv("CLOUDDECK_BACKUP_DIR", backupDir)
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(testEncryptionKey()))

	backup, err := executeBackup(context.Background(), backupExecutePayload{
		BackupID: "10101010-1010-4010-8010-101010101010",
		Kind:     "directory", Source: source, TargetType: "local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if backup.Encryption == nil || backup.Encryption.Algorithm != backupEncryptionAlgorithm || backup.Encryption.KeyVersion != 1 {
		t.Fatalf("missing local backup encryption metadata: %+v", backup.Encryption)
	}
	archive, err := localBackupArchivePath(backup.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	cipherSHA, err := backupFileSHA256(archive)
	if err != nil {
		t.Fatal(err)
	}
	if cipherSHA != backup.Encryption.CipherSHA256 {
		t.Fatal("local encrypted archive checksum does not match manifest")
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "value.txt"), []byte("after"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "extra.txt"), []byte("remove-me"), 0600); err != nil {
		t.Fatal(err)
	}

	err = restoreFilesystem(context.Background(), filesystemRestorePayload{
		BackupID: "10101010-1010-4010-8010-101010101010",
		Kind:     "directory", Source: source, TargetType: "local",
		StorageKey: backup.StorageKey, ExpectedSHA256: backup.SHA256,
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(source, "nested", "value.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "before" {
		t.Fatalf("restored value = %q, want before", data)
	}
	if _, err := os.Stat(filepath.Join(source, "extra.txt")); !os.IsNotExist(err) {
		t.Fatalf("extra file survived restore: %v", err)
	}
}

func TestDirectoryRestoreChecksumFailureDoesNotMutateTarget(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "value.txt"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	backupDir := t.TempDir()
	t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS", root)
	t.Setenv("CLOUDDECK_BACKUP_DIR", backupDir)
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(testEncryptionKey()))
	backup, err := executeBackup(context.Background(), backupExecutePayload{
		BackupID: "20202020-2020-4020-8020-202020202020", Kind: "directory", Source: source, TargetType: "local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "value.txt"), []byte("current"), 0600); err != nil {
		t.Fatal(err)
	}

	err = restoreFilesystem(context.Background(), filesystemRestorePayload{
		BackupID: "20202020-2020-4020-8020-202020202020", Kind: "directory", Source: source, TargetType: "local",
		StorageKey: backup.StorageKey, ExpectedSHA256: strings.Repeat("0", 64),
	})
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("expected checksum failure, got %v", err)
	}
	data, readErr := os.ReadFile(filepath.Join(source, "value.txt"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "current" {
		t.Fatalf("target mutated on failed verification: %q", data)
	}
}

func TestDockerVolumeRestoreRequiresUnusedVolume(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("all") != "1" || r.URL.Query().Has("limit") {
			t.Error("volume inventory must include all containers without a list limit")
			http.Error(w, "incomplete inventory", http.StatusBadRequest)
			return
		}
		var filters map[string][]string
		if err := json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filters); err != nil || len(filters["volume"]) != 1 || filters["volume"][0] != "app-data" {
			t.Error("volume inventory must filter by the exact volume")
			http.Error(w, "missing volume filter", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"Mounts":[{"Type":"volume","Name":"app-data"}]}]`))
	})
	server := &http.Server{Handler: mux}
	go server.Serve(listener)
	defer server.Close()
	t.Setenv("CLOUDDECK_DOCKER_SOCKET", socket)
	inUse, err := dockerVolumeInUse("app-data")
	if err != nil {
		t.Fatal(err)
	}
	if !inUse {
		t.Fatal("expected Docker volume to be detected as in use")
	}
}

func TestReplaceDirectoryRollsBackWhenActivationFails(t *testing.T) {
	parent := t.TempDir()
	target := filepath.Join(parent, "data")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "value"), []byte("current"), 0600); err != nil {
		t.Fatal(err)
	}
	missingStage := filepath.Join(parent, "missing-stage")
	err := replaceDirectoryWithRollback(target, missingStage, "30303030-3030-4030-8030-303030303030")
	if err == nil {
		t.Fatal("expected activation failure")
	}
	data, readErr := os.ReadFile(filepath.Join(target, "value"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "current" {
		t.Fatalf("rollback did not restore original target: %q", data)
	}
}

func TestEncryptedDirectoryRecoveryAfterKeyRotation(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "data")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	value := filepath.Join(source, "value.txt")
	unrelated := filepath.Join(root, "unrelated.txt")
	if err := os.WriteFile(value, []byte("original"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unrelated, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS", root)
	t.Setenv("CLOUDDECK_BACKUP_DIR", t.TempDir())
	oldKey := base64.StdEncoding.EncodeToString(testEncryptionKey())
	newKey := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("N", 32)))
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "7")
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", oldKey)
	id := "40404040-4040-4040-8040-404040404040"
	backup, err := executeBackup(context.Background(), backupExecutePayload{BackupID: id, Kind: "directory", Source: source, TargetType: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if backup.Encryption == nil || backup.Encryption.KeyVersion != 7 || !backup.Verified {
		t.Fatal("missing verified versioned manifest")
	}
	path, err := localBackupArchivePath(backup.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	originalCipher, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cipherSHA, err := backupFileSHA256(path)
	if err != nil || cipherSHA != backup.Encryption.CipherSHA256 {
		t.Fatalf("cipher checksum mismatch: %v", err)
	}
	if err := os.WriteFile(value, []byte("current"), 0640); err != nil {
		t.Fatal(err)
	}
	restore := func() error {
		return restoreFilesystem(context.Background(), filesystemRestorePayload{BackupID: id, Kind: "directory", Source: source, TargetType: "local", StorageKey: backup.StorageKey, ExpectedSHA256: backup.SHA256})
	}
	assertValue := func(want string) {
		t.Helper()
		got, err := os.ReadFile(value)
		if err != nil || string(got) != want {
			t.Fatalf("target = %q, error = %v, want %q", got, err, want)
		}
	}
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "8")
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", newKey)
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V7", "")
	if err := restore(); err == nil {
		t.Fatal("restore accepted missing historical key")
	}
	assertValue("current")
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V7", newKey)
	if err := restore(); err == nil {
		t.Fatal("restore accepted wrong historical key")
	}
	assertValue("current")
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V7", oldKey)
	corrupt := append([]byte(nil), originalCipher...)
	corrupt[len(corrupt)-1] ^= 1
	if err := os.WriteFile(path, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	if err := restore(); err == nil {
		t.Fatal("restore accepted corrupted ciphertext")
	}
	assertValue("current")
	if err := os.WriteFile(path, originalCipher, 0600); err != nil {
		t.Fatal(err)
	}
	if err := restore(); err != nil {
		t.Fatal(err)
	}
	assertValue("original")
	info, err := os.Stat(value)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0640 {
		t.Fatalf("restored mode = %o, want 640", info.Mode().Perm())
	}
	got, err := os.ReadFile(unrelated)
	if err != nil || string(got) != "untouched" {
		t.Fatalf("unrelated data changed: %q, %v", got, err)
	}
}

func TestRestorePreservesRootAndReadOnlyDirectoryModes(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "data")
	nested := filepath.Join(source, "nested")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "value"), []byte("before"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(source, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(nested, 0550); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(nested, 0700) }()
	t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS", root)
	t.Setenv("CLOUDDECK_BACKUP_DIR", t.TempDir())
	t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(testEncryptionKey()))
	const id = "50505050-5050-4050-8050-505050505050"
	backup, err := executeBackup(context.Background(), backupExecutePayload{BackupID: id, Kind: "directory", Source: source, TargetType: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "value"), []byte("after"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := restoreFilesystem(context.Background(), filesystemRestorePayload{BackupID: id, Kind: "directory", Source: source, TargetType: "local", StorageKey: backup.StorageKey, ExpectedSHA256: backup.SHA256}); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{source: 0750, nested: 0550, filepath.Join(nested, "value"): 0640} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s mode = %o, want %o", path, info.Mode().Perm(), want)
		}
	}
	data, err := os.ReadFile(filepath.Join(nested, "value"))
	if err != nil || string(data) != "before" {
		t.Fatalf("restore contents: %q %v", data, err)
	}
}
