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

function loadDashboardDataHelpers() {
  const start = adminPage.indexOf('function dashboardMetrics(rows)');
  const end = adminPage.indexOf('function showView(view)', start + 1);
  assert.ok(start >= 0 && end > start, 'dashboard must expose its channel summary and safe row renderer');
  return runInNewContext(`(()=>{${adminPage.slice(start, end)}; return {dashboardMetrics,filterDashboardChannels,renderDashboardCompanyRows};})()`, {}) as {
    dashboardMetrics(rows: Array<Record<string, unknown>>): { channels: number; ready: number };
    filterDashboardChannels(rows: Array<Record<string, unknown>>, query: string): Array<Record<string, unknown>>;
    renderDashboardCompanyRows(rows: Array<Record<string, unknown>>, target: FakeElement,
      open: (row: Record<string, unknown>) => void, documentRef: FakeDocument): void;
  };
}

interface FakeElement {
  textContent: string;
  innerHTML?: string;
  className: string;
  children: FakeElement[];
  onclick?: () => void;
  append(...children: FakeElement[]): void;
  replaceChildren(...children: FakeElement[]): void;
}

interface FakeDocument { createElement(tag: string): FakeElement & { tagName: string } }

function fakeDocument(): FakeDocument {
  return { createElement: tag => ({ tagName: tag, textContent: '', className: '', children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; } }) };
}

test('channel selection ignores stale configuration responses when operators switch channels quickly', async () => {
  const start = adminPage.indexOf('function createChannelSelectionGuard()');
  const end = adminPage.indexOf('\nfunction showView(view)', start + 1);
  assert.ok(start >= 0 && end > start, 'dashboard must guard selected-channel requests');
  const guardSource = '(()=>{' + adminPage.slice(start, end) + ';return createChannelSelectionGuard()})()';
  const guard = runInNewContext(guardSource, {}) as {
    begin(key: string): { generation: number; key: string };
    isCurrent(request: { generation: number; key: string }): boolean;
  };
  let resolveFirst!: (value: string) => void;
  const firstResponse = new Promise<string>(resolve => { resolveFirst = resolve; });
  const first = guard.begin('instance-a\u0000session-a');
  const second = guard.begin('instance-b\u0000session-b');
  assert.equal(guard.isCurrent(second), true);
  assert.equal(guard.isCurrent(first), false);
  resolveFirst('channel-a');
  assert.equal(await firstResponse, 'channel-a');
});

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

test('overview counts channels, identifies only eligible ones, filters by company or channel and renders text safely', () => {
  const { dashboardMetrics, filterDashboardChannels, renderDashboardCompanyRows } = loadDashboardDataHelpers();
  const rows = [
    { company: 'Same name', instance: 'west', session: 'one', organizationActive: true, channelActive: true, aiEnabled: true, scope: 'test' },
    { company: 'Same name', instance: 'east', session: 'two', organizationActive: true, channelActive: true, aiEnabled: false, scope: 'all' },
    { company: 'Paused org', instance: 'west', session: 'three', organizationActive: false, channelActive: true, aiEnabled: true, scope: 'all' },
    { company: 'Paused channel', instance: 'west', session: 'four', organizationActive: true, channelActive: false, aiEnabled: true, scope: 'all' },
    { company: 'Disabled scope', instance: 'west', session: 'five', organizationActive: true, channelActive: true, aiEnabled: true, scope: 'disabled' },
  ];
  const metrics = dashboardMetrics(rows);
  assert.equal(metrics.channels, 5, 'channel totals include same-name channels independently');
  assert.equal(metrics.ready, 1);
  assert.deepEqual(Array.from(filterDashboardChannels(rows, 'TWO'), row => row.session), ['two']);
  assert.deepEqual(Array.from(filterDashboardChannels(rows, 'same name'), row => row.session), ['one', 'two']);

  const documentRef = fakeDocument();
  const target = documentRef.createElement('div');
  const malicious = { ...rows[0]!, company: '<img src=x onerror=alert(1)>' };
  renderDashboardCompanyRows([malicious], target, () => {}, documentRef);
  const title = target.children[0]!.children[0]!.children[0]!;
  assert.equal(title.textContent, malicious.company);
  assert.equal(title.innerHTML, undefined, 'untrusted company names are plain text, never parsed as HTML');
});
