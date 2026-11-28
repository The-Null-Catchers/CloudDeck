package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestS3RejectsRedirectsAndMismatchedKeyVersionWithoutStagingLeaks(t *testing.T) {
	for _, mode := range []string{"redirect", "version", "interrupted"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "data")
			staging := t.TempDir()
			if err := os.Mkdir(source, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(source, "value"), []byte("synthetic data"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS", root)
			t.Setenv("CLOUDDECK_BACKUP_DIR", staging)
			t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(testEncryptionKey()))
			t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "1")
			var forwarded atomic.Int32
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1); w.WriteHeader(200) }))
			defer sink.Close()
			var size int
			var headers http.Header
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "redirect" {
					http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
					return
				}
				if r.Method == http.MethodPut {
					if mode == "interrupted" {
						conn, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						_ = conn.Close()
						return
					}
					body, _ := io.ReadAll(r.Body)
					size = len(body)
					headers = r.Header.Clone()
					w.WriteHeader(200)
					return
				}
				w.Header().Set("Content-Length", fmt.Sprint(size))
				for _, key := range []string{"x-amz-meta-clouddeck-sha256", "x-amz-meta-clouddeck-encryption", "x-amz-meta-clouddeck-cipher-sha256"} {
					w.Header().Set(key, headers.Get(key))
				}
				w.Header().Set("x-amz-meta-clouddeck-key-version", "2")
				w.WriteHeader(200)
			}))
			defer server.Close()
			_, err := executeBackup(context.Background(), backupExecutePayload{BackupID: "70707070-7070-4070-8070-707070707070", Kind: "directory", Source: source, TargetType: "s3", S3: &s3BackupConfig{Endpoint: server.URL, Region: "us-east-1", Bucket: "lab", AccessKey: "synthetic-access", SecretKey: "synthetic-secret"}})
			if err == nil {
				t.Fatal("unsafe upload reported success")
			}
			if forwarded.Load() != 0 {
				t.Fatal("signed request forwarded to redirect target")
			}
			entries, err := os.ReadDir(staging)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatal("failed S3 upload left staging files")
			}
		})
	}
}
