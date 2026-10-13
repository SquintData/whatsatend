# Admin Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long admin page with the approved Central de operações, preserving all existing admin behavior and safety gates.

**Architecture:** Keep Fastify admin APIs unchanged. Reorganize the server-served `adminPage` into navigation views and a selected-channel workspace; load WAHA status only in that workspace. Use existing endpoints for channels, attention, usage, company settings and conversations, and keep untrusted values in DOM text nodes.

**Tech Stack:** Node 22, TypeScript, Fastify 5, inline browser JavaScript/CSS, Node test runner, PGlite fixtures.

---

Work only in `C:\Users\otavi\whatsatend\admin-dashboard-redesign` on branch `codex/admin-dashboard-redesign`, based on `origin/main` at `87f58042`. The approved design is `docs/superpowers/specs/2026-10-12-admin-dashboard-redesign-design.md`. Preserve the unrelated dirty `repository` checkout and `ai-preview` worktree.

## Files and boundaries

- `src/admin.ts`: keep API routes and export `adminPage` for existing test imports. Move the page literal to `src/admin-page.ts` if that makes the diff easier to review; re-export it from `admin.ts`.
- `src/admin-page.ts` (optional): page structure, CSS and browser behavior only; no database or WAHA access other than calling admin endpoints.
- `test/admin-qr-ui.test.ts`, `test/admin.test.ts`, and an optional `test/admin-dashboard-ui.test.ts`: verify existing QR/conversation safety, auth/API behavior and new navigation/metrics/search behavior.

## Task 1: Page shell and view navigation

- [ ] Add a focused UI test that selects Visão geral, Empresas, Atenção, Conversas and Consumo and checks that exactly one main view is visible and its navigation item has `aria-current="page"`. Run `node --import tsx --test test/admin-dashboard-ui.test.ts` and confirm it fails before implementation.
- [ ] Build the approved shell: desktop sidebar, compact mobile navigation, header and view containers. Use one function such as `showView(view)` with an explicit allowlist `['overview','companies','attention','conversations','usage']`; hide other views and update `aria-current`. Keep login and logout behavior.
- [ ] Run the focused test, `npm run check` and `npm run build`; expected all pass. Commit this self-contained step.

## Task 2: Overview, companies and onboarding

- [ ] Add a test for overview numbers and search. Given duplicate company names on separate channels, total channels must count both rows; “aptos a responder” must require active organization, active channel, `aiEnabled` and non-disabled scope. Search must match company, instance or session without HTML injection. Run the focused test and confirm it fails.
- [ ] Render overview from `/admin/api/channels` and `/admin/api/attention`. Label attention as “itens recentes (até 50)”; do not claim a complete global count or show a WAHA health total. Render the channel list as DOM nodes with `textContent`, a client-side search and an action to open the selected channel.
- [ ] Put “Nova empresa” in its own view. Retain current request schema, duplicate-session error, IA disabled and scope disabled defaults. Keep instance/session fields with short guidance. After success, refresh channels and open that new channel; after failure, retain entered values and display an inline error.
- [ ] Run focused UI tests and `test/admin.test.ts`; expected all pass. Commit this step.

## Task 3: Selected-channel workspace

- [ ] Add tests for selecting two channels in sequence: values shown and all subsequent mutation payloads must use the second `(instance, session)`; a stale first-channel WAHA status or QR response must never appear under the second channel. Keep the existing QR generation guard test. Run tests and confirm the new case fails.
- [ ] Organize the selected-channel workspace into Dados e IA, WhatsApp and Automação tabs. Populate from `/admin/api/channel`; request `/admin/api/channel/status` only when WhatsApp opens. Reuse the existing `createQrView` guard and hide QR outside `SCAN_QR_CODE`.
- [ ] Keep model, tone, instructions, `businessData`, AI enabled and scope controls. When saving `businessData`, parse it locally, preserve unknown keys, and show a field-level error on invalid JSON. Keep the explicit `confirmAll` confirmation and exact test contact input. Never enable automation as a side effect of onboarding or saving AI settings.
- [ ] Run focused tests, `test/admin-qr-ui.test.ts`, `test/admin.test.ts`, `npm run check` and `npm run build`; expected all pass. Commit this step.

## Task 4: Attention, conversations, usage and final verification

- [ ] Add a UI test that opening an attention item switches to Conversas and opens only its scoped conversation; keep the existing safe renderer (`textContent`, fixed link target). Check that failed/uncertain items are read-only and do not gain a resend action. Run it and confirm it fails.
- [ ] Move the existing attention queue, conversation history/manual controls, and monthly UTC usage table into their named views. Preserve pause, manual reply and Retomar IA behavior, their status messages and the `x-admin-action` mutation header. Maintain separate loading, empty and failed states with retry in each data section.
- [ ] Inspect desktop and mobile layouts in a browser. Check keyboard tab/focus, readable labels, absence of horizontal scrolling, login/logout, company create, channel tabs, QR hiding and attention navigation with mocked or local data. No production mutation is needed for visual verification.
- [ ] Run `npm test`, `npm run check`, `npm run build`, and `git diff --check`. Review diff against the design spec and confirm no new dependency, DB migration or backend contract change. Commit and provide changed files, tests, screenshots/observations, limitations and exact branch/head for independent review.
