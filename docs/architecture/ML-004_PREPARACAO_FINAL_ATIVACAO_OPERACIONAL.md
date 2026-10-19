# BD_API_ZEISS — ML-004 | Preparação Final da Ativação Operacional

**Projeto:** `C:\Antigravity\BD_API_ZEISS`  
**Supabase Canônico:** `bklpztydqllqevekgins`  
**Data:** 19/10/2026  
**Status:** PRONTO PARA ATIVAÇÃO OPERACIONAL CONTROLADA  
**Regra de Ouro:** BD_API_ZEISS é 100% independente de qualquer aplicação consumidora externa.

---

## 1. Estado Atual da Produção

Uma inspeção minuciosa e somente-leitura contra o banco de dados Supabase dedicado (`bklpztydqllqevekgins`) e os componentes do repositório confirma o estado operacional:

### 1.1 Banco de Dados PostgreSQL (Supabase `bklpztydqllqevekgins`)
- **Organização:** 1 organização registrada (`Óticas Matriz`, UUID `e12bf28b-b7ea-4cd7-b08e-5b12da6a6039`).
- **Loja Continental:** 1 loja provisionada (`Ótica Continental`, UUID `3cdde1d2-4461-475f-8faf-418bbb3790fd`, código `continental`), em status estrito `ready` (aguardando ativação autorizada).
- **Identidade ZEISS:** Identidade cadastrada para a Continental (`saoweb_code = '33417'`, `zeiss_store_code = 'CN043229'`, `cnpj = '48310092000132'`, `country_id = '01'`).
- **Pedidos Históricos (`zeiss.orders`):**
  - Total de pedidos: **7.234**.
  - Pedidos com `store_id IS NOT NULL`: **0**.
  - Pedidos com `store_id IS NULL` (base histórica legada): **7.234 (100%)**.
- **Políticas Centrais de Sincronização (`integration.sync_policies`):**
  - `zeiss:campaigns:sync`: intervalo 86.400s (24h), `enabled = true`.
  - `zeiss:orders:discovery`: intervalo 3.600s (1h), `enabled = true`.
  - `zeiss:tracking:sync`: intervalo 3.600s (1h), `enabled = true`.
  - `zeiss:products:sync`: intervalo 604.800s (7d), `enabled = true`.
  - `zeiss:receivables:sync`: intervalo 43.200s (12h), `enabled = true`.
  - `zeiss:leads:sync`: intervalo 1.800s (30m), `enabled = false` (desativado preventivamente).
  - `zeiss:leads:redeemed`: intervalo 1.800s (30m), `enabled = false` (desativado preventivamente).
- **Controles Especializados Multi-Loja (`integration.store_sync_*`):**
  - `store_sync_state`: 0 registros (nenhum bootstrap executado em produção).
  - `store_sync_leases`: 0 registros ativos.
  - `store_sync_policies`: 7 registros para a Continental com `enabled = false` (preventivo).
  - `store_provider_health`: 0 registros.
- **Camada de Consumo e Auditoria:**
  - `integration.api_consumers`: 1 registro cadastrado (`mais-zeiss`), desativado preventivamente (`enabled = false`).
  - `integration.api_credentials`: **0 credenciais emitidas** (nenhuma chave gerada ou em circulação).
  - `integration.api_operations` / `api_operation_events`: tabelas criadas e prontas para auditoria e controle de idempotência.
- **Agendamento Interno no Banco:**
  - Extensão `pg_cron`: **NÃO instalada**. O agendamento é 100% externo via worker autônomo.

