#!/usr/bin/env node
/**
 * One-time local OAuth helper.
 *
 * Prints ONLY the refresh token to stdout (once). Instructions go to stderr.
 * Never commit the token; paste it into Cursor → Plugins → Configure.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/oauth-setup.js
 */

import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.OAUTH_PORT || 53682);
const REDIRECT_URI =
  process.env.OAUTH_REDIRECT_URI || `http://127.0.0.1:${PORT}/oauth2callback`;

export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

function usage() {
  console.error(`gmail-sendas OAuth setup (one-time)

This helper signs in a Google Workspace user who owns the sendAs aliases
and prints ONLY a refresh token to stdout.

Usage:
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/oauth-setup.js

Google Cloud Console (generic):
  1. Enable the Gmail API
  2. Configure the OAuth consent screen (Internal for Workspace)
  3. Create an OAuth client (Desktop app, or Web)
  4. Add authorized redirect URI: ${REDIRECT_URI}
  5. Export GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then re-run this script
  6. Sign in as the Workspace user that should send mail
  7. Paste the printed refresh token into Cursor → Plugins → Configure
     (with the same client id/secret). Never commit tokens.

If Google omits a refresh token, revoke the app at
https://myaccount.google.com/permissions and re-run (access_type=offline,
prompt=consent).
`);
}

/**
 * @param {string} clientId
 * @returns {string}
 */
export function buildAuthUrl(clientId) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

/**
 * @param {{ clientId: string, clientSecret: string, code: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<string>}
 */
export async function exchangeCode({
  clientId,
  clientSecret,
  code,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const codeLabel = json.error || res.status;
    throw new Error(
      `Token exchange failed (${codeLabel}). Check client id/secret and redirect URI.`
    );
  }
  if (!json.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke the app under Google Account → Apps with access and re-run with prompt=consent."
    );
  }
  return String(json.refresh_token);
}

async function main() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    usage();
    process.exitCode = 1;
    return;
  }

  const authUrl = buildAuthUrl(clientId);
  console.error("Open this URL, sign in as the Workspace user, and approve:");
  console.error(authUrl);
  console.error("");
  console.error(`Listening for the redirect on ${REDIRECT_URI}`);

  const token = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
        if (reqUrl.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const errParam = reqUrl.searchParams.get("error");
        if (errParam) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("OAuth error. You can close this tab.");
          server.close();
          reject(new Error(`OAuth redirect error: ${errParam}`));
          return;
        }
        const code = reqUrl.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing code. You can close this tab.");
          server.close();
          reject(new Error("OAuth redirect missing code"));
          return;
        }
        const refreshToken = await exchangeCode({
          clientId,
          clientSecret,
          code,
        });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Authorized. Return to the terminal; the refresh token was printed there. You can close this tab.");
        server.close();
        resolve(refreshToken);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Token exchange failed. Check the terminal.");
        server.close();
        reject(err);
      }
    });
    server.listen(PORT, "127.0.0.1", () => {
      // URL already printed
    });
    server.on("error", reject);
  });

  // ONLY the refresh token on stdout.
  process.stdout.write(`${token}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = msg
      .replace(String(process.env.GOOGLE_CLIENT_SECRET || "___"), "[GOOGLE_CLIENT_SECRET]")
      .replace(String(process.env.GOOGLE_CLIENT_ID || "___"), "[GOOGLE_CLIENT_ID]");
    console.error(redacted);
    process.exitCode = 1;
  });
}
