CREATE TABLE push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('fcm')),
  platform text NOT NULL CHECK(platform IN ('android','ios')),
  token text NOT NULL CHECK(char_length(token) BETWEEN 20 AND 4096),
  device_name text CHECK(device_name IS NULL OR char_length(device_name)<=120),
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,token)
);

CREATE INDEX push_devices_user_active_idx
  ON push_devices(user_id,active,last_seen_at DESC);

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_channel_check,
  DROP CONSTRAINT notification_deliveries_notification_id_channel_key,
  ADD COLUMN push_device_id uuid REFERENCES push_devices(id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_deliveries_channel_check CHECK(channel IN ('email','push')),
  ADD CONSTRAINT notification_deliveries_target_check CHECK(
    (channel='email' AND push_device_id IS NULL) OR
    (channel='push' AND push_device_id IS NOT NULL)
  );

CREATE UNIQUE INDEX notification_deliveries_email_unique_idx
  ON notification_deliveries(notification_id)
  WHERE channel='email';

CREATE UNIQUE INDEX notification_deliveries_push_unique_idx
  ON notification_deliveries(notification_id,push_device_id)
  WHERE channel='push';
