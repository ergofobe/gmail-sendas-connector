/**
 * Thin Gmail REST helpers (fetch + refresh-token OAuth).
 * Zero npm runtime deps — googleapis is not used (these REST endpoints do
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
 * @typedef {object} SendAttachmentInput
 * @property {string} [path] local file path (preferred)
 * @property {string} [filename] override of the recipient-visible name
 * @property {string} [mimeType] inferred from extension for pdf/jpg/jpeg/png
 * @property {string} [contentBase64] standard (or base64url) file bytes
 * @property {string} [content] alias of contentBase64
 *
 * @typedef {object} ResolvedAttachment
 * @property {string} filename
 * @property {string} mimeType
 * @property {Buffer} bytes
 *
 * @typedef {object} SendAsArgs
 * @property {string} from sendAs alias email (becomes the From header)
 * @property {string} to
 * @property {string} subject
 * @property {string} [body] plain-text body
 * @property {string} [html] HTML body (used with or instead of body)
 * @property {string} [cc]
 * @property {string} [bcc]
 * @property {string} [inReplyTo] RFC Message-ID of the parent (reply threading)
 * @property {string} [references] RFC References chain (reply threading)
 * @property {SendAttachmentInput[]|SendAttachmentInput|ResolvedAttachment[]} [attachments]
 *
 * @typedef {object} ReplyAsArgs
 * @property {string} messageId inbound Gmail message id to reply to (required)
 * @property {string} [threadId] optional; defaults to the parent message threadId
 * @property {string} [from] explicit Workspace sendAs alias
 * @property {string} [to] default: parent Reply-To or From (reply-to-sender)
 * @property {string} [cc]
 * @property {string} [bcc]
 * @property {boolean} [replyAll]
 * @property {string} [body]
 * @property {string} [html]
 * @property {SendAttachmentInput[]|SendAttachmentInput|ResolvedAttachment[]} [attachments]
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { requireCreds, safeErrorMessage } from "./secrets.js";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Gmail combined message size limit (headers + body + encoded attachments). */
export const GMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

const PRIMARY_MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const SEND_ENDPOINT = `${GMAIL_API}/users/me/messages/send`;
const SEND_AS_ENDPOINT = `${GMAIL_API}/users/me/settings/sendAs`;

/** Parent headers fetched for From inference + RFC2822 reply threading. */
export const REPLY_METADATA_HEADERS = [
  "Delivered-To",
  "X-Original-To",
  "To",
  "From",
  "Reply-To",
  "Cc",
  "Bcc",
  "Subject",
  "Message-ID",
  "References",
  "In-Reply-To",
];

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
 * @param {unknown} value
 * @returns {string[]}
 */
export function extractEmails(value) {
  if (value == null || String(value).trim() === "") return [];
  const found = String(value).match(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
  );
  return found ? found.slice() : [];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Case-insensitive match of an address (or `Name <addr>` header) to sendAs.
 * @param {unknown} emailOrHeader
 * @param {SendAs[]} aliases
 * @returns {SendAs|null}
 */
export function matchSendAs(emailOrHeader, aliases) {
  const extracted = extractEmails(emailOrHeader);
  const needle = normalizeEmail(
    extracted[0] || String(emailOrHeader || "").trim()
  );
  if (!needle) return null;
  const list = Array.isArray(aliases) ? aliases : [];
  return list.find((row) => row && normalizeEmail(row.sendAsEmail) === needle) || null;
}

/**
 * @param {unknown} source Gmail message, { headers }, or header array
 * @returns {Record<string, string[]>}
 */
export function collectHeaders(source) {
  /** @type {unknown[]} */
  let list = [];
  if (Array.isArray(source)) {
    list = source;
  } else if (source && typeof source === "object") {
    const obj = /** @type {{ payload?: { headers?: unknown[] }, headers?: unknown[] }} */ (source);
    if (obj.payload && Array.isArray(obj.payload.headers)) {
      list = obj.payload.headers;
    } else if (Array.isArray(obj.headers)) {
      list = obj.headers;
    }
  }
  /** @type {Record<string, string[]>} */
  const map = {};
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = /** @type {{ name?: unknown, value?: unknown }} */ (row);
    const key = String(rec.name || "").trim().toLowerCase();
    if (!key) continue;
    if (!map[key]) map[key] = [];
    map[key].push(String(rec.value ?? ""));
  }
  return map;
}

