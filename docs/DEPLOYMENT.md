# Deployment

This is a development foundation, not a supported production rollout. Populate `POSTGRES_PASSWORD`, `JWT_SECRET`, `APP_ORIGIN`, and `PUBLIC_API_URL` in a local `.env` beside `infra/docker-compose.yml`. Run `docker compose -f infra/docker-compose.yml up -d --build`, then `docker compose -f infra/docker-compose.yml exec api npm run migrate -w @clouddeck/api`. Place a TLS reverse proxy in front of loopback ports 3000/4000, forwarding WebSocket Upgrade headers for `/api/v1/agent/connect/*`. Set `APP_ORIGIN` to the exact web origin and `PUBLIC_API_URL` to the external API origin.

The image currently includes development dependencies to run migrations, and Compose does not start a job worker. Replace local Mailpit with a real SMTP relay, and configure database backups, monitoring retention, and secret management before production. Never use a demo server as evidence of live health.
