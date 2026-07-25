'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  chooseDetailWork,
  monitoringMode,
  preservePendingClosureStatus,
  scheduledOpenFollowupsEnabled
} = require('../monitoring-mode');

test('scheduled open follow-ups remain enabled by default and accept explicit truthy values', () => {
  assert.equal(scheduledOpenFollowupsEnabled({}), true);
  assert.equal(scheduledOpenFollowupsEnabled({ SCHEDULED_OPEN_FOLLOWUPS_ENABLED: '1' }), true);
  assert.equal(scheduledOpenFollowupsEnabled({ SCHEDULED_OPEN_FOLLOWUPS_ENABLED: 'true' }), true);
  assert.equal(monitoringMode({}), 'email_primary_with_scheduled_fallback');
});

test('scheduled open follow-ups can be disabled without disabling closing or initial work', () => {
  for (const value of ['0', 'false', 'OFF', 'no']) {
    assert.equal(
      scheduledOpenFollowupsEnabled({ SCHEDULED_OPEN_FOLLOWUPS_ENABLED: value }),
      false
    );
    assert.equal(
      monitoringMode({ SCHEDULED_OPEN_FOLLOWUPS_ENABLED: value }),
      'email_primary'
    );
  }

  const closing = { srnumber: '311-00000001', work_kind: 'closing' };
  const initial = { srnumber: '311-00000002', work_kind: 'initial' };
  const open = { srnumber: '311-00000003', work_kind: 'followup' };
  assert.equal(chooseDetailWork({
    closing,
    initial,
    open,
    scheduledOpenFollowups: false
  }), closing);
  assert.equal(chooseDetailWork({
    initial,
    open,
    scheduledOpenFollowups: false
  }), initial);
  assert.equal(chooseDetailWork({
    open,
    scheduledOpenFollowups: false
  }), null);
  assert.equal(chooseDetailWork({
    open,
    scheduledOpenFollowups: true
  }), open);
});

test('a lagging map pin cannot undo a closure while verification is active', () => {
  assert.equal(preservePendingClosureStatus({
    currentStatus: 'Closed',
    incomingStatus: 'In Progress',
    followUpState: 'closing'
  }), true);
  assert.equal(preservePendingClosureStatus({
    currentStatus: 'Closed',
    incomingStatus: 'In Progress',
    followUpState: 'closed'
  }), false);
  assert.equal(preservePendingClosureStatus({
    currentStatus: 'In Progress',
    incomingStatus: 'Closed',
    followUpState: 'open'
  }), false);
});
