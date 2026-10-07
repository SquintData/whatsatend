# WhatsAtend

Plataforma interna para operar atendimento de várias empresas no WhatsApp.
Base em Node.js/TypeScript, Fastify, PostgreSQL e WAHA/GOWS.

## Esta entrega

- API com verificações de saúde e webhook autenticado por canal.
- Cadastro inicial de empresa e vínculo com instância/sessão da WAHA via comando.
- Mensagens de conversas individuais armazenadas por empresa.
- Deduplicação por canal e ID da mensagem; operações transacionais.
- Eventos enviados (`fromMe`) colocam a conversa em modo humano.
- Dockerfile para Easypanel, usuário sem privilégios e nenhuma credencial no código.

**Esta versão apenas recebe e registra mensagens. Não envia respostas, não chama IA
e não tem painel administrativo.** Não conectar números de clientes ainda.
Antes de habilitar envio, correlacionar respostas do backend com seus IDs na WAHA:
`fromMe` também aparece nas mensagens enviadas pela API, não apenas pelo funcionário.

## Desenvolvimento

Requer Node.js 22+ e PostgreSQL. Use um banco exclusivo da aplicação.

```bash
npm ci
cp .env.example .env
```

Edite `.env` com valores locais. Os comandos não carregam esse arquivo implicitamente:

```bash
node --env-file=.env --import tsx src/migrate.ts
node --env-file=.env --import tsx src/provision.ts
node --env-file=.env --import tsx src/server.ts
```

Gere `WEBHOOK_TOKEN` com `openssl rand -hex 32`. É um segredo novo por canal,
diferente de `WAHA_API_KEY`, da senha do dashboard e da senha do banco.
`WAHA_INSTANCE=principal` identifica nossa instalação da WAHA; `WAHA_SESSION=teste`
deve corresponder exatamente ao nome cadastrado no dashboard.
O comando provision é repetível para a mesma sessão e token e recusa substituir
silenciosamente um vínculo existente. O token é guardado no banco apenas como SHA-256.

```bash
npm run check
npm test
npm run build
```

Os testes usam PostgreSQL embarcado via PGlite, sem credenciais ou rede.
Validam autenticação, isolamento entre empresas, deduplicação, modo humano,
entrada inválida e rollback. A integração real com WAHA será testada na VPS.

## Easypanel

1. Criar serviço PostgreSQL no projeto `atendimento`, sem porta pública nem domínio.
   Usar senha aleatória, volume persistente e backups fora da VPS.
2. Criar App `backend` ligado ao repositório privado, selecionando a branch que contém
   esta entrega. Build pelo `Dockerfile` na raiz; não usar buildpack.
3. Em Ambiente, configurar `DATABASE_URL` com a conexão **interna** fornecida pelo
   Easypanel e `PORT=3000`. Não reutilizar o banco da WAHA ou do Easypanel.
   Para provisionamento adicionar `COMPANY_NAME`, `WAHA_INSTANCE`, `WAHA_SESSION`
   e `WEBHOOK_TOKEN`, conforme `.env.example`.
4. Antes do primeiro início, executar uma tarefa de migração com essa mesma imagem
   e ambiente: `node dist/migrate.js`. Executar depois `node dist/provision.js`.
   Se a interface não oferecer tarefa avulsa, temporariamente trocar o comando de
   inicialização pelo comando de migração e, após sucesso confirmado nos logs,
   pelo de provisionamento. Finalmente restaurar `node dist/server.js` e implantar.
   Não executar os comandos one-shot como um serviço permanente.
5. Verificar `/health/ready`. Não publicar a porta interna 3000 no IP da VPS.
6. Para o webhook, preferir o endereço interno do backend acessível pelo contêiner
   WAHA. Usar o hostname fornecido pelo Easypanel e confirmar a comunicação entre
   serviços; não presumir que `localhost` ou o IP do Tailscale aponta para o backend.
   A rota é `/webhooks/waha/principal`.
7. Na sessão `teste` da WAHA, configurar evento **`message.any`** e cabeçalho
   `X-Webhook-Token` com o segredo desse canal. Se a interface não permitir
   cabeçalhos personalizados, conferir a configuração REST dessa versão antes
   de ativar: **não colocar o token na URL nem desabilitar a autenticação**.
8. Configurar tentativas de reenvio para falhas de rede/5xx segundo a versão WAHA.
   Responder 200 só após commit; evento repetido retorna `duplicate`.

Um domínio HTTPS do backend é opcional quando WAHA e backend se comunicam pela
rede interna. Se for publicado, usar DNS correto, caminho externo `/`, destino
HTTP porta 3000 e caminho `/`; webhook permanece autenticado.

## Validação na VPS

- Sem token: webhook deve responder 401.
- Token incorreto ou sessão de outra empresa: 401.
- Mensagem externa: registrar uma entrada `incoming`.
- Repetição do evento: nenhuma mensagem adicional.
- Resposta pelo celular: registrar `outgoing` e conversa em `human`.
- Grupos/status/canais: ignorados nesta entrega.
- Reinício do backend: histórico preservado no PostgreSQL.

Consulta de conferência pelo console SQL do banco:

```sql
SELECT o.name, c.session, m.direction, m.received_at
FROM messages m
JOIN organizations o ON o.id = m.organization_id
JOIN channels c ON c.id = m.channel_id
ORDER BY m.received_at DESC LIMIT 20;
```

## Limites e próximas entregas

Não existe garantia de entrega exatamente uma vez ao enviar ao WhatsApp: falhas
de rede podem deixar o resultado de envio indeterminado. A próxima entrega deverá
introduzir fila persistente, estado de envio, identificação das mensagens próprias,
retentativas controladas e retomada explícita após atendimento humano.
Depois entram resposta fixa em teste, IA com dados publicados da empresa e consumo.

Nesta versão a conta do banco executa migrações e queries do backend. Antes de produção,
separar o usuário de migração do usuário de aplicação, limitar privilégios,
definir retenção de mensagens e testar restauração dos backups.
Não há endpoints públicos de consulta de dados nem autenticação de operadores ainda.
O isolamento é aplicado pelo vínculo autenticado e por chaves estrangeiras compostas;
não se afirma que há RLS ou proteção contra consultas arbitrárias de um operador do banco.

Não registrar corpo de mensagens, cabeçalhos secretos ou credenciais nos logs.
Manter administração via Tailscale e firewall externo aplicado à VPS.
Depois de validar, fixar também versão/digest da WAHA; evitar atualizações automáticas
de `latest` na operação comercial.
