'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyDeploymentFiles,
  deployedReleaseSha,
  selectDeploymentScope
} = require('../scripts/select-deploy-scope');

const DEPLOYED_SHA = 'a'.repeat(40);

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload
  };
}

function gitForChangedFiles(files, { ancestor = true } = {}) {
  const calls = [];
  const execFile = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'merge-base') {
      if (!ancestor) throw new Error('not an ancestor');
      return '';
    }
    if (args[0] === 'diff') return `${files.join('\n')}${files.length ? '\n' : ''}`;
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  return { calls, execFile };
}

test('deployment scope selects the narrowest safe lane', () => {
  assert.equal(classifyDeploymentFiles([]), 'none');
  assert.equal(classifyDeploymentFiles(['public/live.html']), 'assets');
  assert.equal(classifyDeploymentFiles([
    'public/css/live-ui.css',
    'public/vendor/leaflet/leaflet.js',
    'test/live-ui-contract.test.js'
  ]), 'assets');
  assert.equal(classifyDeploymentFiles(['public/live.html', 'server.js']), 'web');
  assert.equal(classifyDeploymentFiles(['sqlite-email-metrics.js']), 'web');
});

test('deployment scope fails closed for workers, dependencies, and infrastructure', () => {
  for (const file of [
    'live-311.js',
    'inbound-email-server.js',
    'package.json',
    'package-lock.json',
    'Dockerfile.sqlite',
    'aws/lightsail-sqlite/compose.yml',
    'aws/lightsail-sqlite/Caddyfile',
    'scripts/deploy-ui.sh',
    'unknown-file.txt'
  ]) {
    assert.equal(classifyDeploymentFiles(['public/live.html', file]), 'service', file);
  }
});

test('release manifest accepts only an exact lowercase commit SHA', async () => {
  const timeoutToken = {};
  let request;
  const sha = await deployedReleaseSha('https://example.test/release.json', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { release_sha: DEPLOYED_SHA });
    },
    timeoutSignal: () => timeoutToken
  });
  assert.equal(sha, DEPLOYED_SHA);
  assert.equal(request.url, 'https://example.test/release.json');
  assert.equal(request.options.signal, timeoutToken);

  await assert.rejects(
    deployedReleaseSha('https://example.test/release.json', {
      fetchImpl: async () => response(200, { release_sha: 'ABC' })
    }),
    /release manifest did not contain a valid SHA/
  );
});

test('a missing release manifest selects the one-time service bootstrap', async () => {
  const git = gitForChangedFiles(['public/live.html']);
  let requestedUrl;
  const result = await selectDeploymentScope({
    fetchImpl: async url => {
      requestedUrl = url;
      return response(404, { error: 'missing' });
    },
    execFile: git.execFile
  });
  assert.equal(requestedUrl, 'https://311.georgelevine.com/release.json');
  assert.deepEqual(result, {
    scope: 'service',
    deployedSha: null,
    changed: [],
    bootstrap: true
  });
  assert.equal(git.calls.length, 0);
});

test('automatic selection uses the manifest ancestor and changed files', async () => {
  const git = gitForChangedFiles(['public/live.html', 'server.js']);
  const result = await selectDeploymentScope({
    fetchImpl: async () => response(200, { release_sha: DEPLOYED_SHA }),
    execFile: git.execFile
  });
  assert.deepEqual(result, {
    scope: 'web',
    deployedSha: DEPLOYED_SHA,
    changed: ['public/live.html', 'server.js']
  });
  assert.deepEqual(git.calls.map(call => call.args), [
    ['merge-base', '--is-ancestor', DEPLOYED_SHA, 'HEAD'],
    ['diff', '--name-only', `${DEPLOYED_SHA}..HEAD`]
  ]);
});

test('automatic selection aborts on non-404 manifest failures', async () => {
  await assert.rejects(
    selectDeploymentScope({
      fetchImpl: async () => response(503, { error: 'unavailable' })
    }),
    /release manifest returned 503/
  );

  await assert.rejects(
    selectDeploymentScope({
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => { throw new SyntaxError('bad JSON'); }
      })
    }),
    /release manifest did not contain valid JSON/
  );

  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  await assert.rejects(
    selectDeploymentScope({ fetchImpl: async () => { throw timeout; } }),
    error => error === timeout
  );

  const network = new Error('network unavailable');
  await assert.rejects(
    selectDeploymentScope({ fetchImpl: async () => { throw network; } }),
    error => error === network
  );
});

test('automatic selection aborts when production is not an ancestor', async () => {
  const git = gitForChangedFiles(['public/live.html'], { ancestor: false });
  await assert.rejects(
    selectDeploymentScope({
      fetchImpl: async () => response(200, { release_sha: DEPLOYED_SHA }),
      execFile: git.execFile
    }),
    new RegExp(`Production release ${DEPLOYED_SHA} is not an ancestor of HEAD`)
  );
  assert.equal(git.calls.length, 1);
});
