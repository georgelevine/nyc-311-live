'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClosureTracker, isClosedStatus } = require('./closure-tracking');
const {
  applyMigrations,
  openDatabase
} = require('./sqlite-finalization');
const {
  DEFAULT_INBOUND_EMAIL_DOMAIN,
  normalizeInboundEmailDomain
} = require('./nyc311-email-aliases');

const MAX_RAW_EMAIL_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERY_AGE_SECONDS = 5 * 60;
const REQUEST_NUMBER_PATTERN = /^311-\d{8}$/;
const SIGNATURE_PATTERN = /^(?:v1=|sha256=)?([a-f0-9]{64})$/i;
const EMAIL_PATTERN = /^[^@\s<>]+@[^@\s<>]+$/;

function cleanText(value, maximumLength = 2048) {
  if (value == null) return null;
  const cleaned = String(value).replace(/\0/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maximumLength);
}

function normalizedRequestNumber(value) {
  const requestNumber = cleanText(value, 64);
  return requestNumber && REQUEST_NUMBER_PATTERN.test(requestNumber)
    ? requestNumber
    : null;
}

function signatureBytes(value) {
  const match = String(value || '').trim().match(SIGNATURE_PATTERN);
  return match ? Buffer.from(match[1], 'hex') : null;
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function secureSignatureMatch(actualHeader, expectedHex) {
  const actual = signatureBytes(actualHeader);
  const expected = Buffer.from(expectedHex, 'hex');
  return Boolean(actual && actual.length === expected.length
    && crypto.timingSafeEqual(actual, expected));
}

function verifyRawSignature(raw, signatureHeader, secret) {
  if (!Buffer.isBuffer(raw)) return false;
  return secureSignatureMatch(signatureHeader, hmacHex(secret, raw));
}

function decodeSignedMetadata(encoded) {
  const value = String(encoded || '').trim();
  if (!value || value.length > 64 * 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid signed metadata');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('invalid signed metadata');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || Number(decoded.version) !== 1) {
    throw new Error('invalid signed metadata');
  }
  const stringArray = (candidate) => Array.isArray(candidate)
    ? candidate.filter(item => typeof item === 'string').map(item => item.slice(0, 2048))
    : [];
  const verdicts = decoded.verdicts && typeof decoded.verdicts === 'object'
    ? decoded.verdicts
    : {};
  return {
    version: 1,
    messageId: cleanText(decoded.messageId, 512),
    bucket: cleanText(decoded.bucket, 512),
    key: cleanText(decoded.key, 2048),
    receivedAt: cleanText(decoded.receivedAt, 128),
    source: cleanText(decoded.source, 2048),
    destinations: stringArray(decoded.destinations),
    recipients: stringArray(decoded.recipients),
    verdicts: {
      spamVerdict: cleanText(verdicts.spamVerdict, 32),
      virusVerdict: cleanText(verdicts.virusVerdict, 32),
      spfVerdict: cleanText(verdicts.spfVerdict, 32),
      dkimVerdict: cleanText(verdicts.dkimVerdict, 32),
      dmarcVerdict: cleanText(verdicts.dmarcVerdict, 32)
    }
  };
}

function verifySignedEnvelope({
  raw,
  secret,
  version,
  timestamp,
  encodedMetadata,
  bodySignature,
  envelopeSignature,
  recipient,
  now = new Date(),
  maximumAgeSeconds = MAX_DELIVERY_AGE_SECONDS
}) {
  if (String(version || '') !== '1') throw new Error('invalid webhook authentication');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const timestampText = String(timestamp || '');
  if (!/^\d{10,13}$/.test(timestampText)) throw new Error('invalid webhook authentication');
  const timestampSeconds = Number(timestampText);
  if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(nowSeconds - timestampSeconds) > maximumAgeSeconds) {
    throw new Error('invalid webhook authentication');
  }
  const bodyHmac = hmacHex(secret, raw);
  if (!secureSignatureMatch(bodySignature, bodyHmac)) {
    throw new Error('invalid webhook authentication');
  }
  const envelopePayload = `v1\n${timestampText}\n${encodedMetadata}\n${bodyHmac}`;
  const expectedEnvelope = hmacHex(secret, Buffer.from(envelopePayload, 'utf8'));
  if (!secureSignatureMatch(envelopeSignature, expectedEnvelope)) {
    throw new Error('invalid webhook authentication');
  }
  const metadata = decodeSignedMetadata(encodedMetadata);
  if (!metadata.messageId || !metadata.bucket || !metadata.key) {
    throw new Error('invalid signed metadata');
  }
  const signedRecipient = cleanText(metadata.recipients[0] || metadata.destinations[0], 2048);
  const convenienceRecipient = cleanText(recipient, 2048);
  if (!signedRecipient || !convenienceRecipient
      || signedRecipient.toLowerCase() !== convenienceRecipient.toLowerCase()) {
    throw new Error('invalid signed metadata');
  }
  if (String(metadata.verdicts.spamVerdict || '').toUpperCase() !== 'PASS'
      || String(metadata.verdicts.virusVerdict || '').toUpperCase() !== 'PASS') {
    const error = new Error('message did not pass SES content checks');
    error.statusCode = 422;
    throw error;
  }
  return {
    metadata,
    recipient: convenienceRecipient,
    bodyHmac
  };
}

