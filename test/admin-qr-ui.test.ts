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
