'use strict';

function originMatchesHost(origin, host, protocol = null) {
  if (!origin) return true;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host.toLowerCase() !== String(host).trim().toLowerCase()) return false;
    if (!protocol) return true;
    const expected = String(protocol).split(',')[0].trim().replace(/:$/, '').toLowerCase();
    return parsed.protocol.toLowerCase() === `${expected}:`;
  } catch (_) {
    return false;
  }
}

module.exports = { originMatchesHost };
