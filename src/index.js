import {
  adminSummary,
  createInvitation,
  createParticipant,
  listDueDelayed,
  revokeInvitation,
} from "./routes-admin.js";
import {
  completeVisit,
  finalizeParticipationInterruption,
  heartbeat,
  previewParticipantName,
  redeemInvitation,
  requestParticipationInterruption,
  saveEvents,
  saveTrialResponse,
  serveStimulus,
  sessionState,
  startTrial,
  uploadRecording,
} from "./routes-participant.js";
import {
  downloadAdminParticipantCopy,
  downloadParticipantCopy,
} from "./routes-participant-copy.js";
import { bootstrapTestMode } from "./routes-test-mode.js";
import { ApiError, errorResponse, jsonResponse } from "./lib/http.js";
import { collectionConfiguration } from "./lib/config.js";

const UUID_IN_PATH = /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/giu;

function privacySafeLogPath(pathname) {
  return pathname
    .replace(UUID_IN_PATH, "/:uuid")
    .replace(
      /^\/api\/admin\/participants\/[1-9][0-9]*\/results\.zip$/u,
      "/api/admin/participants/:id/results.zip",
    );
}

function enforceOrigin(request) {
  if (["GET", "HEAD"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) {
    throw new ApiError(403, "cross_origin_forbidden", "Cross-origin API requests are not allowed");
  }
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  enforceOrigin(request);

  if (path === "/api/health" && request.method === "GET") {
    const collection = collectionConfiguration(env);
    return jsonResponse({
      ok: true,
      service: "accentedness-main-experiment",
      assignment_version: env.ASSIGNMENT_VERSION,
      asset_version: env.ASSET_VERSION,
      environment: collection.environment,
      collection_ready: collection.collectionReady,
      placeholder_assets: collection.placeholder,
      test_token_policy: collection.testTokenPolicy,
      test_token_policy_ready: collection.tokenPolicyReady,
      admin_authentication_ready: collection.adminAuthenticationReady,
      randomization_ready: collection.randomizationReady,
      secrets_independent: collection.secretsIndependent,
      server_now_ms: Date.now(),
    });
  }
  if (path === "/api/test/bootstrap") {
    return bootstrapTestMode(request, {
      enabled: String(env.ENVIRONMENT ?? "").toLowerCase() === "development",
      assignmentVersion: env.ASSIGNMENT_VERSION,
      seedAlgorithmVersion: env.SEED_ALGORITHM_VERSION,
    });
  }
  if (path === "/api/admin/participants") return createParticipant(request, env);
  if (path === "/api/admin/delayed/due") return listDueDelayed(request, env);
  if (path === "/api/admin/summary") return adminSummary(request, env);

  let match = /^\/api\/admin\/participants\/([^/]+)\/results\.zip$/u.exec(path);
  if (match) return downloadAdminParticipantCopy(request, env, match[1]);

  match = /^\/api\/admin\/visits\/([^/]+)\/invitations$/u.exec(path);
  if (match) return createInvitation(request, env, match[1]);
  match = /^\/api\/admin\/invitations\/([^/]+)\/revoke$/u.exec(path);
  if (match) return revokeInvitation(request, env, match[1]);
  if (path === "/api/invitations/name-preview") return previewParticipantName(request, env);
  if (path === "/api/invitations/redeem") return redeemInvitation(request, env);
  if (path === "/api/session") return sessionState(request, env);
  if (path === "/api/session/heartbeat") return heartbeat(request, env);
  if (path === "/api/events") return saveEvents(request, env);
  if (path === "/api/visit/complete") return completeVisit(request, env);
  if (path === "/api/visit/results.zip") return downloadParticipantCopy(request, env);
  if (path === "/api/participation/interruptions") {
    return requestParticipationInterruption(request, env);
  }

  match = /^\/api\/participation\/interruptions\/([^/]+)\/finalize$/u.exec(path);
  if (match) return finalizeParticipationInterruption(request, env, match[1]);

  match = /^\/api\/trials\/([^/]+)\/start$/u.exec(path);
  if (match) return startTrial(request, env, match[1]);
  match = /^\/api\/trials\/([^/]+)\/response$/u.exec(path);
  if (match) return saveTrialResponse(request, env, match[1]);
  match = /^\/api\/recordings\/([^/]+)$/u.exec(path);
  if (match) return uploadRecording(request, env, match[1]);
  match = /^\/api\/stimuli\/([^/]+)\/(audio|image)$/u.exec(path);
  if (match) return serveStimulus(request, env, match[1], match[2]);

  throw new ApiError(404, "api_route_not_found", "API route was not found");
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const loggedPath = privacySafeLogPath(url.pathname);
    const started = Date.now();
    try {
      const response = url.pathname.startsWith("/api/")
        ? await routeApi(request, env)
        : await env.ASSETS.fetch(request);
      console.log(JSON.stringify({
        message: "request_complete",
        request_id: requestId,
        method: request.method,
        path: loggedPath,
        status: response.status,
        duration_ms: Date.now() - started,
      }));
      const responseWithRequestId = new Response(response.body, response);
      responseWithRequestId.headers.set("X-Request-ID", requestId);
      return responseWithRequestId;
    } catch (error) {
      const response = errorResponse(error, requestId);
      console.error(JSON.stringify({
        message: "request_failed",
        request_id: requestId,
        method: request.method,
        path: loggedPath,
        status: response.status,
        code: error instanceof ApiError ? error.code : "internal_error",
        duration_ms: Date.now() - started,
      }));
      return response;
    }
  },
};
