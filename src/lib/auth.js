import { sha256Hex, secureTextEqual } from "./crypto.js";
import { bearerToken, ApiError } from "./http.js";
import { getSessionByTokenHash } from "./db.js";

export async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN || String(env.ADMIN_TOKEN).length < 24) {
    throw new ApiError(503, "admin_auth_unconfigured", "Admin authentication is not configured");
  }
  const token = bearerToken(request);
  if (!(await secureTextEqual(token, env.ADMIN_TOKEN))) {
    throw new ApiError(403, "admin_forbidden", "Admin authorization failed");
  }
}

export async function requireSession(
  request,
  env,
  { allowCompleted = false, allowClosedRetry = false } = {},
) {
  const token = bearerToken(request);
  const tokenHash = await sha256Hex(token);
  const session = await getSessionByTokenHash(env.DB, tokenHash);
  if (!session) throw new ApiError(401, "invalid_session", "Session token is invalid");
  const nowMs = Date.now();
  const completedRetry = allowCompleted
    && session.session_status === "closed"
    && session.visit_status === "completed";
  const closedRetry = allowClosedRetry && session.session_status === "closed";
  if (session.session_status !== "active" && !completedRetry && !closedRetry) {
    throw new ApiError(409, "session_superseded", "This session was replaced by a newer tab or resume attempt");
  }
  if (!completedRetry && !closedRetry
      && Number(session.epoch) !== Number(session.active_session_epoch)) {
    throw new ApiError(409, "session_superseded", "This session is no longer the active visit session");
  }
  if (Number(session.expires_at_ms) <= nowMs) {
    throw new ApiError(401, "session_expired", "The session expired; reopen the invitation link to resume");
  }
  if (!completedRetry && !closedRetry
      && ["completed", "withdrawn"].includes(session.visit_status)) {
    throw new ApiError(409, "visit_closed", "This visit is already closed", { status: session.visit_status });
  }
  if (!completedRetry && !closedRetry
      && nowMs - Number(session.session_last_seen_at_ms ?? 0) >= 60_000) {
    await env.DB.prepare(`
      UPDATE sessions SET last_seen_at_ms = ? WHERE session_uuid = ?
    `).bind(nowMs, session.session_uuid).run();
  }
  return session;
}
