'use strict';

const cheerio = require('cheerio');
const { simpleParser } = require('mailparser');

const SUBJECT_PATTERN = /^\s*SR\s+(Submitted|Updated|Closed)\s*#\s*(311-\d+)\s*$/i;
const BODY_EVENT_PATTERN = /\bService Request\s+(Submitted|Updated|Closed)\b/i;
const SR_NUMBER_PATTERN = /\b311-\d+\b/;
const NYC311_SENDER = 'srnotice@customercare.nyc.gov';
const SUBMITTED_CLOCK_PATTERN =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i;
const MESSAGE_PARSE_OPTIONS = Object.freeze({
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipImageLinks: true
});

class Nyc311NotificationParseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'Nyc311NotificationParseError';
    this.code = code;
  }
}

function cleanInline(value) {
  if (value == null) return null;
  const text = String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
  return text || null;
}

function cleanBodyText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToPlainText(value) {
  if (value == null) return '';
  const $ = cheerio.load(String(value));
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  $('p, div, section, article, header, footer, table, tr, li, h1, h2, h3, h4, h5, h6')
    .each((_index, element) => {
      $(element).prepend('\n');
      $(element).append('\n');
    });
  $('td, th').each((_index, element) => {
    $(element).append('\n');
  });
  return cleanBodyText($.root().text());
}

function titleCaseEvent(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  if (normalized === 'submitted') return 'Submitted';
  if (normalized === 'updated') return 'Updated';
  if (normalized === 'closed') return 'Closed';
  return null;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Convert the unzoned clock printed in a notification into a stable local
 * wall-clock representation. The source does not state a UTC offset, so this
 * deliberately does not append "Z" or otherwise invent an instant.
 */
function normalizeSubmittedClock(value) {
  const raw = cleanInline(value);
  if (!raw) return null;
  const match = raw.match(SUBMITTED_CLOCK_PATTERN);
  if (!match) return null;

  const [, monthText, dayText, yearText, hourText, minuteText, secondText, period] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const rawHour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || rawHour < 1 || rawHour > 12
    || minute < 0 || minute > 59
    || second < 0 || second > 59
  ) {
    return null;
  }

  const hour = rawHour % 12 + (period.toUpperCase() === 'PM' ? 12 : 0);
  const pad = number => String(number).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T`
    + `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function sectionBetween(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return text;
  const afterStart = text.slice(start).replace(startPattern, '');
  const end = afterStart.search(endPattern);
  return end < 0 ? afterStart : afterStart.slice(0, end);
}

function extractField(section, labelPattern, nextLabelPattern) {
  const pattern = new RegExp(
    `${labelPattern}\\s*:\\s*([\\s\\S]*?)(?=(?:\\n\\s*)?${nextLabelPattern}\\s*:|$)`,
    'i'
  );
  return cleanInline(section.match(pattern)?.[1]);
}

function splitRequestType(requestTypeRaw) {
  if (!requestTypeRaw) {
    return { requestType: null, requestSubtype: null };
  }
  const separator = requestTypeRaw.indexOf(' - ');
  if (separator < 0) {
    return { requestType: requestTypeRaw, requestSubtype: null };
  }
  return {
    requestType: cleanInline(requestTypeRaw.slice(0, separator)),
    requestSubtype: cleanInline(requestTypeRaw.slice(separator + 3))
  };
}

function extractAgency(text) {
  const statement = text.match(
    /(?:This|Your) Service Request has been\s+(?:(?:updated|closed)\s+by|submitted\s+to)\s+(?:the\s+)?([^\n]+?)(?:\.\s*(?:\n|$))/i
  );
  let agencyName = cleanInline(statement?.[1]);
  let agencyAcronym = null;

  if (agencyName) {
    const suffix = agencyName.match(/,\s*([A-Z][A-Z0-9&./-]{1,15})$/);
    if (suffix) {
      agencyAcronym = suffix[1];
      agencyName = cleanInline(agencyName.slice(0, suffix.index));
    }
  }

  if (!agencyAcronym) {
    agencyAcronym = text.match(
      /(?:^|\n)\s*([A-Z][A-Z0-9&./-]{1,15})\s+provided the following information\s*:/i
    )?.[1]?.toUpperCase() || null;
  }

  return { agencyName, agencyAcronym };
}

function extractResponse(text) {
  const marker = text.match(
    /(?:^|\n)\s*(?:[A-Z][A-Z0-9&./-]{1,15}\s+)?provided the following information\s*:\s*/i
  );
  if (!marker || marker.index == null) {
    return { responseText: null, nextUpdateText: null };
  }

  const afterMarker = text.slice(marker.index + marker[0].length);
  const end = afterMarker.search(/\n\s*Thank you\s*,/i);
  let responseText = cleanBodyText(end < 0 ? afterMarker : afterMarker.slice(0, end));
  let nextUpdateText = null;

  const nextUpdate = responseText.match(/(?:^|\n)\s*((?:The\s+)?next update\b[\s\S]*)$/i);
  if (nextUpdate && nextUpdate.index != null) {
    nextUpdateText = cleanBodyText(nextUpdate[1]);
    responseText = cleanBodyText(responseText.slice(0, nextUpdate.index));
  }

  return {
    responseText: responseText || null,
    nextUpdateText: nextUpdateText || null
  };
}

function firstAddress(addressObject) {
  const first = addressObject?.value?.[0];
  return {
    sender: cleanInline(first?.address),
    senderName: cleanInline(first?.name)
  };
}

function addresses(addressObject) {
  return (addressObject?.value || [])
    .map(entry => cleanInline(entry?.address))
    .filter(Boolean);
}

function recipientLocalPart(recipient) {
  if (!recipient || !recipient.includes('@')) return null;
  return cleanInline(recipient.slice(0, recipient.lastIndexOf('@')));
}

function messageText(message) {
  const plainText = cleanBodyText(message.text);
  const htmlText = plainText ? '' : htmlToPlainText(message.html);
  return {
    bodySource: plainText ? 'text' : (htmlText ? 'html' : null),
    text: plainText || htmlText
  };
}

function isNyc311Notice(message, text) {
  const sender = cleanInline(message.from?.value?.[0]?.address)?.toLowerCase();
  const subject = cleanInline(message.subject);
  const subjectMatch = subject?.match(SUBJECT_PATTERN);
  if (sender !== NYC311_SENDER || !subjectMatch) return false;
  const bodySrNumber = text.match(/Service Request\s*Number\s*:\s*(311-\d+)/i)?.[1];
  return Boolean(text.match(BODY_EVENT_PATTERN) && bodySrNumber === subjectMatch[2]);
}

function authenticationStatus(rawResults, method) {
  const pattern = new RegExp(
    `(?:^|[;\\s])${method}=(pass|fail|softfail|neutral|none|temperror|permerror|policy)\\b`,
    'ig'
  );
  const results = [];
  for (const raw of rawResults) {
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      results.push(match[1].toLowerCase());
    }
  }
  return results[0] || null;
}

