/**
 * Thin Gmail REST helpers (fetch + refresh-token OAuth).
 * Zero npm runtime deps — googleapis is not used (the three endpoints do
 * not justify the install).
 *
 * @typedef {object} SendAs
 * @property {string} sendAsEmail
 * @property {string} [displayName]
 * @property {boolean} [isPrimary]
 * @property {boolean} [isDefault]
 * @property {string} [verificationStatus]
 *
 * @typedef {object} SendResult
 * @property {string} id
 * @property {string} [threadId]
 *
 * @typedef {object} AttachmentBody
 * @property {number} size
 * @property {string} data standard base64 of decoded bytes
 * @property {string} attachmentId
 * @property {string} [filename]
 * @property {string} [path] disk path when a write was requested
 *
 * @typedef {object} SendAsArgs
 * @property {string} from sendAs alias email (becomes the From header)
 * @property {string} to
 * @property {string} subject
 * @property {string} [body] plain-text body
 * @property {string} [html] HTML body (used with or instead of body)
 * @property {string} [cc]
 * @property {string} [bcc]
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { requireCreds, safeErrorMessage } from "./secrets.js";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

const SEND_ENDPOINT = `${GMAIL_API}/users/me/messages/send`;
const SEND_AS_ENDPOINT = `${GMAIL_API}/users/me/settings/sendAs`;

/**
 * @param {string|Buffer} input
 * @returns {string}
 */
export function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Decode Gmail's base64url attachment payload (padding optional).
 * @param {string} data
 * @returns {Buffer}
 */
export function fromBase64Url(data) {
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("Attachment payload is empty");
  }
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * @param {unknown} payload
 * @returns {SendAs[]}
 */
export function parseSendAsList(payload) {
  const rows = payload && Array.isArray(payload.sendAs) ? payload.sendAs : [];
  return rows.map((row) => ({
    sendAsEmail: String(row.sendAsEmail || ""),
    displayName: row.displayName != null ? String(row.displayName) : "",
    isPrimary: Boolean(row.isPrimary),
    isDefault: Boolean(row.isDefault),
    verificationStatus:
      row.verificationStatus != null ? String(row.verificationStatus) : "",
  }));
}

/**
 * @param {unknown} payload
 * @returns {SendResult}
 */
export function parseSendResult(payload) {
  if (!payload || typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error("Gmail messages.send did not return a message id");
  }
  /** @type {SendResult} */
  const result = { id: payload.id };
  if (typeof payload.threadId === "string" && payload.threadId.length > 0) {
    result.threadId = payload.threadId;
  }
  return result;
}

/**
 * @param {string} name
 * @param {string} [value]
 */
function assertSingleLine(name, value) {
  if (value == null || value === "") return;
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${name}: value must be a single line`);
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeAddrs(value) {
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * RFC 2047 encode non-ASCII subjects.
 * @param {string} subject
 * @returns {string}
 */
export function encodeSubject(subject) {
  if (!/[^\x20-\x7E]/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/**
 * Build an RFC2822 MIME message. From is set to the sendAs alias email.
 * @param {SendAsArgs} args
 * @param {{ boundary?: string }} [opts]
 * @returns {string}
 */
export function buildRfc2822(args, opts = {}) {
  const from = String(args.from || "").trim();
  const to = String(args.to || "").trim();
  const subject = args.subject == null ? "" : String(args.subject);
  const text = args.body == null ? "" : String(args.body);
  const html = args.html == null ? "" : String(args.html);

  if (!from) throw new Error("from is required (sendAs alias email)");
  if (!to) throw new Error("to is required");
  if (!subject) throw new Error("subject is required");
  if (!text && !html) throw new Error("body and/or html is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new Error("from must be a sendAs alias email address");
  }

  assertSingleLine("from", from);
  assertSingleLine("to", to);
  assertSingleLine("subject", subject);
  assertSingleLine("cc", args.cc);
  assertSingleLine("bcc", args.bcc);

  const headers = [
    `From: ${from}`,
    `To: ${normalizeAddrs(to)}`,
  ];
  if (args.cc) headers.push(`Cc: ${normalizeAddrs(args.cc)}`);
  if (args.bcc) headers.push(`Bcc: ${normalizeAddrs(args.bcc)}`);
  headers.push(`Subject: ${encodeSubject(subject)}`);
  headers.push("MIME-Version: 1.0");

  if (text && html) {
    const boundary = opts.boundary || `ss_${randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }

  if (html) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 8bit");
    return [...headers, "", html, ""].join("\r\n");
  }

  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 8bit");
  return [...headers, "", text, ""].join("\r\n");
}

