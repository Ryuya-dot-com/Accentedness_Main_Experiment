const MAX_NAME_CODE_POINTS = 80;
const MAX_NAME_UTF8_BYTES = 256;
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cs}\u0085\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNICODE_WHITESPACE = /\p{White_Space}+/gu;
const encoder = new TextEncoder();

export class ParticipantNameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ParticipantNameError";
    this.code = code;
  }
}

export function normalizeParticipantName(value) {
  if (typeof value !== "string" || FORBIDDEN_NAME_CHARACTERS.test(value)) {
    throw new ParticipantNameError(
      "invalid_participant_name",
      "Participant name contains invalid characters",
    );
  }
  const normalized = value
    .normalize("NFKC")
    .replace(UNICODE_WHITESPACE, " ")
    .trim();
  if (!normalized || FORBIDDEN_NAME_CHARACTERS.test(normalized)) {
    throw new ParticipantNameError(
      "invalid_participant_name",
      "Participant name is empty or invalid",
    );
  }
  if (Array.from(normalized).length > MAX_NAME_CODE_POINTS) {
    throw new ParticipantNameError(
      "invalid_participant_name",
      "Participant name exceeds 80 Unicode code points",
    );
  }
  if (encoder.encode(normalized).byteLength > MAX_NAME_UTF8_BYTES) {
    throw new ParticipantNameError(
      "invalid_participant_name",
      "Participant name exceeds 256 UTF-8 bytes",
    );
  }
  return normalized;
}
