/**
 * Credential checks and redaction. Never log or return OAuth tokens.
 */

export const REQUIRED_OAUTH_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

const SENSITIVE_ENV_KEYS = [
  ...REQUIRED_OAUTH_VARS,
  "GOOGLE_ACCESS_TOKEN",
];

const CREDENTIAL_ASSIGNMENT =
  /(?:refresh_token|access_token|id_token|client_secret|client_id|authorization)\s*[=:]\s*["']?[^"'\s,}\\]+/gi;
const BEARER = /Bearer\s+\S+/gi;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function missingOAuthVars(env = process.env) {
  return REQUIRED_OAUTH_VARS.filter((key) => !String(env[key] || "").trim());
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_REFRESH_TOKEN: string }}
 */
export function requireCreds(env = process.env) {
  const missing = missingOAuthVars(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing required OAuth configuration: ${missing.join(", ")}. Set these in Cursor → Plugins → Configure. Do not pass secrets on the command line.`
    );
  }
  return {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID.trim(),
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET.trim(),
    GOOGLE_REFRESH_TOKEN: env.GOOGLE_REFRESH_TOKEN.trim(),
  };
}

/**
 * Strip known secret values and credential-shaped substrings from an error.
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function safeErrorMessage(err, env = process.env) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const key of SENSITIVE_ENV_KEYS) {
    const val = env[key];
    if (val && String(val).length > 0) {
      msg = msg.split(String(val)).join(`[${key}]`);
    }
  }
  msg = msg.replace(CREDENTIAL_ASSIGNMENT, "[redacted-credential]");
  msg = msg.replace(BEARER, "Bearer [redacted]");
  return msg;
}
