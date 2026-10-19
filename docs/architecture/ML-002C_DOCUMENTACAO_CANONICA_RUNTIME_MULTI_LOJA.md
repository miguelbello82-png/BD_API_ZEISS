# BD_API_ZEISS — ML-002C: Documentação Canônica do Runtime Multi-Loja

**Data:** 19/10/2026  
**Status:** Implementado e Validado  
**Escopo:** Runtime, Providers, Repositórios, Engine, Scheduler e CLI Multi-Loja  
**Projeto Supabase Canônico:** `BD_API_ZEISS` (ref: `bklpztydqllqevekgins`)  
**Workspace:** `C:\Antigravity\BD_API_ZEISS`  

---

## 1. Visão Geral da Arquitetura Implementada

A fase **ML-002C** implementou a adaptação completa do runtime da plataforma BD_API_ZEISS para execução dinâmica e isolada por loja, sem requerer duplicação de código, deploy individual por unidade ou exposição de segredos.

```
                  ┌──────────────────────────────┐
                  │      core.stores / identities │
                  │  (bklpztydqllqevekgins)       │
                  └──────────────┬───────────────┘
                                 │
                 resolveStore()  ▼
                  ┌──────────────────────────────┐
                  │    StoreResolutionService    │
                  │   + ICredentialResolver      │
                  └──────────────┬───────────────┘
                                 │ StoreZeissContext
                                 ▼
                  ┌──────────────────────────────┐
                  │  buildStoreCompositionRoot   │
                  ├──────────────────────────────┤
                  │ - Store-Scoped Providers     │
                  │ - Store-Scoped Data Repos    │
                  │ - Store-Scoped Sync Controls │
                  │ - Dedicated Store Scheduler  │
                  └──────────────┬───────────────┘
                                 │
     ┌───────────────────────────┴───────────────────────────┐
     ▼                                                       ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  MultiStoreOrchestrator      │        │  CLI (run-job --store)       │
│  (worker.ts - tick multi)    │        │  (Execução administrativa)   │
└──────────────────────────────┘        └──────────────────────────────┘
```

---

## 2. Contrato Tipado `StoreZeissContext`

O contrato `StoreZeissContext` (`src/contracts/store.ts`) formaliza a identidade operacional e técnica de uma loja:

```typescript
export type StoreStatus = 'pending' | 'ready' | 'active' | 'suspended';

export interface StoreZeissContext {
  readonly storeId: string;             // UUID interno imutável (PK em core.stores)
  readonly organizationId: string;      // UUID da organização proprietária
  readonly storeCode: string;           // Slug identificador (ex: 'continental')
  readonly orgCode: string;             // Slug da organização (ex: 'continental-group')
  readonly cnpj: string;                // CNPJ canônico de 14 dígitos numéricos
  readonly status: StoreStatus;         // Estado de ciclo de vida ('ready' | 'active' | ...)
  readonly saowebCode: string;          // Código codcli / SAOWEB da ZEISS (ex: '33417')
  readonly zeissStoreCode: string;      // Identificador de loja na ZEISS (ex: 'CN043229')
  readonly countryId: string;           // Identificador do país (ex: '1' para Brasil)
  readonly voucherUserId: string;       // User ID operacional para emissão/ativação de vouchers (ex: '42')
  readonly finUserId: string;           // User ID para emissão de boleto (ex: '0')
  readonly apiKey: string;              // Credencial ZEISS autorizada resolvida
  readonly leadsHmacSecret?: string;    // Segredo para hashing de leads (HMAC-SHA256)
  readonly ordersBaseUrl?: string;      // URL base da API de pedidos
  readonly trackingBaseUrl?: string;    // URL base da API de tracking
  readonly campaignsBaseUrl?: string;   // URL base da API de campanhas/leads/vouchers
  readonly financialBaseUrl?: string;   // URL base da API financeira
  readonly servicesBaseUrl?: string;    // URL base da API de serviços
}
```

### Exceções Específicas
- `StoreNotFoundError`: Disparada quando o código ou UUID da loja não existe nas tabelas `core`.
- `StoreSuspendedError`: Impede a execução de operações em lojas marcadas como suspensas (`status = 'suspended'`).
- `OrganizationMismatchError`: Bloqueia tentativas de associar uma loja a credenciais ou identidades pertencentes a outra organização.
- `CredentialResolutionError`: Disparada se a credencial estiver inativa, revogada ou a variável de ambiente referenciada não existir.

