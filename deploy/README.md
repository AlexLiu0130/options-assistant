# Internal Docker Deployment

This deployment layout is for internal server use. It does not add product login,
multi-user persistence, or public compliance controls.

## Files

- `Dockerfile.api` builds the Node 24 API container.
- `Dockerfile.nginx` builds the React/Vite static site into `nginx:1.31.2-alpine`.
- `docker-compose.yml` runs system services, currently the API service.
- `docker-compose.proxy.yml` runs the independent Nginx proxy/static web service.
- `nginx/default.conf` serves the frontend and proxies `/api/*` to the API service.
- `api.env.example` lists required runtime environment variables.

## First Run

```bash
cp deploy/api.env.example deploy/api.env
# edit deploy/api.env and set QVERIS_API_KEY and DEEPSEEK_API_KEY

docker compose --env-file deploy/api.env -f deploy/docker-compose.yml up -d --build
docker compose --env-file deploy/api.env -f deploy/docker-compose.proxy.yml up -d --build
```

The API compose file creates the shared `options-assistant-net` network. Start it
before the proxy compose file.

For internal use, restrict access with cloud firewall rules, VPN, private network
ingress, or a fronting gateway. The application itself does not yet include login.

## Checks

```bash
docker compose --env-file deploy/api.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/api.env -f deploy/docker-compose.proxy.yml ps
curl http://127.0.0.1/api/health
```

Paper-trade data is stored in the `paper-data` Docker volume at
`/data/paper-trades.json` inside the API container.