### 1.2 Runtime do Worker e Serving API
- **Worker (`src/worker.ts`):** Operando em modo padrão `RUNTIME_MODE=legacy`. Permanece estável executando ticks mono-loja usando `buildCompositionRoot` e as tabelas `integration.sync_*`. O motor multi-loja (`CentralMultiStoreScheduler`) está compilado e integrado, pronto para chaveamento.
- **Serving API (`src/api/server.ts`):** Servidor HTTP nativo Node.js implementado com roteamento para 8 endpoints (incluindo autenticação SHA-256 e isolamento por loja). Pronto para execução via `npm run api` ou `node dist/api/server.js`, mas atualmente **não publicado e sem portas externas abertas**.
- **Testes e Tipagem:** 37 suítes de testes automatizados aprovadas com 100% de sucesso (288/288 testes). `tsc --noEmit` e compilação de produção (`tsc -p tsconfig.build.json`) com 0 erros.

---

## 2. Pendências Impeditivas Reais (Bloqueios Concretos)

Nenhuma das pendências abaixo decorre de deficiência de software ou arquitetura. Tratam-se de deliberações de governança e infraestrutura obrigatórias antes da execução:

| # | Item Impeditivo | Categoria | Descrição do Bloqueio | Ação Necessária |
|---|---|---|---|---|
| **P1** | **Destino dos 7.234 Pedidos Históricos** | Governança de Dados | Os 7.234 registros em `zeiss.orders` possuem `store_id IS NULL`. Não podem ser atribuídos à Continental sem autorização expressa, pois a constraint `UNIQUE (order_number)` é global. | Deliberação humana: autorizar execução controlada do `ContinentalReconciliationService` (atribuindo apenas os que tiverem prova documental SAOWEB `33417` / CNPJ `48310092000132`), ou mantê-los permanentemente em quarentena técnica (`store_id IS NULL`). |
| **P2** | **Definição da Infraestrutura do Gatilho do Worker** | Infraestrutura | Como `pg_cron` não existe no PostgreSQL do Supabase, o tick periódico do worker depende de infraestrutura externa (ex: VM com systemd/crontab, container Docker com loop agendador ou Cloudflare Worker chamando trigger seguro). | Provisionar e formalizar qual runtime executará o comando `node dist/worker.js` na cadência planejada (a cada 5 minutos). |
| **P3** | **Definição de Host e Rede da Serving API** | Infraestrutura / Redes | O servidor HTTP `ServingApiServer` foi projetado para escutar em porta TCP (`PORT`, default 3000). Requer infraestrutura de publicação (proxy reverso Nginx/Caddy/Cloudflare Tunnel com certificado TLS). | Alocar porta de rede interna e DNS oficial para a Serving API independente do BD_API_ZEISS. |
| **P4** | **Emissão Controlada de Credenciais de Consumo** | Segurança | A tabela `integration.api_credentials` possui 0 chaves. Não existem tokens distribuídos. | Gerar chaves criptográficas SHA-256 exclusivamente após autorização formal de cada aplicação consumidora, amarrando escopos e `allowed_store_ids`. |
| **P5** | **Autorização Formal para Troca de Runtime** | Governança Operacional | A transição de `RUNTIME_MODE=legacy` para `RUNTIME_MODE=multi_store` e de `core.stores.status = 'ready'` para `'active'` exige aprovação humana expressa. | Emissão do comando de autorização formal pelo responsável da plataforma. |

---

## 3. Sequência Exata de Ativação Operacional

A ativação operacional deve seguir rigorosamente as 5 etapas lineares abaixo, assegurando zero concorrência entre os modos e zero risco de corrupção de dados:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FASE 1: Pré-Voo & Interrupção Segura do Legado                              │
│ • Snapshot de banco                                                         │
│ • Parar scheduler/cron legado                                               │
│ • Validar expiração de leases em integration.sync_leases                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FASE 2: Conciliação Histórica Auditável (Sob Autorização)                  │
│ • Executar ContinentalReconciliationService (dryRun=true)                   │
│ • Se aprovado: rodar conciliação confirmada (confirmAuthorization=true)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FASE 3: Bootstrap Histórico & Catch-Up da Continental                       │
│ • Disparar StoreBootstrapOrchestrator para a Continental                   │
│ • Processar fatias de 7 dias com checkpoints em store_sync_state             │
│ • Transicionar Continental: core.stores.status = 'active'                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FASE 4: Ativação do Runtime Multi-Loja no Worker                            │
│ • Definir RUNTIME_MODE=multi_store no ambiente                              │
│ • Iniciar novo worker                                                       │
│ • Validar primeiro tick do CentralMultiStoreScheduler                       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FASE 5: Publicação da Serving API & Emissão de Credenciais                  │
│ • Iniciar servidor HTTP (npm run api)                                       │
│ • Validar endpoint /api/v1/health                                           │
│ • Gerar credenciais SHA-256 autorizadas em integration.api_credentials       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detalhamento Passo a Passo:

#### Passo 1: Pré-Voo e Garantia de Não-Concorrência
1. Executar snapshot ou backup lógico do schema no Supabase.
2. Parar o processo/cron responsável pelo trigger legado do worker.
3. Verificar se há leases legados ativos:
   ```sql
   SELECT provider, domain, operation, owner_token, expires_at 
   FROM integration.sync_leases 
   WHERE expires_at > CURRENT_TIMESTAMP;
   ```
   *Se houver lease ativo, aguardar o timestamp `expires_at` ou limpar caso o processo anterior tenha sido finalizado.*

#### Passo 2: Conciliação dos Pedidos Históricos (Opcional sob Deliberação)
1. Executar inspeção prévia sem escrita:
   ```bash
   node dist/cli/run-job.js --provider zeiss --domain orders --operation reconciliation --store continental --dry-run
   ```
2. Analisar o relatório:
   - Pedidos `CONFIRMED`: possuem SAOWEB `33417` ou CNPJ `48310092000132`.
   - Pedidos `INCONCLUSIVE`: pedidos legados sem detalhe associado.
   - Pedidos `CONFLICT`: registros associados a outro CNPJ/SAOWEB.
3. Se autorizado formalmente, aplicar mutação atribuindo exclusivamente os pedidos `CONFIRMED` à Continental. Caso contrário, mantê-los intactos com `store_id IS NULL`.

#### Passo 3: Execução do Bootstrap da Continental
1. Executar o bootstrap histórico da Continental em fatias seguras de 7 dias:
   ```bash
   # Execução via StoreBootstrapOrchestrator com lookbackDays = 90 a 180
   node dist/cli/backfill-orders.js --store continental --days 90
   ```
2. Monitorar os checkpoints salvos na tabela `integration.store_sync_state`:
   ```sql
   SELECT store_id, provider, domain, operation, cursor_value, last_sync 
   FROM integration.store_sync_state 
   WHERE store_id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
   ```
3. Ao término do bootstrap e do catch-up, transicionar a loja para ativa:
   ```sql
   UPDATE core.stores 
   SET status = 'active', updated_at = CURRENT_TIMESTAMP 
   WHERE id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
   ```

#### Passo 4: Chaveamento do Worker para `multi_store`
1. Configurar a variável de ambiente no servidor do worker:
   ```env
   RUNTIME_MODE=multi_store
   ```
2. Iniciar o worker:
   ```bash
   npm run worker
   ```
3. Inspecionar o log do worker para confirmar o agendamento central:
   ```
   [worker] Executing in MULTI_STORE mode with central policy scheduler and dynamic store discovery
   [CentralScheduler] Read 5 enabled central policies for provider 'zeiss'
   [CentralScheduler] Discovered 1 active store(s) out of 1 eligible
   [CentralScheduler] Acquired lease, starting job for store continental
   ```

#### Passo 5: Inicialização da Serving API
1. Definir a porta e iniciar o servidor HTTP:
   ```bash
   PORT=3000 npm run api
   ```
2. Validar que o servidor responde:
   ```bash
   curl -i http://localhost:3000/api/v1/health
   # Retorno esperado: HTTP 200 {"success":true,"data":{"status":"ok",...}}
   ```

