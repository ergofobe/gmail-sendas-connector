import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRfc2822,
  createGmailClient,
  fromBase64Url,
  inspectSendCall,
  parseSendAsList,
  parseSendResult,
  toBase64Url,
  GMAIL_API,
} from "../src/gmail.js";

describe("list_send_as parsing", () => {
  it("maps sendAs fields and drops extras", () => {
    const parsed = parseSendAsList({
      sendAs: [
        {
          sendAsEmail: "ops@oberonlogistics.com",
          displayName: "Logistics",
          isPrimary: false,
          isDefault: false,
          verificationStatus: "accepted",
          signature: "<b>do not leak</b>",
          treatAsAlias: true,
        },
        {
          sendAsEmail: "owner@oberon.group",
          displayName: "Primary",
          isPrimary: true,
          isDefault: true,
          verificationStatus: "accepted",
        },
      ],
    });
    assert.deepEqual(parsed, [
      {
        sendAsEmail: "ops@oberonlogistics.com",
        displayName: "Logistics",
        isPrimary: false,
        isDefault: false,
        verificationStatus: "accepted",
      },
      {
        sendAsEmail: "owner@oberon.group",
        displayName: "Primary",
        isPrimary: true,
        isDefault: true,
        verificationStatus: "accepted",
      },
    ]);
  });

  it("returns an empty list when sendAs is missing", () => {
    assert.deepEqual(parseSendAsList({}), []);
    assert.deepEqual(parseSendAsList(null), []);
  });

  it("listSendAs calls the settings.sendAs endpoint", async () => {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init || {} });
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({
            sendAs: [
              {
                sendAsEmail: "holdings@ogholdings.biz",
                displayName: "Holdings",
                isPrimary: false,
                isDefault: true,
                verificationStatus: "accepted",
              },
            ],
          }),
        });
      },
    });
    const rows = await client.listSendAs();
    assert.equal(calls[0].url, `${GMAIL_API}/users/me/settings/sendAs`);
    assert.match(String(calls[0].init.headers.Authorization), /^Bearer test-access-token$/);
    assert.equal(rows[0].sendAsEmail, "holdings@ogholdings.biz");
    assert.equal(rows[0].isDefault, true);
  });
});

describe("send_as MIME + messages.send shape", () => {
  it("sets From to the alias and posts raw base64url to messages.send", async () => {
    /** @type {{ url: string, init: RequestInit } | null} */
    let captured = null;
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init || {} };
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({ id: "msg-123", threadId: "thr-456", labelIds: ["SENT"] }),
        });
      },
    });

    const result = await client.sendAs(
      {
        from: "ops@oberonlogistics.com",
        to: "counterparty@example.com",
        subject: "Rate confirm",
        body: "Plain body",
        html: "<p>HTML body</p>",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
      },
      { boundary: "testboundary" }
    );

    assert.deepEqual(result, { id: "msg-123", threadId: "thr-456" });
    assert.equal(Object.keys(result).join(","), "id,threadId");

    const inspected = inspectSendCall(captured);
    assert.equal(inspected.url, `${GMAIL_API}/users/me/messages/send`);
    assert.equal(inspected.method, "POST");
    assert.equal(typeof inspected.body.raw, "string");
    assert.equal(Object.keys(inspected.body).join(","), "raw");
    assert.match(inspected.mime, /^From: ops@oberonlogistics.com\r$/m);
    assert.match(inspected.mime, /^To: counterparty@example.com\r$/m);
    assert.match(inspected.mime, /^Cc: cc@example.com\r$/m);
    assert.match(inspected.mime, /^Bcc: bcc@example.com\r$/m);
    assert.match(inspected.mime, /^Subject: Rate confirm\r$/m);
    assert.match(inspected.mime, /Plain body/);
    assert.match(inspected.mime, /<p>HTML body<\/p>/);
    assert.equal(
      inspected.body.raw,
      toBase64Url(buildRfc2822(
        {
          from: "ops@oberonlogistics.com",
          to: "counterparty@example.com",
          subject: "Rate confirm",
          body: "Plain body",
          html: "<p>HTML body</p>",
          cc: "cc@example.com",
          bcc: "bcc@example.com",
        },
        { boundary: "testboundary" }
      ))
    );
  });

  it("rejects header injection and missing body", () => {
    assert.throws(
      () =>
        buildRfc2822({
          from: "ops@oberonlogistics.com\nBcc: evil@x.com",
          to: "a@b.com",
          subject: "Hi",
          body: "x",
        }),
      /from must be a sendAs alias email/
    );
    assert.throws(
      () =>
        buildRfc2822({
          from: "ops@oberonlogistics.com",
          to: "a@b.com\nBcc: evil@x.com",
          subject: "Hi",
          body: "x",
        }),
      /single line/
    );
    assert.throws(
      () =>
        buildRfc2822({
          from: "ops@oberonlogistics.com",
          to: "a@b.com",
          subject: "Hi",
        }),
      /body and\/or html/
    );
  });

  it("parseSendResult requires an id and never invents tokens", () => {
    assert.deepEqual(parseSendResult({ id: "abc", threadId: "t" }), {
      id: "abc",
      threadId: "t",
    });
    assert.throws(() => parseSendResult({}), /message id/);
  });
});

describe("get_attachment decode + file write", () => {
  it("decodes base64url and writes the expected byte length", async () => {
    const pdfish = Buffer.from("%PDF-1.4 mock attachment bytes !!", "utf8");
    const gmailData = toBase64Url(pdfish);
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-sendas-"));
    const dest = path.join(dir, "rate-con.pdf");

    try {
      const client = createGmailClient({
        getAccessToken: async () => "test-access-token",
        fetchImpl: async (url) => {
          assert.equal(
            String(url),
            `${GMAIL_API}/users/me/messages/m%2F1/attachments/att%2F9`
          );
          return /** @type {Response} */ ({
            ok: true,
            json: async () => ({ size: pdfish.length, data: gmailData }),
          });
        },
      });

      const body = await client.getAttachment({
        messageId: "m/1",
        attachmentId: "att/9",
        filename: "rate-con.pdf",
        path: dest,
      });

      assert.equal(body.attachmentId, "att/9");
      assert.equal(body.filename, "rate-con.pdf");
      assert.equal(body.size, pdfish.length);
      assert.equal(body.path, dest);
      assert.equal(body.data, pdfish.toString("base64"));
      assert.equal(fromBase64Url(gmailData).length, pdfish.length);

      const written = await readFile(dest);
      assert.equal(written.length, pdfish.length);
      assert.deepEqual(written, pdfish);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
