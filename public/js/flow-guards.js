function normalizedPath(path) {
  return String(path ?? "").replace(/\/+$/u, "") || "/";
}

export function redirectToCanonical(
  state,
  {
    runner = null,
    audio = null,
    location = window.location,
  } = {},
) {
  if (!state?.next_route) return false;
  if (normalizedPath(location.pathname) === normalizedPath(state.next_route)) return false;
  runner?.stopMonitoring();
  audio?.close();
  location.replace(state.next_route);
  return true;
}

export function microphoneCheckStorageKey(state, segment) {
  return [
    "microphone_checked",
    state.visit.visit_id,
    state.session.epoch,
    segment,
  ].join(":");
}
