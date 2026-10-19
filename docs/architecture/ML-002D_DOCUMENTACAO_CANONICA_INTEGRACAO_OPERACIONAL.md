# BD_API_ZEISS — Documentação Canônica Oficial: Integração Operacional Multi-Loja, Bootstrap e Serving API (ML-002D)

**Código do Documento:** DOC-001  
**Fase de Referência:** ML-002D  
**Projeto:** `C:\Antigravity\BD_API_ZEISS`  
**Supabase Canônico:** `BD_API_ZEISS` (`bklpztydqllqevekgins`)  
**Data:** 19 de Outubro de 2026  
**Status:** CANÔNICO APROVADO PARA HOMOLOGAÇÃO  

---

## 1. Princípios Arquiteturais e Isolamento de Plataforma

A plataforma **BD_API_ZEISS** é um ecossistema independente de ingestão, consolidação, persistência e disponibilização de dados operacionais e comerciais provenientes das APIs da ZEISS.

```
+-------------------------------------------------------------+
|                      APIs ZEISS OFICIAIS                     |
|  (ORD-001, ORD-002, TRK-001, FIN-001, CAM-001, LEAD-001/002) |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                     BD_API_ZEISS PLATFORM                    |
|  - Scheduler Central Único (integration.sync_policies)      |
|  - Orquestrador Multi-Loja (execução segregada por loja)     |
|  - Engine de Bootstrap Histórico & Catch-up Incremental     |
|  - PostgreSQL / Supabase com Isolamento Lógico (store_id)   |
|  - Serving API com Autenticação de Consumidores (SHA-256)   |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                FUTURAS APLICAÇÕES CONSUMIDORAS               |
|      (Consumo estritamente via Serving API /api/v1/)        |
+-------------------------------------------------------------+
```

### Regras Fundamentais da Plataforma:
1. **Independência Absoluta:** O BD_API_ZEISS não depende funcionalmente, operacionalmente ou contratualmente de nenhuma aplicação consumidora anterior ou futura.
2. **Direção Arquitetural Unidirecional:** Os dados fluem de `ZEISS APIs` -> `BD_API_ZEISS` -> `Consumidores`. Consumidores não controlam rotinas de sincronização, não definem janelas temporais e não disparam schedulers.
3. **Fonte de Verdade Única:** Não existem mapas individuais de sincronização por loja. A aplicação define uma **única política global de sincronização e calendário**.

---

## 2. Mapa Global Único vs. Segregação por Loja

A diretriz da fase ML-002D estabeleceu: **"Não existe mapa de sincronização individual por loja."**

### 2.1. O que é 100% Centralizado na Plataforma:
A tabela `integration.sync_policies` é a fonte canônica exclusiva que define:
- Quais domínios e operações são sincronizados (`orders:discovery`, `tracking:sync`, `campaigns:sync`, `leads:sync`, `leads:redeemed`, `receivables:sync`, `products:sync`).
- Intervalo de execução (`interval_seconds`).
- Janelas temporais de busca e lookback (`lookback_seconds`, `maxRangeDays`).
- Timeouts e TTL de lock atômico (`timeout_seconds`, `lease_ttl_seconds`).
- Políticas de retentativa (`max_retries`, `retry_delay_seconds`).

*Nota Arquitetural sobre `integration.store_sync_policies`:* Conforme determinação do projeto, tais tabelas **não** devem ser utilizadas para criar frequências ou cronogramas divergentes por loja. O agendador lê exclusivamente o mapa central e descobre dinamicamente as lojas elegíveis.

### 2.2. O que Cada Loja Possui Individualmente:
- Identidade e credenciais contratuais ZEISS (`core.store_zeiss_identities`, `core.integration_credentials`).
- Histórico segregado de dados com `store_id` associado.
- Cursores e checkpoints de sincronização (`integration.store_sync_state`).
- Leases de exclusão mútua (`integration.store_sync_leases`).
- Histórico de integridade e falhas do provider (`integration.store_provider_health`).
- Progresso do bootstrap histórico.

---

## 3. Ciclo de Vida da Loja e Onboarding sem Redeploy (Zero-Deploy)