/**
 * @param {Record<string, string[]>} headers
 * @param {string} name
 * @returns {string[]}
 */
export function headerValues(headers, name) {
  if (!headers || typeof headers !== "object") return [];
  return headers[String(name).toLowerCase()] || [];
}

/**
 * @param {Record<string, string[]>} headers
 * @param {string} name
 * @returns {string}
 */
export function firstHeader(headers, name) {
  const values = headerValues(headers, name);
  return values.length > 0 ? values[0] : "";
}

/**
 * Landed-address candidates in spec order: Delivered-To, X-Original-To, To.
 * @param {Record<string, string[]>} headers
 * @returns {string[]}
 */
export function collectLandedAddresses(headers) {
  const ordered = [];
  const seen = new Set();
  for (const name of ["delivered-to", "x-original-to", "to"]) {
    for (const value of headerValues(headers, name)) {
      for (const email of extractEmails(value)) {
        const norm = normalizeEmail(email);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        ordered.push(email);
      }
    }
  }
  return ordered;
}

/**
 * Resolve the From alias for reply_send_as.
 * 1. Explicit `from` must be a sendAs alias.
 * 2. Else first landed header (Delivered-To, X-Original-To, To) that matches sendAs.
 * 3. Else fail — caller must pass explicit from.
 *
 * @param {unknown} explicitFrom
 * @param {Record<string, string[]>} headers
 * @param {SendAs[]} aliases
 * @returns {string} canonical sendAsEmail
 */
export function resolveReplyFrom(explicitFrom, headers, aliases) {
  const list = Array.isArray(aliases) ? aliases : [];

  if (explicitFrom != null && String(explicitFrom).trim() !== "") {
    const wanted = String(explicitFrom).trim();
    const match = matchSendAs(wanted, list);
    if (!match) {
      throw new Error(
        `from (${wanted}) is not an allowed sendAs alias on this mailbox. Call list_send_as and pass a verified from.`
      );
    }
    return match.sendAsEmail;
  }

  const landed = collectLandedAddresses(headers);
  for (const addr of landed) {
    const match = matchSendAs(addr, list);
    if (match) return match.sendAsEmail;
  }

  const shown =
    landed.length > 0
      ? landed.join(", ")
      : "(none found in Delivered-To / X-Original-To / To)";
  throw new Error(
    `Could not infer a sendAs From address. Landed address ${shown} is not a sendAs alias on this mailbox. Pass explicit from (a verified sendAs from list_send_as).`
  );
}

/**
 * @param {string} [original]
 * @returns {string}
 */
