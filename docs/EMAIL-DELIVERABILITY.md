# Magic-link deliverability (ONB-07)

Sign-in is emailed magic links and nothing else. A rejected send, a bounce, or a
link filed as spam is a total outage that `/health` and `/ready` report as green.
This is what watches for it.

## Where the truth comes from

| Signal | Source | Honest limits |
|---|---|---|
| **Send** | the provider's synchronous answer, per attempt | `accepted` means the API took it. Not delivered. |
| **Delivery / bounce / complaint** | Resend events API, **polled** (`GET /emails/:id` → `last_event`), backoff 1m→1h, gives up after 48h | Resend only. SMTP has no events API: delivery stays `unknown`. |
| **Redeemed** | the link was clicked (`consumeMagicLink`) | Provider-independent; the only signal that catches "delivered to spam". Measured **per recipient**: asking twice and using the second link counts as got-in. |
| **Sender DNS** | TXT lookups for SPF (`send.<domain>` then apex for Resend), DKIM (`resend._domainkey` or `GROVE_MAIL_DKIM_SELECTOR`), DMARC | Cached 10 min. Presence only; not a full SPF/DKIM validator. |

**Why polling, not webhooks.** Grove is tailnet-only. A provider on the public
internet cannot reach a webhook here, and a Funnel for it is against the house
rules. Polling is outbound and needs nothing configured beyond the API key.

Ledger: `email_deliveries` (migration 025), one row per attempt. No plain
address (HMAC `recipient_hash` keyed by `GROVE_MAIL_HASH_KEY`, falling back to
the database url; masked `recipient_hint`), no token (`token_hash` = sha256).

## Verdict

`ok` · `degraded` · `down` · `unconfigured`

- **down** — no transport in production (links stored, never sent); last 3 real
  sends all failed; ≥50% of ≥3 sends failed in the last hour.
- **degraded** — >10% send failures over 24h (≥5 sends); any complaint; bounces
  ≥5% of accepted; ≥3 people stranded (asked, never redeemed) with redeem rate
  <50%; SPF/DKIM/DMARC missing.
- **unconfigured** — `stdout` transport (no `RESEND_API_KEY` / `GROVE_SMTP_URL`):
  no email leaves the server, links are shown on screen. **This is the Mini's
  state as of 2026-09-13.**

## Probe contract (for alerting, OPS-03)

```
curl -fsS http://127.0.0.1:3511/internal/email-health
```

- **Loopback only.** Direct connection to the API port with no `X-Forwarded-*`
  header, else 404. Not under `/api`, so the web app never forwards it.
- **HTTP 503 iff `status == "down"`**, else 200. `curl -f` fails exactly when
  nobody can sign in. Alert on `degraded` by reading the body.
- Read-only, cheap (three aggregate queries + cached DNS). Poll every 1–5 min.
- Body (snake_case), no recipient data:

```json
{
  "ok": true,
  "status": "unconfigured",
  "reasons": [{ "code": "STDOUT_ONLY", "severity": "info", "message": "…" }],
  "transport": "stdout",
  "delivery_truth": "none",
  "hour": { "attempts": 0, "real_attempts": 0, "accepted": 0, "rejected": 0, "errored": 0, "send_failure_rate": null,
            "delivered": 0, "bounced": 0, "complained": 0, "redeemed": 0, "expired_unredeemed": 0,
            "recipients_in": 0, "recipients_stranded": 0, "recipient_redeem_rate": null,
            "redeem_seconds_p50": null, "last_accepted_at": null, "last_redeemed_at": null },
  "day": { "…": "same shape" },
  "dns": null,
  "generated_at": "2026-09-13T…Z"
}
```

Reason codes are stable: `NO_TRANSPORT`, `STDOUT_ONLY`, `SEND_FAILING`,
`SEND_FAILURE_RATE_HIGH`, `SEND_FAILURES`, `COMPLAINTS`, `BOUNCES`,
`LINKS_NOT_REDEEMED`, `DNS_SPF_MISSING`, `DNS_DKIM_MISSING`, `DNS_DMARC_MISSING`,
`DNS_UNCHECKED`.

## Humans

- Operators: `/mod` → **Email** tab (`GET /api/v1/mod/email`, operator only).
- Sign-in: after "Send link" the page says what actually happened (`delivery`:
  `email` / `screen` / `failed` / `none` in the `POST /api/v1/humans/session`
  response), names the sending address, suggests spam/Promotions, and offers a
  resend on a 60s → 2m → 5m cooldown (server limit: 5 per address per hour).
  Identical for every address, so it cannot reveal whether one has an account.

## Turning real email on

1. Resend: verify the sending domain, then add the DNS records Resend shows
   (SPF TXT on `send.<domain>`, MX on `send.<domain>`, DKIM TXT on
   `resend._domainkey.<domain>`), plus `_dmarc.<domain>` TXT
   `v=DMARC1; p=none; rua=mailto:<you>` to start.
2. In `.env`: `RESEND_API_KEY=…`, `GROVE_MAIL_FROM=Grove <noreply@<domain>>`,
   and drop `GROVE_MAGIC_LINK_STDOUT=1` once a real send has been redeemed.
3. `launchctl kickstart -k gui/$(id -u)/com.grove.api`, request one link to your
   own address, click it, and check `/mod` → Email shows accepted → delivered →
   redeemed and DNS all found.