function authenticationReport(message, source) {
  const rawResults = (message.headerLines || [])
    .filter(header => String(header.key).toLowerCase() === 'authentication-results')
    .map(header => String(header.line).replace(/^Authentication-Results\s*:\s*/i, '').trim());
  return {
    source,
    spf: authenticationStatus(rawResults, 'spf'),
    dkim: authenticationStatus(rawResults, 'dkim'),
    dmarc: authenticationStatus(rawResults, 'dmarc'),
    rawResults
  };
}

function nestedMessageAttachments(message) {
  return (message.attachments || []).filter(attachment => {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const filename = String(attachment.filename || '').toLowerCase();
    return contentType === 'message/rfc822' || filename.endsWith('.eml');
  });
}

async function selectSourceMessage(outerMessage, parseMessage) {
  const outerBody = messageText(outerMessage);
  if (isNyc311Notice(outerMessage, outerBody.text)) {
    return {
      deliveryMode: 'direct',
      message: outerMessage,
      ...outerBody
    };
  }

  const nestedNotices = [];
  for (const attachment of nestedMessageAttachments(outerMessage)) {
    try {
      const nestedMessage = await parseMessage(attachment.content, MESSAGE_PARSE_OPTIONS);
      const nestedBody = messageText(nestedMessage);
      if (isNyc311Notice(nestedMessage, nestedBody.text)) {
        nestedNotices.push({ message: nestedMessage, ...nestedBody });
      }
    } catch {
      // A malformed unrelated .eml attachment does not make the outer message
      // a notification. It is ignored unless no usable notice can be found.
    }
  }

  if (nestedNotices.length > 1) {
    throw new Nyc311NotificationParseError(
      'forwarded message contains more than one NYC311 notification',
      'multiple_nested_notices'
    );
  }
  if (nestedNotices.length === 1) {
    return {
      deliveryMode: 'forwarded-attachment',
      ...nestedNotices[0]
    };
  }
  return {
    deliveryMode: 'direct',
    message: outerMessage,
    ...outerBody
  };
}

