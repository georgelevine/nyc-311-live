'use strict';

const crypto = require('crypto');

const DEFAULT_INBOUND_EMAIL_DOMAIN = 'track.opendata.support';
const REQUEST_NUMBER_PATTERN = /^311-(\d{8})$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeRequestNumber(value) {
  const normalized = String(value || '').trim();
  if (!REQUEST_NUMBER_PATTERN.test(normalized)) {
    throw new TypeError('srnumber must use the form 311-12345678');
  }
  return normalized;
}

function normalizeInboundEmailDomain(value = DEFAULT_INBOUND_EMAIL_DOMAIN) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new TypeError('INBOUND_EMAIL_DOMAIN must be a valid DNS domain');
  }
  return normalized;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function randomToken(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(15);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('randomBytes must return bytes');
  }
  if (bytes.length < 12) throw new Error('at least 96 bits of alias randomness are required');
  return Buffer.from(bytes).toString('base64url');
}

function buildAlias({
  srnumber,
  domain = DEFAULT_INBOUND_EMAIL_DOMAIN,
  randomBytes = crypto.randomBytes
}) {
  const normalizedSrnumber = normalizeRequestNumber(srnumber);
  const normalizedDomain = normalizeInboundEmailDomain(domain);
  const suffix = normalizedSrnumber.slice(4);
  const token = randomToken(randomBytes);
  const localPart = `r${suffix}-${token}`.toLowerCase();
  return {
    srnumber: normalizedSrnumber,
    local_part: localPart,
    domain: normalizedDomain,
    recipient_address: `${localPart}@${normalizedDomain}`,
    token_hash: tokenHash(token)
  };
}

function aliasTableExists(database) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='nyc311_email_aliases'
  `).get());
}

function createRequestAlias(database, {
  srnumber,
  domain = process.env.INBOUND_EMAIL_DOMAIN || DEFAULT_INBOUND_EMAIL_DOMAIN,
  now = new Date(),
  randomBytes = crypto.randomBytes
} = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database must be an open SQLite database');
  }
  if (!aliasTableExists(database)) {
    throw new Error('nyc311_email_aliases is missing; apply SQLite migration v4 first');
  }
  const normalizedSrnumber = normalizeRequestNumber(srnumber);
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const existing = database.prepare(`
    SELECT id,local_part,domain,recipient_address,srnumber,state,
           created_at,subscribed_at,last_received_at,updated_at
    FROM nyc311_email_aliases WHERE srnumber=?
  `).get(normalizedSrnumber);
  if (existing) return { ...existing, created: false };

  const requestExists = database.prepare(
    'SELECT 1 FROM live_portal_requests WHERE srnumber=?'
  ).get(normalizedSrnumber);
  if (!requestExists) {
    throw new Error(`Cannot create an alias before ${normalizedSrnumber} is stored`);
  }

  const insert = database.prepare(`
    INSERT INTO nyc311_email_aliases (
      local_part,domain,recipient_address,srnumber,token_hash,state,
      created_at,subscribed_at,last_received_at,updated_at
    ) VALUES (?,?,?,?,?,'created',?,NULL,NULL,?)
  `);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const generated = buildAlias({
      srnumber: normalizedSrnumber,
      domain,
      randomBytes
    });
    try {
      const result = insert.run(
        generated.local_part,
        generated.domain,
        generated.recipient_address,
        generated.srnumber,
        generated.token_hash,
        createdAt,
        createdAt
      );
      return {
        id: Number(result.lastInsertRowid),
        local_part: generated.local_part,
        domain: generated.domain,
        recipient_address: generated.recipient_address,
        srnumber: generated.srnumber,
        state: 'created',
        created_at: createdAt,
        subscribed_at: null,
        last_received_at: null,
        updated_at: createdAt,
        created: true
      };
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(String(error && error.message))) throw error;
      const raced = database.prepare(`
        SELECT id,local_part,domain,recipient_address,srnumber,state,
               created_at,subscribed_at,last_received_at,updated_at
        FROM nyc311_email_aliases WHERE srnumber=?
      `).get(normalizedSrnumber);
      if (raced) return { ...raced, created: false };
    }
  }
  throw new Error('Could not allocate a unique inbound email alias');
}

function markAliasSubscribed(database, recipientAddress, {
  now = new Date()
} = {}) {
  const normalizedAddress = String(recipientAddress || '').trim().toLowerCase();
  const updatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const result = database.prepare(`
    UPDATE nyc311_email_aliases
    SET state=CASE WHEN state='created' THEN 'subscribed' ELSE state END,
        subscribed_at=COALESCE(subscribed_at,?),
        updated_at=?
    WHERE recipient_address=?
  `).run(updatedAt, updatedAt, normalizedAddress);
  if (!result.changes) throw new Error('Inbound email alias was not found');
  return database.prepare(`
    SELECT id,local_part,domain,recipient_address,srnumber,state,
           created_at,subscribed_at,last_received_at,updated_at
    FROM nyc311_email_aliases WHERE recipient_address=?
  `).get(normalizedAddress);
}

module.exports = {
  DEFAULT_INBOUND_EMAIL_DOMAIN,
  buildAlias,
  createRequestAlias,
  markAliasSubscribed,
  normalizeInboundEmailDomain,
  normalizeRequestNumber,
  randomToken,
  tokenHash
};
