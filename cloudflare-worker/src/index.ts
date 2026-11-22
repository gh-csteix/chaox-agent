import { handleRequest } from "../../server/src/app.js";
import { ServerEnv } from "../../server/src/types.js";

export type WorkerEnv = ServerEnv;

export function handleWorkerRequest(request: Request, env: WorkerEnv): Promise<Response> {
  return handleRequest(request, {
    ...env,
    BACKEND_MODE: env.BACKEND_MODE?.trim() || "cloudflare-d1",
    SERVER_NAME: env.SERVER_NAME?.trim() || "chaox-agent-worker"
  });
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env);
  }
};
