---
name: gmail-sendas
description: >
  Send Gmail from a specific Workspace sendAs alias (including outbound file
  attachments), reply in-thread From the landed alias (reply_as), list sendAs
  aliases, or download inbound attachment bytes. Use this plugin only for
  sendAs + reply_as + attachments. Use stock Gmail MCP for inbox search,
  labels, and triage (including stock reply when From the primary mailbox is
  fine).
---

# Gmail sendAs + attachments

## When to use

Use **this plugin** when the task is one of:

- Sending a **new** message that **must leave From a specific Workspace alias** (`send_as`)
- **In-thread reply** that must From the address the mail landed on, or another sendAs (`reply_as`) — stock Gmail `reply` threads correctly but always sends From the primary mailbox
- **Attach-on-send**: the caller already has a local PDF/JPG/PNG (or other file) and must email it From that alias — do **not** fall back to the Gmail compose UI
- Listing the mailbox's sendAs aliases (`list_send_as`)
- Downloading **inbound attachment bytes** (PDFs, rate cons, BOLs) that the stock Gmail connector cannot fetch

Use **stock Gmail MCP** for everything else:

- Inbox search, thread read, drafts (without a custom From)
- Labels, archive, trash, triage
- Stock `reply` when From the **primary mailbox** is acceptable
- Listing message metadata / attachment *ids* (then hand `messageId` + `attachmentId` to `get_attachment` here)

Do **not** treat this plugin as a full Gmail replacement.

## Tools

| Tool | Use |
| --- | --- |
| `list_send_as` | Confirm which aliases exist and which is default/verified |
| `send_as` | **New** message with `from` set to the alias email; optional `cc` / `bcc`; `body` and/or `html`; optional `attachments` |
| `reply_as` | **In-thread reply** From the landed alias (or explicit `from`). Required: `messageId` + `body` and/or `html`. Optional: `threadId`, `from`, `to` / `cc` / `bcc`, `replyAll`, `attachments` |
| `get_attachment` | Decode **inbound** attachment bytes; write to `path` when the user needs a file on disk |

`send_as` and `reply_as` return `{ id, threadId }` only. Never ask them to print tokens, raw MIME, or file contents.

## `reply_as` vs `send_as` vs stock Gmail `reply`

| Need | Tool |
| --- | --- |
| New outbound that must From an alias | `send_as` |
| Reply that must From the landed alias (e.g. logistics inbound) | `reply_as` |
| Reply when From the primary mailbox is OK | stock Gmail `reply` |

`messageId` is required (the inbound Gmail message to reply to). `threadId` is optional and is taken from that message when omitted.

**From resolution**

1. If `from` is provided, use it — it must be a sendAs alias (`list_send_as`).
2. Else infer from inbound headers, in order: Delivered-To, X-Original-To, then To (parse the address). First match against sendAs aliases (case-insensitive) wins.
3. If none match: the tool fails. Pass explicit `from`, or the landed address is not a sendAs.

Default recipients are reply-to-sender (parent Reply-To or From). Set `replyAll: true` to Cc original To/Cc except our sendAs address.

Example (omit `from` so the logistics Delivered-To can be inferred):

```json
{
  "messageId": "18f2c0ab1234def0",
  "body": "Got it — confirming pickup."
}
```

Example with an explicit alias and a local attachment:

```json
{
  "messageId": "18f2c0ab1234def0",
  "from": "jim.phillips@oberonlogistics.com",
  "body": "Rate con attached.",
  "attachments": [{ "path": "/workspace/outbox/rate-con.pdf" }]
}
```

## Attach-on-send (`send_as.attachments`)

Use when Consola / Inbox (or any agent) has a file on disk and needs to send it From a Workspace alias.

Preferred input — local path; `filename` and `mimeType` optional (inferred from `.pdf` / `.jpg` / `.jpeg` / `.png`):

```json
{
  "from": "ops@oberonlogistics.com",
  "to": "ap@counterparty.com",
  "subject": "Invoice 1042",
  "body": "Please find the invoice attached.",
  "attachments": [
    { "path": "/workspace/outbox/invoice.PDF" }
  ]
}
```

Fallback when bytes are already in memory (no path): `contentBase64` (or `content`) + `filename` + `mimeType`:

```json
{
  "from": "ops@oberonlogistics.com",
  "to": "ap@counterparty.com",
  "subject": "POD photo",
  "body": "Proof of delivery attached.",
  "attachments": [
    {
      "filename": "pod.jpg",
      "mimeType": "image/jpeg",
      "contentBase64": "<standard-base64-bytes>"
    }
  ]
}
```

Rules:

- First-class types: **PDF, JPG/JPEG, PNG**. Other types are OK if `mimeType` is provided.
- Combined message size (headers + body + encoded attachments) must stay under Gmail's **~25MB** limit. If the tool rejects oversize, shrink or drop files — do not retry a live send.
- `get_attachment` is inbound only. Outbound files go on `send_as` or `reply_as`, not through compose UI.

After this plugin is updated, **restart or reinstall the MCP server** (Grok Bot stdio installs included). `tools/list` is served from process memory; a running stdio server will not show `reply_as` or `attachments` until restart.

## From-routing policy (examples)

Pick `from` from `list_send_as`, not from memory. Typical routing (no secrets):

- **Operating / logistics traffic** (carriers, brokers, rate cons, dispatch) → the `*.oberonlogistics.com` sendAs
- **Holdings / corporate** (entity, banking, ownership) → the `*.ogholdings.biz` sendAs
- **Default workspace identity** (internal, catch-all, or unspecified) → the `*.oberon.group` primary / default sendAs

If the user names a brand ("send as logistics") and `list_send_as` has a matching verified alias, use that alias. If none match, ask rather than inventing an address.

## Workflow

1. If From-routing is required and the alias is unknown: `list_send_as`.
2. **New message:** `send_as` (`from` = alias email, never the stock Gmail "send" tool). Add `attachments: [{ path }]` when a local file should go out with the message.
3. **In-thread reply that must From the landed alias:** `reply_as` with the inbound `messageId` (omit `from` to infer Delivered-To / X-Original-To / To). Do **not** use stock Gmail `reply` for alias-landed mail — it always sends From the primary mailbox.
4. For an inbound file: get `messageId` + `attachmentId` from stock Gmail, then `get_attachment` (set `filename` + `path` when writing a PDF to disk).

## Auth

OAuth is configured in Cursor → Plugins → Configure (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`). If a tool fails with missing configuration, point the user at the README auth steps. Do not request that tokens be pasted into chat.
