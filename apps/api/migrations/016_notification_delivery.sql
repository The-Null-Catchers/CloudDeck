ALTER TABLE notifications
  ADD COLUMN body text CHECK(body IS NULL OR char_length(body)<=1000),
  ADD COLUMN href text CHECK(href IS NULL OR char_length(href)<=500);

CREATE TABLE notification_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('email')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text CHECK(last_error IS NULL OR char_length(last_error)<=500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(notification_id,channel)
);

CREATE INDEX notification_deliveries_pending_idx
  ON notification_deliveries(next_attempt_at,id)
  WHERE status='pending';
