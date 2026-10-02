CREATE TABLE server_metrics_hourly (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  bucket_at timestamptz NOT NULL,
  sample_count bigint NOT NULL CHECK(sample_count > 0),
  cpu_percent numeric(5,2) NOT NULL,
  memory_percent numeric(5,2) NOT NULL,
  disk_percent numeric(5,2) NOT NULL,
  load_1 numeric(10,2),
  network_rx_bytes bigint,
  network_tx_bytes bigint,
  PRIMARY KEY(server_id,bucket_at)
);

CREATE INDEX server_metrics_hourly_time_idx
  ON server_metrics_hourly(bucket_at DESC);
