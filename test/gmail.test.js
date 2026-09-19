import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRfc2822,
  buildThreadingHeaders,
  collectHeaders,
  collectLandedAddresses,
  createGmailClient,
  fromBase64Url,
  inferMimeType,
  inspectSendCall,
  messageGetUrl,
  parseSendAsList,
  parseSendResult,
  replySubject,
  resolveReplyFrom,
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

const PRIMARY = "jim.phillips@oberon.group";
const LOGISTICS = "jim.phillips@oberonlogistics.com";

const DEFAULT_SEND_AS = [
  {
    sendAsEmail: PRIMARY,
    displayName: "Jim",
    isPrimary: true,
    isDefault: true,
    verificationStatus: "accepted",
  },
  {
    sendAsEmail: LOGISTICS,
    displayName: "Logistics",
    isPrimary: false,
    isDefault: false,
    verificationStatus: "accepted",
  },
];

function parentMessage(headers, extras = {}) {
  return {
    id: extras.id || "inbound-1",
    threadId: extras.threadId || "thr-logistics",
    payload: { headers },
  };
}

function mockReplyFetch({
  sendAs = DEFAULT_SEND_AS,
  message,
  sendResult = { id: "reply-1", threadId: "thr-logistics" },
} = {}) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || {} });
    if (u.includes("/settings/sendAs")) {
      return /** @type {Response} */ ({
        ok: true,
        json: async () => ({ sendAs }),
      });
    }
    if (u.includes("/messages/send")) {
      return /** @type {Response} */ ({
        ok: true,
        json: async () => sendResult,
      });
    }
    if (u.includes("/messages/")) {
      return /** @type {Response} */ ({
        ok: true,
        json: async () => message,
      });
    }
    throw new Error(`unexpected url ${u}`);
  };
  return { calls, fetchImpl };
}