export function replySubject(original) {
  const subject = original == null ? "" : String(original).trim();
  if (!subject) return "Re:";
  if (/^re\s*:/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/**
 * @param {string} id
 * @returns {string}
 */
export function ensureAngleAddr(id) {
  const value = String(id || "").trim();
  if (!value) return "";
  if (value.startsWith("<") && value.endsWith(">")) return value;
  return `<${value}>`;
}

/**
 * @param {Record<string, string[]>} headers
 * @returns {{ inReplyTo: string, references: string }}
 */
export function buildThreadingHeaders(headers) {
  const messageId = firstHeader(headers, "message-id").trim();
  const existingRefs = firstHeader(headers, "references").trim();
  const inReplyTo = messageId ? ensureAngleAddr(messageId) : "";
  const tokens = existingRefs ? existingRefs.split(/\s+/).filter(Boolean) : [];
  const normalized = tokens.map(ensureAngleAddr).filter(Boolean);
  if (inReplyTo && !normalized.some((token) => token === inReplyTo)) {
    normalized.push(inReplyTo);
  }
  return { inReplyTo, references: normalized.join(" ") };
}

/**
 * Default To is Reply-To, else From (reply-to-sender).
 * replyAll fills Cc from original To/Cc minus ourselves and the To recipient.
 *
 * @param {object} args
 * @param {unknown} [args.to]
 * @param {unknown} [args.cc]
 * @param {unknown} [args.bcc]
 * @param {unknown} [args.replyAll]
 * @param {Record<string, string[]>} headers
 * @param {string} fromEmail
 * @returns {{ to: string, cc?: string, bcc?: string }}
 */
export function resolveReplyRecipients(args, headers, fromEmail) {
  const fromNorm = normalizeEmail(fromEmail);
  const explicitTo = args && args.to != null ? String(args.to).trim() : "";
  const to = explicitTo || defaultReplyTo(headers);
  if (!to) {
    throw new Error(
      "Could not determine reply To address from the parent From/Reply-To. Pass to explicitly."
    );
  }

  const explicitCc = args && args.cc != null ? String(args.cc).trim() : "";
  let cc = explicitCc;
  if (!cc && args && (args.replyAll === true || args.replyAll === "true")) {
    cc = buildReplyAllCc(headers, to, fromNorm);
  }

  const bcc = args && args.bcc != null ? String(args.bcc).trim() : "";
  /** @type {{ to: string, cc?: string, bcc?: string }} */
  const result = { to };
  if (cc) result.cc = cc;
  if (bcc) result.bcc = bcc;
  return result;
}

/**
 * @param {Record<string, string[]>} headers
 * @returns {string}
 */
function defaultReplyTo(headers) {
  const replyTo = firstHeader(headers, "reply-to").trim();
  if (replyTo) return replyTo;
  return firstHeader(headers, "from").trim();
}

/**
 * @param {Record<string, string[]>} headers
 * @param {string} toHeader
 * @param {string} fromNorm
 * @returns {string}
 */
function buildReplyAllCc(headers, toHeader, fromNorm) {
  const skip = new Set(extractEmails(toHeader).map(normalizeEmail));
  skip.add(fromNorm);
  const extras = [...headerValues(headers, "to"), ...headerValues(headers, "cc")];
  const keep = [];
  const seen = new Set();
  for (const value of extras) {
    for (const email of extractEmails(value)) {
      const norm = normalizeEmail(email);
      if (!norm || skip.has(norm) || seen.has(norm)) continue;
      seen.add(norm);
      keep.push(email);
    }
  }
  return keep.join(", ");
}

/**
 * GET users.me.messages/{id} (metadata + reply headers).
 * @param {string} messageId
 * @returns {string}
 */
export function messageGetUrl(messageId) {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of REPLY_METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  return (
    `${GMAIL_API}/users/me/messages/` +
    `${encodeURIComponent(messageId)}?${params.toString()}`
  );
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
 * Infer or validate a MIME type. First-class: PDF, JPG/JPEG, PNG.
 * @param {string} [filename]
 * @param {string} [explicit]
 * @returns {string}
 */
export function inferMimeType(filename, explicit) {
  if (explicit != null && String(explicit).trim() !== "") {
    const mimeType = String(explicit).trim();
    assertMimeType(mimeType);
    return mimeType;
  }
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (PRIMARY_MIME_BY_EXT[ext]) return PRIMARY_MIME_BY_EXT[ext];
  if (filename) return "application/octet-stream";
  throw new Error("mimeType is required when it cannot be inferred from filename");
}

/**
 * @param {string} mimeType
 */
function assertMimeType(mimeType) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9!#$&\-^_.+]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&\-^_.+]{0,126}$/.test(
      mimeType
    )
  ) {
    throw new Error("Invalid mimeType");
  }
}

/**
 * Recipient-visible filename only (basename, no CR/LF/quotes).
 * @param {string} name
 * @returns {string}
 */
export function sanitizeAttachmentFilename(name) {
  const base = path.posix.basename(String(name || "").replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === "..") {
    throw new Error("Attachment filename is required");
  }
  if (/[\r\n"]/.test(base)) {
    throw new Error("Invalid attachment filename");
  }
  return base;
}

/**
 * Decode standard or base64url attachment bytes. Never echoes the payload.
 * @param {string} encoded
 * @returns {Buffer}
 */
export function decodeAttachmentContent(encoded) {
  if (typeof encoded !== "string" || encoded.trim() === "") {
    throw new Error("Attachment content is empty");
  }
  const compact = encoded.replace(/\s+/g, "");
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length === 0) {
    throw new Error("Attachment content is not valid base64");
  }
  return bytes;
}

/**
 * @param {unknown} attachments
 * @returns {unknown[]}
 */
function asAttachmentList(attachments) {
  if (attachments == null || attachments === "") return [];
  if (Array.isArray(attachments)) return attachments;
  return [attachments];
}

/**
 * Read path-based attachments and decode base64 fallbacks.
 * Errors mention filename/code only — never file bytes or OAuth tokens.
 * @param {unknown} attachments
 * @returns {Promise<ResolvedAttachment[]>}
 */
