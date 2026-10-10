# WhatsAtend

Plataforma interna para atendimento de várias empresas no WhatsApp.
Node.js 22+, TypeScript, Fastify, PostgreSQL e WAHA/GOWS.

## Estado atual

- Webhook autenticado por canal; histórico e deduplicação por empresa/sessão.
- Conversas individuais; identificação GOWS por `_data.Info.Chat`, inclusive quando `to` é null.
- Resposta fixa de teste com fila persistente no PostgreSQL.
- Envio desativado por padrao; ativacao opt-in independente por canal em `disabled`, `test` ou `all`.
- Novos contatos diretos elegiveis entram em `auto` na primeira mensagem recente; conversas `human` exigem retomada explicita.
- Resposta manual muda para `human` e cancela os envios pendentes da conversa.
- IDs retornados pela API identificam respostas próprias, que não ativam modo humano.
- IA opcional por empresa; empresas sem IA mantêm a resposta fixa do piloto. Sem painel administrativo, campanhas ou envio de mídia nesta etapa.

A resposta fixa é: “Olá! Recebemos sua mensagem. Este é um teste do atendimento automático.”
Use `all` somente com autorizacao do cliente; a ativacao de cada canal e sempre explicita.

## Desenvolvimento

Use PostgreSQL exclusivo da aplicação. Gere um `WEBHOOK_TOKEN` diferente por canal
com `openssl rand -hex 32`. Não confundir com `WAHA_API_KEY`.

```bash
npm ci
cp .env.example .env
```

Edite `.env`, mantendo `AUTO_REPLY_ENABLED=false`. Os scripts não carregam esse
arquivo implicitamente; use:

```bash
node --env-file=.env --import tsx src/migrate.ts
node --env-file=.env --import tsx src/provision.ts
node --env-file=.env --import tsx src/server.ts
```

```bash
npm run check
npm test
npm run build
```

Testes usam PostgreSQL embarcado via PGlite e uma API WAHA simulada. Verificam
autenticação, isolamento, deduplicação, GOWS, fila persistente, resposta própria,
pausa humana, retomada, cancelamento, timeout e falha de gravação depois do envio.
Concorrência real e envio pelo WhatsApp devem ser validados na VPS.

## Instalação inicial no Easypanel

1. Criar PostgreSQL persistente no projeto `atendimento`, sem domínio/porta pública.
2. Criar App `backend` pelo repositório privado, com `Dockerfile` na raiz.
3. Configurar `DATABASE_URL` com conexão interna e `PORT=3000`. Nunca colocar senhas
   no GitHub, em capturas ou em logs. A senha na URL deve ser codificada para URL.
4. Para o cadastro inicial configurar `COMPANY_NAME`, `WAHA_INSTANCE=principal`,
   `WAHA_SESSION=teste` e `WEBHOOK_TOKEN` com 64 caracteres hexadecimais aleatórios.
5. Executar migração e provisionamento uma vez antes do servidor. No campo Command:

```sh
sh -c 'node dist/migrate.js && node dist/provision.js && exec node dist/server.js'
```

Após sucesso, trocar para `node dist/server.js`. O provisionamento não substitui
silenciosamente o vínculo ou segredo de uma sessão existente.

Na WAHA configurar a sessão para evento `message.any`, webhook interno
`http://atendimento-backend:3000/webhooks/waha/principal` e cabeçalho
`X-Webhook-Token` com o segredo cadastrado. Confirmar que esse hostname resolve
na rede do Easypanel; não usar hostname com underscore na URL validada pela WAHA.
Configurar reenvio de falhas de rede/5xx segundo a versão instalada.

Nenhuma porta pública ou domínio adicional é necessário para o backend ou banco.
Administração via Tailscale; WAHA exige chave de API e senha no dashboard.

## Configuração opcional da IA por empresa

A primeira integração usa a OpenAI Responses API. `OPENAI_API_KEY` fica somente
no ambiente do backend; nunca salve a chave no JSON de configuração, banco ou logs.
O modelo é configurável por empresa. As chamadas usam `store: false`, timeout de
20 segundos, histórico recente limitado e resposta estruturada `reply`/`handoff`.
Falha, falta de chave ou handoff pausam a conversa para atendimento humano, sem
enviar uma resposta inventada. Com IA desativada para a empresa, continua a resposta
fixa do piloto.