A admissão de novas unidades ópticas na plataforma BD_API_ZEISS não exige modificação de código-fonte nem novo deploy do worker.

### 3.1. Máquina de Estados Operacionais (`StoreStatus`):
```
[draft] ──(validação de identificadores)──> [validating]
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          │                                           │
                    (sucesso)                                     (falha)
                          v                                           v
                       [ready]                                     [error]
                          │
                   (início bootstrap)
                          v
                    [bootstrapping]
                          │
                   (fim histórico)
                          v
                    [catching_up]
                          │
                 (sucesso incremental)
                          v
                       [active] ◄────(reativação)─────┐
                          │                           │
                     (suspensão)                  (suspensa)
                          │                           │
                          └──────────> [suspended] ───┘
```

1. **`draft`**: Loja cadastrada administrativamente no banco (`core.stores`).
2. **`validating`**: Teste de resolução dinâmica de credenciais e integridade com a ZEISS.
3. **`ready`**: Identificadores validados com sucesso; credenciais resolvidas. Pronta para bootstrap.
4. **`bootstrapping`**: Importação em lotes e fatias da carga histórica respeitando os limites da ZEISS.
5. **`catching_up`**: Execução de sincronização incremental recente para cobrir a janela entre o início do bootstrap e o momento atual.
6. **`active`**: Loja plenamente operacional, elegível para os ticks recorrentes do `CentralMultiStoreScheduler`.
7. **`suspended`**: Loja temporariamente suspensa administrativamente; ignorada pelo scheduler sem alterar o mapa global.
8. **`error`**: Loja que apresentou falha irrecuperável de credencial ou contrato; aguarda intervenção.

### 3.2. Validador Contratual Brasileiro (CNPJ Modulo 11):
O serviço `CnpjValidator` valida matematicamente o CNPJ de 14 dígitos (DVs 1 e 2 via módulo 11), rejeitando sequências nulas/repetidas antes de qualquer inserção em `core.stores`.

---

## 4. Bootstrap Histórico Obrigatório e Resumabilidade

Uma loja recém-integrada não inicia operação com dados vazios nem assume registros históricos de outra loja.

### 4.1. Regras do Bootstrap (`StoreBootstrapOrchestrator`):
1. **Respeito aos Limites da ZEISS:** A carga histórica observa os tetos reais de retenção dos serviços ZEISS (teto operacional configurável entre 90 e 180 dias). Não se declara legado inexistente sem comprovação.
2. **Fatiamento em Janelas:** O período histórico é dividido em fatias temporais (ex: 7 dias por fatia).
3. **Retomabilidade Granular:** O progresso é registrado em `integration.store_sync_state` (`domain = orders, operation = bootstrap`). Em caso de interrupção ou restart do worker, o orquestrador retoma da fatia seguinte à última concluída, sem reprocessamento redundante.
4. **Segregação de Dados:** Todo pedido (`zeiss.orders`), detalhe (`zeiss.order_details`), rastreamento (`zeiss.tracking_events`), conta a receber (`zeiss.receivables`) ou lead (`zeiss.leads`) recebe explicitamente o `store_id` da unidade.
5. **Transição Automática:** Concluídas as fatias históricas, a loja entra em `catching_up`, executa a ingestão incremental do período recente e, com o sucesso comprovado, transita automaticamente para `active`.

---

## 5. Resolução Segura de Credenciais sem Redeploy

O mecanismo de credenciais suporta rotação sem reinício de contêineres:
- **`env_ref` (Compatibilidade Continental):** Resolução pontual via variáveis de ambiente da unidade pioneira.
- **`secure_storage` (Vault / Secrets Manager / Driver Criptografado):** Armazenamento de identificadores de chave no banco e recuperação em tempo de execução via `ISecureStorageDriver`.
- **Prevenção de Vazamento:** Segredos nunca trafegam em texto plano nas tabelas relacionais de cadastro nem são emitidos em logs estruturados.

---

## 6. Serving API do BD_API_ZEISS

