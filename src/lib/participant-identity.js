import {
  bytesToHex,
  hmacSha256,
  secureTextEqual,
  stableJson,
} from "./crypto.js";
import { canonicalParticipantId } from "./manifest.js";

export const PARTICIPANT_IDENTITY_NORMALIZATION_VERSION = "nfkc-whitespace-lower-v1";
export const PARTICIPANT_IDENTITY_VERIFIER_VERSION = "hmac-sha256-v1";

const PARTICIPANT_IDENTITY_DOMAIN = "accentedness-main-experiment/participant-name-binding";
const MAX_NAME_CODE_POINTS = 80;
const MAX_NAME_UTF8_BYTES = 256;
const MIN_IDENTITY_SECRET_CODE_POINTS = 24;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cs}\u0085\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNICODE_WHITESPACE = /\p{White_Space}+/gu;
const encoder = new TextEncoder();

export class ParticipantIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ParticipantIdentityError";
    this.code = code;
  }
}

function identitySecret(value) {
  if (typeof value !== "string"
      || Array.from(value).length < MIN_IDENTITY_SECRET_CODE_POINTS) {
    throw new ParticipantIdentityError(
      "identity_secret_unconfigured",
      "Identity verification secret must contain at least 24 characters",
    );
  }
  return value;
}

function participantUuid(value) {
  const text = String(value ?? "");
  if (!UUID_PATTERN.test(text)) {
    throw new ParticipantIdentityError(
      "invalid_participant_uuid",
      "Participant UUID is invalid",
    );
  }
  return text.toLowerCase();
}

function participantId(value) {
  try {
    return canonicalParticipantId(value);
  } catch {
    throw new ParticipantIdentityError(
      "invalid_participant_id",
      "Participant ID is invalid",
    );
  }
}

function normalizedParticipantName(value) {
  if (typeof value !== "string" || FORBIDDEN_NAME_CHARACTERS.test(value)) {
    throw new ParticipantIdentityError(
      "invalid_participant_name",
      "Participant name contains invalid characters",
    );
  }
  const normalized = value
    .normalize("NFKC")
    .replace(UNICODE_WHITESPACE, " ")
    .trim()
    .toLowerCase();
  if (!normalized || FORBIDDEN_NAME_CHARACTERS.test(normalized)) {
    throw new ParticipantIdentityError(
      "invalid_participant_name",
      "Participant name is empty or invalid",
    );
  }
  if (Array.from(normalized).length > MAX_NAME_CODE_POINTS) {
    throw new ParticipantIdentityError(
      "invalid_participant_name",
      "Participant name exceeds 80 Unicode code points",
    );
  }
  if (encoder.encode(normalized).byteLength > MAX_NAME_UTF8_BYTES) {
    throw new ParticipantIdentityError(
      "invalid_participant_name",
      "Participant name exceeds 256 UTF-8 bytes",
    );
  }
  return normalized;
}

function verifierMessage(participantUuidValue, participantIdValue, normalizedName) {
  return stableJson({
    domain: PARTICIPANT_IDENTITY_DOMAIN,
    normalization_version: PARTICIPANT_IDENTITY_NORMALIZATION_VERSION,
    participant_id: participantIdValue,
    participant_uuid: participantUuidValue,
    participant_name: normalizedName,
    verifier_version: PARTICIPANT_IDENTITY_VERIFIER_VERSION,
  });
}

export async function createParticipantIdentityBinding({
  identitySecret: secretInput,
  participantUuid: uuidInput,
  participantId: idInput,
  participantName: nameInput,
}) {
  const secret = identitySecret(secretInput);
  const uuid = participantUuid(uuidInput);
  const id = participantId(idInput);
  const normalizedName = normalizedParticipantName(nameInput);
  const verifier = await hmacSha256(
    secret,
    verifierMessage(uuid, id, normalizedName),
  );
  return Object.freeze({
    normalization_version: PARTICIPANT_IDENTITY_NORMALIZATION_VERSION,
    verifier_version: PARTICIPANT_IDENTITY_VERIFIER_VERSION,
    verifier_hex: bytesToHex(verifier),
  });
}

export async function participantIdentityVerifierEqual(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  const equal = await secureTextEqual(leftText, rightText);
  return /^[0-9a-f]{64}$/u.test(leftText)
    && /^[0-9a-f]{64}$/u.test(rightText)
    && equal;
}

export async function verifyParticipantIdentityBinding({
  identitySecret: secretInput,
  participantUuid: uuidInput,
  participantId: idInput,
  participantName: nameInput,
  binding,
}) {
  const computed = await createParticipantIdentityBinding({
    identitySecret: secretInput,
    participantUuid: uuidInput,
    participantId: idInput,
    participantName: nameInput,
  });
  const verifierMatches = await participantIdentityVerifierEqual(
    computed.verifier_hex,
    binding?.verifier_hex,
  );
  return binding?.normalization_version === computed.normalization_version
    && binding?.verifier_version === computed.verifier_version
    && verifierMatches;
}