export async function resolveSendAttachments(attachments) {
  const list = asAttachmentList(attachments);
  /** @type {ResolvedAttachment[]} */
  const resolved = [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Each attachment must be an object with path or contentBase64");
    }
    const destPath =
      raw.path != null && String(raw.path).trim() !== ""
        ? String(raw.path).trim()
        : "";
    const encoded = raw.contentBase64 ?? raw.content;
    let filename = raw.filename != null ? String(raw.filename).trim() : "";
    /** @type {Buffer} */
    let bytes;

    if (destPath) {
      if (!filename) filename = path.basename(destPath);
      try {
        bytes = await readFile(destPath);
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err && err.code
          ? ` (${err.code})`
          : "";
        let label = "attachment";
        try {
          label = sanitizeAttachmentFilename(filename || path.basename(destPath));
        } catch {
          // keep generic label
        }
        throw new Error(`Cannot read attachment file ${label}${code}`);
      }
    } else if (Buffer.isBuffer(raw.bytes)) {
      bytes = raw.bytes;
      if (!filename) {
        throw new Error("filename is required when attaching file bytes");
      }
    } else if (encoded != null && String(encoded).length > 0) {
      bytes = decodeAttachmentContent(String(encoded));
      if (!filename) {
        throw new Error("filename is required when attaching via contentBase64/content");
      }
    } else {
      throw new Error("Each attachment needs a local file path or contentBase64/content");
    }

    const mimeType = inferMimeType(filename, raw.mimeType);
    resolved.push({
      filename: sanitizeAttachmentFilename(filename),
      mimeType,
      bytes,
    });
  }

  return resolved;
}

/**
 * @param {unknown} att
 * @returns {ResolvedAttachment}
 */
function coerceResolvedAttachment(att) {
  if (!att || typeof att !== "object") {
    throw new Error("Each attachment must be an object with path or contentBase64");
  }
  if (Buffer.isBuffer(att.bytes)) {
    const filename = sanitizeAttachmentFilename(
      att.filename || (att.path ? path.basename(String(att.path)) : "")
    );
    return {
      filename,
      mimeType: inferMimeType(filename, att.mimeType),
      bytes: att.bytes,
    };
  }
  if (att.contentBase64 != null || att.content != null) {
    const filename = sanitizeAttachmentFilename(att.filename || "");
    return {
      filename,
      mimeType: inferMimeType(filename, att.mimeType),
      bytes: decodeAttachmentContent(String(att.contentBase64 ?? att.content)),
    };
  }
  throw new Error("Attachment path must be resolved before building MIME");
}

/**
 * @param {ResolvedAttachment[]} attachments
 */
function assertAttachmentsFit(attachments) {
  let total = 0;
  for (const att of attachments) {
    total += att.bytes.length;
    if (total > GMAIL_MAX_MESSAGE_BYTES) {
      throw new Error(
        `Message exceeds Gmail's ~25MB combined size limit (${GMAIL_MAX_MESSAGE_BYTES} bytes). Remove or shrink attachments.`
      );
    }
  }
}

/**
 * @param {string} mime
 */
export function assertWithinGmailSize(mime) {
  const size = Buffer.byteLength(mime, "utf8");
  if (size > GMAIL_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Message is ${size} bytes and exceeds Gmail's ~25MB combined size limit (${GMAIL_MAX_MESSAGE_BYTES} bytes). Remove or shrink attachments.`
    );
  }
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function foldBase64(bytes) {
  const b64 = bytes.toString("base64");
  return b64.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

/**
 * @param {string} text
 * @param {string} html
 * @param {{ boundary?: string }} [opts]
 * @returns {string}
 */
function buildBodyEntity(text, html, opts = {}) {
  if (text && html) {
    const boundary = opts.boundary || `alt_${randomBytes(12).toString("hex")}`;
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
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
    ].join("\r\n");
  }
  if (html) {
    return [
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
    ].join("\r\n");
  }
  return [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
  ].join("\r\n");
}

/**
 * @param {ResolvedAttachment} att
 * @returns {string}
 */
