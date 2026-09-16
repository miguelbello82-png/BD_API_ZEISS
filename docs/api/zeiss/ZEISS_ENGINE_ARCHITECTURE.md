# Arquitetura do Sync Engine — BD_API_ZEISS

**Documento Vivo — BD_API_ZEISS**
**Status:** IMPLEMENTAÇÃO FUNDACIONAL COMPLETA

---

## 1. PRINCÍPIO FUNDAMENTAL

BD_API_ZEISS é uma plataforma independente dos aplicativos consumidores.

```text
ZEISS APIs
    ↓
BD_API_ZEISS (providers → engine → repositories)
    ↓
├── Suite RMG (consumidor)
├── Mais ZEISS (consumidor)
└── futuros apps (consumidores)
```

Os apps consumidores:
- NÃO chamam ZEISS diretamente.
- NÃO possuem `ZEISS_API_KEY`.
- NÃO implementam providers ZEISS.
- NÃO controlam scheduler.
- NÃO duplicam regras de sincronização.

### Regra Permanente de Fontes Canônicas de Evidência

As fontes canônicas de evidência do BD_API_ZEISS limitam-se exclusivamente a:
- Contratos e documentações oficiais da ZEISS;
- Respostas reais de APIs da ZEISS obtidas por esta plataforma;
- Evidências de banco de dados e runtime do BD_API_ZEISS;
- Especificações e implementação do BD_API_ZEISS.

Artefatos de aplicações consumidoras (como Suite RMG, Mais ZEISS, app_suite) NUNCA são fontes de evidência.
Códigos ou documentos legados de consumidores jamais devem ser consultados para preencher lacunas de evidência (evidence gaps); lacunas não comprovadas canonicamente devem ser formalmente marcadas como `UNRESOLVED`.

---

## 2. MODELO DE EXECUÇÃO: STATE-DRIVEN

O engine opera sobre o **estado real dos dados no banco**, não sobre janelas temporais fixas.

### Orders (ORD-001 + ORD-002)

```text
ORD-001 (discovery)
→ Identifica pedidos novos/incrementais
→ UPSERT em zeiss.orders

Pedido NOVO → ORD-002 imediatamente
Pedido SEM DETALHE → ORD-002 (recovery)
Pedido ATIVO/MUTÁVEL → ORD-002 no ciclo
Pedido FATURADO/LOGISTICS → sai do refresh recorrente → candidato ao Tracking
```

**Nenhuma regra depende de idade do pedido.** A população é determinada pelo classificador de lifecycle.

### Tracking (TRK-001)

```text
Pedido classificado como BILLED_LOGISTICS_READY
+ possui identificadores contratuais (nf_number)
+ tracking NÃO classificado como terminal
→ candidato para TRK-001
```

Sem identificadores → não chama provider.
Sem classificador terminal configurado → não assume encerramento.

---

## 3. MODOS DE OPERAÇÃO

### AUTO BACKGROUND
O scheduler (futuro) executa os jobs nas cadências definidas em `integration.sync_policies`.
Nenhuma cadência está hardcoded no engine.

### AGGRESSIVE POLICY
Alteração administrativa da `sync_policy` de uma operação. Não exige alteração de código.

### MANUAL REFRESH (On-Demand)
Apps solicitam "Atualizar agora" via `RefreshService`. Utiliza os **mesmos providers e repositories** do background — zero duplicação de lógica.

### ON_DEMAND
VCH-001, FIN-002 e FIN-003 operam de forma transiente via `api_runtime` futuro.

### MUTATION
VCH-002, VCH-003, VCH-2FA-001, VCH-2FA-002 e Venda Assistida permanecem fora do sync automático.

---

## 4. CLASSIFIERS

Os classificadores são abstrações que convertem status brutos da ZEISS em conceitos de plataforma:

- `IOrderClassifier`: classifica `MUTABLE`, `BILLED_LOGISTICS_READY` ou `UNKNOWN`.
- `ITrackingClassifier`: classifica `ACTIVE`, `TERMINAL` ou `NOT_CONFIGURED`.

**Implementações padrão (Unresolved):**
- `OrderClassifier`: implementado baseando-se no codsit 6.1 (BILLED_LOGISTICS_READY).
- `UnresolvedTrackingClassifier`: nada é terminal (conservador).

Nenhum status ZEISS está hardcoded. Os classificadores concretos serão configurados quando houver evidência canônica.

---

## 5. BOOTSTRAP

### Orders Bootstrap
- Aceita período parametrizado (sem limite fixo de slices).
- Cada slice: ORD-001 → UPSERT → ORD-002 para todos os encontrados.
- Retomável: progresso salvo em `sync_state` por slice.

### Tracking Bootstrap
- 2026 tem prioridade.
- Pré-2026: slicing configurável (até 10 intervalos como limite operacional do caller).
- Processa somente candidatos elegíveis com NF.

---

## 6. DEPENDENCY INJECTION

O engine depende exclusivamente de interfaces:

```text
Engine
  ├── IOrdersListProvider     (ORD-001)
  ├── IOrderDetailProvider    (ORD-002)
  ├── ITrackingProvider       (TRK-001)
  ├── ICampaignsProvider      (CAM-001)
  ├── ILeadsProvider          (LEAD-001/002)
  ├── IProductsProvider       (PRD-001)
  ├── IReceivablesProvider    (FIN-001)
  ├── IVoucherDetailProvider  (VCH-001)
  ├── IOrdersRepository
  ├── IOrderDetailsRepository
  ├── ITrackingRepository
  ├── ICampaignsRepository
  ├── ILeadsRepository
  ├── IProductsRepository
  ├── IReceivablesRepository
  ├── ISyncPolicyRepository
  ├── ISyncStateRepository
  ├── ISyncLeaseRepository
  ├── IProviderHealthRepository
  ├── IOrderClassifier
  ├── ITrackingClassifier
  └── ILogger
```

Concretos são injetados. Testes usam test doubles.

---

## 7. LEASE (CONCEITUAL)

Aquisição atômica via PostgreSQL:
```sql
INSERT INTO integration.sync_leases (...)
ON CONFLICT (provider, domain, operation) DO UPDATE
SET ... WHERE sync_leases.expires_at < CURRENT_TIMESTAMP;
```

Release condicionado: `WHERE owner_token = ?`

---

## 8. UNRESOLVED

- **TRACKING_TERMINAL_STATUS = UNRESOLVED**
- **CAMPAIGN_INACTIVE_BEHAVIOR = UNRESOLVED**
