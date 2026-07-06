# Internal Docker Deployment

This deployment layout is for internal server use. It does not add product login,
multi-user persistence, or public compliance controls.

## Files

- `Dockerfile.service` builds the Node 24 application service container.
- `docker-compose.yml` runs the application service.
- `docker-compose.proxy.yml` runs an independent `nginx:1.31.2-alpine` proxy.
- `nginx/default.conf` proxies browser traffic to the application service.
- `service.env.example` lists required runtime environment variables.

## First Run

```bash
cp deploy/service.env.example deploy/service.env
# edit deploy/service.env and set QVERIS_API_KEY and DEEPSEEK_API_KEY

docker compose --env-file deploy/service.env -f deploy/docker-compose.yml up -d --build
docker compose --env-file deploy/service.env -f deploy/docker-compose.proxy.yml up -d
```

The service compose file creates the shared `options-assistant-net` network.
Start it before the proxy compose file.

For internal use, restrict access with cloud firewall rules, VPN, private network
ingress, or a fronting gateway. The application itself does not yet include login.

## Checks

```bash
docker compose --env-file deploy/service.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/service.env -f deploy/docker-compose.proxy.yml ps
curl http://127.0.0.1/api/health
```

Paper-trade data is stored in the `paper-data` Docker volume at
`/data/paper-trades.json` inside the application service container.
