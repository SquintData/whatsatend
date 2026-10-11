import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { adminPage } from '../src/admin.js';

function qrController(revoked: string[]) {
  const start = adminPage.indexOf('function createQrView');
  const end = adminPage.indexOf('\nconst root', start);
  assert.ok(start >= 0 && end > start, 'admin page must expose the isolated QR lifecycle helper');
  const urls = {
    createObjectURL: (blob: string) => `blob:${blob}`,
    revokeObjectURL: (url: string) => { revoked.push(url); },
  };
  const create = runInNewContext(`(()=>{${adminPage.slice(start, end)};return createQrView})()`, { URL: urls }) as
    (image: { dataset: Record<string, string>; src: string; hidden: boolean; removeAttribute(name: string): void }) => {
      select(key: string): void;
      updateStatus(key: string, status: string): boolean;
      show(key: string, load: () => Promise<string>): Promise<boolean>;
    };
  const image = { dataset: {} as Record<string, string>, src: '', hidden: true,
    removeAttribute(name: string) { if (name === 'src') this.src = ''; } };
  return { image, view: create(image), revoked };
}

test('switching channels clears the old QR immediately and ignores a late QR response from the prior session', async () => {
  const state = qrController([]);
  state.view.select('company-a/session-a');
  state.view.updateStatus('company-a/session-a', 'SCAN_QR_CODE');
  assert.equal(await state.view.show('company-a/session-a', async () => 'qr-a'), true);
  assert.equal(state.image.src, 'blob:qr-a');

  state.view.select('company-b/session-b');
  assert.equal(state.image.hidden, true, 'switching sessions must hide the old QR synchronously');
  assert.equal(state.image.src, '');
  assert.deepEqual(state.revoked, ['blob:qr-a'], 'switching sessions must revoke the old object URL');
  assert.equal(state.view.updateStatus('company-a/session-a', 'WORKING'), false, 'a late status response for the old channel is ignored');

  state.view.select('company-a/session-a');
  state.view.updateStatus('company-a/session-a', 'SCAN_QR_CODE');
  let finishOldQr!: (value: string) => void;
  const oldQr = state.view.show('company-a/session-a', () => new Promise(resolve => { finishOldQr = resolve; }));

  state.view.select('company-b/session-b');
  assert.equal(state.image.hidden, true);
  assert.equal(state.image.src, '');
  state.view.updateStatus('company-b/session-b', 'SCAN_QR_CODE');
  assert.equal(await state.view.show('company-b/session-b', async () => 'qr-b'), true);
  assert.equal(state.image.src, 'blob:qr-b');

  finishOldQr('qr-a');
  assert.equal(await oldQr, false);
  assert.equal(state.image.src, 'blob:qr-b', 'a stale callback must not replace another session QR');

  assert.equal(state.view.updateStatus('company-b/session-b', 'WORKING'), true);
  assert.equal(state.image.hidden, true);
  assert.equal(state.image.src, '');
  assert.deepEqual(state.revoked, ['blob:qr-a', 'blob:qr-b']);
});

test('conversation search discards an older channel response when requests finish out of order', async () => {
  const start = adminPage.indexOf('function createConversationSearchGuard');
  const end = adminPage.indexOf('\nfunction mountConversationHistory', start);
  assert.ok(start >= 0 && end > start, 'admin UI must expose the conversation request guard');
  const createGuard = runInNewContext(`(()=>{${adminPage.slice(start, end)};return createConversationSearchGuard})()`) as
    () => { begin(key: string): unknown; isCurrent(request: unknown): boolean };
  const guard = createGuard();
  const rendered: string[] = [];
  let resolveA!: (rows: string[]) => void;
  let resolveB!: (rows: string[]) => void;
  const responseA = new Promise<string[]>(resolve => { resolveA = resolve; });
  const requestA = guard.begin('company-a/channel-a');
  const renderA = responseA.then(rows => { if (guard.isCurrent(requestA)) rendered.push(...rows); });
  const responseB = new Promise<string[]>(resolve => { resolveB = resolve; });
  const requestB = guard.begin('company-b/channel-b');
  const renderB = responseB.then(rows => { if (guard.isCurrent(requestB)) rendered.push(...rows); });

  resolveB(['preview-from-b']);
  await renderB;
  resolveA(['preview-from-a']);
  await renderA;
  assert.deepEqual(rendered, ['preview-from-b']);
});

test('conversation detail discards a prior channel response after the selected channel changes', async () => {
  const mountStart = adminPage.indexOf('function mountConversationHistory');
  const mountEnd = adminPage.indexOf('\nfunction mountConversationLinks', mountStart);
  assert.ok(mountStart >= 0 && mountEnd > mountStart);
  const mount = adminPage.slice(mountStart, mountEnd);
  const detailFetch = mount.indexOf("await api('/admin/api/conversation?");
  const detailCheck = mount.indexOf('detailGuard.isCurrent(request)', detailFetch);
  assert.ok(detailCheck > detailFetch, 'detail rendering must verify the current channel/conversation request after fetch');
  const start = adminPage.indexOf('function createConversationSearchGuard');
  const end = adminPage.indexOf('\nfunction mountConversationHistory', start);
  assert.ok(start >= 0 && end > start, 'admin UI must expose the conversation request guard');
  const createGuard = runInNewContext(`(()=>{${adminPage.slice(start, end)};return createConversationSearchGuard})()`) as
    () => { begin(key: string): unknown; isCurrent(request: unknown): boolean };
  const detailGuard = createGuard();
  const rendered: string[] = [];
  let resolveA!: (rows: string[]) => void;
  let resolveB!: (rows: string[]) => void;
  const responseA = new Promise<string[]>(resolve => { resolveA = resolve; });
  const requestA = detailGuard.begin(JSON.stringify(['company-a', 'channel-a', 'conversation-a']));
  const renderA = responseA.then(rows => { if (detailGuard.isCurrent(requestA)) rendered.push(...rows); });

  detailGuard.begin(JSON.stringify(['company-b', 'channel-b']));
  const responseB = new Promise<string[]>(resolve => { resolveB = resolve; });
  const requestB = detailGuard.begin(JSON.stringify(['company-b', 'channel-b', 'conversation-b']));
  const renderB = responseB.then(rows => { if (detailGuard.isCurrent(requestB)) rendered.push(...rows); });
  resolveB(['detail-from-b']);
  await renderB;
  resolveA(['detail-from-a']);
  await renderA;
  assert.deepEqual(rendered, ['detail-from-b']);
});
