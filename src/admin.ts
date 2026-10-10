import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from './db.js';
import { parseCompanyAIConfig, type CompanyAIConfig } from './ai-config.js';
import { setChannelScope, type ChannelScope } from './channel-scope.js';
import { directChat } from './automation.js';
import { listCompanies, configureCompanyAI, createCompany, parseCompanyOnboarding } from './company-admin.js';
import type { WahaAdminClient } from './waha-admin.js';

const sessionCookie = 'wa_admin';
const sessionTtlMs = 8 * 60 * 60 * 1000;
export const adminPage = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsAtend · Operação</title>
<style>body{font:16px system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#17202a;background:#f6f8fa}input,textarea,select,button{font:inherit;padding:.55rem;border:1px solid #aab4be;border-radius:5px}input,textarea,select{max-width:100%;box-sizing:border-box}textarea{width:100%;min-height:7rem}button{cursor:pointer;background:#fff}button.primary{background:#145a46;color:#fff}label{display:block;margin:.8rem 0}.row{display:flex;gap:.8rem;flex-wrap:wrap}.row label{flex:1;min-width:220px}table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:.65rem;border-bottom:1px solid #ddd}.panel{background:#fff;padding:1rem;margin:1rem 0;border:1px solid #ddd;border-radius:7px}.muted{color:#53616f}#notice{min-height:1.4rem;color:#8b1e1e}</style>
<main id="app"></main><script>
function createQrView(image,objectUrls=URL){let selectedKey='',generation=0,status='';const clear=()=>{image.hidden=true;const previous=image.dataset.url;if(previous){objectUrls.revokeObjectURL(previous);delete image.dataset.url}image.removeAttribute('src')};return{select(key){if(key===selectedKey)return;selectedKey=key;status='';generation++;clear()},updateStatus(key,next){if(key!==selectedKey)return false;status=next;if(next!=='SCAN_QR_CODE'){generation++;clear()}return true},async show(key,load){if(key!==selectedKey||status!=='SCAN_QR_CODE')return false;const current=++generation;clear();const blob=await load();if(key!==selectedKey||current!==generation||status!=='SCAN_QR_CODE')return false;const url=objectUrls.createObjectURL(blob);image.dataset.url=url;image.src=url;image.hidden=false;return true}}}
const root=document.querySelector('#app');
async function api(url,options={}){const method=(options.method||'GET').toUpperCase();const mutating=['POST','PUT','PATCH','DELETE'].includes(method);const response=await fetch(url,{...options,headers:{...(options.body?{'content-type':'application/json'}:{}),...options.headers,...(mutating?{'x-admin-action':'1'}:{})}});if(!response.ok)throw Error(response.status===401?'Sessão encerrada. Entre novamente.':'Operação não concluída. Confira os dados e tente outra vez.');return response.status===204?null:response.json()}
function notice(text){const n=document.querySelector('#notice');if(n)n.textContent=text}
function login(){root.innerHTML='<h1>WhatsAtend · Operação interna</h1><section class="panel"><h2>Entrar</h2><form id="login"><label>Segredo administrativo<input id="secret" type="password" autocomplete="current-password" required minlength="32"></label><button class="primary">Entrar</button><p id="notice" role="status"></p></form></section>';document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const field=document.querySelector('#secret');const secret=field.value;field.value='';try{await api('/admin/api/login',{method:'POST',body:JSON.stringify({secret})});await dashboard()}catch{notice('Acesso negado. Verifique o segredo administrativo.')}}}
async function dashboard(){root.innerHTML='<header class="row"><h1>Empresas e canais</h1><button id="logout">Sair</button></header><p class="muted">Configurações são isoladas por empresa. O escopo disabled pausa o canal; conversas em atendimento humano permanecem pausadas.</p><section class="panel"><h2>Cadastrar empresa e canal</h2><form id="create-channel"><div class="row"><label>Instância do webhook<input name="instance" required maxlength="100" pattern="[A-Za-z0-9_-]+" value="principal"></label><label>Sessão WAHA<input name="session" required maxlength="100" pattern="[A-Za-z0-9_-]+"></label><label>Empresa<input name="company" required maxlength="200"></label></div><button class="primary">Criar e iniciar sessão</button><p id="create-notice" role="status"></p></form><p class="muted">A sessão nasce com automação desativada. O segredo do webhook é gerado no backend e não é exibido.</p></section><section class="panel"><div class="row"><h2>Canais cadastrados</h2><button id="refresh">Atualizar</button></div><div id="table"></div></section><section class="panel" id="editor" hidden><h2 id="title">Configuração</h2><form id="ai"><label><input id="enabled" type="checkbox"> IA habilitada para a empresa</label><label>Modelo<input id="model" required maxlength="100"></label><label>Dados da empresa (JSON)<textarea id="data" maxlength="10000" spellcheck="false"></textarea></label><label>Tom<textarea id="tone" maxlength="300"></textarea></label><label>Instruções<textarea id="instructions" maxlength="2000"></textarea></label><button class="primary">Salvar configuração da IA</button></form><hr><form id="scope"><label>Escopo do canal<select id="scope-value"><option value="disabled">Desativado</option><option value="test">Teste · contato exato</option><option value="all">Todos os contatos diretos</option></select></label><label id="test-row">ID exato para teste<input id="test-chat" maxlength="255" placeholder="5511999999999@c.us"></label><label id="all-row"><input id="confirm-all" type="checkbox"> Confirmo ativação para todos os contatos diretos deste canal</label><button class="primary">Aplicar escopo</button></form><p id="notice" role="status"></p></section><p class="muted">O painel nunca exibe tokens de webhook ou a chave WAHA.</p></main>';
let selected=null;const refresh=async()=>{try{const rows=await api('/admin/api/channels');const table=document.querySelector('#table');table.replaceChildren();if(!rows.length){table.textContent='Nenhuma empresa/canal cadastrado.';return}const t=document.createElement('table');t.innerHTML='<thead><tr><th>Empresa</th><th>Instância / sessão</th><th>Ativa</th><th>IA</th><th>Escopo</th><th></th></tr></thead>';const body=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');for(const value of [row.company,row.instance+' / '+row.session,row.organizationActive&&row.channelActive?'sim':'não',row.aiEnabled?'ativa':'desativada',row.scope]){const td=document.createElement('td');td.textContent=String(value);tr.append(td)}const td=document.createElement('td'),button=document.createElement('button');button.textContent='Configurar';button.onclick=()=>open(row.instance,row.session);const connect=document.createElement('button');connect.textContent='Conexão';connect.onclick=()=>showConnection(row.instance,row.session);td.append(button,connect);tr.append(td);body.append(tr)}t.append(body);table.append(t)}catch{login()}};
const open=async(instance,session)=>{try{const item=await api('/admin/api/channel?'+new URLSearchParams({instance,session}));selected={instance,session};document.querySelector('#editor').hidden=false;document.querySelector('#title').textContent=item.company+' · '+instance+' / '+session;document.querySelector('#enabled').checked=item.ai.enabled;document.querySelector('#model').value=item.ai.model;document.querySelector('#data').value=JSON.stringify(item.ai.businessData,null,2);document.querySelector('#tone').value=item.ai.tone;document.querySelector('#instructions').value=item.ai.instructions;document.querySelector('#scope-value').value=item.scope;document.querySelector('#test-chat').value=item.testChatId||'';notice('')}catch{notice('Não foi possível carregar esta configuração.')}};
let connectionQr;let currentConnectionKey='';const showConnection=async(instance,session)=>{let panel=document.querySelector('#connection');if(!panel){panel=document.createElement('section');panel.id='connection';panel.className='panel';panel.innerHTML='<h2>Conexão WhatsApp</h2><p id=connection-status role=status></p><button id=start-session>Iniciar sess\u00e3o</button> <button id=refresh-status>Consultar status</button> <button id=show-qr>Exibir QR de pareamento</button><p><img id=session-qr alt="QR de pareamento WAHA" hidden style="max-width:320px"></p>';document.querySelector('#editor').after(panel);connectionQr=createQrView(document.querySelector('#session-qr'))}panel.hidden=false;const key=instance+'\u0000'+session;currentConnectionKey=key;connectionQr.select(key);const query=new URLSearchParams({instance,session});const status=async()=>{const value=await api('/admin/api/channel/status?'+query);if(!connectionQr.updateStatus(key,value.status)||currentConnectionKey!==key)return null;document.querySelector('#connection-status').textContent='Status: '+value.status+(value.engine?' \u00b7 Engine: '+value.engine:'')+(value.account?' \u00b7 Conta: '+value.account:'');return value};document.querySelector('#start-session').onclick=async()=>{try{await api('/admin/api/channel/start',{method:'POST',body:JSON.stringify({instance,session})});await status()}catch{if(currentConnectionKey===key){connectionQr.updateStatus(key,'UNKNOWN');document.querySelector('#connection-status').textContent='N\u00e3o foi poss\u00edvel iniciar a sess\u00e3o.'}}};document.querySelector('#refresh-status').onclick=()=>status().catch(()=>{if(currentConnectionKey===key){connectionQr.updateStatus(key,'UNKNOWN');document.querySelector('#connection-status').textContent='Status indispon\u00edvel.'}});document.querySelector('#show-qr').onclick=async()=>{try{const shown=await connectionQr.show(key,async()=>{const response=await fetch('/admin/api/channel/qr?'+query);if(!response.ok)throw Error();return response.blob()});if(!shown&&currentConnectionKey===key)document.querySelector('#connection-status').textContent='QR dispon\u00edvel somente durante SCAN_QR_CODE.'}catch{if(currentConnectionKey===key)document.querySelector('#connection-status').textContent='QR indispon\u00edvel.'}};await status().catch(()=>{if(currentConnectionKey===key){connectionQr.updateStatus(key,'UNKNOWN');document.querySelector('#connection-status').textContent='Status indispon\u00edvel.'}})};document.querySelector('#create-channel').onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));try{await api('/admin/api/channels',{method:'POST',body:JSON.stringify(data)});e.currentTarget.reset();document.querySelector('#refresh').click();document.querySelector('#create-notice').textContent='Empresa/canal criado; sessão iniciada com automação desativada.'}catch{document.querySelector('#create-notice').textContent='Cadastro não concluído. Verifique a sessão WAHA e a configuração do backend.'}};document.querySelector('#logout').onclick=async()=>{try{await api('/admin/api/logout',{method:'POST'})}finally{login()}};document.querySelector('#refresh').onclick=refresh;document.querySelector('#ai').onsubmit=async e=>{e.preventDefault();if(!selected)return;try{const businessData=JSON.parse(document.querySelector('#data').value||'{}');await api('/admin/api/channel/ai',{method:'PUT',body:JSON.stringify({...selected,enabled:document.querySelector('#enabled').checked,model:document.querySelector('#model').value,businessData,tone:document.querySelector('#tone').value,instructions:document.querySelector('#instructions').value})});notice('Configuração salva.')}catch{notice('JSON inválido ou configuração recusada.')}};document.querySelector('#scope').onsubmit=async e=>{e.preventDefault();if(!selected)return;const scope=document.querySelector('#scope-value').value;try{await api('/admin/api/channel/scope',{method:'PUT',body:JSON.stringify({...selected,scope,testChatId:document.querySelector('#test-chat').value||undefined,confirmAll:document.querySelector('#confirm-all').checked})});notice('Escopo atualizado.');await refresh();await open(selected.instance,selected.session)}catch{notice('Escopo recusado. Para “Todos”, marque a confirmação explícita.')}};document.querySelector('#scope-value').onchange=e=>{document.querySelector('#test-row').hidden=e.target.value!=='test';document.querySelector('#all-row').hidden=e.target.value!=='all'};document.querySelector('#scope-value').dispatchEvent(new Event('change'));await refresh()}
login();
</script></html>`;

const mappingSchema = z.object({ instance: z.string().min(1).max(100), session: z.string().min(1).max(200) }).strict();
const loginSchema = z.object({ secret: z.string().min(1).max(256) }).strict();
const scopeSchema = mappingSchema.extend({
  scope: z.enum(['disabled', 'test', 'all']), testChatId: z.string().max(255).optional(), confirmAll: z.boolean().optional(),
}).strict();

export function registerAdminPanel(app: FastifyInstance, db: Database, secret: string,
  connections: { waha?: WahaAdminClient; publicBaseUrl?: string } = {}) {
  const secretBytes = Buffer.from(secret);
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; startedAt: number }>();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const secretMatches = (value: string) => {
    const bytes = Buffer.from(value);
    return bytes.length === secretBytes.length && timingSafeEqual(bytes, secretBytes);
  };
  const sessionKey = (request: { headers: { cookie?: string } }) => {
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionCookie}=`));
    const token = cookie?.slice(sessionCookie.length + 1);
    return token && /^[A-Za-z0-9_-]{40,60}$/.test(token) ? digest(token) : undefined;
  };
  const authenticated = (request: { headers: { cookie?: string } }) => {
    const key = sessionKey(request);
    const expiry = key ? sessions.get(key) : undefined;
    if (!key || !expiry || expiry <= Date.now()) { if (key) sessions.delete(key); return false; }
    return true;
  };
  const headers = (reply: { header(name: string, value: string): unknown }) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  };
  const reject = (reply: { code(status: number): { send(payload: unknown): unknown } }, status = 401) => reply.code(status).send({ error: status === 401 ? 'unauthorized' : 'invalid_request' });
  const secureSameOrigin = (request: { headers: { origin?: string; host?: string | string[] } }) =>
    typeof request.headers.host === 'string' && request.headers.origin === `https://${request.headers.host}`;
  const ensureMutation = (request: { headers: Record<string, string | string[] | undefined> }) =>
    request.headers['x-admin-action'] === '1' && typeof request.headers.host === 'string'
      && request.headers.origin === `https://${request.headers.host}`;
  const guard = (request: { headers: { cookie?: string } }, reply: { code(status: number): { send(payload: unknown): unknown } }) => {
    if (authenticated(request)) return true;
    reject(reply);
    return false;
  };

  app.get('/admin', async (_request, reply) => {
    headers(reply); return reply.type('text/html; charset=utf-8').send(adminPage);
  });
  app.post('/admin/api/login', async (request, reply) => {
    headers(reply);
    if (!secureSameOrigin(request)) return reject(reply);
    const ip = request.ip;
    let state = attempts.get(ip);
    if (!state || Date.now() - state.startedAt > 10 * 60_000) { state = { count: 0, startedAt: Date.now() }; attempts.set(ip, state); }
    if (state.count >= 8) return reject(reply, 429);
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || !secretMatches(parsed.data.secret)) { state.count++; return reject(reply); }
    attempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token), Date.now() + sessionTtlMs);
    reply.header('Set-Cookie', `${sessionCookie}=${token}; Path=/admin; Max-Age=${sessionTtlMs / 1000}; HttpOnly; Secure; SameSite=Strict`);
    return reply.code(204).send();
  });
  app.post('/admin/api/logout', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const key = sessionKey(request); if (key) sessions.delete(key);
    reply.header('Set-Cookie', `${sessionCookie}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return reply.code(204).send();
  });
  app.get('/admin/api/channels', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    try { return await listCompanies(db); } catch { return reject(reply, 503); }
  });
  const channelForConnection = async (instance: string, session: string) => {
    const result = await db.query<{ id: string }>(
      'SELECT id FROM channels WHERE instance = $1 AND session = $2', [instance, session]);
    return result.rows.length > 0;
  };
  app.post('/admin/api/channels', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = z.object({ company: z.string().trim().min(1).max(200),
      instance: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), session: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
      .strict().safeParse(request.body);
    if (!parsed.success) return reject(reply, 400);
    if (!connections.waha || !connections.publicBaseUrl) return reject(reply, 503);
    const { company, instance, session } = parsed.data;
    const webhookToken = randomBytes(32).toString('hex');
    try {
      if (await channelForConnection(instance, session)) return reject(reply, 409);
      const existing = await connections.waha.listSessions();
      if (existing.some(item => item.name === session)) return reject(reply, 409);
      const webhookUrl = new URL(`/webhooks/waha/${instance}`, connections.publicBaseUrl).toString();
      await connections.waha.createStoppedSession(session, webhookUrl, webhookToken);
      await createCompany(db, parseCompanyOnboarding(JSON.stringify({ name: company, instance, session, webhookToken })));
      await connections.waha.startSession(session);
      return reply.code(201).send({ ok: true });
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/channel', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const mapping = mappingSchema.safeParse(request.query);
    if (!mapping.success) return reject(reply, 400);
    try {
      const result = await db.query<{
        company: string; ai_enabled: boolean; ai_model: string; ai_business_data: Record<string, unknown>;
        ai_tone: string; ai_instructions: string; automation_scope: ChannelScope; automation_test_chat_id: string | null;
      }>(`SELECT o.name AS company, o.ai_enabled, o.ai_model, o.ai_business_data, o.ai_tone, o.ai_instructions,
          c.automation_scope, c.automation_test_chat_id FROM channels c JOIN organizations o ON o.id = c.organization_id
          WHERE c.instance = $1 AND c.session = $2`, [mapping.data.instance, mapping.data.session]);
      const row = result.rows[0]; if (!row) return reject(reply, 400);
      return { company: row.company, ai: { enabled: row.ai_enabled, model: row.ai_model,
        businessData: row.ai_business_data, tone: row.ai_tone, instructions: row.ai_instructions },
        scope: row.automation_scope, testChatId: row.automation_test_chat_id };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/channel/status', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const mapping = mappingSchema.safeParse(request.query);
    if (!mapping.success || !connections.waha) return reject(reply, mapping.success ? 503 : 400);
    try {
      if (!await channelForConnection(mapping.data.instance, mapping.data.session)) return reject(reply, 404);
      return await connections.waha.sessionStatus(mapping.data.session);
    } catch { return reject(reply, 503); }
  });
  app.post('/admin/api/channel/start', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const mapping = mappingSchema.safeParse(request.body);
    if (!mapping.success || !connections.waha) return reject(reply, mapping.success ? 503 : 400);
    try {
      if (!await channelForConnection(mapping.data.instance, mapping.data.session)) return reject(reply, 404);
      await connections.waha.startSession(mapping.data.session);
      return { ok: true };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/channel/qr', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const mapping = mappingSchema.safeParse(request.query);
    if (!mapping.success || !connections.waha) return reject(reply, mapping.success ? 503 : 400);
    try {
      if (!await channelForConnection(mapping.data.instance, mapping.data.session)) return reject(reply, 404);
      const status = await connections.waha.sessionStatus(mapping.data.session);
      if (status.status !== 'SCAN_QR_CODE') return reject(reply, 409);
      return reply.type('image/png').send(Buffer.from(await connections.waha.qrPng(mapping.data.session)));
    } catch { return reject(reply, 503); }
  });
  app.put('/admin/api/channel/ai', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const body = z.object({ instance: mappingSchema.shape.instance, session: mappingSchema.shape.session,
      enabled: z.boolean(), model: z.string(), businessData: z.record(z.string(), z.unknown()),
      tone: z.string(), instructions: z.string() }).strict().safeParse(request.body);
    if (!body.success) return reject(reply, 400);
    let config: CompanyAIConfig;
    try { config = parseCompanyAIConfig(JSON.stringify({ enabled: body.data.enabled, model: body.data.model,
      businessData: body.data.businessData, tone: body.data.tone, instructions: body.data.instructions })); }
    catch { return reject(reply, 400); }
    try { await configureCompanyAI(db, body.data.instance, body.data.session, config); return { ok: true }; }
    catch { return reject(reply, 400); }
  });
  app.put('/admin/api/channel/scope', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.scope === 'all' && parsed.data.confirmAll !== true)
      || (parsed.data.scope !== 'all' && parsed.data.confirmAll)
      || (parsed.success && parsed.data.scope === 'test' && !directChat(parsed.data.testChatId ?? ''))
      || (parsed.success && parsed.data.scope !== 'test' && parsed.data.testChatId !== undefined)) return reject(reply, 400);
    try {
      if (parsed.data.scope !== 'disabled') {
        if (!connections.waha) return reject(reply, 503);
        const session = await connections.waha.sessionStatus(parsed.data.session);
        if (session.status !== 'WORKING' || !session.account) return reject(reply, 409);
      }
      await setChannelScope(db, parsed.data.instance, parsed.data.session, parsed.data.scope, parsed.data.testChatId);
      return { ok: true };
    } catch { return reject(reply, 400); }
  });
}