async function parseNyc311Notification(rawMessage, {
  parseMessage = simpleParser
} = {}) {
  if (
    typeof rawMessage !== 'string'
    && !Buffer.isBuffer(rawMessage)
    && !(rawMessage instanceof Uint8Array)
  ) {
    throw new TypeError('rawMessage must be a string, Buffer, or Uint8Array');
  }

  const outerMessage = await parseMessage(rawMessage, MESSAGE_PARSE_OPTIONS);
  const selected = await selectSourceMessage(outerMessage, parseMessage);
  const { message, text, bodySource, deliveryMode } = selected;
  const subject = cleanInline(message.subject);
  const subjectMatch = subject?.match(SUBJECT_PATTERN);
  const bodyEvent = text.match(BODY_EVENT_PATTERN);
  const eventKind = titleCaseEvent(subjectMatch?.[1] || bodyEvent?.[1]);
  const serviceRequestNumber = subjectMatch?.[2]
    || text.match(/Service Request\s*Number\s*:\s*(311-\d+)/i)?.[1]
    || text.match(SR_NUMBER_PATTERN)?.[0]
    || null;

  const details = sectionBetween(
    text,
    /Your request details are\s*:/i,
    /(?:^|\n)\s*(?:(?:[A-Z][A-Z0-9&./-]{1,15}\s+)?provided the following information\s*:|Thank you\s*,)/i
  );
  const requestTypeRaw = extractField(details, 'Type', 'Location');
  const location = extractField(details, 'Location', 'Date\\s+Submitted');
  const submittedAtRaw = extractField(
    details,
    'Date\\s+Submitted',
    '(?:[A-Z][A-Z0-9&./-]{1,15}\\s+)?provided\\s+the\\s+following\\s+information'
  );
  const { requestType, requestSubtype } = splitRequestType(requestTypeRaw);
  const { agencyName, agencyAcronym } = extractAgency(text);
  const { responseText, nextUpdateText } = extractResponse(text);
  const { sender, senderName } = firstAddress(message.from);
  const deliveryRecipients = addresses(outerMessage.to);
  const sourceRecipients = addresses(message.to);
  const recipient = deliveryRecipients[0] || null;
  const sourceRecipient = sourceRecipients[0] || null;
  const outerSender = firstAddress(outerMessage.from);

  return {
    isNyc311Notification: isNyc311Notice(message, text),
    deliveryMode,
    eventKind,
    serviceRequestNumber,
    agencyName,
    agencyAcronym,
    requestTypeRaw,
    requestType,
    requestSubtype,
    location,
    submittedAtRaw,
    submittedAt: normalizeSubmittedClock(submittedAtRaw),
    responseText,
    nextUpdateText,
    messageId: cleanInline(message.messageId),
    sender,
    senderName,
    subject,
    bodySource,
    recipient,
    recipientLocalPart: recipientLocalPart(recipient),
    recipients: deliveryRecipients,
    sourceRecipient,
    sourceRecipients,
    authentication: authenticationReport(
      message,
      deliveryMode === 'direct' ? 'direct-message' : 'nested-message'
    ),
    outerMessage: deliveryMode === 'forwarded-attachment'
      ? {
          messageId: cleanInline(outerMessage.messageId),
          sender: outerSender.sender,
          senderName: outerSender.senderName,
          subject: cleanInline(outerMessage.subject),
          authenticationIgnored: true
        }
      : null
  };
}

module.exports = {
  Nyc311NotificationParseError,
  normalizeSubmittedClock,
  parseNyc311Notification,
  splitRequestType
};
