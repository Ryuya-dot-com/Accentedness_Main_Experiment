const API_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
});

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...API_HEADERS, ...extraHeaders },
  });
}

export function errorResponse(error, requestId) {
  if (error instanceof ApiError) {
    return jsonResponse({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
      request_id: requestId,
    }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ message: "unhandled_request_error", request_id: requestId, error: message }));
  return jsonResponse({
    ok: false,
    error: { code: "internal_error", message: "サーバー内部エラーが発生しました。担当者に連絡してください。" },
    request_id: requestId,
  }, 500);
}

export async function readBoundedBytes(request, maxBytes) {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "body_too_large", `Request body exceeds ${maxBytes} bytes`);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body_too_large");
        throw new ApiError(413, "body_too_large", `Request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return output;
}

export async function readJson(request, maxBytes = 131_072) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "content_type_required", "Content-Type must be application/json");
  }
  const bytes = await readBoundedBytes(request, maxBytes);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "invalid_json_object", "Request JSON must be an object");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export function requireMethod(request, allowed) {
  if (!allowed.includes(request.method)) {
    throw new ApiError(405, "method_not_allowed", "Method not allowed", { allowed });
  }
}

export function bearerToken(request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(header);
  if (!match) throw new ApiError(401, "authorization_required", "Authorization token is required");
  return match[1];
}

export function requireUuid(value, fieldName) {
  const text = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new ApiError(400, "invalid_identifier", `${fieldName} must be a UUID`);
  }
  return text.toLowerCase();
}
