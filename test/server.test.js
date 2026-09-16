import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, createStdioParser, TOOL_DEFS } from "../src/server.js";
import { buildAuthUrl, exchangeCode, OAUTH_SCOPES } from "../scripts/oauth-setup.js";

describe("MCP surface", () => {
  it("lists exactly the three gap tools", async () => {
    const handle = createMessageHandler({
      runTool: async () => {
        throw new Error("should not run");
      },
    });
    const listed = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_attachment", "list_send_as", "send_as"]);
    assert.equal(TOOL_DEFS.length, 3);
  });

  it("initialize and tools/call return JSON-RPC results", async () => {
    const handle = createMessageHandler({
      runTool: async (name, args) => {
        assert.equal(name, "send_as");
        assert.equal(args.from, "ops@oberonlogistics.com");
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
