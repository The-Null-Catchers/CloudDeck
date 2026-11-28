package main

import (
	"bytes"
	"encoding/base64"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// Microbenchmark only: 8 MiB deterministic incompressible payload, local temporary
// filesystem. Includes file sync and deletion; does not model a production disk/S3.
func BenchmarkBackupPayload(b *testing.B) {
	data := make([]byte, 8*1024*1024)
	_, _ = rand.New(rand.NewSource(1)).Read(data)
	key := bytes.Repeat([]byte{0x42}, 32)
	b.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "1")
	b.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(key))
	dir := b.TempDir()
	plain := filepath.Join(dir, "plain")
	if err := os.WriteFile(plain, data, 0600); err != nil {
		b.Fatal(err)
	}
	encrypted := filepath.Join(dir, "cipher")
	if err := encryptBackupPayload(plain, encrypted, key); err != nil {
		b.Fatal(err)
	}
	b.Run("encrypt", func(b *testing.B) {
		b.SetBytes(int64(len(data)))
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			output := filepath.Join(dir, "encrypted-output")
			if err := encryptBackupPayload(plain, output, key); err != nil {
				b.Fatal(err)
			}
			if err := os.Remove(output); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("decrypt", func(b *testing.B) {
		b.SetBytes(int64(len(data)))
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			output := filepath.Join(dir, "decrypted-output")
			if err := decryptBackupPayload(encrypted, output, key); err != nil {
				b.Fatal(err)
			}
			if err := os.Remove(output); err != nil {
				b.Fatal(err)
			}
		}
	})
}