---

## 3. Resolução Desacoplada de Credenciais

A resolução de segredos é intermediada pela interface `ICredentialResolver` (`src/core/CredentialResolver.ts`).

### Princípios de Segurança:
1. **Zero Texto Plano no Banco:** O PostgreSQL armazena apenas referências indiretas (`storage_type = 'env_ref'`, `secret_ref = 'ZEISS_API_KEY'`).
2. **Sem Vazamento em Logs:** O segredo nunca é logado, concatenado em strings de erro ou exposto em objetos de retorno de diagnóstico.
3. **Validação de Status:** Se a credencial não possuir `status = 'active'`, a resolução falha imediatamente.
4. **Isolamento Organizacional:** A credencial precisa pertencer à mesma `organization_id` da loja solicitante.
5. **Extensibilidade:** O resolver pode ser estendido no futuro para AWS Secrets Manager, HashiCorp Vault ou Azure Key Vault sem impactar o código dos providers.

---

## 4. Adaptação dos Providers ZEISS

Todos os providers em `src/providers/` foram adaptados para receber dinamicamente o `StoreZeissContext`:

| Provider | Endpoint ZEISS | Identificadores Utilizados |
| :--- | :--- | :--- |
| **OrdersProvider** (`ORD-001`) | `/prd/pedidos/data/{cnpj}/{countryId}/...` | `cnpj`, `countryId`, `apiKey` |
| **OrdersProvider** (`ORD-002`) | `/prd/pedidos/detalhe` (POST) | `countryId`, `numpedido`, `saowebCode` (`codcli`), `apiKey` |
| **OrdersProvider** (`TRK-001`) | `/prd/pedidos/tracking/drivin/{countryId}/{saowebCode}/{nf}` | `countryId`, `saowebCode`, `apiKey` |
| **VouchersProvider** (`CAM-001`) | `/prd/campanhas/bff/list/ativas/{loja}/{countryId}` | `zeissStoreCode`, `countryId`, `apiKey` |
| **VouchersProvider** (`LEAD-001/002`) | `/prd/campanhas/leads/loja/{loja}/{campId}` | `zeissStoreCode`, `apiKey` |
| **VouchersProvider** (`VCH-003`) | `/vouchers/ativar` (POST) | `zeissStoreCode`, `voucherUserId`, `apiKey` |
| **FinancialProvider** (`FIN-001`) | `/prd/financial/receivable/{loja}/.../{countryId}` | `zeissStoreCode`, `countryId`, `apiKey` |
| **FinancialProvider** (`FIN-002`) | `/prd/financial/receivable/boletourl/.../{loja}/{finUserId}` | `zeissStoreCode`, `finUserId`, `apiKey` |
| **FinancialProvider** (`FIN-003`) | `/prd/pedidos/nf/{countryId}/{loja}/{nf}` | `countryId`, `zeissStoreCode`, `apiKey` |
| **ProductsProvider** (`PRD-001`) | `/prd/produtos/lista/{countryId}/{cnpj}` | `countryId`, `cnpj`, `apiKey` |

**Compatibilidade Mantida:** Quando instanciados sem `StoreZeissContext`, os providers mantêm fallback transparente para `zeissConfig`, garantindo retrocompatibilidade total com a suíte de testes existente.

---

## 5. Repositórios e Persistência Isolada por Loja

### 5.1 Tabelas Operacionais (`zeiss.*`)
- `PgOrdersRepository`:
  - `upsertMany`: Persiste `store_id`. No conflito `(order_number)`, utiliza `store_id = COALESCE(zeiss.orders.store_id, EXCLUDED.store_id)`.
  - `findOrdersWithoutDetail`: Filtra obrigatoriamente por `WHERE o.store_id = $1` quando operando sob contexto de loja.
  - `findActiveOrders`: Filtra obrigatoriamente por `WHERE o.store_id = $1`.
- `PgOrderDetailsRepository`:
  - Propaga `store_id` para `zeiss.order_details` e `zeiss.fiscal_documents`.
  - `exists`: Valida a existência do detalhe sob o escopo `store_id`.
- `PgTrackingRepository`:
  - Persiste `store_id` em `zeiss.tracking_events`.
  - Busca candidatos de rastreamento com filtro estrito `WHERE o.store_id = $x`.
