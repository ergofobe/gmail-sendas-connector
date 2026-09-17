---
name: gmail-sendas
description: >
  Send Gmail from a specific Workspace sendAs alias (including outbound file
  attachments), list sendAs aliases, or download inbound attachment bytes. Use
  this plugin only for sendAs + attachments. Use stock Gmail MCP for inbox
  search, labels, and triage.
---

# Gmail sendAs + attachments

## When to use

Use **this plugin** when the task is one of:

- Sending mail that **must leave From a specific Workspace alias** (for example `oberonlogistics.com`, `ogholdings.biz`, `oberon.group`, or another verified sendAs on the mailbox)
- **Attach-on-send**: the caller already has a local PDF/JPG/PNG (or other file) and must email it From that alias — do **not** fall back to the Gmail compose UI
- Listing the mailbox's sendAs aliases (`list_send_as`)
- Downloading **inbound attachment bytes** (PDFs, rate cons, BOLs) that the stock Gmail connector cannot fetch

Use **stock Gmail MCP** for everything else:

- Inbox search, thread read, drafts (without a custom From)
- Labels, archive, trash, triage
- Listing message metadata / attachment *ids* (then hand `messageId` + `attachmentId` to `get_attachment` here)

Do **not** treat this plugin as a full Gmail replacement.

## Tools

| Tool | Use |
| --- | --- |
| `list_send_as` | Confirm which aliases exist and which is default/verified |
| `send_as` | Send with `from` set to the alias email; optional `cc` / `bcc`; `body` and/or `html`; optional `attachments` |
| `get_attachment` | Decode **inbound** attachment bytes; write to `path` when the user needs a file on disk |

`send_as` returns `{ id, threadId }` only. Never ask it to print tokens, raw MIME, or file contents.

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
- `get_attachment` is inbound only. Outbound files go on `send_as`, not through compose UI.

After this plugin is updated, **restart or reinstall the MCP server** (Grok Bot stdio installs included). `tools/list` is served from process memory; a running stdio server will not show `attachments` until restart.

## From-routing policy (examples)

Pick `from` from `list_send_as`, not from memory. Typical routing (no secrets):

- **Operating / logistics traffic** (carriers, brokers, rate cons, dispatch) → the `*.oberonlogistics.com` sendAs
- **Holdings / corporate** (entity, banking, ownership) → the `*.ogholdings.biz` sendAs
- **Default workspace identity** (internal, catch-all, or unspecified) → the `*.oberon.group` primary / default sendAs

If the user names a brand ("send as logistics") and `list_send_as` has a matching verified alias, use that alias. If none match, ask rather than inventing an address.

## Workflow

1. If From-routing is required and the alias is unknown: `list_send_as`.
2. Send with `send_as` (`from` = alias email, never the stock Gmail "send" tool). Add `attachments: [{ path }]` when a local file should go out with the message.
3. For an inbound file: get `messageId` + `attachmentId` from stock Gmail, then `get_attachment` (set `filename` + `path` when writing a PDF to disk).

## Auth

OAuth is configured in Cursor → Plugins → Configure (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`). If a tool fails with missing configuration, point the user at the README auth steps. Do not request that tokens be pasted into chat.
