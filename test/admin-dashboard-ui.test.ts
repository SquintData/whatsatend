import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { adminPage } from '../src/admin.js';

const views = ['overview', 'companies', 'attention', 'conversations', 'usage'];

function loadShowView() {
  const start = adminPage.indexOf('function showView(view)');
  const end = adminPage.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, 'dashboard must define an isolated showView function');
  const panels = views.map(view => ({ dataset: { viewPanel: view }, hidden: true }));
  const navigation = views.map(view => {
    const attributes = new Map<string, string>();
    return { dataset: { viewNav: view }, attributes,
      setAttribute(name: string, value: string) { attributes.set(name, value); },
      removeAttribute(name: string) { attributes.delete(name); } };
  });
  const documentRef = { querySelectorAll(selector: string) {
    if (selector === '[data-view-panel]') return panels;
    if (selector === '[data-view-nav]') return navigation;
    throw new Error(`unexpected selector ${selector}`);
  } };
  const showView = runInNewContext(`(()=>{${adminPage.slice(start, end)}; return showView;})()`,
    { document: documentRef }) as (view: string) => boolean;
  return { showView, panels, navigation };
}

test('dashboard navigation exposes one requested view and marks its link as current', () => {
  const { showView, panels, navigation } = loadShowView();
  for (const selected of views) {
    assert.equal(showView(selected), true);
    assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.dataset.viewPanel), [selected]);
    assert.deepEqual(navigation.filter(item => item.attributes.get('aria-current') === 'page')
      .map(item => item.dataset.viewNav), [selected]);
  }
  assert.equal(showView('unknown'), false);
  assert.equal(panels.filter(panel => !panel.hidden).length, 1, 'an invalid route must not expose another view');
});
