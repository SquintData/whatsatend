# WhatsAtend

Plataforma interna para atendimento de várias empresas no WhatsApp.
Node.js 22+, TypeScript, Fastify, PostgreSQL e WAHA/GOWS.

## Estado atual

- Webhook autenticado por canal; histórico e deduplicação por empresa/sessão.
- Conversas individuais; identificação GOWS por `_data.Info.Chat`, inclusive quando `to` é null.
- Resposta fixa de teste com fila persistente no PostgreSQL.
- Envio desativado por padrão; limitado a uma instância, sessão e identificador de contato.
- Conversas começam em `monitoring`. Retomada explícita muda para `auto`.
- Resposta manual muda para `human` e cancela os envios pendentes da conversa.
- IDs retornados pela API identificam respostas próprias, que não ativam modo humano.
- Sem IA, painel administrativo, campanhas ou envio de mídia nesta etapa.

A resposta fixa é: “Olá! Recebemos sua mensagem. Este é um teste do atendimento automático.”
Não ativar esta versão para clientes: o envio foi limitado ao piloto autorizado.

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

## Atualização da instalação existente

A migração `002_fixed_reply.sql` adiciona modo `auto`, geração de automação e fila.
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
AUTO_REPLY_INSTANCE=principal
AUTO_REPLY_SESSION=teste
TEST_CHAT_ID=ID_EXATO_DO_CONTATO_DE_TESTE
WAHA_BASE_URL=http://atendimento-waha:3000
WAHA_API_KEY=CHAVE_EXISTENTE_DA_WAHA
```

O endereço acima é a raiz da WAHA, **sem `/api` ou `/dashboard`**. Se o hostname
interno não resolver, conferir aliases no Easypanel; nunca abrir portas para resolver
comunicação interna. Chave inválida não deve ser impressa para diagnosticar erros.

Implantar e, pelo console do backend ou Termius, executar:

```bash
docker exec "$(docker ps -q --filter label=com.docker.swarm.service.name=atendimento_backend | head -n 1)" node dist/control.js resume
```

O comando é restrito ao canal/contato definidos nas variáveis, exige conversa
existente e canal/empresa ativos. Não existe endpoint público de administração.

Só **novas mensagens de texto**, posteriores à retomada, com timestamp recente
(até 120 segundos; tolerância de 30 segundos para relógio à frente) podem gerar
resposta. Mensagens antigas já registradas não são respondidas retroativamente.
Uma tarefa por mensagem, no máximo uma pendente por conversa e intervalo mínimo
de 5 segundos após o último envio; mensagens extras desse intervalo ficam no
histórico, sem resposta fixa adicional. Não testar enviando uma rajada.

Para pausar:

```bash
docker exec "$(docker ps -q --filter label=com.docker.swarm.service.name=atendimento_backend | head -n 1)" node dist/control.js pause
```

Ou responder pelo celular. Depois dessa intervenção, rodar `resume` explicitamente
para voltar a `auto`; isso invalida a fila antiga e não a reenvia.
Para desligamento global, definir `AUTO_REPLY_ENABLED=false` e reimplantar.
Uma requisição já enviada à WAHA não pode ser recolhida por uma pausa posterior.

## Verificação do piloto

1. Contato de teste envia mensagem nova: recebe uma resposta fixa.
2. Eco da própria resposta: conversa continua em `auto`, sem loop.
3. Funcionário responde pelo celular: conversa fica em `human`.
4. Nova mensagem enquanto `human`: fica no histórico, sem resposta automática.
5. Retomada explícita + mensagem nova: responde novamente.
6. Outros contatos/empresas e grupos: não recebem resposta fixa.
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

O webhook da sessão deve incluir `message.any` e `message.reaction`. Uma reação
`🤖` com `fromMe=true` e `source=app` retoma somente a conversa explicitamente
configurada em `TEST_CHAT_ID`, quando a mensagem reagida é uma entrada já gravada
nesse canal. Reações de clientes, via API, a mensagens enviadas, em outros contatos
ou com outro emoji não liberam o atendimento. O comando ainda depende de
`AUTO_REPLY_ENABLED=true`; o piloto continua usando resposta fixa, sem modelo de IA.

O comando persiste no PostgreSQL, não responde ao histórico e não reinicia uma
conversa que já está automática. Depois da reação, envie uma nova mensagem no
segundo seguinte ou depois. Timestamps têm resolução de segundos: reações no mesmo
segundo de uma pausa são ignoradas; remova e refaça a reação depois. Eventos com
mais de 120 segundos ou mais de 30 segundos no futuro não retomam. Duplicatas e
comandos anteriores a uma nova pausa não liberam a conversa novamente.

Atualização no Easypanel: execute `node dist/migrate.js` antes de `node dist/server.js`
para aplicar `003_reaction_resume.sql`, sem repetir o provisionamento. O servidor
recusa iniciar com o esquema incompleto. Os logs `WAHA reaction processed` mostram
o resultado, `fromMe` e `source`, sem conteúdo de mensagens ou tokens.

Validação na VPS em 08/10/2026: o usuário confirmou que a reação 🤖 da conta da
empresa retoma, a reação do cliente não retoma, a próxima mensagem recebe uma
resposta e uma nova mensagem do funcionário pausa a automação. Os logs também
registraram `result=resumed`, `fromMe=true` e `source=app`. Isso não comprova
concorrência em PostgreSQL real nem recuperação após reinício integral da VPS.