Depois de definir `OPENAI_API_KEY`, mantenha `AUTO_REPLY_ENABLED=true` somente como kill switch global;
a autorizacao efetiva e o escopo de cada canal, configurados explicitamente na secao abaixo. Execute a migracao normal:

```bash
node dist/migrate.js
```

Crie um arquivo JSON protegido fora do repositório, por exemplo:

```json
{
  "enabled": true,
  "model": "gpt-4o-mini",
  "businessData": {
    "description": "Atendimento da empresa",
    "services": ["Serviço de exemplo"],
    "faqs": [{ "question": "Qual o horário?", "answer": "Segunda a sexta, 9h-18h." }]
  },
  "tone": "Natural e cordial",
  "instructions": "Não prometa disponibilidade sem confirmação."
}
```

Configure a empresa pelo canal já provisionado, sem painel:

```bash
npm run ai:config -- principal teste /caminho/protegido/empresa.json
```

Os dados aceitos ficam limitados a 10 KB, tom a 300 caracteres e instruções a
2.000 caracteres. Uso de tokens de entrada/saída é registrado por tarefa e empresa
em `ai_usage`; a resposta e o conteúdo bruto do provedor não são gravados como log.

## Atualização da instalação existente

A migracao `002_fixed_reply.sql` adiciona modo `auto`, automacao e fila. `005_channel_automation_scope.sql` cria escopo por canal com padrao `disabled`, que exige ativacao explicita do piloto.
Não remove empresas ou histórico. O runner cria um registro de migrações e aplica
arquivos novos uma vez, dentro de transação e lock de migração.
Uma instalação antiga sem registro reaplica `001` de modo idempotente.

1. Fazer backup do PostgreSQL antes de atualizar o schema.
2. Manter `AUTO_REPLY_ENABLED=false` e implantar a branch com esta entrega.
3. Temporariamente usar o Command:

```sh
sh -c 'node dist/migrate.js && exec node dist/server.js'
```

4. Confirmar `Database migrations ready` e servidor iniciado. Restaurar Command
   `node dist/server.js`. Não executar provisionamento novamente.
5. Confirmar comunicação do backend com WAHA e a saúde do banco antes de ativar.

## Ativacao opt-in por canal

`005_channel_automation_scope.sql` adiciona escopo por canal com padrao `disabled`;
apos a migracao nenhum canal responde ate ativacao administrativa explicita.
O canal `test` aceita somente o ID direto exato; `all` aceita conversas diretas,
excluindo grupos. Configure por instance/sessao, dentro do container do backend:

```bash
node dist/channel-scope.js principal teste test ID_EXATO_DO_CONTATO
node dist/channel-scope.js principal segunda-sessao all --confirm-all
node dist/channel-scope.js principal segunda-sessao disabled
```

`all` exige a confirmacao literal `--confirm-all`. `disabled` cancela tarefas
pendentes/gerando e encerra o modo automatico ativo do canal. Conversas em `human`
nao voltam ao automatico por novas mensagens; e preciso retomada explicita ou
reacao valida no mesmo canal, sob seu escopo atual. Novos contatos diretos
compativeis iniciam no automatico na primeira mensagem recente do canal opt-in.

## Operação interna de empresas

Use a CLI local do operador depois de `npm run build`; ela requer `DATABASE_URL` e
as migrações atuais. Não há interface web: o servidor público atende webhooks, e
esta versão não inclui autenticação de operador para rotas administrativas.

Crie uma empresa e seu canal com um arquivo JSON protegido fora do repositório:

```json
{
  "name": "Empresa Exemplo",
  "instance": "principal",
  "session": "cliente-2",
  "webhookToken": "<64 caracteres hex aleatórios>",
  "ai": {
    "enabled": false,
    "model": "gpt-4o-mini",
    "businessData": { "address": "Rua Exemplo, 10", "faqs": [] },
    "tone": "Natural e cordial",
    "instructions": "Não invente informações."
  }
}
```

```bash
npm run company:admin -- list
npm run company:admin -- create /caminho/protegido/empresa.json
```

O canal nasce `disabled` e a IA desligada por padrão. `configure` atualiza os
dados de IA da empresa mapeada ao canal; `scope` opta o canal em `test` (ID direto
exato) ou `all` (conversas diretas), e `disabled` pausa com cancelamento da fila:

