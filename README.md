# gmail-sendas

Cursor plugin (**Gmail sendAs + attachments**) that fills two gaps in the stock Gmail MCP:

1. **From / sendAs** — send mail as a verified Workspace alias, including **attach-on-send** for outbound PDFs/images
2. **Attachment bytes** — download inbound file data the stock connector cannot return

Keep **stock Gmail MCP** for inbox search, labels, and triage. This plugin is not a Gmail replacement.

## File tree

```text
.
├── .cursor-plugin/plugin.json   # name, displayName, OAuth variables (no secrets)
├── mcp.json                     # stdio MCP; env wires ${GOOGLE_*} into Node
├── skills/gmail-sendas/SKILL.md
├── src/
│   ├── index.js                 # stdio entry
│   ├── server.js                # MCP JSON-RPC + three tools
│   ├── gmail.js                 # fetch + MIME + OAuth refresh
│   └── secrets.js               # creds check + redaction
├── scripts/oauth-setup.js       # one-time helper; prints refresh token only
├── test/                        # mocked; no live Google calls
├── assets/logo.svg
├── package.json
├── LICENSE                      # MIT
└── README.md
```

No rules, hooks, agents, or commands.

## Tools

| Tool | API | Returns |
| --- | --- | --- |
| `list_send_as` | `GET https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs` | `SendAs[]` |
| `send_as` | `POST .../users/me/messages/send` with RFC2822 MIME `raw` (base64url); optional outbound attachments as multipart/mixed | `SendResult` (`id`, optional `threadId`) only |
| `get_attachment` | `GET .../users/me/messages/{messageId}/attachments/{attachmentId}` | `AttachmentBody`; writes a file when `path` is set |

`send_as` required arguments: `from` (sendAs alias email), `to`, `subject`, and `body` (plain text) and/or `html`. Optional: `cc`, `bcc`, `attachments`. The From header is set to the alias.

**Attach-on-send** (when the caller already has a local file and must send From an alias — do not fall back to the Gmail compose UI):

- Preferred: `{ path }` (e.g. `/workspace/outbox/invoice.PDF`), plus optional `filename` and `mimeType`
- Fallback: `{ contentBase64 }` (or `content`) + `filename` + `mimeType`
- First-class types: **PDF, JPG/JPEG, PNG**. `mimeType` is inferred from those extensions when omitted; other types are fine if `mimeType` is provided
- Combined RFC2822 message (headers + body + encoded attachments) must be under Gmail's **~25MB** limit; oversize is rejected before `messages.send`
- Return value is still `{ id, threadId }` only — never tokens or file bytes

Example call shape for agents (Consola / Inbox):

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

Base64 fallback when no local path is available:

```json
{
  "from": "ops@oberonlogistics.com",
  "to": "ap@counterparty.com",
  "subject": "Signed rate con",
  "html": "<p>Signed copy attached.</p>",
  "attachments": [
    {
      "filename": "rate-con.pdf",
      "mimeType": "application/pdf",
      "contentBase64": "<standard-base64-bytes>"
    }
  ]
}
```

After merge, **restart / reinstall the MCP server** for Grok Bot stdio installs. Tool schemas are loaded at process start (`tools/list` from `TOOL_DEFS`); an already-running stdio process will not advertise `attachments` until it is restarted.

OAuth tokens are never returned or logged.

## Data shapes

```js
/** @typedef {{ sendAsEmail: string, displayName?: string, isPrimary?: boolean, isDefault?: boolean, verificationStatus?: string }} SendAs */
/** @typedef {{ id: string, threadId?: string }} SendResult */
/** @typedef {{ path?: string, filename?: string, mimeType?: string, contentBase64?: string, content?: string }} SendAttachment */
/** @typedef {{ size: number, data: string, attachmentId: string, filename?: string, path?: string }} AttachmentBody */
```

