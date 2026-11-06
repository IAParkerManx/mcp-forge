// Secret redaction for anything forge writes to disk or sends to an LLM.
// REA already nulls known transport credentials (Cookie, Authorization,
// Set-Cookie); this catches application-level secrets it cannot know about,
// such as login passwords in bodies and CSRF tokens echoed in custom headers.

export const REDACTED = "[REDACTED]";

const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|csrf|xsrf|api[_-]?key|(^|[_-])auth([_-]|$)|authorization|authentication|session|cookie|otp|pin$|private[_-]?key|signature/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Collect string values stored under secret-looking keys. */
export function collectSecrets(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectSecrets(v, into);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k) && typeof v === "string" && v.length >= 4) into.add(v);
      else collectSecrets(v, into);
    }
  }
  return into;
}

/** Replace secret-keyed values and any known secret literal anywhere in the value. */
export function redact<T>(value: T, knownSecrets: ReadonlySet<string> = new Set()): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key !== undefined && isSecretKey(key)) return REDACTED;
      let out = v;
      for (const secret of knownSecrets) if (secret.length >= 4 && out.includes(secret)) out = out.split(secret).join(REDACTED);
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * Replace known secret literals only. Used for REA Evidence, whose own field
 * names (`api_key`, `session`...) describe structure, not secrets.
 */
export function redactLiterals<T>(value: T, knownSecrets: ReadonlySet<string>): T {
  const secrets = [...knownSecrets].filter((s) => s.length >= 4);
  if (secrets.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return secrets.reduce((out, secret) => (out.includes(secret) ? out.split(secret).join(REDACTED) : out), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