```bash
npm run company:admin -- configure principal cliente-2 /caminho/protegido/ia.json
npm run company:admin -- scope principal cliente-2 test 5511999999999@c.us
npm run company:admin -- scope principal cliente-2 all --confirm-all
npm run company:admin -- scope principal cliente-2 disabled
```

`all` exige a confirmação literal `--confirm-all`. Desativar encerra o modo
automático do canal sem retomar conversas `human`; a pausa humana e o kill switch
global continuam prevalecendo. Mantenha arquivos com token/dados fora do Git e
configure `OPENAI_API_KEY` somente no ambiente do backend.

## Ativação da resposta fixa

Primeiro identificar a conversa do contato de teste no PostgreSQL:

```sql
SELECT cv.chat_id, cv.mode, c.instance, c.session
FROM conversations cv JOIN channels c ON c.id = cv.channel_id
WHERE c.instance = 'principal' AND c.session = 'teste';
```

Com GOWS, o identificador pode terminar em `@lid`. Use o ID exato informado
em `Info.Chat` e confirme que corresponde ao contato autorizado, não ao número
da empresa. Não enviar o identificador ao chat de suporte se não for necessário.
Eventos novos usam `Info.Chat` consistentemente; registros antigos em forma
de telefone podem permanecer em uma conversa separada. Esta entrega não faz uma
fusão geral de contatos nem presume equivalência entre IDs distintos.

Em Ambiente do backend, sem remover `DATABASE_URL`/`PORT`:

```env
AUTO_REPLY_ENABLED=true
# AUTO_REPLY_INSTANCE, AUTO_REPLY_SESSION e TEST_CHAT_ID sao opcionais/legado; podem ficar vazios.
WAHA_BASE_URL=http://atendimento-waha:3000
WAHA_API_KEY=CHAVE_EXISTENTE_DA_WAHA
```

O endereço acima é a raiz da WAHA, **sem `/api` ou `/dashboard`**. Se o hostname
interno não resolver, conferir aliases no Easypanel; nunca abrir portas para resolver
comunicação interna. Chave inválida não deve ser impressa para diagnosticar erros.

Ative cada canal com `node dist/channel-scope.js` conforme acima. `AUTO_REPLY_INSTANCE`, `AUTO_REPLY_SESSION` e `TEST_CHAT_ID` sao opcionais e legados; podem ser omitidos ou vazios com `AUTO_REPLY_ENABLED=true`. Novos contatos diretos elegiveis entram em auto na primeira mensagem recente apos ativacao. Conversas em `human` nao retomam por novas mensagens; retome explicitamente, por exemplo com reacao `🤖` valida no proprio canal.

So mensagens com timestamp posterior a ativacao do canal ou a retomada explicita, e recente (ate 120 segundos; tolerancia de 30 segundos para relogio a frente), podem gerar resposta. Mensagens anteriores nao sao respondidas retroativamente.
Uma tarefa por mensagem, no máximo uma pendente por conversa e intervalo mínimo
de 5 segundos após o último envio; mensagens extras desse intervalo ficam no
histórico, sem resposta fixa adicional. Não testar enviando uma rajada.

Para pausar:

```bash
docker exec "$(docker ps -q --filter label=com.docker.swarm.service.name=atendimento_backend | head -n 1)" node dist/channel-scope.js principal teste disabled
```

Ou responder pelo celular. Isso muda o modo para `human`; mensagens novas nao retomam automaticamente.
Para retomar, use uma reacao `🤖` valida no proprio canal ou a ferramenta administrativa autorizada.
Para desligamento global, definir `AUTO_REPLY_ENABLED=false` e reimplantar.
Uma requisição já enviada à WAHA não pode ser recolhida por uma pausa posterior.

## Verificação do piloto

1. Contato direto elegivel envia mensagem recente apos opt-in; recebe resposta fixa ou da IA da empresa.
2. Eco da própria resposta: conversa continua em `auto`, sem loop.
3. Funcionário responde pelo celular: conversa fica em `human`.
4. Nova mensagem enquanto `human`: fica no histórico, sem resposta automática.
5. Retomada explícita + mensagem nova: responde novamente.
6. Canais `disabled` e grupos nunca recebem resposta; outros canais respondem somente apos opt-in.
7. Reinício: histórico e tarefas persistem, sem repetir envios já tentados.

