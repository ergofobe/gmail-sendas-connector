---
name: gmail-sendas
description: >
  Send Gmail from a specific Workspace sendAs alias, list sendAs aliases, or
  download inbound attachment bytes. Use this plugin only for sendAs +
  attachments. Use stock Gmail MCP for inbox search, labels, and triage.
---

# Gmail sendAs + attachments

## When to use

Use **this plugin** when the task is one of:

- Sending mail that **must leave From a specific Workspace alias** (for example `oberonlogistics.com`, `ogholdings.biz`, `oberon.group`, or another verified sendAs on the mailbox)
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
| `send_as` | Send with `from` set to the alias email; optional `cc` / `bcc`; `body` and/or `html` |
| `get_attachment` | Decode attachment bytes; write to `path` when the user needs a file on disk |

`send_as` returns `{ id, threadId }` only. Never ask it to print tokens or raw MIME.

## From-routing policy (examples)

Pick `from` from `list_send_as`, not from memory. Typical routing (no secrets):

- **Operating / logistics traffic** (carriers, brokers, rate cons, dispatch) → the `*.oberonlogistics.com` sendAs
- **Holdings / corporate** (entity, banking, ownership) → the `*.ogholdings.biz` sendAs
- **Default workspace identity** (internal, catch-all, or unspecified) → the `*.oberon.group` primary / default sendAs

If the user names a brand ("send as logistics") and `list_send_as` has a matching verified alias, use that alias. If none match, ask rather than inventing an address.

## Workflow

1. If From-routing is required and the alias is unknown: `list_send_as`.
2. Send with `send_as` (`from` = alias email, never the stock Gmail "send" tool).
3. For an inbound file: get `messageId` + `attachmentId` from stock Gmail, then `get_attachment` (set `filename` + `path` when writing a PDF to disk).

## Auth

OAuth is configured in Cursor → Plugins → Configure (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`). If a tool fails with missing configuration, point the user at the README auth steps. Do not request that tokens be pasted into chat.
