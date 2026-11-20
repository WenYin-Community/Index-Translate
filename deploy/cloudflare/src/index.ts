/**
 * Index-Translate OpenAI-compatible proxy for Cloudflare Workers.
 *
 * Browser extensions such as Immersive Translate need three things that the
 * public API cannot provide directly: CORS, a stable User-Agent for the
 * upstream WAF, and `enable_thinking=false` so chain-of-thought never replaces
 * the translated text.
 */

interface Env {
  /** Upstream OpenAI-compatible base URL. Defaults to the free public API. */
  API_BASE?: string;
  /** Required bearer token. Set with `wrangler secret put PROXY_TOKEN`. */
  PROXY_TOKEN?: string;
}

const DEFAULT_API_BASE = "https://index-translate.bilibili.com/v1";
const CLIENT_USER_AGENT = "Index-Translate-Client/1.0";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Accept",
  "Access-Control-Max-Age": "86400",
};

const MODELS = [
  { id: "Index-Translate-35B-A3B", object: "model" },
  { id: "Index-Translate-2B", object: "model" },
  { id: "Index-Translate-9B", object: "model" },
];

const PROXY_ENDPOINTS = ["/chat/completions", "/completions", "/responses"] as const;

function withCors(headers: Headers): Headers {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

function jsonResponse(data: unknown, status = 200): Response {
  const headers = withCors(new Headers({ "Content-Type": "application/json; charset=utf-8" }));
  return new Response(JSON.stringify(data), { status, headers });
}

function textResponse(text: string, status = 200): Response {
  const headers = withCors(new Headers({ "Content-Type": "text/plain; charset=utf-8" }));
  return new Response(text, { status, headers });
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function hasValidToken(request: Request, expected: string): boolean {
  const authorization = request.headers.get("Authorization") ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  const apiKey = (request.headers.get("X-API-Key") ?? "").trim();
  return constantTimeEqual(bearer, expected) || constantTimeEqual(apiKey, expected);
}

function resolveUpstreamPath(pathname: string): string | null {
  for (const endpoint of PROXY_ENDPOINTS) {
    if (pathname.endsWith(endpoint)) {
      return endpoint;
    }
  }
  return null;
}

/**
 * Mirror the Python bridge: disable thinking by default and use greedy
 * decoding unless the caller explicitly asks otherwise.
 */
function injectDefaults(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = payload.chat_template_kwargs;
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    const kwargs = existing as Record<string, unknown>;
    if (!("enable_thinking" in kwargs)) {
      kwargs.enable_thinking = false;
    }
  } else {
    payload.chat_template_kwargs = { enable_thinking: false };
  }
  if (payload.temperature === undefined || payload.temperature === null) {
    payload.temperature = 0;
  }
  return payload;
}

async function proxyPost(request: Request, env: Env, upstreamPath: string): Promise<Response> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ error: "Unable to read request body" }, 400);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ error: "Request body must be a JSON object" }, 400);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const apiBase = (env.API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const headers = new Headers({
    "Content-Type": "application/json",
    "User-Agent": CLIENT_USER_AGENT,
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase}${upstreamPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(injectDefaults(payload)),
      signal: request.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Upstream request failed: ${message}` }, 502);
  }

  // Stream the upstream body straight through. Do not copy Content-Length or
  // Content-Encoding: Workers already decoded the response and the length of a
  // streamed SSE body is unknown.
  const responseHeaders = withCors(new Headers());
  for (const name of ["content-type", "cache-control", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      responseHeaders.set(name, value);
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors(new Headers()) });
    }

    if (request.method === "GET") {
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        return jsonResponse({ object: "list", data: MODELS });
      }
      if (url.pathname === "/healthz") {
        return textResponse("ok");
      }
      return textResponse("Index-Translate Proxy Ready\n");
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    const upstreamPath = resolveUpstreamPath(url.pathname);
    if (upstreamPath === null) {
      return jsonResponse({ error: "Not Found" }, 404);
    }

    const expectedToken = env.PROXY_TOKEN?.trim();
    if (expectedToken === undefined || expectedToken === "") {
      return jsonResponse({ error: "PROXY_TOKEN is not configured" }, 503);
    }
    if (!hasValidToken(request, expectedToken)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    return proxyPost(request, env, upstreamPath);
  },
};
