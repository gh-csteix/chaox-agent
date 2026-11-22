import { handleMcpRequest } from "./mcp.js";
import { ExchangeStore } from "./store.js";
import { Receipt, SCHEMA_VERSION, ServerEnv, SnapshotUploadBody } from "./types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version"
};

const TEXT_ENCODER = new TextEncoder();
const TOKEN_DIGEST_CACHE = new Map<string, Uint8Array>();

async function digestSha256(value: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
  return new Uint8Array(buf);
}

async function getExpectedTokenDigest(expectedToken: string): Promise<Uint8Array> {
  const cached = TOKEN_DIGEST_CACHE.get(expectedToken);
  if (cached) return cached;
  const digest = await digestSha256(expectedToken);
  if (TOKEN_DIGEST_CACHE.size >= 16) {
    TOKEN_DIGEST_CACHE.clear();
  }
  TOKEN_DIGEST_CACHE.set(expectedToken, digest);
  return digest;
}

function isInternalError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (code.startsWith("ERR_SQLITE") || code.startsWith("SQLITE"))) {
    return true;
  }
  if (/SQLITE_|D1_ERROR|database is locked|no such table/i.test(error.message)) {
    return true;
  }
  return false;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    })
  );
}

async function verifyBearerToken(headerValue: string | null, expectedToken: string | undefined): Promise<boolean> {
  const expected = expectedToken?.trim();
  if (!expected) {
    return false;
  }
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return false;
  }
  const actualRaw = headerValue.slice("Bearer ".length);
  const [a, b] = await Promise.all([
    digestSha256(actualRaw),
    getExpectedTokenDigest(expected)
  ]);
  let diff = a.length ^ b.length;
  for (let idx = 0; idx < a.length; idx += 1) {
    diff |= a[idx] ^ b[idx];
  }
  return diff === 0;
}

export async function handleRequest(request: Request, env: ServerEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const backendMode = env.BACKEND_MODE?.trim() || "sqlite";
  const serverName = env.SERVER_NAME?.trim() || "chaox-agent-server";

  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({
      status: "ok",
      schemaVersion: SCHEMA_VERSION,
      mode: backendMode
    });
  }

  const authorized = await verifyBearerToken(
    request.headers.get("Authorization"),
    env.CHAOX_AUTH_TOKEN
  );
  if (!authorized) {
    return withCors(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": "Bearer"
        }
      })
    );
  }

  const store = new ExchangeStore(env.DB, {
    backendMode,
    defaultClient: serverName
  });

  try {
    if (url.pathname === "/mcp") {
      return withCors(await handleMcpRequest(request, store));
    }

    if (url.pathname === "/preferences") {
      if (request.method === "GET") {
        return jsonResponse(await store.getPreferences());
      }
      if (request.method === "PUT") {
        const body = (await request.json()) as { content?: string };
        if (typeof body.content !== "string") {
          return jsonResponse({ error: "Expected JSON object with 'content' string." }, 400);
        }
        return jsonResponse(await store.setPreferences(body.content));
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/sync/csteix/wuxu") {
      if (request.method === "GET") {
        const since = url.searchParams.get("since");
        const rawIncludeDeleted = url.searchParams.get("includeDeleted");
        const includeDeleted =
          rawIncludeDeleted === null
            ? true
            : rawIncludeDeleted !== "0" && rawIncludeDeleted.toLowerCase() !== "false";
        return jsonResponse(await store.csteix.getWuxuDelta({ since, includeDeleted }));
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/sync/csteix/wuxu/import") {
      if (request.method === "POST") {
        const body = (await request.json()) as { articles?: unknown };
        return jsonResponse(await store.csteix.importWuxuArticles(body.articles));
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const syncMatch = /^\/sync\/([a-z]+)\/(status|inbox|ack|snapshot|data)$/.exec(url.pathname);
    if (syncMatch) {
      const app = ExchangeStore.parseAppId(syncMatch[1]);
      const action = syncMatch[2];

      if (action === "status" && request.method === "GET") {
        const rawLimit = Number(url.searchParams.get("limit") || "10");
        const limit = Number.isFinite(rawLimit) ? rawLimit : 10;
        return jsonResponse(await store.getAppSyncStatus(app, limit));
      }

      if (action === "inbox" && request.method === "GET") {
        return jsonResponse(await store.listAppInbox(app));
      }

      if (action === "ack" && request.method === "POST") {
        const body = (await request.json()) as { receipts?: Receipt[] };
        if (!Array.isArray(body.receipts)) {
          return jsonResponse({ error: "Expected JSON object with 'receipts' array." }, 400);
        }
        return jsonResponse(await store.ackAppReceipts(app, body.receipts));
      }

      if (action === "snapshot" && request.method === "PUT") {
        const body = (await request.json()) as SnapshotUploadBody;
        return jsonResponse(await store.putAppSnapshot(app, body));
      }

      if (action === "data" && request.method === "DELETE") {
        return jsonResponse(await store.wipeAppData(app));
      }

      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const datasetMatch = /^\/sync\/([a-z]+)\/dataset\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (datasetMatch && request.method === "PUT") {
      const app = ExchangeStore.parseAppId(datasetMatch[1]);
      const domain = datasetMatch[2];
      const body = (await request.json()) as { data?: unknown | null };
      return jsonResponse(await store.putAppDatasetDomain(app, domain, body.data ?? null));
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof SyntaxError
          ? 400
          : isInternalError(error)
            ? 500
            : 400;
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      status
    );
  }
}

export const handleWorkerRequest = handleRequest;
