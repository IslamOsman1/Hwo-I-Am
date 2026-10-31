import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {iceConfig} from '../src/ice.js';

test('missing, partial or invalid TURN configuration does not claim relay support', () => {
  for (const env of [{}, {TURN_URLS: 'turn:example.com:3478'}, {TURN_URLS: 'https://example.com', TURN_SECRET: 'test'}]) {
    assert.equal(iceConfig('player', 1000, env).turnConfigured, false);
  }
});
test('shared-secret TURN credentials are temporary and player-specific', () => {
  const config = iceConfig('player', 1000, {TURN_URLS: 'turn:example.com:3478,turns:example.com:5349', TURN_SECRET: 'test-secret'});
  assert.equal(config.turnConfigured, true);
  assert.equal(config.iceServers[1].username, '86401:player');
  assert.equal(config.iceServers[1].credential, createHmac('sha1', 'test-secret').update('86401:player').digest('base64'));
});
test('managed TURN username/password is returned only to authenticated room sessions', () => {
  const config = iceConfig('player', 1000, {TURN_URLS: 'turn:example.com:3478?transport=tcp', TURN_USERNAME: 'test-user', TURN_CREDENTIAL: 'test-password'});
  assert.deepEqual(config.iceServers[1], {urls: ['turn:example.com:3478?transport=tcp'], username: 'test-user', credential: 'test-password'});
  assert.equal(config.turnConfigured, true);
});
