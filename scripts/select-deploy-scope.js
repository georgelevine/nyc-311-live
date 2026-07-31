'use strict';

const { execFileSync } = require('node:child_process');

const ASSET_PREFIXES = ['public/', 'test/'];
const ASSET_FILES = new Set([
  'README.md',
  'LIGHTSAIL_SQLITE_DEPLOYMENT.md',
  'AWS_DEPLOYMENT.md',
  'CLOUD_DEPLOYMENT.md'
]);
const WEB_FILES = new Set([
  'server.js',
  'nyc311-email-events.js',
  'sqlite-live-summary.js',
  'sqlite-email-metrics.js',
  'email-metrics-presentation.js',
  'email-metrics-background.js',
  'email-metrics-worker.js',
  'operational-health.js'
]);

function isAssetFile(file) {
  return ASSET_FILES.has(file) || ASSET_PREFIXES.some(prefix => file.startsWith(prefix));
}

function classifyDeploymentFiles(files) {
  const normalized = [...new Set(files.map(file => String(file).trim()).filter(Boolean))];
  if (normalized.length === 0) return 'none';
  if (normalized.every(isAssetFile)) return 'assets';
  if (normalized.every(file => isAssetFile(file) || WEB_FILES.has(file))) return 'web';
  return 'service';
}

function git(args, execFile = execFileSync) {
  return execFile('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

async function deployedReleaseSha(url, {
  fetchImpl = fetch,
  timeoutSignal = () => AbortSignal.timeout(10_000)
} = {}) {
  const response = await fetchImpl(url, { signal: timeoutSignal() });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`release manifest returned ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('release manifest did not contain valid JSON', { cause: error });
  }
  const sha = String(payload && payload.release_sha || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('release manifest did not contain a valid SHA');
  }
  return sha;
}

async function selectDeploymentScope({
  releaseManifestUrl = 'https://311.georgelevine.com/release.json',
  fetchImpl = fetch,
  execFile = execFileSync,
  timeoutSignal = () => AbortSignal.timeout(10_000)
} = {}) {
  const deployedSha = await deployedReleaseSha(releaseManifestUrl, {
    fetchImpl,
    timeoutSignal
  });
  if (deployedSha == null) {
    return {
      scope: 'service',
      deployedSha: null,
      changed: [],
      bootstrap: true
    };
  }

  try {
    execFile('git', ['merge-base', '--is-ancestor', deployedSha, 'HEAD'], {
      stdio: 'ignore'
    });
  } catch (error) {
    throw new Error(
      `Production release ${deployedSha} is not an ancestor of HEAD; automatic deployment aborted`,
      { cause: error }
    );
  }

  const changed = git(
    ['diff', '--name-only', `${deployedSha}..HEAD`],
    execFile
  ).split('\n').filter(Boolean);
  return { scope: classifyDeploymentFiles(changed), deployedSha, changed };
}

if (require.main === module) {
  selectDeploymentScope().then(result => {
    process.stdout.write(`${result.scope}\n`);
    const detail = result.bootstrap
      ? 'No production release manifest exists; selecting the one-time service bootstrap.'
      : result.scope === 'none'
        ? 'Production already matches this commit.'
        : `Automatic deployment scope: ${result.scope} (${result.changed.length} changed ${result.changed.length === 1 ? 'file' : 'files'}).`;
    process.stderr.write(`${detail}\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ASSET_FILES,
  ASSET_PREFIXES,
  WEB_FILES,
  classifyDeploymentFiles,
  deployedReleaseSha,
  selectDeploymentScope
};
