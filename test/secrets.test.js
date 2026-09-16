import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTokenSource } from "../src/gmail.js";
import { createMessageHandler, createToolRunner } from "../src/server.js";
import { missingOAuthVars, requireCreds, safeErrorMessage } from "../src/secrets.js";

const SECRET = "rt-super-secret-refresh-token-XYZ-9911";
const CLIENT_SECRET = "cs-do-not-echo-me-ever-4422";

describe("missing-cred errors never echo secrets", () => {
  it("requireCreds lists missing names only", () => {
    const env = {
      GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    };
    assert.deepEqual(missingOAuthVars(env), ["GOOGLE_REFRESH_TOKEN"]);
    assert.throws(
      () => requireCreds(env),
      (err) => {
        assert.match(err.message, /GOOGLE_REFRESH_TOKEN/);
        assert.doesNotMatch(err.message, new RegExp(CLIENT_SECRET));
        assert.doesNotMatch(err.message, /do-not-echo/);
        return true;
      }
    );
  });

  it("safeErrorMessage redacts env values, bearer tokens, and assignment forms", () => {
    const env = {
      GOOGLE_REFRESH_TOKEN: SECRET,
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    };
    const raw = new Error(
      `refresh_token=${SECRET} client_secret=${CLIENT_SECRET} Bearer ${SECRET} boom`
    );
    const msg = safeErrorMessage(raw, env);
    assert.doesNotMatch(msg, new RegExp(SECRET));
    assert.doesNotMatch(msg, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(msg, /super-secret-refresh-token/);
    assert.match(msg, /\[GOOGLE_REFRESH_TOKEN\]|\[redacted-credential\]|Bearer \[redacted\]/);
  });

  it("OAuth refresh failure omits tokens even if the HTTP body is noisy", async () => {
    const env = {
      GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN: SECRET,
    };
    const getToken = createTokenSource({
      env,
      fetchImpl: async () =>
        /** @type {Response} */ ({
          ok: false,
          status: 400,
          json: async () => ({
            error: "invalid_grant",
            error_description: `bad refresh_token=${SECRET}`,
            access_token: "should-never-surface",
          }),
        }),
    });
    await assert.rejects(getToken, (err) => {
      const msg = safeErrorMessage(err, env);
      assert.match(msg, /OAuth token refresh failed/);
      assert.doesNotMatch(msg, new RegExp(SECRET));
      assert.doesNotMatch(msg, /should-never-surface/);
      assert.doesNotMatch(msg, new RegExp(CLIENT_SECRET));
      return true;
    });
  });

  it("tools/call error content never includes secrets", async () => {
    const env = {
      GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN: SECRET,
    };
    const runTool = createToolRunner({
      env,
      fetchImpl: async () => {
        throw new Error(`upstream Bearer ${SECRET} refresh_token=${SECRET}`);
      },
    });
    const handle = createMessageHandler({ runTool, env });
    const reply = await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "list_send_as",
        arguments: {},
      },
    });
    const text = reply.result.content[0].text;
    assert.equal(reply.result.isError, true);
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.doesNotMatch(text, /rt-super-secret/);
  });
});