function extractEmailAddress(value) {
  const input = cleanText(value, 2048);
  if (!input) return null;
  const bracketed = input.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  const address = cleanText(bracketed ? bracketed[1] : input, 320);
  return address && EMAIL_PATTERN.test(address) ? address.toLowerCase() : null;
}

function recipientParts(parsed, envelopeRecipient, inboundDomain) {
  const candidates = [
    envelopeRecipient,
    parsed && parsed.sourceRecipient,
    ...(parsed && Array.isArray(parsed.sourceRecipients) ? parsed.sourceRecipients : []),
    parsed && parsed.recipient,
    ...(parsed && Array.isArray(parsed.recipients) ? parsed.recipients : [])
  ];
  const normalizedDomain = normalizeInboundEmailDomain(
    inboundDomain || DEFAULT_INBOUND_EMAIL_DOMAIN
  );
  let fallback = null;
  for (const candidate of candidates) {
    const address = extractEmailAddress(candidate);
    if (!address) continue;
    if (!fallback) fallback = address;
    if (address.endsWith(`@${normalizedDomain}`)) {
      return {
        address,
        localPart: address.slice(0, address.lastIndexOf('@'))
      };
    }
  }
  return fallback
    ? { address: fallback, localPart: fallback.slice(0, fallback.lastIndexOf('@')) }
    : { address: null, localPart: null };
}

function jsonText(value, maximumLength = 512 * 1024) {
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= maximumLength ? encoded : null;
  } catch (_) {
    return null;
  }
}

function findDuplicate(database, {
  rawSha256,
  sesMessageId,
  internetMessageId
}) {
  return database.prepare(`
    SELECT id,parse_outcome,closure_wake_queued
    FROM nyc311_email_events
    WHERE raw_sha256=?
       OR (? IS NOT NULL AND ses_message_id=?)
       OR (? IS NOT NULL AND internet_message_id=?)
    ORDER BY id LIMIT 1
  `).get(
    rawSha256,
    sesMessageId,
    sesMessageId,
    internetMessageId,
    internetMessageId
  ) || null;
}