---

## 4. Testes de Saúde e Critérios de Aprovação

Para que a ativação seja considerada homologada em produção, todos os 5 critérios objetivos abaixo devem ser comprovados:

| ID | Teste de Saúde | Comando / Verificação | Critério de Aprovação |
|---|---|---|---|
| **HC-01** | **Integridade do Tick Central Multi-Loja** | Consulta em `integration.store_provider_health` após primeiro tick | Registros de saúde para a Continental com status de sucesso nas operações habilitadas. Zero erros críticos. |
| **HC-02** | **Isolamento Absoluto de Pedidos na API** | `GET /api/v1/stores/3cdde1d2-4461-475f-8faf-418bbb3790fd/orders` | Retorna exclusivamente pedidos da Continental (`store_id = Continental`). Pedidos históricos com `store_id IS NULL` nunca são expostos. |
| **HC-03** | **Segregação do Endpoint Administrativo** | `GET /api/v1/admin/unassigned-orders` com e sem escopo `admin:historical:read` | Retorna HTTP 403 para tokens normais; retorna os 7.234 pedidos históricos apenas para tokens administrativos. |
| **HC-04** | **Inviolabilidade de Chaves e Conflitos** | Tentativa de upsert de pedido existente | Nenhuma duplicação em `zeiss.orders`; `store_id` original preservado; zero erros de constraint violada. |
| **HC-05** | **Idempotência de Mutações** | `POST /api/v1/stores/{store_id}/vouchers/activate` com o mesmo `Idempotency-Key` | Primeira chamada processa normalmente; segunda chamada reproduz o resultado anterior com flag `_replayed: true`, sem nova requisição à ZEISS. |

---

## 5. Procedimento de Rollback Operacional (Não-Destrutivo)

Caso seja detectada qualquer anomalia de rede, fornecedor, infraestrutura ou inconsistência operacional durante ou após a ativação:

### 5.1 Regras de Não-Destrutividade
- **Nenhum registro de pedido, cliente, nota fiscal ou financeiro é excluído.**
- As tabelas especializadas multi-loja (`integration.store_sync_*`) permanecem preservadas para auditoria.
- A reversão para o runtime legado é instantânea e retrocompatível.

### 5.2 Passos do Rollback:
1. **Passo R1 — Parar o Worker Multi-Loja:**
   Finalizar imediatamente o processo em execução (`kill <pid>` ou `systemctl stop bd-api-zeiss-worker`).
2. **Passo R2 — Retornar a Variável de Ambiente para Modo Legado:**
   ```env
   RUNTIME_MODE=legacy
   ```
3. **Passo R3 — Suspender a Continental no PostgreSQL:**
   ```sql
   UPDATE core.stores 
   SET status = 'suspended', updated_at = CURRENT_TIMESTAMP 
   WHERE id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
   ```
   *(Garante que, mesmo que o worker volte a ser executado em multi-loja acidentalmente, a Continental será ignorada).*
4. **Passo R4 — Liberar Leases Residuais:**
   ```sql
   DELETE FROM integration.store_sync_leases 
   WHERE store_id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
   ```
5. **Passo R5 — Reiniciar o Worker em Modo Legado:**
   ```bash
   npm run worker
   ```
   O worker retomará a execução mono-loja tradicional a partir dos cursores originais intactos em `integration.sync_state`.
6. **Passo R6 — Interromper a Serving API (se necessário):**
   Finalizar o processo do servidor HTTP (`npm run api`).

---

## 6. Contratos da API Disponíveis e Pendentes

A Serving API do BD_API_ZEISS possui especificação canônica formalizada em `docs/api/openapi.yaml` (OpenAPI 3.1). O mapeamento entre a especificação, as rotas do servidor HTTP (`src/api/server.ts`), os handlers (`src/api/handlers.ts`) e os providers é o seguinte:

