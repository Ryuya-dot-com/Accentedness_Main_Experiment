import {
  ApiError,
  jsonResponse,
  readJson,
  requireMethod,
} from "./lib/http.js";
import { requireAdmin } from "./lib/auth.js";
import {
  buildTestModeBootstrap,
  isCanonicalTestModeAssetKey,
  isAllowedTestModeScope,
} from "./lib/test-mode.js";

const MAX_TEST_BOOTSTRAP_BODY_BYTES = 4_096;
const TEST_BOOTSTRAP_FIELDS = new Set([
  "participant_id",
  "expected_visit_type",
  "expected_segment",
]);

function requireConfiguration(env) {
  if (String(env.ENVIRONMENT ?? "").toLowerCase() !== "development") {
    throw new ApiError(404, "api_route_not_found", "API route was not found");
  }
  for (const field of [
    "ASSIGNMENT_VERSION",
    "SEED_ALGORITHM_VERSION",
    "RESEARCHER_TEST_ASSET_VERSION",
  ]) {
    if (typeof env[field] !== "string" || !env[field]) {
      throw new ApiError(
        503,
        "test_mode_configuration_incomplete",
        "Test mode is not configured",
      );
    }
  }
}

function validateFields(body) {
  const unknown = Object.keys(body).filter((field) => !TEST_BOOTSTRAP_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new ApiError(400, "unexpected_fields", "Request contains unexpected fields", {
      fields: unknown,
    });
  }
  if (body.participant_id !== "999") {
    throw new ApiError(
      422,
      "test_mode_participant_id_required",
      "Test mode requires the exact participant ID '999'",
    );
  }

  const visitType = typeof body.expected_visit_type === "string"
    ? body.expected_visit_type
    : "";
  const segment = typeof body.expected_segment === "string" ? body.expected_segment : "";
  if (!isAllowedTestModeScope(visitType, segment)) {
    throw new ApiError(
      422,
      "invalid_test_mode_scope",
      "Visit and segment are not a valid task-page combination",
    );
  }
  return { visitType, segment };
}

export async function bootstrapTestMode(request, env) {
  requireConfiguration(env);
  requireMethod(request, ["POST"]);
  await requireAdmin(request, env);
  const body = await readJson(request, MAX_TEST_BOOTSTRAP_BODY_BYTES);
  const { visitType, segment } = validateFields(body);
  const state = await buildTestModeBootstrap({
    visitType,
    segment,
    assignmentVersion: env.ASSIGNMENT_VERSION,
    seedAlgorithmVersion: env.SEED_ALGORITHM_VERSION,
    assetVersion: env.RESEARCHER_TEST_ASSET_VERSION,
  });
  return jsonResponse(state);
}

export async function serveTestModeStimulus(request, env, kind) {
  requireConfiguration(env);
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const keys = url.searchParams.getAll("key");
  if ([...url.searchParams.keys()].some((name) => name !== "key") || keys.length !== 1
      || !isCanonicalTestModeAssetKey(keys[0], kind, env.RESEARCHER_TEST_ASSET_VERSION)) {
    throw new ApiError(404, "stimulus_not_found", "Stimulus was not found");
  }

  const object = await env.STIMULI.get(keys[0]);
  if (!object) {
    throw new ApiError(503, "stimulus_asset_missing", "The stimulus file has not been uploaded");
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", kind === "audio" ? "audio/wav" : "image/webp");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}