A camada de Serving API foi construída sobre o runtime nativo do Node.js, com zero dependências externas extras, fornecendo consumo padronizado para parceiros e futuros clientes.

### 6.1. Autenticação e Segurança do Consumidor:
- Tokens de acesso identificados pelo prefixo e validados contra hash **SHA-256** gravado em `integration.api_credentials`.
- Validação temporal de expiração (`expires_at`) e verificação de revogação imediata (`revoked_at`).
- Controle estrito de escopos (`allowed_scopes`). Ex: `orders:read`, `tracking:read`, `campaigns:read`, `vouchers:write`, `admin:historical:read`.
- **Isolamento entre Lojas:** O array `allowed_store_ids` restringe o consumidor às lojas autorizadas. Tentativas de acesso a outras lojas resultam imediatamente em **403 FORBIDDEN (STORE_ACCESS_DENIED)**.

### 6.2. Proteção do Histórico Não Conciliado:
- Os 7.234 pedidos históricos com `store_id IS NULL` permanecem totalmente inacessíveis nos endpoints de lojas (`/api/v1/stores/{store_id}/orders`).
- O acesso a esse acervo é exclusivo do endpoint administrativo segregado `/api/v1/admin/unassigned-orders`, protegido pelo escopo `admin:historical:read`.

### 6.3. Idempotência em Mutações:
- Operações mutativas (ex: `/api/v1/stores/{store_id}/vouchers/activate`) exigem o cabeçalho `Idempotency-Key`.
- O hash da requisição e o resultado são persistidos em `integration.api_operations`.
- Requisições duplicadas reproduzem a resposta armazenada com a flag `_replayed: true` sem acionar nova mutação na ZEISS.

---

## 7. Matriz de Classificação de Recursos da Plataforma

| Recurso / Endpoint | Status Operacional | Justificativa / Evidência |
|---|---|---|
| **Health Check (`GET /api/v1/health`)** | `[STATUS: OPERACIONAL]` | Testado e verificado; rota pública de diagnóstico. |
| **Listagem de Pedidos (`GET /api/v1/stores/:id/orders`)** | `[STATUS: OPERACIONAL]` | Isolado por `store_id`, paginado e validado em suíte de testes. |
| **Detalhes do Pedido (`GET /api/v1/stores/:id/orders/:nr`)** | `[STATUS: OPERACIONAL]` | Junção com `order_details` com filtro estrito de loja. |
| **Rastreamento (`GET /api/v1/stores/:id/tracking/:nf`)** | `[STATUS: OPERACIONAL]` | Eventos DRIVIN consolidados por nota fiscal e loja. |
| **Campanhas Vigentes (`GET /api/v1/stores/:id/campaigns`)** | `[STATUS: OPERACIONAL]` | Consulta de campanhas ativas para a unidade. |
| **Leads da Campanha (`GET /api/v1/stores/:id/campaigns/:id/leads`)** | `[STATUS: OPERACIONAL]` | Retorno de leads com HMAC pseudonymizado protegido. |
| **Pedidos Não Atribuídos (`GET /api/v1/admin/unassigned-orders`)** | `[STATUS: OPERACIONAL]` | Endpoint administrativo segregado para conciliação. |
| **Scheduler Central Multi-Loja** | `[STATUS: OPERACIONAL]` | Single central map, segregação de estado/leases por loja. |
| **Onboarding Zero-Deploy** | `[STATUS: OPERACIONAL]` | Serviço `StoreOnboardingService` com validação de CNPJ módulo 11. |
| **Orquestrador de Bootstrap** | `[STATUS: OPERACIONAL]` | Fatiamento, checkpoints em `store_sync_state`, retomabilidade. |
| **Ativação de Voucher (`POST .../vouchers/activate`)** | `[STATUS: IMPLEMENTADO_NAO_HOMOLOGADO]` | Idempotência e código prontos; pendente homologação comercial com a ZEISS. |
| **Geração de Voucher (`POST .../vouchers/generate`)** | `[STATUS: IMPLEMENTADO_NAO_HOMOLOGADO]` | Código pronto no provider; bloqueado por segurança comercial. |
| **Voucher On-Demand (`GET .../vouchers/:code`)** | `[STATUS: IMPLEMENTADO_NAO_HOMOLOGADO]` | Contrato VCH-001 implementado; aguarda massa de homologação. |
| **Boleto On-Demand (`GET .../financial/boletos/:id`)** | `[STATUS: IMPLEMENTADO_NAO_HOMOLOGADO]` | Contrato FIN-002 implementado; consulta transitória. |
| **DANFE/XML On-Demand (`GET .../financial/danfe/:key`)** | `[STATUS: IMPLEMENTADO_NAO_HOMOLOGADO]` | Contrato FIN-003 implementado; consulta transitória. |
| **Cadastro de Loja via API (`POST /admin/stores/onboard`)** | `[STATUS: IMPLEMENTADO_NAO_HOMOLOGADO]` | Rota pronta na API; pendente token master administrativo. |
| **Confirmação 2FA (`POST .../vouchers/2fa/confirm`)** | `[STATUS: PLANEJADO]` | Especificado no OpenAPI; previsto para fase posterior. |
| **Reenvio 2FA (`POST .../vouchers/2fa/resend`)** | `[STATUS: PLANEJADO]` | Especificado no OpenAPI; previsto para fase posterior. |
| **Venda Assistida (`POST .../sales/assisted`)** | `[STATUS: PLANEJADO]` | Especificado no OpenAPI; aguarda homologação da ZEISS. |