### 6.1 Endpoints Prontos para Publicação (Implementados no Servidor HTTP)

| Método | Endpoint | Escopo Exigido | Status Técnico | Descrição Funcional |
|---|---|---|---|---|
| `GET` | `/api/v1/health` | Nenhum (Público) | **OPERACIONAL** | Health check do runtime HTTP da API. |
| `GET` | `/api/v1/stores/{store_id}/orders` | `orders:read` | **OPERACIONAL** | Lista paginada de pedidos pertencentes estritamente à loja informada. |
| `GET` | `/api/v1/stores/{store_id}/orders/{order_number}` | `orders:read` | **OPERACIONAL** | Detalhes consolidados do pedido e situação fiscal na loja. |
| `GET` | `/api/v1/stores/{store_id}/tracking/{nf_number}` | `tracking:read` | **OPERACIONAL** | Histórico de eventos logísticos da nota fiscal da loja. |
| `GET` | `/api/v1/stores/{store_id}/campaigns` | `campaigns:read` | **OPERACIONAL** | Lista de campanhas ativas e vigentes na unidade. |
| `GET` | `/api/v1/stores/{store_id}/campaigns/{campaign_id}/leads` | `leads:read` | **OPERACIONAL** | Leads da campanha na loja com e-mails pseudonimizados em HMAC. |
| `POST` | `/api/v1/stores/{store_id}/vouchers/activate` | `vouchers:write` | **OPERACIONAL** | Ativação/resgate idempotente de voucher (exige `Idempotency-Key`). |
| `GET` | `/api/v1/admin/unassigned-orders` | `admin:historical:read` | **OPERACIONAL** | Endpoint segregado exclusivo para auditoria de pedidos sem loja (`store_id IS NULL`). |

### 6.2 Endpoints Implementados em Providers/Serviços (Pendentes de Roteamento HTTP)

Estes endpoints possuem lógica de provider e serviço validada, mas não estão expostos no router HTTP principal:

| Método | Endpoint | Provedor / Serviço Subjacente | Status | Motivo da Não-Exposição HTTP |
|---|---|---|---|---|
| `POST` | `/api/v1/stores/{store_id}/vouchers/generate` | `VouchersProvider.generateVoucher` | IMPLEMENTADO_NAO_HOMOLOGADO | Mutação ZEISS VCH-002; requer homologação de fluxo comercial. |
| `GET` | `/api/v1/stores/{store_id}/vouchers/{voucher_code}` | `VouchersProvider.getVoucher` | IMPLEMENTADO_NAO_HOMOLOGADO | Consulta VCH-001 on-demand; aguarda homologação de credencial. |
| `GET` | `/api/v1/stores/{store_id}/financial/boletos/{boleto_id}` | `FinancialProvider.getBoleto` | IMPLEMENTADO_NAO_HOMOLOGADO | Consulta transitória FIN-002; aguarda massa de dados real. |
| `GET` | `/api/v1/stores/{store_id}/financial/danfe/{nf_key}` | `FinancialProvider.getDanfe` | IMPLEMENTADO_NAO_HOMOLOGADO | Consulta transitória FIN-003; aguarda chaves NFe de teste. |
| `POST` | `/api/v1/admin/stores/onboard` | `StoreOnboardingService` | IMPLEMENTADO_NAO_HOMOLOGADO | Operação administrativa zero-deploy; disponível via CLI/código. |
| `POST` | `/api/v1/admin/stores/{store_id}/bootstrap` | `StoreBootstrapOrchestrator` | IMPLEMENTADO_NAO_HOMOLOGADO | Disparo de importação histórica; disponível via CLI de backfill. |

### 6.3 Endpoints Planejados no Roadmap da Plataforma

