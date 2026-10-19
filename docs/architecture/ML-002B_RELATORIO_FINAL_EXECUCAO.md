# BD_API_ZEISS — Relatório Consolidado de Execução: Fase ML-002B
## Isolamento Operacional Multi-Loja no PostgreSQL

**Data de Execução:** 19 de Outubro de 2026  
**Status:** CONCLUÍDO E VALIDADO COM SUCESSO  
**Projeto:** `C:\Antigravity\BD_API_ZEISS`  
**Supabase Canônico:** `BD_API_ZEISS` (ref: `bklpztydqllqevekgins`)  
**Loja Continental:** `store_id = 3cdde1d2-4461-475f-8faf-418bbb3790fd`  
**Autor:** Antigravity Architect Agent  

---

## 1. MIGRATIONS APLICADAS

As seguintes migrations foram versionadas no repositório local e executadas com sucesso no PostgreSQL do Supabase canônico:

| Ordem | Arquivo de Migration Local | Objeto / Finalidade | Status no Supabase |
|---|---|---|---|
| **01** | [`supabase/migrations/20261020110000_zeiss_add_store_id_operational.sql`](file:///C:/Antigravity/BD_API_ZEISS/supabase/migrations/20261020110000_zeiss_add_store_id_operational.sql) | Adição da coluna `store_id UUID NULL REFERENCES core.stores(id)` e índices em 7 tabelas operacionais da ZEISS (`orders`, `order_details`, `tracking_events`, `fiscal_documents`, `receivables`, `leads`, `vouchers`). | **APLICADA COM SUCESSO** |
| **02** | [`supabase/migrations/20261020110001_zeiss_store_campaigns.sql`](file:///C:/Antigravity/BD_API_ZEISS/supabase/migrations/20261020110001_zeiss_store_campaigns.sql) | Criação da tabela `zeiss.store_campaigns` para isolamento de adesão/aceite de campanhas por loja, preservando o catálogo mestre em `zeiss.campaigns`. | **APLICADA COM SUCESSO** |
| **03** | [`supabase/migrations/20261020110002_integration_store_sync_controls.sql`](file:///C:/Antigravity/BD_API_ZEISS/supabase/migrations/20261020110002_integration_store_sync_controls.sql) | Criação das tabelas especializadas multi-loja de controle de sincronização (`integration.store_sync_state`, `store_sync_policies`, `store_sync_leases`, `store_provider_health`), mantendo 100% de compatibilidade com o worker atual. | **APLICADA COM SUCESSO** |

---

## 2. ESTRUTURAS CRIADAS OU EVOLUÍDAS

### 2.1 Coluna `store_id` nas Tabelas Operacionais
- `zeiss.orders`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_orders_store_id`.
- `zeiss.order_details`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_order_details_store_id`.
- `zeiss.tracking_events`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_tracking_events_store_id`.
- `zeiss.fiscal_documents`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_fiscal_documents_store_id`.
- `zeiss.receivables`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_receivables_store_id`.
- `zeiss.leads`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_leads_store_id`.
- `zeiss.vouchers`: adicionada `store_id UUID NULL REFERENCES core.stores(id)` e índice `idx_zeiss_vouchers_store_id`.
- **Catálogos Preservados**: `zeiss.products` e `zeiss.product_services` permaneceram sem `store_id`, preservando o portfólio universal do fabricante.

### 2.2 Tabela `zeiss.store_campaigns`
- PK: `PRIMARY KEY (store_id, campaign_id)`
- FKs: `store_id REFERENCES core.stores(id) ON DELETE RESTRICT`, `campaign_id REFERENCES zeiss.campaigns(campaign_id) ON DELETE RESTRICT`
- Colunas: `aceite BOOLEAN DEFAULT false`, `status VARCHAR(50)`, `incentive_type VARCHAR(100)`, `synced_at`, `created_at`, `updated_at`.
- RLS: Habilitada com políticas para `bd_api_zeiss_worker` e `service_role`.

### 2.3 Tabelas de Controle Multi-Loja (`integration.store_sync_*`)
- `integration.store_sync_state`: PK `(store_id, provider, domain, operation)`
- `integration.store_sync_policies`: PK `(store_id, provider, domain, operation)`
- `integration.store_sync_leases`: PK `(store_id, provider, domain, operation)`
- `integration.store_provider_health`: PK `(store_id, provider, domain, operation)`
- RLS: Habilitada em todas as 4 tabelas com 8 políticas ativas.

---

## 3. EVIDÊNCIAS DE PRESERVAÇÃO DE DADOS

O snapshot comparativo executado antes e após as migrations comprova variação zero nas tabelas existentes:

| Tabela | Contagem Pré-Migração | Contagem Pós-Migração | Variação |
|---|---|---|---|
| `zeiss.orders` | **7.180** | **7.180** | **0 (Inalterado)** |
| `zeiss.order_details` | **6.748** | **6.748** | **0 (Inalterado)** |
| `zeiss.tracking_events` | **23.156** | **23.156** | **0 (Inalterado)** |
| `zeiss.fiscal_documents` | **6.701** | **6.701** | **0 (Inalterado)** |
| `zeiss.receivables` | **191** | **191** | **0 (Inalterado)** |
| `zeiss.campaigns` | **13** | **13** | **0 (Inalterado)** |
| `zeiss.products` | **986** | **986** | **0 (Inalterado)** |
| `zeiss.leads` | **0** | **0** | **0 (Inalterado)** |
| `zeiss.vouchers` | **0** | **0** | **0 (Inalterado)** |
| `integration.sync_state` | **5** | **5** | **0 (Inalterado)** |
| `integration.sync_policies` | **7** | **7** | **0 (Inalterado)** |
| `integration.sync_leases` | **0** | **0** | **0 (Inalterado)** |
| `integration.provider_health` | **5** | **5** | **0 (Inalterado)** |
| `core.organizations` | **1** | **1** | **0 (Inalterado)** |
| `core.stores` | **1** | **1** | **0 (Inalterado)** |
| `core.integration_credentials` | **1** | **1** | **0 (Inalterado)** |
| `core.store_zeiss_identities` | **1** | **1** | **0 (Inalterado)** |

### Evidência de Não-Atribuição de Dados Históricos
A query de auditoria executada em `zeiss.orders` comprovou:
- Total de pedidos: `7.180`
- Pedidos com `store_id` preenchido: `0`
- Pedidos com `store_id NULL`: `7.180` (**100% dos dados históricos preservados sem atribuição à Continental**).

---

## 4. TESTES EXECUTADOS E RESULTADOS

| Teste | Objetivo | Resultado | Status |
|---|---|---|---|
| **T01 — Snapshot de Contagens** | Comparar volumetria antes e depois das migrations. | Todas as contagens idênticas. Zero perda de dados. | **APROVADO** |
| **T02 — Auditoria de NULLs Históricos** | Comprovar que `store_id IS NULL` em todas as 7.180 linhas. | 100% das linhas preservadas com `NULL`. | **APROVADO** |
| **T03 — Integridade das FKs** | Inspecionar catálogo de foreign keys apontando para `core.stores(id)`. | 14 constraints de FK ativas no catálogo. | **APROVADO** |
| **T04 — Chaves Primárias Compostas** | Comprovar PK `(store_id, ...)` em `store_campaigns` e `store_sync_*`. | Catálogo confirma `PRIMARY KEY (store_id, ...)`. | **APROVADO** |
| **T05 — RLS e Grants** | Verificar `rowsecurity` e permissões de roles. | Todas as 5 tabelas com RLS e 10 políticas ativas. Zero acesso para `anon`. | **APROVADO** |
| **T06 — Compatibilidade do Worker** | Confirmar integridade das tabelas legadas `integration.sync_*`. | Tabelas legadas intactas com suas chaves e cursores originais. | **APROVADO** |
| **T07 — Preservação de Código** | Confirmar integridade dos arquivos TypeScript em `src/`. | Zero alterações em arquivos TypeScript. | **APROVADO** |

---

## 5. COMPATIBILIDADE OPERACIONAL

A estratégia de evolução aditiva garantiu que:
1. **O worker atualmente em produção continuará operando normalmente**, pois as queries em `zeiss.orders` utilizam `ON CONFLICT (order_number)` (constraint que foi rigorosamente preservada).
2. As tabelas `integration.sync_*` continuam servindo o agendador existente sem alteração de schema.
3. A nova estrutura multi-loja (`store_sync_*` e `store_campaigns`) está implantada e pronta para ser ativada na fase **ML-002C**, sem que tenha havido qualquer momento de indisponibilidade ou conflito.

---

## 6. PENDÊNCIAS REAIS

1. **Adaptação do Código (Runtime)**:
   - Os providers em `src/providers/*` continuam consumindo o singleton estático `zeissConfig`.
   - O `Scheduler.ts` e o `worker.ts` continuam lendo de `integration.sync_policies` e `integration.sync_state`.
2. **Reconciliação e Atribuição dos Pedidos Históricos**:
   - Os 7.180 pedidos históricos permanecem com `store_id = NULL`. Sua atribuição formal à Continental (ou quarentena) dependerá de aprovação e execução na fase **ML-002D**.

---

## 7. PLANO OBJETIVO PARA ADAPTAR O RUNTIME NA PRÓXIMA FASE (ML-002C)

Com o schema operacional pronto, a fase **ML-002C (Refatoração da Engine & Adaptação do Runtime)** executará os seguintes passos em código TypeScript:

1. **Criação do `StoreZeissContext` e `SecretResolverService`**:
   - Serviço que lê `core.stores` e `core.store_zeiss_identities` e resolve credenciais (suportando `env_ref` inicial e `encrypted`).
2. **Refatoração dos Providers (`src/providers/*`)**:
   - Tornar os providers parametrizáveis para receber o contexto da loja (`cnpj`, `saowebCode`, `zeissStoreCode`, `countryId`, `apiKey`).
3. **Refatoração dos Repositórios (`src/repositories/postgres/*`)**:
   - Atualizar queries de `OrdersRepository`, `TrackingRepository`, etc., para persistir e filtrar pelo `store_id` da loja em execução.
   - Atualizar `CampaignsRepository` para persistir adesão em `zeiss.store_campaigns`.
   - Atualizar `SyncStateRepository`, `SyncPolicyRepository`, `SyncLeaseRepository` para operar sob as tabelas multi-loja `integration.store_sync_*`.
4. **Refatoração do Scheduler e Worker (`src/worker.ts`, `src/engine/Scheduler.ts`)**:
   - `Scheduler.tick()` itera sobre todas as lojas ativas em `core.stores`, executando políticas e adquirindo leases por `(store_id, provider, domain, operation)`.
5. **Atualização do CLI Administrativo (`src/cli/run-job.ts`)**:
   - Adição do argumento obrigatório `--store <store_code | store_id>`.

---

*Fim do Relatório Consolidado ML-002B.*