---

## 8. Procedimento Operacional: Migração da Continental para o Runtime Multi-Loja

Para promover a loja Continental do runtime legado para o runtime multi-loja de forma segura e sem downtime:

1. **Validação Prévia da Loja no Cadastro:**
   Verificar no Supabase que a Continental possui status `'ready'`:
   ```sql
   SELECT id, code, status, organization_id FROM core.stores WHERE code = 'continental';
   ```
2. **Execução de Bootstrap Histórico Controlado:**
   Disparar o bootstrap exclusivo da Continental via CLI/Orquestrador com lookback de segurança (ex: 90 dias):
   ```bash
   node dist/cli/run-job.js --provider zeiss --domain orders --operation bootstrap --store continental
   ```
3. **Validação de Ativação:**
   Confirmar que o status transitou de `bootstrapping` -> `catching_up` -> `active`.
4. **Verificação de Isolamento de Dados:**
   Confirmar que os 7.234 pedidos históricos legados permaneceram inalterados com `store_id IS NULL`, enquanto os novos pedidos e detalhes foram inseridos com `store_id = '3cdde1d2-4461-475f-8faf-418bbb3790fd'`.
5. **Virada de Chave:**
   Substituir a invocação legada do worker pela execução do `CentralMultiStoreScheduler`.

---

## 9. Changelog da Plataforma (Fase ML-002D)

- **feat(core):** Criado `CnpjValidator` com algoritmo de módulo 11 brasileiro oficial.
- **feat(core):** Implementado `StoreOnboardingService` com ciclo de vida completo (`draft` -> `validating` -> `ready` -> `active` / `suspended` / `error`).
- **feat(core):** Atualizado `CredentialResolver` para suporte a resolução dinâmica de segredos por referência sem redeploy.
- **feat(engine):** Implementado `CentralMultiStoreScheduler` unificando o agendador em uma única política central (`integration.sync_policies`) com execução estritamente segregada por loja.
- **feat(engine):** Criado `StoreBootstrapOrchestrator` com suporte a fatiamento histórico, checkpoints granulares em `integration.store_sync_state`, retomabilidade e catch-up incremental.
- **feat(api):** Implementada a Serving API nativa com autenticação via SHA-256, autorização por escopos, bloqueio entre lojas e isolamento do acervo não atribuído.
- **feat(api):** Suporte a idempotência com deduplicação de mutações e auditoria em `integration.api_operations`.
- **docs(api):** Especificação OpenAPI 3.1 completa (`docs/api/openapi.yaml`) com marcação rigorosa de status de maturidade.
- **test(suite):** Suíte de testes automatizados expandida para 33 suites e 263 testes unitários com 100% de aprovação.