`AttachmentBody.data` is **standard base64** of the decoded bytes (Gmail's wire format is base64url). `path` is present only when a disk write was requested.

## Implementation choice

**Zero runtime npm dependencies.** Node 18+ `fetch` refreshes the access token and calls Gmail REST. `googleapis` is not used — three endpoints do not justify the install. The MCP layer is a small stdio JSON-RPC 2.0 shim (newline-delimited, plus Content-Length read for older clients) instead of `@modelcontextprotocol/sdk`.

## Auth (Jim — one-time, local)

Sign in as the Google Workspace user who **owns the sendAs aliases** (the Oberon mailbox that sends as `oberonlogistics.com` / `ogholdings.biz` / `oberon.group` — typically the primary Workspace user). Do this on a trusted machine. **Never commit tokens** or paste them into git, issues, or screenshots.

### 1. Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. **APIs & Services → Library** → enable **Gmail API**.
4. **OAuth consent screen**: User type **Internal** (Workspace). App name can be `gmail-sendas`.
5. Add scopes (minimum):
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.settings.basic`
6. **Credentials → Create credentials → OAuth client ID** → application type **Desktop app** (or Web).
7. Add authorized redirect URI: `http://127.0.0.1:53682/oauth2callback`
8. Copy the **client ID** and **client secret**. Leave them out of the repo.

### 2. Print a refresh token (stdout only)

```bash
cd /path/to/gmail-sendas-connector
export GOOGLE_CLIENT_ID='your-client-id.apps.googleusercontent.com'
export GOOGLE_CLIENT_SECRET='your-client-secret'
node scripts/oauth-setup.js
```

The script prints an authorization URL on **stderr**. Open it, sign in as the Workspace user, and approve. On success, **stdout is a single refresh token** — nothing else. Copy that value.

If Google does not return a refresh token, revoke the app under [Google Account → Apps with access](https://myaccount.google.com/permissions) and re-run. The helper always uses `access_type=offline` and `prompt=consent`.

Optional: `OAUTH_PORT` (default `53682`) if that port is busy. The redirect URI in Cloud Console must match.

### 3. Cursor → Plugins → Configure

Install or enable this plugin, then set:

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from Cloud Console |
| `GOOGLE_CLIENT_SECRET` | from Cloud Console |
| `GOOGLE_REFRESH_TOKEN` | stdout from `oauth-setup.js` |

`mcp.json` injects those `${VAR}` placeholders into the Node process. The server exchanges the refresh token for a short-lived access token at runtime.

## Tests (no live Google)

```bash
npm test
```

Requires Node 18+. Coverage (all mocked):

- `list_send_as` response parsing
- `send_as` builds the From header and `users.messages.send` `{ raw }` body
- `send_as` attachments: multipart/mixed Content-Type / Content-Disposition, path read, base64 fallback, ~25MB oversize reject; no-attachment MIME unchanged
- `get_attachment` decodes base64url and writes a file of the expected byte length
- Missing-credential / refresh errors never echo secrets or file contents

## Live demo (after Jim finishes auth)

Not run in CI. After Configure is filled:

1. In Cursor, ask: *List my Gmail sendAs aliases.* Expect verified rows for the logistics / holdings / group domains as configured on the mailbox.
2. Send a test: *Send a short test to myself From the logistics alias* (`send_as` with `from` = that `*.oberonlogistics.com` address). Confirm the message in Gmail shows the alias as From. Note the returned `id` only.
3. Download a known inbound PDF: use stock Gmail to find a message and its `attachmentId`, then *Save that attachment to `/tmp/rate-con.pdf`* via `get_attachment`. Confirm the file opens and the byte length is non-zero.

## From-routing (no secrets)

- Logistics / carrier / dispatch → `*.oberonlogistics.com` sendAs
- Holdings / entity → `*.ogholdings.biz` sendAs
- Default workspace identity → `*.oberon.group` sendAs

Always prefer `list_send_as` over hardcoding addresses.

## Non-goals

- Full Gmail replacement (filters, drafts UI, label management)
- Calendar
- Cursor Marketplace publish — **owner decides later**

## License

MIT
