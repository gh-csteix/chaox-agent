import { handleMcpRequest } from "./mcp.js";
import { D1ExchangeStore } from "./store.js";
import { Receipt, SCHEMA_VERSION, SnapshotUploadBody, WorkerEnv } from "./types.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id"
};

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
  if (!expectedToken || !expectedToken.trim()) {
    return false;
  }
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return false;
  }
  const actualRaw = headerValue.slice("Bearer ".length);
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actualRaw)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken.trim()))
  ]);
  const a = new Uint8Array(actualDigest);
  const b = new Uint8Array(expectedDigest);
  let diff = a.length ^ b.length;
  for (let idx = 0; idx < a.length; idx += 1) {
    diff |= a[idx] ^ b[idx];
  }
  return diff === 0;
}

export async function handleWorkerRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({
      status: "ok",
      schemaVersion: SCHEMA_VERSION,
      mode: "cloudflare-d1"
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

  const store = new D1ExchangeStore(env.DB);

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

    const syncMatch = /^\/sync\/([a-z]+)\/(status|inbox|ack|snapshot|data)$/.exec(url.pathname);
    if (syncMatch) {
      const app = D1ExchangeStore.parseAppId(syncMatch[1]);
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
      const app = D1ExchangeStore.parseAppId(datasetMatch[1]);
      const domain = datasetMatch[2];
      const body = (await request.json()) as { data?: unknown | null };
      return jsonResponse(await store.putAppDatasetDomain(app, domain, body.data ?? null));
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env);
  }
};