/**
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @returns {() => Promise<string>}
 */
export function createTokenSource({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  let cached = { token: "", expiresAt: 0 };

  return async function getAccessToken() {
    const creds = requireCreds(env);
    if (cached.token && now() < cached.expiresAt - 30_000) {
      return cached.token;
    }

    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.GOOGLE_CLIENT_ID,
          client_secret: creds.GOOGLE_CLIENT_SECRET,
          refresh_token: creds.GOOGLE_REFRESH_TOKEN,
          grant_type: "refresh_token",
        }),
      });
    } catch (err) {
      throw new Error(`OAuth token refresh failed: ${safeErrorMessage(err, env)}`);
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const code = json.error || res.status;
      throw new Error(
        `OAuth token refresh failed (${code}). Check Cursor → Plugins → Configure. Details omitted.`
      );
    }

    cached = {
      token: json.access_token,
      expiresAt: now() + (Number(json.expires_in) || 3600) * 1000,
    };
    return cached.token;
  };
}

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getAccessToken
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function createGmailClient({
  getAccessToken,
  fetchImpl = fetch,
  env = process.env,
}) {
  /**
   * @param {string} url
   * @param {RequestInit} [init]
   */
  async function gmailFetch(url, init = {}) {
    const token = await getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    };
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers });
    } catch (err) {
      throw new Error(`Gmail request failed: ${safeErrorMessage(err, env)}`);
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMsg =
        json.error && typeof json.error.message === "string"
          ? json.error.message
          : `HTTP ${res.status}`;
      throw new Error(`Gmail API error (${res.status}): ${apiMsg}`);
    }
    return json;
  }

  return {
    /**
     * GET users.me.settings.sendAs
     * @returns {Promise<SendAs[]>}
     */
    async listSendAs() {
      const payload = await gmailFetch(SEND_AS_ENDPOINT);
      return parseSendAsList(payload);
    },

    /**
     * POST users.messages.send with RFC2822 raw (base64url).
     * @param {SendAsArgs} args
     * @param {{ boundary?: string }} [mimeOpts]
     * @returns {Promise<SendResult>}
     */
    async sendAs(args, mimeOpts) {
      const mime = buildRfc2822(args, mimeOpts);
      const payload = await gmailFetch(SEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: toBase64Url(mime) }),
      });
      return parseSendResult(payload);
    },

    /**
     * GET users.me.messages.attachments + optional disk write.
     * @param {{ messageId: string, attachmentId: string, filename?: string, path?: string }} args
     * @returns {Promise<AttachmentBody>}
     */
    async getAttachment(args) {
      const messageId = String(args.messageId || "").trim();
      const attachmentId = String(args.attachmentId || "").trim();
      if (!messageId) throw new Error("messageId is required");
      if (!attachmentId) throw new Error("attachmentId is required");

      const url =
        `${GMAIL_API}/users/me/messages/` +
        `${encodeURIComponent(messageId)}/attachments/` +
        `${encodeURIComponent(attachmentId)}`;
      const payload = await gmailFetch(url);
      const bytes = fromBase64Url(String(payload.data || ""));
      const filename = args.filename ? String(args.filename) : "attachment";

      /** @type {AttachmentBody} */
      const result = {
        size: Number(payload.size) || bytes.length,
        data: bytes.toString("base64"),
        attachmentId,
        filename,
      };

      if (args.path) {
        const dest = await resolveWritePath(String(args.path), filename);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        result.path = dest;
        result.size = bytes.length;
      }

      return result;
    },
  };
}

/**
 * @param {string} dest
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function resolveWritePath(dest, filename) {
  try {
    const info = await stat(dest);
    if (info.isDirectory()) return path.join(dest, filename);
  } catch {
    // dest does not exist yet — treat as a file path
  }
  return dest;
}

/**
 * Inspect a captured messages.send fetch for tests.
 * @param {{ url: string, init: RequestInit }} call
 */
export function inspectSendCall(call) {
  const url = String(call.url);
  const init = call.init || {};
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  const mime = Buffer.from(String(body.raw || ""), "base64url").toString("utf8");
  return { url, method: init.method || "GET", body, mime };
}
