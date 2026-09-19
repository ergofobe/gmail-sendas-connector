/**
 * Minimal stdio MCP (newline-delimited JSON-RPC 2.0).
 * No @modelcontextprotocol/sdk — four tools do not need the extra surface.
 */

import { createGmailClient, createTokenSource } from "./gmail.js";
import { missingOAuthVars, safeErrorMessage } from "./secrets.js";

export const PROTOCOL_VERSION = "2025-03-26";
export const SERVER_INFO = { name: "gmail-sendas", version: "1.2.0" };

const ATTACHMENT_ITEMS_SCHEMA = {
  type: "array",
  description:
    "Outbound files to attach (multipart/mixed). Prefer local path; otherwise contentBase64/content + filename + mimeType. mimeType is inferred from .pdf/.jpg/.jpeg/.png when omitted. Rejected if the combined MIME exceeds Gmail's ~25MB limit.",
  items: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Local file path (preferred), e.g. /workspace/outbox/invoice.PDF",
      },
      filename: {
        type: "string",
        description:
          "Recipient-visible filename; defaults to the path basename",
      },
      mimeType: {
        type: "string",
        description:
          "MIME type. Inferred from extension for pdf/jpg/jpeg/png; required (or application/octet-stream) for other types",
      },
      contentBase64: {
        type: "string",
        description:
          "Standard base64 of the file bytes when no local path is available",
      },
      content: {
        type: "string",
        description: "Alias of contentBase64",
      },
    },
  },
};

