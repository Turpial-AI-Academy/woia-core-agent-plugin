function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(label + " is required", "INVALID_AUTHORITY_REQUEST");
  return value;
}

export function findEffectGrant(authorityContext, request) {
  if (!authorityContext || authorityContext.schema !== "dev.woia.authority-context/v1") return null;
  const capability = assertString(request?.capability, "capability");
  const operation = assertString(request?.operation, "operation");
  const effectClass = assertString(request?.effectClass, "effectClass");
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
      "WOIA authority denied: no matching grant for " +
        [request?.capability, request?.operation, request?.effectClass].join(" / "),
      "AUTHORITY_GRANT_REQUIRED",
    );
  }
  return grant;
}
