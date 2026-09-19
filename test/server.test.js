import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMessageHandler,
  createStdioParser,
  createToolRunner,
  TOOL_DEFS,
} from "../src/server.js";
import { inspectSendCall } from "../src/gmail.js";
import { buildAuthUrl, exchangeCode, OAUTH_SCOPES } from "../scripts/oauth-setup.js";

describe("MCP surface", () => {
  it("lists exactly the four gap tools", async () => {
    const handle = createMessageHandler({
      runTool: async () => {
        throw new Error("should not run");
      },
    });
    const listed = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_attachment", "list_send_as", "send_as", "thread_send_as"]);
    assert.equal(TOOL_DEFS.length, 4);
    const sendAs = listed.result.tools.find((t) => t.name === "send_as");
    assert.ok(sendAs.inputSchema.properties.attachments);
    assert.ok(sendAs.inputSchema.properties.attachments.items.properties.path);
    assert.ok(sendAs.inputSchema.properties.attachments.items.properties.contentBase64);
    assert.deepEqual(sendAs.inputSchema.required, ["from", "to", "subject"]);
    const threadSendAs = listed.result.tools.find((t) => t.name === "thread_send_as");
    assert.deepEqual(threadSendAs.inputSchema.required, ["messageId"]);
    assert.ok(threadSendAs.inputSchema.properties.from);
    assert.ok(threadSendAs.inputSchema.properties.replyAll);
    assert.ok(threadSendAs.inputSchema.properties.attachments);
    assert.ok(threadSendAs.inputSchema.properties.attachments.items.properties.path);
    assert.ok(threadSendAs.inputSchema.properties.attachments.items.properties.contentBase64);
    const getAtt = listed.result.tools.find((t) => t.name === "get_attachment");
    assert.deepEqual(getAtt.inputSchema.required, ["messageId", "attachmentId"]);
  });

  it("initialize and tools/call return JSON-RPC results", async () => {
    const handle = createMessageHandler({
      runTool: async (name, args) => {
        assert.equal(name, "send_as");
        assert.equal(args.from, "ops@oberonlogistics.com");
        assert.equal(args.attachments, undefined);
        return { id: "mid", threadId: "tid" };
      },
    });
    const init = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    assert.equal(init.result.serverInfo.name, "gmail-sendas");
    assert.equal(init.result.protocolVersion, "2025-03-26");

    const call = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "send_as",
        arguments: {
          from: "ops@oberonlogistics.com",
          to: "a@b.com",
          subject: "Hi",
          body: "Hello",
        },
      },
    });
    assert.deepEqual(JSON.parse(call.result.content[0].text), {
      id: "mid",
      threadId: "tid",
    });

    const withAtt = createMessageHandler({
      runTool: async (name, args) => {
        assert.equal(name, "send_as");
        assert.deepEqual(args.attachments, [{ path: "/workspace/outbox/invoice.PDF" }]);
        return { id: "mid2", threadId: "tid2" };
      },
    });
    const attached = await withAtt({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "send_as",
        arguments: {
          from: "ops@oberonlogistics.com",
          to: "a@b.com",
          subject: "Invoice",
          body: "Attached.",
          attachments: [{ path: "/workspace/outbox/invoice.PDF" }],
        },
      },
    });
    assert.deepEqual(JSON.parse(attached.result.content[0].text), {
      id: "mid2",
      threadId: "tid2",
    });
  });

  it("parses Content-Length and newline frames", () => {
    const messages = [];
    const parser = createStdioParser((msg) => messages.push(msg));
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    parser.push(`Content-Length: ${Buffer.byteLength(a)}\r\n\r\n${a}`);
    parser.push('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].id, 1);
    assert.equal(messages[1].id, 2);
  });
});