export const TOOL_DEFS = [
  {
    name: "list_send_as",
    description:
      "List Gmail sendAs aliases (GET users.me.settings.sendAs). Use this plugin only for sendAs + in-thread reply_send_as + attachment bytes. Use stock Gmail MCP for inbox search, labels, and triage.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "send_as",
    description:
      "Send a new message From a Workspace sendAs alias via users.messages.send (RFC2822 MIME raw, base64url). Required: from (alias email), to, subject, and body text and/or html. Optional: cc, bcc, attachments (local path preferred; contentBase64 fallback). First-class attach types: PDF, JPG/JPEG, PNG. Combined message must be under ~25MB. Returns message id (and threadId) only — never tokens or file bytes. For in-thread replies that must From the landed alias, use reply_send_as instead of stock Gmail reply.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "sendAs alias email; written to the From header",
        },
        to: {
          type: "string",
          description: "Recipient email(s), comma-separated",
        },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body" },
        html: {
          type: "string",
          description: "HTML body (with or instead of body)",
        },
        cc: { type: "string" },
        bcc: { type: "string" },
        attachments: ATTACHMENT_ITEMS_SCHEMA,
      },
      required: ["from", "to", "subject"],
    },
  },
  {
    name: "reply_send_as",
    description:
      "Reply in an existing Gmail thread From the address the mail landed on (or an explicit sendAs alias). Required: messageId (inbound Gmail message to reply to) and body and/or html. Optional: threadId (defaults to the parent message threadId), from, to, cc, bcc, replyAll, attachments (same shape as send_as). From resolution: explicit from if provided (must be a sendAs alias); else first of Delivered-To, X-Original-To, To that matches a sendAs alias (case-insensitive). Sends via users.messages.send with threadId plus In-Reply-To/References. Returns { id, threadId } only. Use instead of stock Gmail reply when the inbound landed on an alias (e.g. logistics) rather than the primary mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description:
            "Required. Gmail id of the inbound message to reply to. threadId is optional and is taken from this message when omitted.",
        },
        threadId: {
          type: "string",
          description:
            "Optional Gmail thread id. If omitted, uses the parent message's threadId so the reply stays in-thread.",
        },
        from: {
          type: "string",
          description:
            "Optional Workspace sendAs alias. If omitted, inferred from the inbound Delivered-To, then X-Original-To, then To (first that matches a sendAs alias, case-insensitive).",
        },
        to: {
          type: "string",
          description:
            "Optional. Defaults to the parent Reply-To or From (reply-to-sender).",
        },
        cc: { type: "string" },
        bcc: { type: "string" },
        replyAll: {
          type: "boolean",
          description:
            "If true and cc is omitted, Cc the original To/Cc except our sendAs address and the To recipient.",
        },
        body: { type: "string", description: "Plain-text body" },
        html: {
          type: "string",
          description: "HTML body (with or instead of body)",
        },
        attachments: ATTACHMENT_ITEMS_SCHEMA,
      },
      required: ["messageId"],
    },
  },
  {
    name: "get_attachment",
    description:
      "Download Gmail attachment bytes (GET users.me.messages.attachments). Stock Gmail MCP cannot return file bytes. Decodes base64url; writes to disk when path is set; returns size, filename, attachmentId, and standard base64.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        attachmentId: { type: "string" },
        filename: { type: "string" },
        path: {
          type: "string",
          description: "If set, write decoded bytes to this file (or directory)",
        },
      },
      required: ["messageId", "attachmentId"],
    },
  },
];

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof createGmailClient>} [opts.client]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createToolRunner({
  client,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const gmail =
    client ||
    createGmailClient({
      getAccessToken: createTokenSource({ env, fetchImpl }),
      fetchImpl,
      env,
    });

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   */
  return async function runTool(name, args = {}) {
    switch (name) {
      case "list_send_as":
        return { sendAs: await gmail.listSendAs() };
      case "send_as":
        return gmail.sendAs({
          from: /** @type {string} */ (args.from),
          to: /** @type {string} */ (args.to),
          subject: /** @type {string} */ (args.subject),
          body: /** @type {string|undefined} */ (args.body),
          html: /** @type {string|undefined} */ (args.html),
          cc: /** @type {string|undefined} */ (args.cc),
          bcc: /** @type {string|undefined} */ (args.bcc),
          attachments: args.attachments,
        });
      case "reply_send_as":
        return gmail.replyAs({
          messageId: /** @type {string} */ (args.messageId),
          threadId: /** @type {string|undefined} */ (args.threadId),
          from: /** @type {string|undefined} */ (args.from),
          to: /** @type {string|undefined} */ (args.to),
          cc: /** @type {string|undefined} */ (args.cc),
          bcc: /** @type {string|undefined} */ (args.bcc),
          replyAll: args.replyAll === true || args.replyAll === "true",
          body: /** @type {string|undefined} */ (args.body),
          html: /** @type {string|undefined} */ (args.html),
          attachments: args.attachments,
        });
      case "get_attachment":
        return gmail.getAttachment({
          messageId: /** @type {string} */ (args.messageId),
          attachmentId: /** @type {string} */ (args.attachmentId),
          filename: /** @type {string|undefined} */ (args.filename),
          path: /** @type {string|undefined} */ (args.path),
        });
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof createToolRunner>} [opts.runTool]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function createMessageHandler({ runTool, env = process.env } = {}) {
  const dispatch = runTool || createToolRunner({ env });

  /**
   * @param {object} message
   * @returns {Promise<object|null>}
   */
  return async function handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0") return null;
    if (message.method === undefined && message.id === undefined) return null;

    const isNotification = message.id === undefined || message.id === null;
    try {
      if (message.method === "initialize") {
        const requested = message.params && message.params.protocolVersion;
        return result(message, {
          protocolVersion: requested || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }
      if (message.method === "notifications/initialized" || message.method === "initialized") {
        return null;
      }
      if (message.method === "ping") {
        return isNotification ? null : result(message, {});
      }
      if (message.method === "tools/list") {
        return result(message, { tools: TOOL_DEFS });
      }
      if (message.method === "tools/call") {
        const name = message.params && message.params.name;
        const args = (message.params && message.params.arguments) || {};
        try {
          const value = await dispatch(name, args);
          return result(message, {
            content: [{ type: "text", text: JSON.stringify(value) }],
          });
        } catch (err) {
          return result(message, {
            content: [{ type: "text", text: safeErrorMessage(err, env) }],
            isError: true,
          });
        }
      }
      if (isNotification) return null;
      return rpcError(message, -32601, `Method not found: ${message.method}`);
    } catch (err) {
      if (isNotification) return null;
      return rpcError(message, -32603, safeErrorMessage(err, env));
    }
  };
}

function result(message, value) {
  return { jsonrpc: "2.0", id: message.id, result: value };
}

function rpcError(message, code, errMessage) {
  return {
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: errMessage },
  };
}

/**
 * Parse stdio bytes: Content-Length framing and newline-delimited JSON.
 * @param {(msg: object) => void} onMessage
 */
export function createStdioParser(onMessage) {
  let buffer = Buffer.alloc(0);

  /**
   * @param {Buffer|string} chunk
   */
  function push(chunk) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const len = Number(match[1]);
          const start = headerEnd + 4;
          if (buffer.length < start + len) return;
          const json = buffer.subarray(start, start + len).toString("utf8");
          buffer = buffer.subarray(start + len);
          emit(json);
          continue;
        }
      }

      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line || /^Content-Length:/i.test(line)) continue;
      emit(line);
    }
  }

  /**
   * @param {string} json
   */
  function emit(json) {
    try {
      onMessage(JSON.parse(json));
    } catch {
      // ignore malformed frames
    }
  }

  return { push };
}

/**
 * @param {object} opts
 * @param {NodeJS.ReadStream|import('node:stream').Readable} opts.stdin
 * @param {NodeJS.WriteStream|import('node:stream').Writable} opts.stdout
 * @param {NodeJS.WriteStream|import('node:stream').Writable} [opts.stderr]
 * @param {ReturnType<typeof createMessageHandler>} [opts.handleMessage]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function startServer({
  stdin,
  stdout,
  stderr,
  handleMessage,
  env = process.env,
}) {
  const handle = handleMessage || createMessageHandler({ env });
  const missing = missingOAuthVars(env);
  if (missing.length > 0 && stderr) {
    stderr.write(
      `gmail-sendas: missing ${missing.join(", ")}. Set them in Cursor → Plugins → Configure.\n`
    );
  }

  let queue = Promise.resolve();
  const parser = createStdioParser((msg) => {
    queue = queue
      .then(async () => {
        const reply = await handle(msg);
        if (reply) {
          stdout.write(`${JSON.stringify(reply)}\n`);
        }
      })
      .catch((err) => {
        if (stderr) stderr.write(`${safeErrorMessage(err, env)}\n`);
      });
  });

  stdin.on("data", (chunk) => parser.push(chunk));
  return { parser };
}