function reconcileAlias(database, {
  recipientAddress,
  recipientLocalPart,
  parsedSrnumber,
  receivedAt
}) {
  let alias = null;
  if (recipientAddress) {
    alias = database.prepare(`
      SELECT * FROM nyc311_email_aliases WHERE recipient_address=?
    `).get(recipientAddress);
  }
  if (!alias && recipientLocalPart) {
    alias = database.prepare(`
      SELECT * FROM nyc311_email_aliases WHERE local_part=?
    `).get(recipientLocalPart);
  }
  if (!alias) {
    return {
      alias: null,
      status: recipientAddress ? 'unregistered' : 'missing_recipient',
      reconciledSrnumber: null,
      mismatch: false
    };
  }
  database.prepare(`
    UPDATE nyc311_email_aliases
    SET last_received_at=?,updated_at=? WHERE id=?
  `).run(receivedAt, receivedAt, alias.id);

  if (!parsedSrnumber) {
    return {
      alias,
      status: 'parsed_sr_missing',
      reconciledSrnumber: null,
      mismatch: false
    };
  }
  if (alias.srnumber && alias.srnumber !== parsedSrnumber) {
    return {
      alias,
      status: 'mismatch',
      reconciledSrnumber: null,
      mismatch: true
    };
  }

  let status = 'matched';
  if (!alias.srnumber) {
    const requestExists = database.prepare(
      'SELECT 1 FROM live_portal_requests WHERE srnumber=?'
    ).get(parsedSrnumber);
    if (!requestExists) {
      return {
        alias,
        status: 'request_missing',
        reconciledSrnumber: null,
        mismatch: false
      };
    }
    try {
      database.prepare(`
        UPDATE nyc311_email_aliases
        SET srnumber=?,state=CASE
              WHEN state IN ('paused','retired') THEN state ELSE 'active' END,
            last_received_at=?,updated_at=?
        WHERE id=? AND srnumber IS NULL
      `).run(parsedSrnumber, receivedAt, receivedAt, alias.id);
      alias = database.prepare('SELECT * FROM nyc311_email_aliases WHERE id=?').get(alias.id);
      status = 'attached';
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(String(error && error.message))) throw error;
      return {
        alias,
        status: 'alias_conflict',
        reconciledSrnumber: null,
        mismatch: false
      };
    }
  } else {
    database.prepare(`
      UPDATE nyc311_email_aliases
      SET state=CASE WHEN state IN ('paused','retired') THEN state ELSE 'active' END,
          last_received_at=?,updated_at=?
      WHERE id=?
    `).run(receivedAt, receivedAt, alias.id);
  }
  return {
    alias,
    status,
    reconciledSrnumber: parsedSrnumber,
    mismatch: false
  };
}

function wakeClosureVerification(database, srnumber, checkedAt) {
  const request = database.prepare(`
    SELECT srnumber,portal_id,status FROM live_portal_requests WHERE srnumber=?
  `).get(srnumber);
  if (!request || isClosedStatus(request.status)) return false;
  const closureTracker = createClosureTracker(database);
  const existing = closureTracker.getFollowUp.get(srnumber);
  if (existing && existing.state === 'closed') return false;

  const closureCycle = existing && existing.state === 'closing'
    ? Math.max(1, Number(existing.closure_cycle) || 1)
    : Math.max(0, Number(existing && existing.closure_cycle) || 0) + 1;
  const result = database.prepare(`
    INSERT INTO request_followup_queue (
      srnumber,portal_id,state,next_check_at,attempts,closing_attempts,
      closure_cycle,last_checked_at,last_success_at,last_error,finalized_at,updated_at
    ) VALUES (?,?,'closing',?,0,0,?,NULL,NULL,NULL,NULL,?)
    ON CONFLICT(srnumber) DO UPDATE SET
      portal_id=COALESCE(excluded.portal_id,request_followup_queue.portal_id),
      state='closing',
      next_check_at=excluded.next_check_at,
      attempts=0,
      closing_attempts=CASE
        WHEN request_followup_queue.state='closing'
          THEN request_followup_queue.closing_attempts
        ELSE 0 END,
      closure_cycle=excluded.closure_cycle,
      last_error=NULL,
      finalized_at=NULL,
      updated_at=excluded.updated_at
    WHERE request_followup_queue.state<>'closed'
  `).run(
    srnumber,
    request.portal_id || (existing && existing.portal_id) || null,
    checkedAt,
    closureCycle,
    checkedAt
  );
  return Number(result.changes || 0) > 0;
}

