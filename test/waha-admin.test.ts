import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WahaAdminClient, optionalWahaAdmin, parsePublicBaseUrl } from '../src/waha-admin.js';

test('optional connection settings cannot prevent startup when credentials or the public HTTPS origin are absent', () => {
  assert.equal(optionalWahaAdmin('http://waha.local', undefined), undefined);
  assert.equal(optionalWahaAdmin('not a URL', 'key'.padEnd(40, 'x')), undefined);
  assert.equal(parsePublicBaseUrl(undefined), undefined);
  assert.equal(parsePublicBaseUrl('http://app.local'), undefined);
  assert.equal(parsePublicBaseUrl('https://app.local/path'), undefined);
  assert.equal(parsePublicBaseUrl('https://app.local/'), 'https://app.local');
});

test('WAHA admin uses only documented session endpoints and keeps its API key server-side', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const apiKey = 'secret-api-key-'.padEnd(40, 'x');
  const client = new WahaAdminClient({ baseUrl: 'http://waha.local', apiKey }, async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/api/sessions?all=true')) return Response.json([{ name: 'existing', status: 'WORKING' }]);
    if (String(input).endsWith('/api/sessions')) return Response.json({ name: 'new', status: 'STOPPED' });
    if (String(input).endsWith('/api/sessions/new/start')) return new Response(null, { status: 200 });
    if (String(input).endsWith('/api/sessions/new')) return Response.json({ name: 'new', status: 'WORKING' });
    if (String(input).endsWith('/api/sessions/linked')) return Response.json({ name: 'linked', status: 'WORKING', engine: 'GOWS', me: { id: '123@c.us' } });
    if (String(input).endsWith('/api/linked/auth/qr')) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'image/png' } });
    return new Response('unexpected endpoint', { status: 500 });
  });

  const sessions = await client.listSessions();
  assert.deepEqual(sessions, [{ name: 'existing', status: 'WORKING' }]);
  await client.createStoppedSession('new', 'https://app.local/webhooks/waha/instance', 'a'.repeat(64));
  await client.startSession('new');
  assert.deepEqual(await client.sessionStatus('linked'), { status: 'WORKING', engine: 'GOWS', account: '123@c.us' });
  assert.deepEqual([...await client.qrPng('linked')], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname + new URL(call.url).search), [
    '/api/sessions?all=true', '/api/sessions', '/api/sessions/new/start', '/api/sessions/linked', '/api/linked/auth/qr',
  ]);
  for (const call of calls) assert.equal((call.init.headers as Record<string, string>)['X-Api-Key'], apiKey);
  const createBody = JSON.parse(String(calls[1]!.init.body));
  assert.equal(createBody.start, false);
  assert.deepEqual(createBody.config.webhooks[0].events, ['message.any', 'message.reaction', 'session.status']);
  assert.deepEqual(createBody.config.webhooks[0].customHeaders, { 'X-Webhook-Token': 'a'.repeat(64) });
});

test('WAHA status accepts the real engine metadata object and normalizes it without exposing metadata', async () => {
  const client = new WahaAdminClient({ baseUrl: 'http://waha.local', apiKey: 'test-api-key-'.padEnd(40, 'x') }, async () =>
    Response.json({ name: 'fixture-session', status: 'WORKING',
      engine: { engine: 'GOWS', grpc: { internal: 'ignored' }, gows: { internal: 'ignored' } },
      me: { id: 'fixture-account' } }));
  const status = await client.sessionStatus('fixture-session');
  assert.deepEqual(status, { status: 'WORKING', engine: 'GOWS', account: 'fixture-account' });
  assert.equal(Object.keys(status).join(','), 'status,engine,account');
});

test('WAHA admin rejects non-PNG or oversized QR data and does not log response contents', async () => {
  const invalid = new WahaAdminClient({ baseUrl: 'http://waha.local', apiKey: 'secret-api-key-'.padEnd(40, 'x') }, async () =>
    new Response('not a png', { headers: { 'content-type': 'text/plain' } }));
  await assert.rejects(() => invalid.qrPng('safe'), /WAHA request failed/);
});
