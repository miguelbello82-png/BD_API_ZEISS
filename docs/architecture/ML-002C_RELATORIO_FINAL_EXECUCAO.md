# BD_API_ZEISS — ML-002C: Relatório Final de Execução

**Fase:** ML-002C — Implementação do Runtime Multi-Loja  
**Data:** 19/10/2026  
**Status:** Concluído com Sucesso e 100% Validado  
**Projeto Supabase Canônico:** `BD_API_ZEISS` (ref: `bklpztydqllqevekgins`)  
**Workspace:** `C:\Antigravity\BD_API_ZEISS`  

---

## 1. Sumário Executivo

A fase **ML-002C** implementou a adaptação completa e modular do runtime do `BD_API_ZEISS`, permitindo a execução de operações ZEISS isoladas por loja. 

Toda a infraestrutura desenvolvida nas fases ML-002A e ML-002B foi integrada ao código em TypeScript:
- Resolução dinâmica de lojas e identidades a partir das tabelas `core.*`.
- Resolução desacoplada de credenciais com zero exposição de segredos.
- Parametrização dos providers ZEISS a partir do contexto da loja.
- Isolamento estrito de dados operacionais e controles de sincronização por `store_id`.
- Orquestrador e Scheduler dinâmicos capazes de descobrir e executar lojas ativas de forma não bloqueante.
- CLI administrativo adaptado com suporte a `--store` e códigos de saída canônicos.
- Mecanismo explícito e reversível de seleção do runtime (`RUNTIME_MODE`).

---

## 2. Arquivos Implementados e Modificados

### 2.1 Novos Contratos e Serviços de Domínio
- `src/contracts/store.ts`: Definição de `StoreZeissContext`, `StoreStatus` e classes de erro (`StoreNotFoundError`, `StoreSuspendedError`, `OrganizationMismatchError`, `CredentialResolutionError`).
- `src/core/CredentialResolver.ts`: Interface `ICredentialResolver` e implementação `EnvRefCredentialResolver` para resolução segura de segredos.
- `src/core/StoreResolutionService.ts`: Serviço `PgStoreResolutionService` com consultas unificadas às tabelas `core.*` e validação de fronteiras organizacionais.

### 2.2 Repositórios Multi-Loja
- `src/repositories/postgres/StoreSyncStateRepository.ts`: Persistência de cursores em `integration.store_sync_state`.
- `src/repositories/postgres/StoreSyncPolicyRepository.ts`: Leitura de políticas por loja em `integration.store_sync_policies`.
- `src/repositories/postgres/StoreSyncLeaseRepository.ts`: Controle atômico de leases por loja em `integration.store_sync_leases`.
- `src/repositories/postgres/StoreProviderHealthRepository.ts`: Registro de saúde por loja em `integration.store_provider_health`.

### 2.3 Repositórios Operacionais Adaptados
- `src/repositories/postgres/OrdersRepository.ts`: Upsert com `store_id` e filtragem obrigatória por loja em `findOrdersWithoutDetail` e `findActiveOrders`.
- `src/repositories/postgres/OrderDetailsRepository.ts`: Propagação de `store_id` para `zeiss.order_details` e `zeiss.fiscal_documents`.
- `src/repositories/postgres/TrackingRepository.ts`: Persistência e busca de eventos de tracking filtrados por `store_id`.
- `src/repositories/postgres/CampaignsRepository.ts`: Persistência do catálogo global em `zeiss.campaigns` e adesão por unidade em `zeiss.store_campaigns`.
- `src/repositories/postgres/LeadsRepository.ts`: Upsert de leads e leads resgatados com `store_id`.
- `src/repositories/postgres/ReceivablesRepository.ts`: Upsert de recebíveis e boletos com `store_id`.

### 2.4 Providers e Clientes Adaptados
- `src/config/client.ts`: Suporte a `apiKey` dinâmica por requisição.
- `src/providers/orders.ts`: Uso dos identificadores `cnpj`, `countryId`, `saowebCode` e `apiKey` da loja.
- `src/providers/vouchers.ts`: Uso de `zeissStoreCode`, `countryId`, `voucherUserId` e `apiKey`.
- `src/providers/financial.ts`: Uso de `zeissStoreCode`, `countryId`, `finUserId` e `apiKey`.
- `src/providers/products.ts`: Uso de `countryId`, `cnpj` e `apiKey`.

### 2.5 Engine, Scheduler e CLI
- `src/engine/StoreCompositionRoot.ts`: Construtor de `CompositionRoot` escopado por loja.
- `src/engine/MultiStoreOrchestrator.ts`: Orquestrador com descoberta dinâmica e isolamento de falhas entre lojas.
- `src/worker.ts`: Suporte reversível entre `RUNTIME_MODE=legacy` e `RUNTIME_MODE=multi_store`.
- `src/cli/run-job.ts`: Suporte a `--store <code|uuid>` e `--legacy`, com tratamento rigoroso de lojas inexistentes ou suspensas.