function parsedEventValues(parsed) {
  const recognized = Boolean(parsed && parsed.isNyc311Notification
    && parsed.eventKind && parsed.serviceRequestNumber);
  return {
    parseOutcome: recognized ? 'parsed' : 'unrecognized',
    parsedSrnumber: normalizedRequestNumber(parsed && parsed.serviceRequestNumber),
    eventKind: cleanText(parsed && parsed.eventKind, 64),
    internetMessageId: cleanText(parsed && parsed.messageId, 512),
    sender: cleanText(parsed && parsed.sender, 2048),
    senderName: cleanText(parsed && parsed.senderName, 2048),
    subject: cleanText(parsed && parsed.subject, 4096),
    agencyName: cleanText(parsed && parsed.agencyName, 4096),
    agencyAcronym: cleanText(parsed && parsed.agencyAcronym, 128),
    requestTypeRaw: cleanText(parsed && parsed.requestTypeRaw, 4096),
    requestType: cleanText(parsed && parsed.requestType, 4096),
    requestSubtype: cleanText(parsed && parsed.requestSubtype, 4096),
    location: cleanText(parsed && parsed.location, 8192),
    submittedAtRaw: cleanText(parsed && parsed.submittedAtRaw, 1024),
    submittedAt: cleanText(parsed && parsed.submittedAt, 128),
    responseText: cleanText(parsed && parsed.responseText, 256 * 1024),
    nextUpdateText: cleanText(parsed && parsed.nextUpdateText, 16 * 1024),
    bodySource: cleanText(parsed && parsed.bodySource, 64)
  };
}