```sql
SELECT c.session, m.direction, cv.mode, m.received_at
FROM messages m JOIN channels c ON c.id = m.channel_id
JOIN conversations cv ON cv.id = m.conversation_id
ORDER BY m.received_at DESC LIMIT 10;

SELECT state, created_at, claimed_at, completed_at
FROM reply_jobs ORDER BY created_at DESC LIMIT 10;
```

## Falhas e limites

Não há garantia de envio exatamente uma vez pelo WhatsApp. A API pode enviar e
falhar antes de devolver o ID. Por isso, após tentativa de rede, não há reenvio
automático: timeout/resposta ambígua vira `uncertain`, erro de credencial vira
`failed` e a conversa é pausada. Conferir o WhatsApp antes de retomar. Um novo
`resume` permite só novas mensagens; nunca reenfileira o envio incerto anterior.

A tarefa é marcada `sending` em uma transação curta antes da rede. Se o processo
cair ou a gravação final falhar, ela não volta a `pending`; após 60 segundos é
marcada `uncertain` e pausa a conversa se ela ainda estiver na mesma geração.
Isso pode perder uma resposta, mas evita repetir um envio
cujo resultado não conhecemos. A fila bloqueia novas tarefas da mesma geração
enquanto houver resultado incerto.

O envio mantém locks na ordem canal/conversa/tarefa por até o timeout da API
(10 segundos), serializando o eco que pode chegar antes do ID da resposta.
Isso pode atrasar o processamento de webhooks desse canal. Testar esse comportamento
com a WAHA instalada; não afirmar capacidade de produção com base nos testes locais.
Intervenção humana recebida antes do envio cancela a tarefa. Um envio já iniciado
pode chegar mesmo se o funcionário responder nesse intervalo.

Separar usuário de migração e de aplicação antes de produção; reduzir privilégios,
definir retenção de mensagens, backups fora da VPS e testar restauração.
Isolamento por autenticação de canal e FKs compostas; não há RLS nem acesso de clientes
ao banco nesta fase. O dono do banco continua tendo acesso amplo.
Manter versões/digests de WAHA fixados na operação comercial. Nunca registrar
mensagens brutas, dados `_data`, chaves ou respostas de erro completas nos logs.
# Retomada por reação no piloto

Uma reacao `🤖` com `fromMe=true` e `source=app` retoma somente conversa elegivel do proprio canal autenticado e dentro do escopo atual (`test` exato ou `all` direto).
Reacoes de clientes, via API, a mensagens enviadas, fora do escopo ou com outro emoji nao retomam. O kill switch global `AUTO_REPLY_ENABLED` precisa estar ativo.
Empresas com IA desativada continuam usando a resposta fixa do piloto; para empresas com IA ativada, a proxima mensagem usa sua configuracao.

O comando persiste no PostgreSQL, não responde ao histórico e não reinicia uma
conversa que já está automática. Depois da reação, envie uma nova mensagem no
segundo seguinte ou depois. Timestamps têm resolução de segundos: reações no mesmo
segundo de uma pausa são ignoradas; remova e refaça a reação depois. Eventos com
mais de 120 segundos ou mais de 30 segundos no futuro não retomam. Duplicatas e
comandos anteriores a uma nova pausa não liberam a conversa novamente.

Atualização no Easypanel: execute `node dist/migrate.js` antes de `node dist/server.js`
para aplicar as migrações pendentes, incluindo `004_company_ai.sql` e `005_channel_automation_scope.sql`; todos os canais ficam disabled ate ativacao explicita, sem repetir o provisionamento. O servidor
recusa iniciar com o esquema incompleto. Os logs `WAHA reaction processed` mostram
o resultado, `fromMe` e `source`, sem conteúdo de mensagens ou tokens.

Validação na VPS em 08/10/2026: o usuário confirmou que a reação 🤖 da conta da
empresa retoma, a reação do cliente não retoma, a próxima mensagem recebe uma
resposta e uma nova mensagem do funcionário pausa a automação. Os logs também
registraram `result=resumed`, `fromMe=true` e `source=app`. Isso não comprova
concorrência em PostgreSQL real nem recuperação após reinício integral da VPS.
