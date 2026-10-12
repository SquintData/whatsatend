# Painel interno WhatsAtend — direção Central de operações

## Problema e objetivo

O painel atual concentra cadastro, configuração de IA, conexão WAHA, fila, consumo e histórico numa única página longa. O operador precisa procurar controles e perde a visão das empresas que exigem ação. A nova interface deve permitir cadastrar e operar várias empresas pelo painel, com estados e próximos passos claros, preservando as regras de automação existentes.

O painel é interno para o operador do serviço gerenciado. A equipe da empresa continua usando o WhatsApp; este projeto não transforma o painel em caixa de entrada diária nem cria acesso self-service para clientes.

## Direção visual e navegação

Usar a proposta visual **A — Central de operações** escolhida pelo usuário: navegação lateral em desktop, cabeçalho compacto, superfícies claras, hierarquia tipográfica forte e estados legíveis. Em telas estreitas, a navegação se torna compacta e o conteúdo passa a uma coluna sem rolagem horizontal. Cores e ícones reforçam texto; nenhuma decisão depende apenas de cor.

Áreas principais:

1. **Visão geral:** total de canais cadastrados, canais aptos a responder (empresa/canal ativos, IA habilitada e escopo diferente de desativado), até 50 itens recentes da fila de atenção, lista de empresas/canais e acesso imediato a “Nova empresa”. Os números vêm de `/admin/api/channels` e `/admin/api/attention`; a fila não é rotulada como contagem total se houver mais itens. Não haverá contador de conexão WAHA inventado. Estado de conexão é consultado ao abrir uma empresa.
2. **Empresas:** lista pesquisável das empresas/canais, com nome, IA e escopo. Abrir uma linha mostra o espaço daquela empresa, com abas Dados e IA, WhatsApp e Automação. O cadastro fica numa tela própria com dados da empresa, tom e instruções; instância e sessão exigidas pelo backend aparecem com orientação no bloco de conexão. Após criar, o operador retorna ao espaço da empresa criada.
3. **Atenção:** reaproveita a fila existente de handoffs de IA e jobs `failed`/`uncertain`, com link para a conversa. É leitura e navegação; não cria reenvio automático.
4. **Conversas:** busca e histórico existentes, incluindo assumir/pausar, resposta manual e Retomar IA. Continua como ferramenta de inspeção e intervenção excepcional.

O consumo mensal permanece numa visão consolidada com uma linha por empresa. O endpoint atual não fornece identificador estável de organização, então a interface não associa consumo à aba de uma empresa por comparação de nomes iguais. Chamadas e tokens são exibidos como consumo medido; não são apresentados como preço monetário.

## Fluxo da empresa

O espaço de cada empresa reúne controles hoje dispersos. **Dados e IA** mostra descrição/informações da empresa, tom, instruções, modelo e habilitação da IA. A edição preserva o objeto `businessData` existente; campos desconhecidos não podem ser descartados quando o operador salva. Dados avançados podem continuar em editor JSON identificado como avançado, com validação e erro local antes do envio. **WhatsApp** mostra status WAHA, ações Iniciar/Atualizar e QR apenas durante `SCAN_QR_CODE`; QR e segredos não entram em listagens nem logs. **Automação** mostra escopo desativado/teste/todos com explicações e a confirmação explícita já exigida para “todos”.

O fluxo padrão é criar com IA e automação desativadas, preencher dados, conectar WhatsApp, testar com contato autorizado e só então ativar. A interface mostra o estado atual e o próximo passo, sem acionar ativação automaticamente.

## Implementação e dados

A mudança usa HTML/CSS/JavaScript servidos pelo Fastify existente, sem framework, dependência, migração ou nova integração. A página mantém a autenticação e os endpoints admin existentes. A interface pode dividir o template em módulos pequenos para separar estrutura, estilos e comportamento, preservando `adminPage` exportado para os testes. Navegação interna não altera URLs de API nem a associação `(instance, session)`; toda operação sensível continua validada no backend.

As chamadas de `/admin/api/channels`, `/admin/api/attention` e `/admin/api/ai-usage` abastecem as visões principais. Ao selecionar uma empresa, a página consulta `/admin/api/channel` e, na aba WhatsApp, `/admin/api/channel/status`. A tela não faz polling de todas as sessões WAHA. Erros de rede aparecem junto à seção afetada com ação de tentar novamente; erro de autenticação leva ao login. Depois de salvar, a seção refaz a consulta necessária e comunica o resultado em texto. Conteúdo vindo do backend é inserido com `textContent`/nós DOM, nunca como HTML interpolado.

## Critérios de aceite

- Operador autenticado encontra empresa, atenção e ação de cadastrar sem percorrer a página inteira.
- Cria uma empresa com IA/escopo desativados, abre seu espaço, edita dados/IA, conecta por QR e ativa o escopo com as mesmas barreiras atuais.
- Lista, histórico, pausa, resposta manual e Retomar IA continuam acessíveis e funcionais.
- Visões mostram estados vazios, carregamento e falha; dados de uma empresa não aparecem no espaço de outra.
- Layout é utilizável em desktop e telefone, com teclado, rótulos de campo, foco visível e mensagens de estado acessíveis.
- Nenhum segredo, QR, conteúdo de mensagem ou custo monetário aparece em cartões agregados.

Verificação proporcional: testes de UI para navegação, renderização segura, formulários/estados e preservação dos controles; testes de API existentes para autenticação, isolamento e mutações; `npm test`, `npm run check` e `npm run build`. Revisão visual no navegador em largura desktop e móvel. O redesenho pode ser publicado após revisão e CI; não exige alteração de banco.
