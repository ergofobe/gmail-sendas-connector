import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRfc2822,
  createGmailClient,
  fromBase64Url,
  inferMimeType,
  inspectSendCall,
  parseSendAsList,
  parseSendResult,
  resolveSendAttachments,
  toBase64Url,
  GMAIL_API,
  GMAIL_MAX_MESSAGE_BYTES,
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

  it("send_as without attachments still posts the same raw MIME", async () => {
    /** @type {{ url: string, init: RequestInit } | null} */
    let captured = null;
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init || {} };
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({ id: "plain-1" }),
        });
      },
    });

    const args = {
      from: "ops@oberonlogistics.com",
      to: "a@b.com",
      subject: "No files",
      body: "Just text",
    };
    const result = await client.sendAs(args);
    assert.deepEqual(result, { id: "plain-1" });
    const inspected = inspectSendCall(captured);
    assert.doesNotMatch(inspected.mime, /multipart\/mixed/);
    assert.doesNotMatch(inspected.mime, /Content-Disposition: attachment/);
    assert.equal(inspected.body.raw, toBase64Url(buildRfc2822(args)));
    assert.match(inspected.mime, /^Content-Type: text\/plain; charset="UTF-8"\r$/m);
  });
});

describe("send_as outbound attachments", () => {
  it("infers PDF/JPG/PNG mime types from extension", () => {
    assert.equal(inferMimeType("invoice.PDF"), "application/pdf");
    assert.equal(inferMimeType("pod.jpg"), "image/jpeg");
    assert.equal(inferMimeType("scan.JPEG"), "image/jpeg");
    assert.equal(inferMimeType("photo.png"), "image/png");
    assert.equal(inferMimeType("notes.csv", "text/csv"), "text/csv");
    assert.equal(inferMimeType("notes.csv"), "application/octet-stream");
  });

  it("multipart/mixed includes Content-Type and Content-Disposition filename", () => {
    const pdf = Buffer.from("%PDF-1.4 mock-invoice-bytes", "utf8");
    const mime = buildRfc2822(
      {
        from: "ops@oberonlogistics.com",
        to: "ap@counterparty.com",
        subject: "Invoice 1042",
        body: "Please find the invoice attached.",
        attachments: [
          { filename: "invoice.PDF", mimeType: "application/pdf", bytes: pdf },
        ],
      },
      { mixedBoundary: "mix_test" }
    );

    assert.match(mime, /Content-Type: multipart\/mixed; boundary="mix_test"/);
    assert.match(mime, /Content-Type: application\/pdf; name="invoice\.PDF"/);
    assert.match(
      mime,
      /Content-Disposition: attachment; filename="invoice\.PDF"/
    );
    assert.match(mime, /Content-Transfer-Encoding: base64/);
    assert.match(mime, /Please find the invoice attached\./);
    assert.match(mime, new RegExp(pdf.toString("base64").replace(/[+]/g, "\\+")));
    assert.doesNotMatch(mime, /test-access-token/);
  });

  it("path-based attach reads file bytes into the MIME part", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-sendas-out-"));
    const dest = path.join(dir, "invoice.PDF");
    const pdf = Buffer.from("%PDF-1.4 path-attach-bytes", "utf8");
    await writeFile(dest, pdf);

    /** @type {{ url: string, init: RequestInit } | null} */
    let captured = null;
    try {
      const client = createGmailClient({
        getAccessToken: async () => "test-access-token",
        fetchImpl: async (url, init) => {
          captured = { url: String(url), init: init || {} };
          return /** @type {Response} */ ({
            ok: true,
            json: async () => ({ id: "msg-att", threadId: "thr-att" }),
          });
        },
      });

      const result = await client.sendAs(
        {
          from: "ops@oberonlogistics.com",
          to: "ap@counterparty.com",
          subject: "Invoice 1042",
          body: "Attached.",
          attachments: [{ path: dest }],
        },
        { mixedBoundary: "mix_path" }
      );

      assert.deepEqual(result, { id: "msg-att", threadId: "thr-att" });
      const inspected = inspectSendCall(captured);
      assert.equal(inspected.url, `${GMAIL_API}/users/me/messages/send`);
      assert.match(inspected.mime, /Content-Type: application\/pdf; name="invoice\.PDF"/);
      assert.match(
        inspected.mime,
        /Content-Disposition: attachment; filename="invoice\.PDF"/
      );
      assert.match(
        inspected.mime,
        new RegExp(pdf.toString("base64").replace(/[+]/g, "\\+"))
      );

      const resolved = await resolveSendAttachments([{ path: dest }]);
      assert.equal(resolved[0].filename, "invoice.PDF");
      assert.equal(resolved[0].mimeType, "application/pdf");
      assert.deepEqual(resolved[0].bytes, pdf);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts contentBase64 (and content) fallback with filename + mimeType", async () => {
    const jpg = Buffer.from("\xFF\xD8\xFF jpeg-bytes", "binary");
    const png = Buffer.from("\x89PNG png-bytes", "binary");

    /** @type {{ url: string, init: RequestInit } | null} */
    let captured = null;
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init || {} };
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({ id: "msg-b64", threadId: "thr-b64" }),
        });
      },
    });

    const result = await client.sendAs(
      {
        from: "ops@oberonlogistics.com",
        to: "ops@example.com",
        subject: "POD photos",
        html: "<p>Photos attached.</p>",
        attachments: [
          {
            filename: "pod.jpg",
            mimeType: "image/jpeg",
            contentBase64: jpg.toString("base64"),
          },
          {
            filename: "stamp.png",
            content: png.toString("base64"),
          },
        ],
      },
      { mixedBoundary: "mix_b64" }
    );

    assert.deepEqual(result, { id: "msg-b64", threadId: "thr-b64" });
    const inspected = inspectSendCall(captured);
    assert.match(inspected.mime, /Content-Type: image\/jpeg; name="pod\.jpg"/);
    assert.match(inspected.mime, /Content-Disposition: attachment; filename="pod\.jpg"/);
    assert.match(inspected.mime, /Content-Type: image\/png; name="stamp\.png"/);
    assert.match(inspected.mime, /Content-Disposition: attachment; filename="stamp\.png"/);
    assert.match(inspected.mime, new RegExp(jpg.toString("base64").replace(/[+]/g, "\\+")));
    assert.match(inspected.mime, new RegExp(png.toString("base64").replace(/[+]/g, "\\+")));
  });

  it("rejects oversize messages before send and never echoes file bytes", async () => {
    const marker = "SECRETFILEBYTES_should_never_appear_in_errors";
    const huge = Buffer.alloc(GMAIL_MAX_MESSAGE_BYTES + 1, 0);
    huge.write(marker, 0, "utf8");

    let fetchCalls = 0;
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl: async () => {
        fetchCalls += 1;
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({ id: "should-not-send" }),
        });
      },
    });

    await assert.rejects(
      () =>
        client.sendAs({
          from: "ops@oberonlogistics.com",
          to: "a@b.com",
          subject: "Too big",
          body: "x",
          attachments: [
            { filename: "huge.bin", mimeType: "application/octet-stream", bytes: huge },
          ],
        }),
      (err) => {
        assert.match(err.message, /25MB/);
        assert.doesNotMatch(err.message, new RegExp(marker));
        assert.doesNotMatch(err.message, /SECRETFILEBYTES/);
        assert.doesNotMatch(err.message, /test-access-token/);
        return true;
      }
    );
    assert.equal(fetchCalls, 0);

    assert.throws(
      () =>
        buildRfc2822({
          from: "ops@oberonlogistics.com",
          to: "a@b.com",
          subject: "Too big",
          body: "x",
          attachments: [
            { filename: "huge.bin", mimeType: "application/octet-stream", bytes: huge },
          ],
        }),
      (err) => {
        assert.match(err.message, /25MB/);
        assert.doesNotMatch(err.message, new RegExp(marker));
        return true;
      }
    );
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
