'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDetail } = require('../cloud/portal');

const PORTAL_ID = '11111111-2222-3333-4444-555555555555';

function detailHtml({
  dateReported = '7/21/2026 4:28:50 PM',
  updatedOn = '2026-07-21T18:58:50+02:30',
  dateClosed = '7/21/2026 5:00:00 PM'
} = {}) {
  return `
    <input id="EntityFormView_EntityID" value="${PORTAL_ID}">
    <div id="page-wrapper">
      <p>The mobile outreach response team reached the person, who did not want assistance.</p>
      <div class="page-copy">Service Request Status</div>
    </div>
    <div class="info">
      <div class="col-sm-6">
        <label>SR Number</label>
        <div class="control"><span>311-28310246</span></div>
      </div>
      <div class="col-sm-6">
        <label>SR Status</label>
        <div class="control"><span>Closed</span></div>
      </div>
    </div>
    <script>
      $("#srdatereported").text(getESTDate("${dateReported}"));
      $("#srupdatedon").text(getESTDate("${updatedOn}"));
      $("#srdateclosed").text(getESTDate("${dateClosed}"));
    </script>
  `;
}

test('cloud Portal detail parser emits canonical timestamps for every detail date', () => {
  const parsed = parseDetail(detailHtml(), '311-28310246');

  assert.equal(parsed.outcome, 'found');
  assert.equal(parsed.record.portalId, PORTAL_ID);
  assert.equal(parsed.record.dateReported, '2026-07-21T16:28:50.000Z');
  assert.equal(parsed.record.updatedOn, '2026-07-21T16:28:50.000Z');
  assert.equal(parsed.record.dateClosed, '2026-07-21T17:00:00.000Z');
  assert.equal(
    parsed.record.agencyResponse,
    'The mobile outreach response team reached the person, who did not want assistance.'
  );
  assert.equal(parsed.record.fields['Agency Response'], parsed.record.agencyResponse);
});

test('cloud Portal detail parser converts an invalid published date to null', () => {
  const parsed = parseDetail(detailHtml({
    updatedOn: '2/29/2023 4:28:50 PM'
  }), '311-28310246');

  assert.equal(parsed.outcome, 'found');
  assert.equal(parsed.record.dateReported, '2026-07-21T16:28:50.000Z');
  assert.equal(parsed.record.updatedOn, null);
  assert.equal(parsed.record.dateClosed, '2026-07-21T17:00:00.000Z');
});

test('cloud Portal detail parser leaves agency response empty when the Portal did not publish one', () => {
  const parsed = parseDetail(
    detailHtml().replace(
      '<p>The mobile outreach response team reached the person, who did not want assistance.</p>',
      ''
    ),
    '311-28310246'
  );

  assert.equal(parsed.outcome, 'found');
  assert.equal(parsed.record.agencyResponse, null);
  assert.equal(parsed.record.fields['Agency Response'], undefined);
});

test('cloud Portal detail parser ignores an N/A agency-response placeholder', () => {
  const parsed = parseDetail(
    detailHtml().replace(
      'The mobile outreach response team reached the person, who did not want assistance.',
      'N/A'
    ),
    '311-28310246'
  );

  assert.equal(parsed.record.agencyResponse, null);
  assert.equal(parsed.record.fields['Agency Response'], undefined);
});