function persistInboundEmail(database, {
  raw,
  parsed = null,
  parseError = null,
  metadata,
  envelopeRecipient,
  inboundDomain = DEFAULT_INBOUND_EMAIL_DOMAIN,
  now = new Date()
}) {
  if (!Buffer.isBuffer(raw)) throw new TypeError('raw must be a Buffer');
  applyMigrations(database, now.toISOString());
  const createdAt = now.toISOString();
  const rawSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const values = parsedEventValues(parsed);
  if (parseError) values.parseOutcome = 'error';
  const sesMessageId = cleanText(metadata && metadata.messageId, 512);
  const duplicate = findDuplicate(database, {
    rawSha256,
    sesMessageId,
    internetMessageId: values.internetMessageId
  });
  if (duplicate) return { ...duplicate, duplicate: true };

  const metadataReceivedAt = metadata && Date.parse(metadata.receivedAt);
  const receivedAt = Number.isFinite(metadataReceivedAt)
    ? new Date(metadataReceivedAt).toISOString()
    : createdAt;
  const recipient = recipientParts(parsed, envelopeRecipient, inboundDomain);
  const verdicts = metadata && metadata.verdicts || {};

  database.exec('BEGIN IMMEDIATE');
  try {
    const raced = findDuplicate(database, {
      rawSha256,
      sesMessageId,
      internetMessageId: values.internetMessageId
    });
    if (raced) {
      database.exec('COMMIT');
      return { ...raced, duplicate: true };
    }
    const reconciliation = reconcileAlias(database, {
      recipientAddress: recipient.address,
      recipientLocalPart: recipient.localPart,
      parsedSrnumber: values.parsedSrnumber,
      receivedAt
    });
    const insert = database.prepare(`
      INSERT INTO nyc311_email_events (
        raw_sha256,raw_bytes,ses_message_id,internet_message_id,
        s3_bucket,s3_key,ses_source,ses_destinations_json,ses_recipients_json,
        ses_metadata_json,recipient_address,recipient_local_part,alias_id,
        alias_match_status,alias_srnumber,parsed_srnumber,reconciled_srnumber,
        srnumber_mismatch,event_kind,sender,sender_name,subject,agency_name,
        agency_acronym,request_type_raw,request_type,request_subtype,location,
        submitted_at_raw,submitted_at,response_text,next_update_text,body_source,
        spam_verdict,virus_verdict,spf_verdict,dkim_verdict,dmarc_verdict,
        parsed_json,parse_outcome,parse_error,received_at,created_at,
        closure_wake_queued
      ) VALUES (
        @raw_sha256,@raw_bytes,@ses_message_id,@internet_message_id,
        @s3_bucket,@s3_key,@ses_source,@ses_destinations_json,
        @ses_recipients_json,@ses_metadata_json,@recipient_address,
        @recipient_local_part,@alias_id,@alias_match_status,@alias_srnumber,
        @parsed_srnumber,@reconciled_srnumber,@srnumber_mismatch,@event_kind,
        @sender,@sender_name,@subject,@agency_name,@agency_acronym,
        @request_type_raw,@request_type,@request_subtype,@location,
        @submitted_at_raw,@submitted_at,@response_text,@next_update_text,
        @body_source,@spam_verdict,@virus_verdict,@spf_verdict,@dkim_verdict,
        @dmarc_verdict,@parsed_json,@parse_outcome,@parse_error,@received_at,
        @created_at,0
      )
      ON CONFLICT DO NOTHING
    `).run({
      raw_sha256: rawSha256,
      raw_bytes: raw.length,
      ses_message_id: sesMessageId,
      internet_message_id: values.internetMessageId,
      s3_bucket: cleanText(metadata && metadata.bucket, 512),
      s3_key: cleanText(metadata && metadata.key, 2048),
      ses_source: cleanText(metadata && metadata.source, 2048),
      ses_destinations_json: jsonText(metadata && metadata.destinations || []),
      ses_recipients_json: jsonText(metadata && metadata.recipients || []),
      ses_metadata_json: jsonText(metadata),
      recipient_address: recipient.address,
      recipient_local_part: recipient.localPart,
      alias_id: reconciliation.alias && reconciliation.alias.id,
      alias_match_status: reconciliation.status,
      alias_srnumber: reconciliation.alias && reconciliation.alias.srnumber,
      parsed_srnumber: values.parsedSrnumber,
      reconciled_srnumber: reconciliation.reconciledSrnumber,
      srnumber_mismatch: reconciliation.mismatch ? 1 : 0,
      event_kind: values.eventKind,
      sender: values.sender,
      sender_name: values.senderName,
      subject: values.subject,
      agency_name: values.agencyName,
      agency_acronym: values.agencyAcronym,
      request_type_raw: values.requestTypeRaw,
      request_type: values.requestType,
      request_subtype: values.requestSubtype,
      location: values.location,
      submitted_at_raw: values.submittedAtRaw,
      submitted_at: values.submittedAt,
      response_text: values.responseText,
      next_update_text: values.nextUpdateText,
      body_source: values.bodySource,
      spam_verdict: cleanText(verdicts.spamVerdict, 32),
      virus_verdict: cleanText(verdicts.virusVerdict, 32),
      spf_verdict: cleanText(verdicts.spfVerdict, 32),
      dkim_verdict: cleanText(verdicts.dkimVerdict, 32),
      dmarc_verdict: cleanText(verdicts.dmarcVerdict, 32),
      parsed_json: parsed == null ? null : jsonText(parsed),
      parse_outcome: values.parseOutcome,
      parse_error: cleanText(parseError && parseError.message || parseError, 4096),
      received_at: receivedAt,
      created_at: createdAt
    });
    if (!insert.changes) {
      const existing = findDuplicate(database, {
        rawSha256,
        sesMessageId,
        internetMessageId: values.internetMessageId
      });
      database.exec('COMMIT');
      return { ...existing, duplicate: true };
    }
    const id = Number(insert.lastInsertRowid);
    const closureWakeQueued = values.parseOutcome === 'parsed'
      && values.eventKind === 'Closed'
      && reconciliation.reconciledSrnumber
      ? wakeClosureVerification(database, reconciliation.reconciledSrnumber, createdAt)
      : false;
    if (closureWakeQueued) {
      database.prepare(`
        UPDATE nyc311_email_events SET closure_wake_queued=1 WHERE id=?
      `).run(id);
    }
    database.exec('COMMIT');
    const forward = values.parseOutcome === 'parsed'
      && !reconciliation.mismatch
      && reconciliation.reconciledSrnumber
      && ['matched', 'attached'].includes(reconciliation.status)
      ? {
          recipient_address: recipient.address,
          srnumber: reconciliation.reconciledSrnumber,
          event_kind: values.eventKind,
          subject: values.subject,
          agency_name: values.agencyName,
          agency_acronym: values.agencyAcronym,
          request_type: values.requestType,
          request_subtype: values.requestSubtype,
          location: values.location,
          submitted_at: values.submittedAt,
          response_text: values.responseText,
          next_update_text: values.nextUpdateText,
          received_at: receivedAt
        }
      : null;
    return {
      id,
      duplicate: false,
      parse_outcome: values.parseOutcome,
      closure_wake_queued: closureWakeQueued ? 1 : 0,
      alias_match_status: reconciliation.status,
      forward
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function requestIsHttps(req) {
  if (req.secure) return true;
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return forwarded.toLowerCase() === 'https';
}

function createNyc311EmailHandler({
  env = process.env,
  parseNotification,
  databasePath = env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite'),
  openDatabaseFn = openDatabase,
  now = () => new Date(),
  requireHttps = env.NODE_ENV === 'production',
  allowLegacySignature = false
} = {}) {
  if (typeof parseNotification !== 'function') {
    throw new TypeError('parseNotification must be a function');
  }
  return async function receiveNyc311Email(req, res) {
    const secret = String(env.INBOUND_EMAIL_WEBHOOK_SECRET || '');
    if (secret.length < 32) {
      return res.status(503).json({ error: 'inbound email receiver unavailable' });
    }
    if (requireHttps && !requestIsHttps(req)) {
      return res.status(400).json({ error: 'HTTPS is required' });
    }
    if (!req.is('message/rfc822') && !req.is('application/octet-stream')) {
      return res.status(415).json({ error: 'message/rfc822 is required' });
    }
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_RAW_EMAIL_BYTES) {
      return res.status(raw && raw.length > MAX_RAW_EMAIL_BYTES ? 413 : 400)
        .json({ error: 'invalid raw email body' });
    }

    let signed;
    try {
      const richSignature = req.get('x-nyc311-email-signature');
      if (richSignature) {
        signed = verifySignedEnvelope({
          raw,
          secret,
          version: req.get('x-nyc311-email-version'),
          timestamp: req.get('x-nyc311-email-timestamp'),
          encodedMetadata: req.get('x-nyc311-email-metadata'),
          bodySignature: richSignature,
          envelopeSignature: req.get('x-nyc311-email-envelope-signature'),
          recipient: req.get('x-nyc311-recipient'),
          now: now()
        });
      } else if (allowLegacySignature && verifyRawSignature(
        raw,
        req.get('x-nyc311-signature'),
        secret
      )) {
        const recipient = cleanText(req.get('x-nyc311-recipient'), 2048);
        signed = {
          recipient,
          metadata: {
            version: 1,
            messageId: cleanText(req.get('x-nyc311-ses-message-id'), 512),
            bucket: null,
            key: cleanText(req.get('x-nyc311-s3-key'), 2048),
            receivedAt: null,
            source: null,
            destinations: recipient ? [recipient] : [],
            recipients: recipient ? [recipient] : [],
            verdicts: {
              spamVerdict: cleanText(req.get('x-nyc311-spam-verdict'), 32),
              virusVerdict: cleanText(req.get('x-nyc311-virus-verdict'), 32),
              spfVerdict: null,
              dkimVerdict: null,
              dmarcVerdict: null
            }
          }
        };
      } else {
        throw new Error('invalid webhook authentication');
      }
    } catch (error) {
      const status = Number(error && error.statusCode) || 401;
      return res.status(status).json({
        error: status === 422 ? 'email failed content checks' : 'invalid webhook authentication'
      });
    }

    let parsed = null;
    let parseError = null;
    try {
      parsed = await parseNotification(raw);
    } catch (error) {
      parseError = error;
    }

    let database;
    try {
      if (!fs.existsSync(databasePath)) {
        return res.status(503).json({ error: 'inbound email receiver unavailable' });
      }
      database = openDatabaseFn(databasePath);
      const result = persistInboundEmail(database, {
        raw,
        parsed,
        parseError,
        metadata: signed.metadata,
        envelopeRecipient: signed.recipient,
        inboundDomain: env.INBOUND_EMAIL_DOMAIN || DEFAULT_INBOUND_EMAIL_DOMAIN,
        now: now()
      });
      return res.status(202).json({
        accepted: true,
        duplicate: result.duplicate,
        event_id: result.id,
        forward: result.forward || null
      });
    } catch (error) {
      console.error('Inbound NYC311 email failed:', error.message);
      return res.status(503).json({ error: 'inbound email receiver unavailable' });
    } finally {
      if (database) database.close();
    }
  };
}

module.exports = {
  MAX_DELIVERY_AGE_SECONDS,
  MAX_RAW_EMAIL_BYTES,
  createNyc311EmailHandler,
  decodeSignedMetadata,
  extractEmailAddress,
  hmacHex,
  persistInboundEmail,
  recipientParts,
  secureSignatureMatch,
  verifyRawSignature,
  verifySignedEnvelope,
  wakeClosureVerification
};