| Método | Endpoint | Status | Roadmap |
|---|---|---|---|
| `POST` | `/api/v1/stores/{store_id}/vouchers/2fa/confirm` | **PLANEJADO** | Validação de PIN/token 2FA para resgate de vouchers restritos. |
| `POST` | `/api/v1/stores/{store_id}/vouchers/2fa/resend` | **PLANEJADO** | Solicitação de reenvio de código 2FA ao consumidor. |
| `POST` | `/api/v1/stores/{store_id}/sales/assisted` | **PLANEJADO** | Registro transacional de venda assistida ZEISS. |

---

## 7. Comandos Operacionais Necessários para a Ativação

Abaixo estão reunidos todos os comandos operacionais para os operadores realizarem a ativação controlada quando houver autorização expressa:

### 7.1 Pré-Voo e Diagnóstico Somente-Leitura
```bash
# 1. Executar testes de sanidade da aplicação
npm test -- --forceExit

# 2. Executar validação de tipos TypeScript
npm run typecheck

# 3. Compilar os binários de distribuição
npm run build

# 4. Inspecionar se há leases residuais no Supabase (pelo psql ou query remota)
# SELECT * FROM integration.sync_leases WHERE expires_at > CURRENT_TIMESTAMP;
```

### 7.2 Conciliação Prévia (Dry-Run Sem Mutações)
```bash
# Execução da análise de correspondência documental dos 7.234 pedidos
node dist/cli/run-job.js --provider zeiss --domain orders --operation reconciliation --store continental --dry-run
```

### 7.3 Execução do Bootstrap Histórico da Continental
```bash
# Disparo do backfill histórico fatiado em janelas de 7 dias
node dist/cli/backfill-orders.js --store continental --days 90
```

### 7.4 Ativação da Loja Continental no Banco de Dados
```sql
-- Executar no Supabase SQL Editor
UPDATE core.stores 
SET status = 'active', updated_at = CURRENT_TIMESTAMP 
WHERE id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
```

### 7.5 Inicialização do Worker em Modo Multi-Loja
```bash
# No ambiente do worker:
export RUNTIME_MODE=multi_store
npm run worker
```

### 7.6 Inicialização da Serving API
```bash
# No ambiente da API:
export PORT=3000
npm run api
```

### 7.7 Emissão Segura de Credencial para Consumidor (Exemplo Script)
```typescript
// Script administrativo isolado para gerar credencial com hash SHA-256
import * as crypto from 'crypto';
const secret = crypto.randomBytes(32).toString('hex');
const secretHash = crypto.createHash('sha256').update(secret).digest();
const prefix = secret.slice(0, 8);
// Inserir secretHash e prefix em integration.api_credentials vinculado ao consumer_id.
// Entregar 'secret' de forma segura e pontual ao consumidor autorizado.
```

### 7.8 Comandos de Rollback de Emergência
```bash
# 1. Parar o worker multi-loja imediatamente
kill $(pgrep -f "dist/worker.js")

# 2. Suspender a loja no PostgreSQL
# UPDATE core.stores SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';

# 3. Limpar leases
# DELETE FROM integration.store_sync_leases WHERE store_id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';

# 4. Voltar worker para modo legado
export RUNTIME_MODE=legacy
npm run worker
```

---

## 8. Conclusão da Preparação Operacional

A fase **ML-004** consolida a prontidão técnica integral da plataforma **BD_API_ZEISS**:
- Continuidade operacional garantida sem concorrência entre runtimes legado e multi-loja.
- Procedimento de bootstrap da Continental rigorosamente definido com fatiamento de 7 dias, esclarecimento comprovado da retenção de 90-180 dias e proteção dos 7.234 pedidos históricos.
- Mapa de sincronização único, global e centralizado em `integration.sync_policies`, com isolamento total de estado em `integration.store_sync_*`.
- Serving API pronta para execução independente, com autenticação SHA-256 e documentação OpenAPI 3.1 rigorosamente confrontada com o código.
- Nenhuma mutação ou alteração foi executada em produção, respeitando integralmente as diretrizes de governança.
