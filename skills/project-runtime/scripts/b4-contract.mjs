// Portable validation for the linked B4 records; no installed authoring dependencies.
export function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string");
}

export function requireObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error(label + " has invalid fields");
}

export function requireStrings(value, label, { nonEmpty = false, unique = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && !value.length)) throw new Error(label + " must be an array");
  for (const item of value) requireText(item, label + " item");
  if (unique && new Set(value).size !== value.length) throw new Error(label + " must be unique");
}

export function instant(value, label) {
  const parts = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!parts) throw new Error(label + " must be ISO date-time");
  const [, y, m, d, h, min, s, , oh, om] = parts;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ms = Date.parse(value);
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(h) > 23 || Number(min) > 59 || Number(s) > 59 ||
      (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) || !Number.isFinite(ms)) {
    throw new Error(label + " must be ISO date-time");
  }
  return ms;
}

export function requireTaskRef(value, label) {
  requireObject(value, ["kind", "id", "revision", "version", "digest"], label);
  if (value.kind !== "Task") throw new Error(label + " must reference a Task");
  requireText(value.id, label + ".id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.id)) throw new Error(label + " has invalid id");
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 1)) throw new Error(label + " has invalid revision");
  if (value.version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)) throw new Error(label + " has invalid version");
  if (value.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(value.digest)) throw new Error(label + " has invalid digest");
}

export function requireBlocker(value) {
  requireObject(value, ["id", "type", "summary", "recovery"], "blocker");
  for (const field of ["id", "type", "summary"]) requireText(value[field], "blocker." + field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.id)) throw new Error("blocker has invalid id");
  if (value.recovery !== undefined) requireText(value.recovery, "blocker.recovery");
}

export function requireResourceRef(value, label) {
  requireObject(value, ["type", "id", "uri", "version"], label);
  requireText(value.type, label + ".type");
  requireText(value.id, label + ".id");
  for (const field of ["uri", "version"]) if (value[field] !== undefined) requireText(value[field], label + "." + field);
}

export function requireSelector(selector, version) {
  if (selector !== "v" + version && !(typeof selector === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(selector))) {
    throw new Error("selector must be the exact version tag or immutable commit SHA");
  }
}