- `PgCampaignsRepository`:
  - Persiste o catálogo global em `zeiss.campaigns`.
  - Persiste a adesão e status da unidade em `zeiss.store_campaigns (store_id, campaign_id, status, aceite, updated_at)`.
- `PgLeadsRepository` e `PgReceivablesRepository`:
  - Persistem `store_id` nos respectivos registros, impedindo atribuição cruzada.

### 5.2 Controles de Sincronização Multi-Loja (`integration.store_sync_*`)
Implementadas classes dedicadas que implementam os contratos de sincronização:
- `PgStoreSyncStateRepository` -> Tabela `integration.store_sync_state` (`PK (store_id, provider, domain, operation)`).
- `PgStoreSyncPolicyRepository` -> Tabela `integration.store_sync_policies` (`PK (store_id, provider, domain, operation)`).
- `PgStoreSyncLeaseRepository` -> Tabela `integration.store_sync_leases` (`PK (store_id, provider, domain, operation)`).
- `PgStoreProviderHealthRepository` -> Tabela `integration.store_provider_health` (`PK (store_id, provider, domain, operation)`).

---

## 6. Scheduler e MultiStoreOrchestrator

O orquestrador multi-loja (`src/engine/MultiStoreOrchestrator.ts`) realiza:
1. **Descoberta Dinâmica:** Consulta `core.stores` filtrando por `status IN ('ready', 'active')`.
2. **Resolução de Contexto:** Obtém o `StoreZeissContext` e resolve a API Key.
3. **Instanciação Isolada:** Constrói um `CompositionRoot` dedicado via `buildStoreCompositionRoot(db, storeContext)`.
4. **Isolamento de Falhas:** Se a Loja A falhar por erro de rede ou credencial, a Loja B é sincronizada normalmente sem interrupção.
5. **Controle de Concorrência:** Cada loja adquire seus próprios leases atômicos no PostgreSQL por `(store_id, provider, domain, operation)`.

---

## 7. CLI Administrativo (`run-job.ts`)

O CLI administrativo foi adaptado para execução segura e explícita:

### Exemplos de Uso:
```bash
# Execução no contexto da Continental (por código)
npm run job:run -- --provider zeiss --domain orders --operation discovery --store continental --allow-disabled

# Execução no contexto da Continental (por UUID)
npm run job:run -- --provider zeiss --domain orders --operation discovery --store 3cdde1d2-4461-475f-8faf-418bbb3790fd --allow-disabled

# Execução legada explícita (durante transição)
npm run job:run -- --provider zeiss --domain orders --operation discovery --legacy
```

### Códigos de Retorno Canônicos:
- `0`: `EXECUTED_SUCCESS`
- `1`: `EXECUTED_FAILED`
- `2`: `SKIPPED_LEASE`
- `3`: `SKIPPED_DISABLED` (inclusive para lojas suspensas ou políticas desabilitadas)
- `4`: `CONFIGURATION_ERROR` (loja não encontrada, argumentos faltantes, erro de configuração)
- `5`: `SKIPPED_NOT_DUE`

---

## 8. Transição, Compatibilidade e Procedimento de Ativação

### Mecanismo de Seleção de Runtime
O worker e CLI operam com base na variável `RUNTIME_MODE`:
- `RUNTIME_MODE=legacy` (padrão): Mantém o comportamento mono-loja utilizando `integration.sync_*` e o `zeissConfig` de ambiente.
- `RUNTIME_MODE=multi_store`: Ativa a orquestração dinâmica via `MultiStoreOrchestrator` e `integration.store_sync_*`.

### Procedimento de Ativação de Nova Loja (Zero Deploy):
1. Inserir organização em `core.organizations`.
2. Inserir referência de credencial em `core.integration_credentials`.
3. Inserir a loja em `core.stores` com `status = 'ready'`.
4. Inserir a identidade técnica em `core.store_zeiss_identities`.
5. Provisionar as políticas operacionais em `integration.store_sync_policies`.
6. Configurar o secret referenciado no ambiente/vault (`env_ref`).
7. Testar via CLI: `node dist/cli/run-job.js --provider zeiss --domain orders --operation discovery --store <slug> --allow-disabled`.
8. Habilitar as políticas desejadas na tabela `integration.store_sync_policies (enabled = true)`.
9. Alterar `core.stores.status = 'active'`. A loja passará a ser processada pelo worker dinamicamente.
