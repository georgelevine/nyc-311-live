'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  Nyc311NotificationParseError,
  normalizeSubmittedClock,
  parseNyc311Notification,
  splitRequestType
} = require('../nyc311-notification-email');

const SAMPLE_FILES = {
  closed: '/Users/georgelevine/Downloads/SR Closed # 311-28327449.eml',
  updated: '/Users/georgelevine/Downloads/SR Updated # 311-28327195.eml'
};

function sampleOptions(filename) {
  return fs.existsSync(filename)
    ? {}
    : { skip: `local sample is unavailable: ${path.basename(filename)}` };
}

function wrapAsForwardedAttachment(nestedRaw, {
  recipient = 'r28327449-f4k8m2@track.opendata.support',
  boundary = 'nyc311-forwarded-boundary'
} = {}) {
  const encoded = Buffer.from(nestedRaw).toString('base64').match(/.{1,76}/g).join('\r\n');
  return [
    'From: Pilot Forwarder <pilot@example.net>',
    `To: ${recipient}`,
    'Subject: Fwd: original NYC311 notice',
    'Message-ID: <outer-forward@example.net>',
    'Authentication-Results: inbound.example; dkim=fail; spf=fail; dmarc=fail',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Attached is the original notification.',
    `--${boundary}`,
    'Content-Type: message/rfc822; name="notice.eml"',
    'Content-Disposition: attachment; filename="notice.eml"',
    'Content-Transfer-Encoding: base64',
    '',
    encoded,
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

function syntheticNotice({
  srNumber = '311-99999999',
  event = 'Updated',
  bodyType = 'text/plain',
  body
} = {}) {
  const content = body || [
    `Service Request ${event}`,
    '',
    `This Service Request has been ${event.toLowerCase()} by the Test Agency, TEST.`,
    '',
    'Your request details are:',
    `Service Request Number: ${srNumber}`,
    'Type: General',
    'Location: 1 CENTRE STREET, MANHATTAN, NY, 10007',
    'Date Submitted: 7/23/2026 1:02:03 PM',
    '',
    'TEST provided the following information:',
    '',
    'Testing.'
  ].join('\r\n');
  return [
    'From: SRNotice <SRNotice@customercare.nyc.gov>',
    'To: notice@track.opendata.support',
    `Subject: SR ${event} # ${srNumber}`,
    `Message-ID: <${srNumber}@SRNOTICE.CUSTOMERCARE.NYC.GOV>`,
    'Authentication-Results: receiver.example; dkim=pass header.d=customercare.nyc.gov; spf=pass smtp.mailfrom=customercare.nyc.gov; dmarc=pass header.from=customercare.nyc.gov',
    `Content-Type: ${bodyType}; charset=utf-8`,
    'MIME-Version: 1.0',
    '',
    content
  ].join('\r\n');
}

test(
  'parses the supplied closed NYC311 .eml without inferring an official status',
  sampleOptions(SAMPLE_FILES.closed),
  async () => {
    const parsed = await parseNyc311Notification(fs.readFileSync(SAMPLE_FILES.closed));

    assert.equal(parsed.isNyc311Notification, true);
    assert.equal(parsed.deliveryMode, 'direct');
    assert.equal(parsed.eventKind, 'Closed');
    assert.equal(parsed.serviceRequestNumber, '311-28327449');
    assert.equal(parsed.agencyName, 'New York City Police Department');
    assert.equal(parsed.agencyAcronym, 'NYPD');
    assert.equal(parsed.requestTypeRaw, 'Drug Activity - Use Outside');
    assert.equal(parsed.requestType, 'Drug Activity');
    assert.equal(parsed.requestSubtype, 'Use Outside');
    assert.equal(
      parsed.location,
      '124 EAST 15 STREET, MANHATTAN (NEW YORK), NY, 10003'
    );
    assert.equal(parsed.submittedAtRaw, '7/22/2026 6:46:35 PM');
    assert.equal(parsed.submittedAt, '2026-07-22T18:46:35');
    assert.match(
      parsed.responseText,
      /^The New York City Police Department responded to the complaint/
    );
    assert.equal(parsed.nextUpdateText, null);
    assert.equal(
      parsed.messageId,
      '<EF0F485EFCD846BCBE020B42B446A1C01DD1A3A9573D@SRNOTICE.CUSTOMERCARE.NYC.GOV>'
    );
    assert.equal(parsed.sender, 'SRNotice@customercare.nyc.gov');
    assert.equal(parsed.senderName, 'SRNotice');
    assert.equal(parsed.subject, 'SR Closed # 311-28327449');
    assert.equal(parsed.bodySource, 'text');
    assert.deepEqual(
      {
        source: parsed.authentication.source,
        spf: parsed.authentication.spf,
        dkim: parsed.authentication.dkim,
        dmarc: parsed.authentication.dmarc
      },
      { source: 'direct-message', spf: 'pass', dkim: 'pass', dmarc: 'pass' }
    );
    assert.equal(parsed.outerMessage, null);
    assert.equal(Object.hasOwn(parsed, 'status'), false);
  }
);

test(
  'parses the supplied updated NYC311 .eml and separates next-update wording',
  sampleOptions(SAMPLE_FILES.updated),
  async () => {
    const parsed = await parseNyc311Notification(fs.readFileSync(SAMPLE_FILES.updated));

    assert.equal(parsed.eventKind, 'Updated');
    assert.equal(parsed.serviceRequestNumber, '311-28327195');
    assert.equal(parsed.agencyName, 'Department of Consumer and Worker Protection');
    assert.equal(parsed.agencyAcronym, 'DCWP');
    assert.equal(parsed.requestTypeRaw, 'Consumer Complaint - Tobacco Sales');
    assert.equal(parsed.requestType, 'Consumer Complaint');
    assert.equal(parsed.requestSubtype, 'Tobacco Sales');
    assert.equal(
      parsed.location,
      '510 6 AVENUE, MANHATTAN (NEW YORK), NY, 10011'
    );
    assert.equal(parsed.submittedAtRaw, '7/22/2026 6:26:04 PM');
    assert.equal(parsed.submittedAt, '2026-07-22T18:26:04');
    assert.match(
      parsed.responseText,
      /^The Department of Consumer and Worker Protection \(DCWP\) Enforcement Division/
    );
    assert.doesNotMatch(parsed.responseText, /next update/i);
    assert.match(parsed.nextUpdateText, /^The next update is due within 35 days\./);
    assert.match(parsed.nextUpdateText, /srnum=311-28327195/);
  }
);

test(
  'parses exactly one attached original and ignores outer-message authentication',
  sampleOptions(SAMPLE_FILES.closed),
  async () => {
    const original = fs.readFileSync(SAMPLE_FILES.closed);
    const parsed = await parseNyc311Notification(wrapAsForwardedAttachment(original));

    assert.equal(parsed.deliveryMode, 'forwarded-attachment');
    assert.equal(parsed.eventKind, 'Closed');
    assert.equal(parsed.serviceRequestNumber, '311-28327449');
    assert.equal(parsed.recipient, 'r28327449-f4k8m2@track.opendata.support');
    assert.equal(parsed.recipientLocalPart, 'r28327449-f4k8m2');
    assert.equal(parsed.sourceRecipient, 'georgealevine@gmail.com');
    assert.equal(parsed.authentication.source, 'nested-message');
    assert.equal(parsed.authentication.dkim, 'pass');
    assert.equal(parsed.authentication.spf, 'pass');
    assert.equal(parsed.authentication.dmarc, 'pass');
    assert.equal(parsed.authentication.rawResults.some(result => /inbound\.example/.test(result)), false);
    assert.deepEqual(parsed.outerMessage, {
      messageId: '<outer-forward@example.net>',
      sender: 'pilot@example.net',
      senderName: 'Pilot Forwarder',
      subject: 'Fwd: original NYC311 notice',
      authenticationIgnored: true
    });
  }
);

test('rejects an ambiguous forward containing two nested NYC311 notices', async () => {
  const first = syntheticNotice({ srNumber: '311-90000001' });
  const second = syntheticNotice({ srNumber: '311-90000002' });
  const firstForward = wrapAsForwardedAttachment(first, { boundary: 'first-boundary' });
  const firstBody = firstForward.slice(0, firstForward.lastIndexOf('--first-boundary--'));
  const secondEncoded = Buffer.from(second).toString('base64').match(/.{1,76}/g).join('\r\n');
  const ambiguous = `${firstBody}--first-boundary\r\n`
    + 'Content-Type: message/rfc822; name="second.eml"\r\n'
    + 'Content-Disposition: attachment; filename="second.eml"\r\n'
    + 'Content-Transfer-Encoding: base64\r\n\r\n'
    + `${secondEncoded}\r\n--first-boundary--\r\n`;

  await assert.rejects(
    parseNyc311Notification(ambiguous),
    error => error instanceof Nyc311NotificationParseError
      && error.code === 'multiple_nested_notices'
  );
});

test('uses HTML when no plain-text part exists and splits only the first type delimiter', async () => {
  const html = [
    '<html><body>',
    '<h1>Service Request Updated</h1>',
    '<p>This Service Request has been updated by the Department of Testing, DOT.</p>',
    '<p>Your request details are:</p>',
    '<table>',
    '<tr><th>Service Request Number:</th><td>311-90000003</td></tr>',
    '<tr><th>Type:</th><td>Street Condition - Cave-In - Large</td></tr>',
    '<tr><th>Location:</th><td>2 BROADWAY, MANHATTAN, NY, 10004</td></tr>',
    '<tr><th>Date Submitted:</th><td>2/29/2023 1:02:03 PM</td></tr>',
    '</table>',
    '<p>DOT provided the following information:</p>',
    '<p>The test response was saved &amp; decoded.</p>',
    '<p>The next update is due within 2 days.</p>',
    '<p>Thank you,<br>NYC311</p>',
    '</body></html>'
  ].join('');
  const parsed = await parseNyc311Notification(syntheticNotice({
    srNumber: '311-90000003',
    bodyType: 'text/html',
    body: html
  }));

  assert.equal(parsed.bodySource, 'html');
  assert.equal(parsed.isNyc311Notification, true);
  assert.equal(parsed.agencyName, 'Department of Testing');
  assert.equal(parsed.agencyAcronym, 'DOT');
  assert.equal(parsed.requestTypeRaw, 'Street Condition - Cave-In - Large');
  assert.equal(parsed.requestType, 'Street Condition');
  assert.equal(parsed.requestSubtype, 'Cave-In - Large');
  assert.equal(parsed.location, '2 BROADWAY, MANHATTAN, NY, 10004');
  assert.equal(parsed.submittedAtRaw, '2/29/2023 1:02:03 PM');
  assert.equal(parsed.submittedAt, null);
  assert.equal(parsed.responseText, 'The test response was saved & decoded.');
  assert.equal(parsed.nextUpdateText, 'The next update is due within 2 days.');
});

test('normalizes only valid unzoned notification clocks', () => {
  assert.equal(normalizeSubmittedClock('7/23/2026 12:00:00 AM'), '2026-07-23T00:00:00');
  assert.equal(normalizeSubmittedClock('7/23/2026 12:00:00 PM'), '2026-07-23T12:00:00');
  assert.equal(normalizeSubmittedClock('2/29/2024 1:02:03 PM'), '2024-02-29T13:02:03');
  assert.equal(normalizeSubmittedClock('2/29/2023 1:02:03 PM'), null);
  assert.equal(normalizeSubmittedClock('2026-07-23T13:02:03Z'), null);
});

test('splits a request type once and preserves a missing subtype', () => {
  assert.deepEqual(splitRequestType('Noise - Residential - After Hours'), {
    requestType: 'Noise',
    requestSubtype: 'Residential - After Hours'
  });
  assert.deepEqual(splitRequestType('General'), {
    requestType: 'General',
    requestSubtype: null
  });
  assert.deepEqual(splitRequestType(null), {
    requestType: null,
    requestSubtype: null
  });
});

test('rejects unsupported raw-message values before MIME parsing', async () => {
  await assert.rejects(
    parseNyc311Notification({}),
    error => error instanceof TypeError
      && error.message === 'rawMessage must be a string, Buffer, or Uint8Array'
  );
});
