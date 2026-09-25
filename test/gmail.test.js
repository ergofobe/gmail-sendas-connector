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
  inspectDraftCall,
  inspectSendCall,
  isGmailSendEndpoint,
  isVerifiedSendAs,
  messageGetUrl,
  parseDraftResult,
  parseSendAsList,
  parseSendResult,
  replySubject,
  requireVerifiedSendAs,
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

describe("thread_send_as From inference + threading", () => {
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

describe("draft_as drafts.create (never sends)", () => {
  const TRACKING_URL = "https://ptycoin.com/some/path?utm_source=x&utm_medium=y";
  const DRAFTS_URL = `${GMAIL_API}/users/me/drafts`;

  function mockDraftFetch({
    sendAs = DEFAULT_SEND_AS,
    draftResult = {
      id: "draft-1",
      message: { id: "msg-draft-1", threadId: "thr-draft", labelIds: ["DRAFT"] },
    },
  } = {}) {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const fetchImpl = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, init: init || {} });
      if (isGmailSendEndpoint(u)) {
        throw new Error(`send endpoint must not be called: ${u}`);
      }
      if (u.includes("/settings/sendAs")) {
        return /** @type {Response} */ ({
          ok: true,
          json: async () => ({ sendAs }),
        });
      }
      if (u === DRAFTS_URL) {
        return /** @type {Response} */ ({
          ok: true,
          json: async () => draftResult,
        });
      }
      throw new Error(`unexpected url ${u}`);
    };
    return { calls, fetchImpl };
  }

  function assertNoSend(calls) {
    assert.equal(calls.filter((c) => isGmailSendEndpoint(c.url)).length, 0);
    for (const call of calls) {
      assert.equal(isGmailSendEndpoint(call.url), false);
    }
  }

  it("rejects unknown and unverified aliases before drafts.create", async () => {
    const sendAs = [
      ...DEFAULT_SEND_AS,
      {
        sendAsEmail: "pending@oberonlogistics.com",
        displayName: "Pending",
        isPrimary: false,
        isDefault: false,
        verificationStatus: "pending",
      },
    ];
    const { calls, fetchImpl } = mockDraftFetch({ sendAs });
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });

    await assert.rejects(
      () =>
        client.draftAs({
          from: "not-an-alias@oberon.group",
          to: "a@b.com",
          subject: "Nope",
          body: "x",
        }),
      /not an allowed sendAs alias/
    );
    await assert.rejects(
      () =>
        client.draftAs({
          from: "pending@oberonlogistics.com",
          to: "a@b.com",
          subject: "Nope",
          body: "x",
        }),
      /not a verified sendAs alias.*pending/
    );
    assert.equal(calls.filter((c) => c.url === DRAFTS_URL).length, 0);
    assertNoSend(calls);

    assert.equal(isVerifiedSendAs(sendAs[2]), false);
    assert.throws(
      () => requireVerifiedSendAs("pending@oberonlogistics.com", sendAs),
      /not a verified sendAs alias/
    );
    assert.throws(
      () => requireVerifiedSendAs("unknown@elsewhere.com", sendAs),
      /not an allowed sendAs alias/
    );
  });

  it("text-only draft posts raw MIME to drafts.create with alias From", async () => {
    const { calls, fetchImpl } = mockDraftFetch();
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });
    const result = await client.draftAs({
      from: LOGISTICS,
      to: "counterparty@example.com",
      subject: "Draft text",
      body: "Plain draft body",
    });

    assert.deepEqual(result, { id: "draft-1", threadId: "thr-draft" });
    const create = calls.find((c) => c.url === DRAFTS_URL);
    const inspected = inspectDraftCall(create);
    assert.equal(inspected.method, "POST");
    assert.equal(Object.keys(inspected.body).join(","), "message");
    assert.equal(Object.keys(inspected.message).join(","), "raw");
    assert.match(inspected.mime, /^From: jim\.phillips@oberonlogistics\.com\r$/m);
    assert.match(inspected.mime, /^Content-Type: text\/plain; charset="UTF-8"\r$/m);
    assert.match(inspected.mime, /^Content-Transfer-Encoding: 8bit\r$/m);
    assert.match(inspected.mime, /Plain draft body/);
    assert.doesNotMatch(inspected.mime, /multipart\//);
    assertNoSend(calls);
  });

  it("html-only draft uses text/html 8bit (no quoted-printable)", async () => {
    const { calls, fetchImpl } = mockDraftFetch();
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });
    await client.draftAs({
      from: LOGISTICS,
      to: "a@b.com",
      subject: "Draft html",
      html: "<p>HTML only</p>",
    });
    const inspected = inspectDraftCall(calls.find((c) => c.url === DRAFTS_URL));
    assert.match(inspected.mime, /^Content-Type: text\/html; charset="UTF-8"\r$/m);
    assert.match(inspected.mime, /^Content-Transfer-Encoding: 8bit\r$/m);
    assert.match(inspected.mime, /<p>HTML only<\/p>/);
    assert.doesNotMatch(inspected.mime, /quoted-printable/i);
    assertNoSend(calls);
  });

  it("text+html draft is multipart/alternative via the shared MIME builder", async () => {
    const { calls, fetchImpl } = mockDraftFetch();
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });
    await client.draftAs(
      {
        from: "Logistics <" + LOGISTICS + ">",
        to: "a@b.com",
        subject: "Both",
        body: "Plain part",
        html: "<p>HTML part</p>",
      },
      { boundary: "alt_draft" }
    );
    const inspected = inspectDraftCall(calls.find((c) => c.url === DRAFTS_URL));
    assert.match(inspected.mime, /^From: jim\.phillips@oberonlogistics\.com\r$/m);
    assert.match(
      inspected.mime,
      /Content-Type: multipart\/alternative; boundary="alt_draft"/
    );
    assert.match(inspected.mime, /Plain part/);
    assert.match(inspected.mime, /<p>HTML part<\/p>/);
    const expected = buildRfc2822(
      {
        from: LOGISTICS,
        to: "a@b.com",
        subject: "Both",
        body: "Plain part",
        html: "<p>HTML part</p>",
      },
      { boundary: "alt_draft" }
    );
    assert.equal(inspected.message.raw, toBase64Url(expected));
    assertNoSend(calls);
  });

  it("attachments use multipart/mixed with the same path/base64 shape as send_as", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-draft-as-"));
    const dest = path.join(dir, "invoice.PDF");
    const pdf = Buffer.from("%PDF-1.4 draft-attach-bytes", "utf8");
    await writeFile(dest, pdf);
    const png = Buffer.from("\x89PNG draft-png", "binary");

    try {
      const { calls, fetchImpl } = mockDraftFetch({
        draftResult: {
          id: "draft-att",
          message: { id: "msg-att", threadId: "thr-att", labelIds: ["DRAFT"] },
        },
      });
      const client = createGmailClient({
        getAccessToken: async () => "test-access-token",
        fetchImpl,
      });
      const result = await client.draftAs(
        {
          from: LOGISTICS,
          to: "ap@counterparty.com",
          subject: "Invoice draft",
          body: "Please find the invoice attached.",
          attachments: [
            { path: dest },
            {
              filename: "stamp.png",
              contentBase64: png.toString("base64"),
            },
          ],
        },
        { mixedBoundary: "mix_draft" }
      );
      assert.deepEqual(result, { id: "draft-att", threadId: "thr-att" });
      const inspected = inspectDraftCall(calls.find((c) => c.url === DRAFTS_URL));
      assert.match(inspected.mime, /Content-Type: multipart\/mixed; boundary="mix_draft"/);
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
      assertNoSend(calls);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("threaded variant sets In-Reply-To / References and threadId on the draft", async () => {
    const threading = buildThreadingHeaders(
      collectHeaders([
        { name: "Message-ID", value: "<abc@carrier.com>" },
        { name: "References", value: "<root@carrier.com>" },
      ])
    );
    const { calls, fetchImpl } = mockDraftFetch({
      draftResult: {
        id: "draft-thr",
        message: { id: "msg-thr", threadId: "thr-logistics", labelIds: ["DRAFT"] },
      },
    });
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });
    await client.draftAs({
      from: LOGISTICS,
      to: "Carrier Ops <dispatch@carrier.com>",
      subject: "Re: Load 1042",
      body: "Draft reply in thread.",
      threadId: "thr-logistics",
      inReplyTo: threading.inReplyTo,
      references: threading.references,
    });

    const inspected = inspectDraftCall(calls.find((c) => c.url === DRAFTS_URL));
    assert.equal(inspected.message.threadId, "thr-logistics");
    assert.equal(Object.keys(inspected.message).sort().join(","), "raw,threadId");
    assert.match(inspected.mime, /^In-Reply-To: <abc@carrier\.com>\r$/m);
    assert.match(
      inspected.mime,
      /^References: <root@carrier\.com> <abc@carrier\.com>\r$/m
    );
    assert.match(inspected.mime, /^From: jim\.phillips@oberonlogistics\.com\r$/m);
    assertNoSend(calls);
  });

  it("keeps https://ptycoin.com tracking URL byte-exact in decoded MIME", async () => {
    const { calls, fetchImpl } = mockDraftFetch();
    const client = createGmailClient({
      getAccessToken: async () => "test-access-token",
      fetchImpl,
    });
    const html = `<p>See <a href="${TRACKING_URL}">link</a></p>`;
    await client.draftAs({
      from: LOGISTICS,
      to: "a@b.com",
      subject: "URL intact",
      body: `Visit ${TRACKING_URL}`,
      html,
    });
    const inspected = inspectDraftCall(calls.find((c) => c.url === DRAFTS_URL));
    const idxText = inspected.mime.indexOf(TRACKING_URL);
    const idxHtml = inspected.mime.indexOf(TRACKING_URL, idxText + 1);
    assert.notEqual(idxText, -1);
    assert.notEqual(idxHtml, -1);
    assert.equal(
      inspected.mime.slice(idxText, idxText + TRACKING_URL.length),
      TRACKING_URL
    );
    assert.equal(
      inspected.mime.slice(idxHtml, idxHtml + TRACKING_URL.length),
      TRACKING_URL
    );
    assert.doesNotMatch(inspected.mime, /google\.com\/url/);
    assert.doesNotMatch(inspected.mime, /quoted-printable/i);
    assert.doesNotMatch(inspected.mime, /utm_source=3D/);
    assertNoSend(calls);
  });

  it("parseDraftResult requires a draft id", () => {
    assert.deepEqual(
      parseDraftResult({
        id: "d1",
        message: { id: "m1", threadId: "t1" },
      }),
      { id: "d1", threadId: "t1" }
    );
    assert.throws(() => parseDraftResult({ message: { id: "m1" } }), /draft id/);
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
