import {createHmac} from 'node:crypto';

export function iceConfig(id, now, env = process.env) {
  const urls = (env.TURN_URLS || '').split(',').map(x => x.trim()).filter(x => /^turns?:[^\s]+$/.test(x));
  const iceServers = [{urls: ['stun:stun.l.google.com:19302']}];
  if (urls.length && env.TURN_SECRET) {
    const username = `${Math.floor(now / 1000) + 86400}:${id}`;
    iceServers.push({urls, username, credential: createHmac('sha1', env.TURN_SECRET).update(username).digest('base64')});
  } else if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    // Managed free-tier providers often supply long-term credentials instead of a shared secret.
    iceServers.push({urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL});
  }
  return {iceServers, turnConfigured: iceServers.length > 1};
}
