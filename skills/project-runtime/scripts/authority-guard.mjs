function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(label + " is required", "INVALID_AUTHORITY_REQUEST");
  return value;
}

function sameRef(actual, expected) {
  if (!expected) return true;
  if (!actual || typeof actual !== "object") return false;
  return actual.type === expected.type &&
    actual.id === expected.id &&
    (expected.revision === undefined || actual.revision === expected.revision);
}

export function findEffectGrant(authorityContext, request) {
  if (!authorityContext || authorityContext.schema !== "dev.woia.authority-context/v1") return null;

  const capability = assertString(request?.capability, "capability");
  const operation = assertString(request?.operation, "operation");
  const effectClass = assertString(request?.effectClass, "effectClass");
  const principalId = assertString(request?.principalId, "principalId");
  const department = assertString(request?.department, "department");

  if (authorityContext.principal?.kind !== "agent-instance" || authorityContext.principal?.id !== principalId) return null;
  if (authorityContext.department !== department) return null;
  if (!sameRef(authorityContext.task_ref, request?.taskRef)) return null;

  // Denials are intentionally opaque strings in the v1 schema. Until they have a
  // structured matching contract, fail closed rather than guessing that a grant wins.
  if (!Array.isArray(authorityContext.denials) || authorityContext.denials.length > 0) return null;

  const grants = Array.isArray(authorityContext.grants) ? authorityContext.grants : [];
  return grants.find((grant) =>
    grant?.capability === capability &&
    Array.isArray(grant.operations) &&
    grant.operations.includes(operation) &&
    Array.isArray(grant.effect_classes) &&
    grant.effect_classes.includes(effectClass)
  ) ?? null;
}

export function requireEffectGrant(authorityContext, request) {
  const grant = findEffectGrant(authorityContext, request);
  if (!grant) {
    fail(
      "WOIA authority denied: no current exact grant for " +
        [request?.capability, request?.operation, request?.effectClass].join(" / "),
      "AUTHORITY_GRANT_REQUIRED",
    );
  }
  return grant;
}
