---
name: Email and SMS channels
description: Connect this agent to email (send and receive) and SMS so a role can run full conversations across channels. SMS is via Telnyx; email is via SMTP/IMAP, a managed API (Mailgun/Resend/Postmark), or Gmail OAuth. Includes deliverability, threading, and opt-out rules.
tags: email, sms, channels, imap, smtp, telnyx
agents: any
---

You are wiring a role up to **email** and **SMS** so you can hold a thread
across whichever channel a person uses. SMS is Telnyx (see the
**telnyx-phone-setup** skill for the number, messaging profile, and 10DLC).
This skill covers email, and how to run the two channels as one conversation.

Placeholders only — never commit a real credential:

- `<EMAIL_ADDRESS>`, `<SMTP_HOST>`, `<SMTP_PORT>`, `<SMTP_USER>`, `<SMTP_PASS>`
- `<IMAP_HOST>`, `<IMAP_PORT>`
- `<MAIL_API_KEY>`, `<SENDING_DOMAIN>`
- `<TELNYX_API_KEY>`, `<TELNYX_NUMBER>`, `<MESSAGING_PROFILE_ID>`

## 🚨 Sandbox network first

Outbound to mail/SMS hosts (`api.telnyx.com`, your SMTP/IMAP host, or
`api.mailgun.net` / `api.resend.com` / `api.postmarkapp.com`) is blocked in an
OpenShell sandbox until the operator approves it. Make the request, let it
raise the approval, ask the operator to grant it, then retry. A DNS/timeout
error means "not approved yet," not "broken."

## Email — pick one connector

| Option | Use when | Send | Receive |
|---|---|---|---|
| **Managed API** (Mailgun / Resend / Postmark) | New client, you control a sending domain. Best deliverability, simplest. | HTTPS POST | Inbound-parse webhook → your gateway |
| **SMTP + IMAP** | Client already has a mailbox and will give credentials or an app password | SMTP | IMAP poll / IDLE |
| **Gmail / Google Workspace OAuth** | Client lives in Gmail and wants replies from their own address | Gmail API | Gmail API |

### A — Managed API (recommended for new setups)

Operator: create a sending domain `<SENDING_DOMAIN>` in the provider and add
the **SPF, DKIM, and DMARC** DNS records it gives you. Email without these
lands in spam. Create `<MAIL_API_KEY>`.

Send (Mailgun shape; Resend/Postmark differ only in URL and field names):

```bash
curl -s -X POST "https://api.mailgun.net/v3/<SENDING_DOMAIN>/messages" \
  --user "api:<MAIL_API_KEY>" \
  -F from="{{from_name}} <hello@<SENDING_DOMAIN>>" \
  -F to="prospect@example.com" \
  -F subject="Re: your enquiry" \
  -F text="Thanks for reaching out — ..."
```

Receive: the provider POSTs inbound email to a route/webhook that reaches your
gateway (`<YOUR_WEBHOOK_URL>/mail`). You get sender, subject, body, and the
`In-Reply-To` / `References` headers — keep those to stay in the same thread.

### B — SMTP + IMAP (client's existing mailbox)

Operator supplies host/port/user and an **app password** (not the login
password; providers require an app-specific password when 2FA is on). Send via
SMTP over TLS; read via IMAP (poll the inbox every 1–2 minutes, or use IDLE if
your runtime supports it). On reply, set `In-Reply-To` and `References` to the
message you are answering, and keep the `Subject` with its `Re:`.

### C — Gmail OAuth

Operator runs the OAuth consent once and stores the refresh token in the
runtime's secret store. You then call the Gmail API to send (as the client's
address) and to list/read threads. Use this only when the client insists
replies come from their own Gmail.

## Running email + SMS as one conversation

A person may text, then email, then text again. Treat them as one thread:

1. **Key the conversation on the person, not the channel.** Match on phone and
   email in the CRM/contact record. One contact = one history.
2. **Reply on the channel they used last**, unless they asked otherwise.
3. **Log every message both ways** to the contact record with a timestamp and
   the channel, so a human can read the whole thread in one place.
4. **Never duplicate.** If you just emailed an answer, do not also text it.

## Opt-out and consent (do not skip)

- **SMS:** first message of a thread carries an opt-out line
  (`Reply STOP to opt out`). On an inbound `STOP`/`UNSUBSCRIBE`, mark the
  contact opted out of SMS and never text again. US A2P sending needs 10DLC
  (telnyx-phone-setup).
- **Email:** marketing/outreach email needs a working unsubscribe and your
  physical sender identity (CAN-SPAM / the client's local equivalent). On an
  unsubscribe or a clear "stop emailing me," mark opted out of email.
- Opt-out is **per channel and per contact**, and it is permanent until the
  person re-opts in. Store it on the contact record, not in memory.

## Human-review checkpoints

- A human approves the **first** outbound message to a brand-new contact for a
  given role until the operator tells you to run unattended.
- Anything that commits the client — a price not on the approved list, a
  refund, a legal or medical statement — is drafted, flagged, and left for a
  human. Never send it on your own.

## Verify

- Send yourself an email from the connector; confirm it arrives in the inbox,
  not spam (if spam: SPF/DKIM/DMARC are missing or wrong — operator fixes DNS).
- Reply to a thread; confirm it threads (same subject, `In-Reply-To` set).
- Text the Telnyx number; confirm inbound wakes you and your reply arrives.
- Send `STOP`; confirm the contact is marked opted out and a follow-up is
  suppressed.

## Common mistakes

1. Sending from a domain with no SPF/DKIM/DMARC → straight to spam.
2. Treating email and SMS as two separate people → duplicate, contradictory
   replies.
3. Ignoring `STOP`/unsubscribe → compliance violation.
4. Threading lost because `In-Reply-To`/`References` were dropped → every reply
   starts a new thread and looks robotic.
5. Login password instead of an app password for IMAP/SMTP with 2FA on.