describe("reply_send_as From inference + threading", () => {
  it("infers From from Delivered-To when it matches sendAs", () => {
    const headers = collectHeaders([
      { name: "Delivered-To", value: "Jim.Phillips@OberonLogistics.com" },
      { name: "To", value: `Jim Phillips <${PRIMARY}>` },
    ]);
    assert.deepEqual(collectLandedAddresses(headers), [
      "Jim.Phillips@OberonLogistics.com",
      PRIMARY,
    ]);
    assert.equal(resolveReplyFrom(undefined, headers, DEFAULT_SEND_AS), LOGISTICS);
  });

  it("infers From from To when Delivered-To / X-Original-To do not match", () => {
    const headers = collectHeaders([
      { name: "Delivered-To", value: "catchall@forwarded.example" },
      { name: "To", value: `Dispatch <${LOGISTICS}>` },
    ]);
    assert.equal(resolveReplyFrom("", headers, DEFAULT_SEND_AS), LOGISTICS);
  });

  it("prefers X-Original-To over To", () => {
    const headers = collectHeaders([
      { name: "X-Original-To", value: LOGISTICS },
      { name: "To", value: PRIMARY },
    ]);
    assert.equal(resolveReplyFrom(null, headers, DEFAULT_SEND_AS), LOGISTICS);
  });

  it("explicit from wins over inferred landed address", () => {
    const headers = collectHeaders([
      { name: "Delivered-To", value: LOGISTICS },
      { name: "To", value: LOGISTICS },
    ]);
    assert.equal(resolveReplyFrom(PRIMARY, headers, DEFAULT_SEND_AS), PRIMARY);
    assert.equal(
      resolveReplyFrom(`Jim <${PRIMARY}>`, headers, DEFAULT_SEND_AS),
      PRIMARY
    );
  });

  it("fails clearly when inferred address is not a sendAs alias", () => {
    const headers = collectHeaders([
      { name: "Delivered-To", value: "unknown@elsewhere.com" },
      { name: "To", value: "Also Unknown <also@elsewhere.com>" },
    ]);
    assert.throws(
      () => resolveReplyFrom(undefined, headers, DEFAULT_SEND_AS),
      /not a sendAs alias.*Pass explicit from/
    );
    assert.throws(
      () => resolveReplyFrom("not-an-alias@oberon.group", headers, DEFAULT_SEND_AS),
      /not an allowed sendAs alias/
    );
  });

  it("adds Re: when needed and builds In-Reply-To / References", () => {
    assert.equal(replySubject("Load 1042"), "Re: Load 1042");
    assert.equal(replySubject("Re: Load 1042"), "Re: Load 1042");
    assert.equal(replySubject("RE: already"), "RE: already");
    const threading = buildThreadingHeaders(
      collectHeaders([
        { name: "Message-ID", value: "<abc@carrier.com>" },
        { name: "References", value: "<root@carrier.com>" },
      ])
    );
    assert.equal(threading.inReplyTo, "<abc@carrier.com>");
    assert.equal(threading.references, "<root@carrier.com> <abc@carrier.com>");
  });

  it("sets In-Reply-To, References, and threadId on messages.send", async () => {
    const message = parentMessage([
      { name: "Delivered-To", value: LOGISTICS },
      { name: "To", value: `Jim Phillips <${LOGISTICS}>` },
      { name: "From", value: "Carrier Ops <dispatch@carrier.com>" },
      { name: "Subject", value: "Load 1042" },
      { name: "Message-ID", value: "<abc@carrier.com>" },
      { name: "References", value: "<root@carrier.com>" },
    ]);
    const { calls, fetchImpl } = mockReplyFetch({ message });
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });

    const result = await client.replyAs({
      messageId: "inbound-1",
      body: "Confirmed, rolling.",
    });

    assert.deepEqual(result, { id: "reply-1", threadId: "thr-logistics" });
    assert.equal(Object.keys(result).join(","), "id,threadId");

    const getUrl = calls.find((c) => c.url.includes("/messages/inbound-1"));
    assert.equal(getUrl.url, messageGetUrl("inbound-1"));

    const send = calls.find((c) => c.url.includes("/messages/send"));
    const inspected = inspectSendCall(send);
    assert.equal(inspected.url, `${GMAIL_API}/users/me/messages/send`);
    assert.equal(inspected.body.threadId, "thr-logistics");
    assert.equal(Object.keys(inspected.body).sort().join(","), "raw,threadId");
    assert.match(inspected.mime, /^From: jim\.phillips@oberonlogistics\.com\r$/m);
    assert.match(inspected.mime, /^To: Carrier Ops <dispatch@carrier\.com>\r$/m);
    assert.match(inspected.mime, /^Subject: Re: Load 1042\r$/m);
    assert.match(inspected.mime, /^In-Reply-To: <abc@carrier\.com>\r$/m);
    assert.match(
      inspected.mime,
      /^References: <root@carrier\.com> <abc@carrier\.com>\r$/m
    );
    assert.doesNotMatch(JSON.stringify(result), /test-access-token/);
  });

  it("explicit from wins on the wire even when Delivered-To would infer another alias", async () => {
    const message = parentMessage([
      { name: "Delivered-To", value: LOGISTICS },
      { name: "From", value: "Broker <ap@broker.com>" },
      { name: "Subject", value: "Re: Invoice" },
      { name: "Message-ID", value: "<inv@broker.com>" },
    ]);
    const { calls, fetchImpl } = mockReplyFetch({ message });
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });

    await client.replyAs({
      messageId: "inbound-1",
      from: PRIMARY,
      html: "<p>Paid.</p>",
    });

    const send = calls.find((c) => c.url.includes("/messages/send"));
    const inspected = inspectSendCall(send);
    assert.match(inspected.mime, /^From: jim\.phillips@oberon\.group\r$/m);
    assert.match(inspected.mime, /^Subject: Re: Invoice\r$/m);
    assert.equal(inspected.body.threadId, "thr-logistics");
  });

  it("does not send when the landed address is not a sendAs alias", async () => {
    const message = parentMessage([
      { name: "Delivered-To", value: "random@elsewhere.com" },
      { name: "To", value: "also@elsewhere.com" },
      { name: "From", value: "Someone <a@b.com>" },
      { name: "Subject", value: "Hi" },
      { name: "Message-ID", value: "<x@y.com>" },
    ]);
    const { calls, fetchImpl } = mockReplyFetch({ message });
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });

    await assert.rejects(
      () => client.replyAs({ messageId: "inbound-1", body: "Nope" }),
      /not a sendAs alias.*Pass explicit from/
    );
    assert.equal(calls.filter((c) => c.url.includes("/messages/send")).length, 0);
  });

  it("attaches files on reply using the same path/base64 shape as send_as", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-reply-as-"));
    const dest = path.join(dir, "invoice.PDF");
    const pdf = Buffer.from("%PDF-1.4 reply-attach-bytes", "utf8");
    await writeFile(dest, pdf);
    const png = Buffer.from("\x89PNG reply-png", "binary");

    const message = parentMessage([
      { name: "Delivered-To", value: LOGISTICS },
      { name: "From", value: "AP <ap@counterparty.com>" },
      { name: "Subject", value: "Invoice 1042" },
      { name: "Message-ID", value: "<inv@counterparty.com>" },
    ]);
    const { calls, fetchImpl } = mockReplyFetch({
      message,
      sendResult: { id: "reply-att", threadId: "thr-logistics" },
    });

    try {
      const client = createGmailClient({
        getAccessToken: async () => "test-access-token",
        fetchImpl,
      });
      const result = await client.replyAs(
        {
          messageId: "inbound-1",
          body: "Invoice attached.",
          attachments: [
            { path: dest },
            {
              filename: "stamp.png",
              contentBase64: png.toString("base64"),
            },
          ],
        },
        { mixedBoundary: "mix_reply" }
      );

      assert.deepEqual(result, { id: "reply-att", threadId: "thr-logistics" });
      const send = calls.find((c) => c.url.includes("/messages/send"));
      const inspected = inspectSendCall(send);
      assert.equal(inspected.body.threadId, "thr-logistics");
      assert.match(inspected.mime, /Content-Type: multipart\/mixed; boundary="mix_reply"/);
      assert.match(inspected.mime, /Content-Type: application\/pdf; name="invoice\.PDF"/);
      assert.match(
        inspected.mime,
        /Content-Disposition: attachment; filename="invoice\.PDF"/
      );
      assert.match(inspected.mime, /Content-Disposition: attachment; filename="stamp\.png"/);
      assert.match(
        inspected.mime,
        new RegExp(pdf.toString("base64").replace(/[+]/g, "\\+"))
      );
      assert.match(
        inspected.mime,
        new RegExp(png.toString("base64").replace(/[+]/g, "\\+"))
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