describe("createToolRunner send_as wiring", () => {
  it("forwards attachments into sendAs and returns id + threadId only", async () => {
    const png = Buffer.from("png-runner-bytes", "utf8");
    /** @type {{ url: string, init: RequestInit } | null} */
    let captured = null;
    const runTool = createToolRunner({
      env: {
        GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "not-used-because-token-source-not-hit",
        GOOGLE_REFRESH_TOKEN: "not-used",
      },
      fetchImpl: async (url, init) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return /** @type {Response} */ ({
            ok: true,
            json: async () => ({ access_token: "tok", expires_in: 3600 }),
          });
        }
        captured = { url: String(url), init: init || {} };
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({
            id: "runner-id",
            threadId: "runner-thr",
            labelIds: ["SENT"],
            raw: "must-not-return",
          }),
        });
      },
    });

    const result = await runTool("send_as", {
      from: "ops@oberonlogistics.com",
      to: "a@b.com",
      subject: "Runner attach",
      body: "See file.",
      attachments: [
        { filename: "stamp.png", contentBase64: png.toString("base64") },
      ],
    });
    assert.deepEqual(result, { id: "runner-id", threadId: "runner-thr" });
    const inspected = inspectSendCall(captured);
    assert.match(inspected.mime, /Content-Type: image\/png; name="stamp\.png"/);
    assert.match(inspected.mime, /Content-Disposition: attachment; filename="stamp\.png"/);
    assert.doesNotMatch(JSON.stringify(result), /must-not-return/);
    assert.doesNotMatch(JSON.stringify(result), /png-runner-bytes/);
  });
});

describe("createToolRunner thread_send_as wiring", () => {
  it("forwards messageId + attachments and returns id + threadId only", async () => {
    const pdf = Buffer.from("%PDF-1.4 runner-reply", "utf8");
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const runTool = createToolRunner({
      env: {
        GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "not-used-because-token-source-not-hit",
        GOOGLE_REFRESH_TOKEN: "not-used",
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com/token")) {
          return /** @type {Response} */ ({
            ok: true,
            json: async () => ({ access_token: "tok", expires_in: 3600 }),
          });
        }
        calls.push({ url: u, init: init || {} });
        if (u.includes("/settings/sendAs")) {
          return /** @type {Response} */ ({
            ok: true,
            json: async () => ({
              sendAs: [
                {
                  sendAsEmail: "jim.phillips@oberonlogistics.com",
                  isPrimary: false,
                  verificationStatus: "accepted",
                },
              ],
            }),
          });
        }
        if (u.includes("/messages/") && !u.includes("/messages/send")) {
          return /** @type {Response} */ ({
            ok: true,
            json: async () => ({
              id: "inbound-9",
              threadId: "thr-logistics",
              payload: {
                headers: [
                  { name: "Delivered-To", value: "jim.phillips@oberonlogistics.com" },
                  { name: "To", value: "Jim <jim.phillips@oberonlogistics.com>" },
                  { name: "From", value: "Carrier <dispatch@carrier.com>" },
                  { name: "Subject", value: "Load 1042" },
                  { name: "Message-ID", value: "<abc@carrier.com>" },
                  { name: "References", value: "<root@carrier.com>" },
                ],
              },
            }),
          });
        }
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({
            id: "reply-runner",
            threadId: "thr-logistics",
            raw: "must-not-return",
          }),
        });
      },
    });

    const result = await runTool("thread_send_as", {
      messageId: "inbound-9",
      body: "Confirmed.",
      attachments: [
        { filename: "rate-con.pdf", contentBase64: pdf.toString("base64") },
      ],
    });
    assert.deepEqual(result, { id: "reply-runner", threadId: "thr-logistics" });
    const send = calls.find((c) => c.url.includes("/messages/send"));
    const inspected = inspectSendCall(send);
    assert.equal(inspected.body.threadId, "thr-logistics");
    assert.match(inspected.mime, /^From: jim\.phillips@oberonlogistics\.com\r$/m);
    assert.match(inspected.mime, /Content-Disposition: attachment; filename="rate-con\.pdf"/);
    assert.doesNotMatch(JSON.stringify(result), /must-not-return/);
  });
});

describe("oauth-setup helper", () => {
  it("requests offline consent for the three Gmail scopes", () => {
    const url = new URL(buildAuthUrl("client.apps.googleusercontent.com"));
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    const scope = url.searchParams.get("scope");
    for (const needed of OAUTH_SCOPES) {
      assert.match(scope, new RegExp(needed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("exchangeCode returns only the refresh token and ignores access_token", async () => {
    const token = await exchangeCode({
      clientId: "id",
      clientSecret: "secret",
      code: "auth-code",
      fetchImpl: async (_url, init) => {
        const body = String(init.body);
        assert.match(body, /grant_type=authorization_code/);
        assert.doesNotMatch(body, /refresh_token=rt-/);
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({
            access_token: "should-not-be-returned",
            refresh_token: "rt-only-this",
            expires_in: 3600,
          }),
        });
      },
    });
    assert.equal(token, "rt-only-this");
  });
});
