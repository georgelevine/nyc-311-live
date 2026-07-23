# NYC311 inbound notification email

This stack receives every address at `track.opendata.support`, stores the
original MIME message privately in S3, and sends the exact same bytes to the
NYC311 Lightsail application over HTTPS.

An address such as
`r28327449-f4k8m2@track.opendata.support` is a routing token, not a mailbox.
There is no Cloudflare alias, SES identity, or inbox to create for each request.
Once the catch-all domain is configured, the application can generate a new,
unguessable local part for every service request.

## What the stack creates

- A private, encrypted, versioned S3 bucket for original MIME messages.
- An explicit SES identity for `track.opendata.support`, with the three Easy
  DKIM verification CNAMEs exposed as stack outputs.
- A lifecycle rule that removes raw messages after a configurable retention
  period (90 days by default). The bucket itself is retained if the stack is
  deleted.
- An SES receipt rule for the whole dedicated inbound domain.
- A Node.js Lambda invoked after the S3 action. It reads the stored object and
  posts `Content-Type: message/rfc822` to the configured HTTPS endpoint.
- Immediate Gmail copies of authenticated, parsed updates whose registered
  aliases fall within the configured pilot SR-number range. Each copy is sent
  from that request's unique `track.opendata.support` alias.
- Two automatic retries for asynchronous Lambda failures and an encrypted SQS
  failure queue after retries are exhausted.
- A 30-day CloudWatch log group. Message bodies and the webhook secret are never
  logged.

The webhook must be idempotent. Use the SES `messageId` in the signed metadata
as a unique key so Lambda retries cannot create duplicate database events.
SES's S3 receipt action accepts messages up to 30 MB; NYC311 notices are far
smaller, but the webhook should still enforce its own conservative body limit.

## Before deployment

Use `us-east-1`; that is the receiving region and MX target for this setup.
Create the Lightsail webhook first, and configure it with the same random secret
passed to CloudFormation.

Generate a secret locally without printing the value into shell history:

```sh
WEBHOOK_SECRET="$(openssl rand -hex 32)"
export WEBHOOK_SECRET
```

The value must contain at least 32 characters. Keep it out of Git and deployment
logs.

## Deploy

In the AWS console, switch to `us-east-1`, open CloudFormation, choose
**Create stack → With new resources**, upload `template.yaml`, fill the
parameters, and acknowledge that the stack creates IAM resources.

Or, from the repository root with AWS CLI credentials configured:

```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name nyc311-inbound-email \
  --template-file aws/inbound-email/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    RecipientDomain=track.opendata.support \
    WebhookUrl=https://311.georgelevine.com/api/inbound/nyc311-email \
    WebhookSecret="$WEBHOOK_SECRET" \
    ForwardToEmail=georgealevine@gmail.com \
    ForwardPilotMinSuffix=28334803 \
    ForwardPilotMaxSuffix=28334842
```

After deployment, inspect the outputs:

```sh
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name nyc311-inbound-email \
  --query 'Stacks[0].Outputs'
```

## Verify the dedicated receiving identity

SES requires the receiving domain to be a verified identity. Verification of
`311.opendata.support` does not cover the sibling
`track.opendata.support` subdomain, so the stack creates the latter explicitly.

Copy each `DkimCnameNameN`/`DkimCnameValueN` output pair into Cloudflare as a
DNS-only CNAME. Use the exact fully qualified name and target returned by AWS.
Wait until the `track.opendata.support` identity is **Verified** in SES before
publishing the MX record or starting the pilot. CloudFormation can create the
identity, but only the DNS records can complete verification.

## Activate the receipt rule set carefully

SES supports only one active receipt rule set per region, and CloudFormation
does not activate one. First check whether the account already receives email:

```sh
aws ses describe-active-receipt-rule-set --region us-east-1
```

If there is no active set, or this new dedicated set may safely replace it,
activate the `ReceiptRuleSetName` stack output:

```sh
aws ses set-active-receipt-rule-set \
  --region us-east-1 \
  --rule-set-name nyc311-inbound
```

Do **not** replace an unrelated active set. In that case, add an equivalent rule
to the existing set (S3 action first, Lambda action second), or migrate the
existing rules into a shared set before changing activation.

## Cloudflare DNS

Only after the stack exists, its three verification CNAMEs are published, and
the SES identity is verified, add this DNS record to the
`opendata.support` zone:

| Type | Name | Priority | Target |
| --- | --- | ---: | --- |
| MX | `track` | 10 | `inbound-smtp.us-east-1.amazonaws.com` |

MX records are never proxied. This dedicated subdomain keeps inbound receiving
separate from the existing `311.opendata.support` outbound sender and from any
Gmail routing on the apex domain.

## Webhook authentication contract

The request body is the exact S3 object: the original raw MIME bytes. Lambda
sends these headers:

- `x-nyc311-email-version: 1`
- `x-nyc311-email-timestamp`: Unix time in seconds
- `x-nyc311-email-metadata`: base64url JSON containing the SES message ID, S3
  location, envelope source/destinations, receipt recipients, and SES
  spam/virus/SPF/DKIM/DMARC verdicts
- `x-nyc311-email-signature: v1=<lowercase hex HMAC-SHA256>` authenticates
  the exact raw MIME request body
- `x-nyc311-email-envelope-signature: v1=<lowercase hex HMAC-SHA256>`
  authenticates the timestamp and SES metadata
- `x-nyc311-recipient`: the first SES envelope recipient (the unique request
  alias), when SES supplies one

Verify the primary signature by computing HMAC-SHA256 with the shared secret
over the unchanged request-body bytes only.

Then verify the envelope signature by computing HMAC-SHA256 over the UTF-8
bytes for:

```text
v1\n<TIMESTAMP>\n<METADATA>\n<BODY_SIGNATURE_HEX>
```

`BODY_SIGNATURE_HEX` is the lowercase hexadecimal primary HMAC without the
`v1=` prefix. Compare both signatures with a timing-safe comparison. Reject
stale timestamps (five minutes is a reasonable window), non-HTTPS traffic,
oversized messages, and invalid signatures. Only after both checks should the
receiver decode the metadata and enforce
`verdicts.spamVerdict === "PASS"` and
`verdicts.virusVerdict === "PASS"` before parsing or updating a request.
Treat the signed metadata's first receipt recipient as authoritative; the
convenience recipient header must match it.

The S3 object remains the recovery source if the webhook is unavailable or a
parser bug is discovered. Failed events can be replayed from S3 by message ID.

## Pilot test

1. Subscribe one known NYC311 request using a unique address such as
   `r28327449-f4k8m2@track.opendata.support`.
2. Confirm a new object appears under `raw/` in the output S3 bucket.
3. Confirm the Lambda log contains `inbound_email_delivered` with the same SES
   message ID and a 2xx webhook response.
4. Confirm one idempotent email-event row was stored by the application.
5. Replay that same object once and confirm it does not create a duplicate.

Do this controlled pilot before generating addresses or subscriptions in bulk.