### 2.6 Migrations Aplicadas
- `supabase/migrations/20261020120000_provision_continental_store_policies.sql`: Provisionamento das 7 políticas operacionais da Continental em `integration.store_sync_policies` com `enabled = false`.
- Permissão `GRANT USAGE ON SCHEMA core TO bd_api_zeiss_worker, service_role` aplicada e validada.

---

## 3. Evidências de Testes e Validação

### 3.1 Testes Automatizados (Jest)
Foram executadas todas as 28 suítes de teste (23 existentes + 5 novas suítes multi-loja):
- `tests/unit/core/CredentialResolver.test.ts` (5 testes): Resolução de `env_ref`, rejeição de status inativo, rejeição de variáveis ausentes/vazias, proteção de segredos.
- `tests/unit/core/StoreResolutionService.test.ts` (6 testes): Resolução por código/UUID, rejeição de loja inexistente, rejeição de suspensa, detecção de mismatch de organização, listagem de elegíveis.
- `tests/unit/repositories/postgres/StoreSyncRepositories.test.ts` (5 testes): Isolamento de estado, políticas, leases e saúde em `integration.store_sync_*`.
- `tests/unit/engine/MultiStoreOrchestrator.test.ts` (3 testes): Orquestração multi-loja, isolamento de falha entre lojas, execução avulsa por loja.
- `tests/unit/cli/run-job-multistore.test.ts` (8 testes): Flags `--store`, `--legacy`, rejeição de loja inexistente (código 4), rejeição de suspensa (código 3), bloqueio em `RUNTIME_MODE=multi_store` sem loja.

**Resultado Consolidado:**
```text
Test Suites: 28 passed, 28 total
Tests:       230 passed, 230 total
Snapshots:   0 total
Time:        8.977 s
```

### 3.2 Typecheck e Build TypeScript
```text
> bd_api_zeiss@1.0.0 typecheck
> tsc --noEmit
Exit Code: 0

> bd_api_zeiss@1.0.0 build
> tsc -p tsconfig.build.json
Exit Code: 0
```

### 3.3 Verificação com o Banco Supabase em Produção
Executado via `scratch/verify_ml002c_database.js`:
- **Preservação de Pedidos Históricos:** 7.234 pedidos verificados no banco real com `store_id IS NULL` (0 registros incorretamente atribuídos à Continental).
- **Preservação dos Controles Legados:** 5 registros em `integration.sync_state` permaneceram intactos.
- **Resolução da Continental em `core.*`:** Resolvida com sucesso (`3cdde1d2-4461-475f-8faf-418bbb3790fd`, status `ready`, CNPJ `48310092000132`, SAOWEB `33417`, ZEISS `CN043229`).
- **Políticas da Continental:** 7 políticas provisionadas em `integration.store_sync_policies` com `enabled = false`.
- **Aquisição e Liberação de Lease Multi-Loja:** Testadas com sucesso via `integration.store_sync_leases`.

### 3.4 Verificação do CLI Administrativo
- `run-job.js --store continental --provider zeiss --domain orders --operation discovery` -> Retorna `SKIPPED_DISABLED` (código 3) porque a política está desabilitada em produção.
- `run-job.js --store loja_fantasma` -> Retorna `CONFIGURATION_ERROR` (código 4).
- `run-job.js --legacy` -> Executa sob o scheduler legado, preservando a retrocompatibilidade.

---

## 4. Garantias de Segurança e Não Vazamento

1. **Isolamento de Credenciais:** As chaves de API e segredos são resolvidos em runtime por referência e nunca persistem em tabelas de auditoria ou logs.
2. **Checagem de Fronteira Organizacional:** O `PgStoreResolutionService` aborta com `OrganizationMismatchError` caso uma loja tente usar credenciais de outra organização.
3. **Isolamento de Leases:** O composite key `(store_id, provider, domain, operation)` impede que a execução de uma loja colida com o lease de outra.
4. **Isolamento de Falhas:** O `MultiStoreOrchestrator` isola exceções por loja; uma indisponibilidade na API da Loja A não afeta o processamento da Loja B.

---

## 5. Pendências Reais e Próximos Passos (Fase ML-002D)

Com a fundação (ML-002A), o isolamento de dados (ML-002B) e o runtime multi-loja (ML-002C) totalmente implantados e testados, a plataforma está pronta para a etapa final:

1. **ML-002D — Serving API e Homologação:**
   - Adaptar os endpoints públicos da Serving API para expor consultas com filtro obrigatório de loja (ex: `/api/v1/stores/{store_id}/orders`).
   - Implementar autenticação e autorização por loja para consumidores externos (impedindo que um consumidor de uma loja consulte dados de outra apenas alterando o ID na requisição).
   - Reconciliação documental dos 7.180 pedidos históricos da Continental.
   - Homologação operacional final com chaveamento do `RUNTIME_MODE=multi_store`.