function buildAttachmentEntity(att) {
  return [
    `Content-Type: ${att.mimeType}; name="${att.filename}"`,
    `Content-Disposition: attachment; filename="${att.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(att.bytes),
  ].join("\r\n");
}

/**
 * Build an RFC2822 MIME message. From is set to the sendAs alias email.
 * With attachments, uses multipart/mixed (body + attachment parts).
 * @param {SendAsArgs} args
 * @param {{ boundary?: string, mixedBoundary?: string, altBoundary?: string }} [opts]
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

  const attachments = asAttachmentList(args.attachments).map(coerceResolvedAttachment);
  assertAttachmentsFit(attachments);

  const headers = [
    `From: ${from}`,
    `To: ${normalizeAddrs(to)}`,
  ];
  if (args.cc) headers.push(`Cc: ${normalizeAddrs(args.cc)}`);
  if (args.bcc) headers.push(`Bcc: ${normalizeAddrs(args.bcc)}`);
  headers.push(`Subject: ${encodeSubject(subject)}`);
  if (args.inReplyTo) {
    const inReplyTo = String(args.inReplyTo).trim();
    assertSingleLine("In-Reply-To", inReplyTo);
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (args.references) {
    const references = String(args.references).trim();
    assertSingleLine("References", references);
    headers.push(`References: ${references}`);
  }
  headers.push("MIME-Version: 1.0");

  if (attachments.length === 0) {
    if (text && html) {
      const boundary = opts.boundary || `ss_${randomBytes(12).toString("hex")}`;
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      const mime = [
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
      assertWithinGmailSize(mime);
      return mime;
    }

    if (html) {
      headers.push('Content-Type: text/html; charset="UTF-8"');
      headers.push("Content-Transfer-Encoding: 8bit");
      const mime = [...headers, "", html, ""].join("\r\n");
      assertWithinGmailSize(mime);
      return mime;
    }

    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 8bit");
    const mime = [...headers, "", text, ""].join("\r\n");
    assertWithinGmailSize(mime);
    return mime;
  }

  const mixedBoundary =
    opts.mixedBoundary || opts.boundary || `mix_${randomBytes(12).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const parts = [
    buildBodyEntity(text, html, { boundary: opts.altBoundary }),
    ...attachments.map(buildAttachmentEntity),
  ];

  const mime = [
    ...headers,
    "",
    ...parts.flatMap((part) => [`--${mixedBoundary}`, part]),
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");

  assertWithinGmailSize(mime);
  return mime;
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
     * @param {{ boundary?: string, mixedBoundary?: string, altBoundary?: string }} [mimeOpts]
     * @returns {Promise<SendResult>}
     */
    async sendAs(args, mimeOpts) {
      const attachments = await resolveSendAttachments(args.attachments);
      const mime = buildRfc2822({ ...args, attachments }, mimeOpts);
      const payload = await gmailFetch(SEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: toBase64Url(mime) }),
      });
      return parseSendResult(payload);
    },

    /**
     * In-thread reply From a sendAs alias (inferred or explicit).
     * POST users.messages.send with { raw, threadId }.
     * @param {ReplyAsArgs} args
     * @param {{ boundary?: string, mixedBoundary?: string, altBoundary?: string }} [mimeOpts]
     * @returns {Promise<SendResult>}
     */
    async replyAs(args, mimeOpts) {
      const messageId = String(args.messageId || "").trim();
      if (!messageId) {
        throw new Error(
          "messageId is required (inbound Gmail message to reply to). threadId is optional."
        );
      }
      const text = args.body == null ? "" : String(args.body);
      const html = args.html == null ? "" : String(args.html);
      if (!text && !html) throw new Error("body and/or html is required");

      const [aliases, parent] = await Promise.all([
        this.listSendAs(),
        gmailFetch(messageGetUrl(messageId)),
      ]);

      const headers = collectHeaders(parent);
      const from = resolveReplyFrom(args.from, headers, aliases);
      const recipients = resolveReplyRecipients(args, headers, from);
      const subject = replySubject(firstHeader(headers, "Subject"));
      const threading = buildThreadingHeaders(headers);
      const threadId = String(args.threadId || parent.threadId || "").trim();
      if (!threadId) {
        throw new Error(
          "threadId is required to keep the reply in the Gmail thread; the parent message did not include one. Pass threadId."
        );
      }

      const attachments = await resolveSendAttachments(args.attachments);
      const mime = buildRfc2822(
        {
          from,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject,
          body: text || undefined,
          html: html || undefined,
          attachments,
          inReplyTo: threading.inReplyTo || undefined,
          references: threading.references || undefined,
        },
        mimeOpts
      );

      const payload = await gmailFetch(SEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: toBase64Url(mime), threadId }),
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
