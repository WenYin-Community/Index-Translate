# Cloudflare Workers Translation Proxy

[中文](README_zh.md)

Deploy the OpenAI-compatible bridge proxy for [Index-Translate](https://github.com/bilibili/Index-Translate) on Cloudflare Workers: no server, **100,000 requests/day** on the free plan, one stable endpoint for phones, tablets, and multiple computers.

## What it does

- Forwards `/v1/chat/completions`, `/v1/completions`, and `/v1/responses`
- Adds `chat_template_kwargs.enable_thinking = false` so chain-of-thought never leaks into translations
- Sets `temperature` to `0` when the caller omits it
- Adds CORS headers and the `User-Agent` expected by the upstream WAF
- Passes SSE streams through without buffering

## Free plan limits

| Item | Limit |
| --- | --- |
| Requests | 100,000/day (resets at UTC midnight) |
| CPU time | 10 ms per invocation (I/O wait is not CPU time) |
| Memory | 128 MB |
| Request body | Up to 100 MB (depends on the zone plan) |
| Outbound connections | 6 concurrently waiting for response headers |
| Subrequests | 50 per request |
| Worker script | 64 MiB uncompressed |

Text translation uses very little CPU. Parsing a large base64 image may approach or exceed the 10 ms CPU limit; keep images under 2 MB.

## Prerequisites

- Node.js 18+ (tested with Node 24)
- A Cloudflare account

## Deploy

```bash
cd deploy/cloudflare
npm install
npx wrangler login
npx wrangler secret put PROXY_TOKEN   # paste the key generated below
npm run deploy
```

Generate a 256-bit random key:

```bash
python3 -c "import secrets; print('itk_' + secrets.token_urlsafe(32))"
```

On success, `wrangler deploy` prints `https://index-translate-proxy.<your-subdomain>.workers.dev`.

> [!IMPORTANT]
> Keep `PROXY_TOKEN` in Cloudflare Secrets and in the local `.dev.vars` file (gitignored). **Never put it in `wrangler.toml`, this README, or Git history.** If the token is missing, the Worker returns `503` instead of becoming an open relay.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars and use the same key
npm run dev
```

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[{"role":"user","content":"Translate into English. Output only the translation.\n\nHello, world."}]}'
```

Streaming check:

```bash
curl -N -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -d '{"model":"Index-Translate-35B-A3B","stream":true,"messages":[{"role":"user","content":"Translate: Hello, world."}]}'
```

## Immersive Translate

| Field | Value |
| --- | --- |
| Service | `OpenAI` |
| API URL | `https://<worker>.<subdomain>.workers.dev/v1` |
| Model | `Index-Translate-35B-A3B` |
| API Key | the `PROXY_TOKEN` you configured |
| Max requests/s | `3` ~ `5` |

## Custom domain

The domain must already be on Cloudflare. Uncomment and edit the route in `wrangler.toml`:

```toml
routes = [{ pattern = "translate.example.com", custom_domain = true }]
```

Then run `npm run deploy` again.

## Known limitations

- **Network location**: Workers run on overseas edge nodes. `workers.dev` may be slow or unreachable from mainland China, and the latency from an overseas edge to `index-translate.bilibili.com` needs to be measured. If most users are in mainland China, a CloudBase Shanghai CloudRun service is usually faster.
- **10 ms CPU**: enough for a text proxy; very large images may exceed the free-plan limit.
- **No SLA** on the free plan; intended for personal use.
- **Upstream WAF**: if the upstream returns 403 or a challenge page to data-center IPs, the Worker cannot bypass it. Use the local proxy or CloudBase instead.
- **Key rotation**: rerun `npx wrangler secret put PROXY_TOKEN` and update the client.

## License

This directory follows the Apache-2.0 license at the repository root.
