import {
  ApiError,
  jsonResponse,
  readJson,
  requireMethod,
} from "./lib/http.js";
import {
  buildTestModeBootstrap,
  isAllowedTestModeScope,
} from "./lib/test-mode.js";

const MAX_TEST_BOOTSTRAP_BODY_BYTES = 4_096;
const TEST_BOOTSTRAP_FIELDS = new Set([
  "participant_id",
  "expected_visit_type",
  "expected_segment",
]);

function requireConfiguration(configuration) {
  if (configuration.enabled !== true) {
    throw new ApiError(404, "api_route_not_found", "API route was not found");
  }
  for (const field of ["assignmentVersion", "seedAlgorithmVersion"]) {
    if (typeof configuration[field] !== "string" || !configuration[field]) {
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
  if (body.participant_id !== "test") {
    throw new ApiError(
      422,
      "test_mode_participant_id_required",
      "Test mode requires the exact participant ID 'test'",
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

export async function bootstrapTestMode(request, configuration = {}) {
  requireMethod(request, ["POST"]);
  requireConfiguration(configuration);
  const body = await readJson(request, MAX_TEST_BOOTSTRAP_BODY_BYTES);
  const { visitType, segment } = validateFields(body);
  const state = await buildTestModeBootstrap({
    visitType,
    segment,
    assignmentVersion: configuration.assignmentVersion,
    seedAlgorithmVersion: configuration.seedAlgorithmVersion,
  });
  return jsonResponse(state);
}
