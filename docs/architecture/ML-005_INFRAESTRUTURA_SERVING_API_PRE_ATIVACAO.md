# BD_API_ZEISS — ML-005 | Infraestrutura, Serving API e Pré-Ativação

**Projeto:** `C:\Antigravity\BD_API_ZEISS`  
**Supabase Canônico:** `bklpztydqllqevekgins`  
**Railway:** Projeto `BD_API_ZEISS` (`6c01539c-7864-4f47-afa1-740f25086529`)  
**Data:** 19/10/2026  
**Status:** INFRAESTRUTURA VALIDADA — SERVING API HOMOLOGADA — PRONTO PARA ATIVAÇÃO CONTROLADA  
**Regra de Ouro:** BD_API_ZEISS é 100% independente de qualquer aplicação consumidora externa.

---

## 1. Inspeção e Estado Real do Railway (Worker Existente)

A inspeção executada via Railway CLI autenticado (`miguelbello82@gmail.com`) contra o ambiente produtivo confirmou a topologia e a configuração efetiva do serviço:

### 1.1 Metadados do Projeto e Serviço
- **Workspace:** `miguelbello82-png's Projects`
- **Projeto Railway:** `BD_API_ZEISS` (ID: `6c01539c-7864-4f47-afa1-740f25086529`)
- **Ambiente:** `production` (ID: `2fa5373f-645a-4165-bd8d-b32c372d864d`)
- **Serviço Vinculado:** `BD_API_ZEISS` (ID: `a84d9151-12f9-4e68-83c2-33252f6fa005`)
- **Repositório GitHub:** `miguelbello82-png/BD_API_ZEISS` (Branch: `main`)
- **Outros Serviços no Projeto:** `graceful-art` (ID: `e62de29e-52ab-49d0-92e9-c6db59d4fffc`, `Offline`)

### 1.2 Configuração de Deploy e Agendamento
- **Origem Real do Agendamento:** **Railway Native Cron Job** (`cronSchedule: "*/5 * * * *"`).
- **Cadência:** Invocação a cada 5 minutos.
- **Comando de Inicialização (Start Command):** `npm run worker`
- **Comando de Build:** `npm run build` (Builder: `RAILPACK`, Node.js: `24.20.0` LTS)
- **Política de Reinicialização (Restart Policy):** `NEVER` (comportamento correto para execuções batch episódicas, prevenindo loops de reinicialização em caso de falha de rede/fornecedor).
- **Healthcheck Path:** `null` (apropriado para job batch de background sem porta HTTP).
- **Status do Serviço:** `Offline` (o container sobe episodicamente a cada 5 minutos pelo cron, executa o tick do worker e encerra graciosamente).

### 1.3 Variáveis de Ambiente Configuradas (Sanitizadas)
As variáveis presentes no serviço do Railway foram inspecionadas sem exposição de segredos:
- `DATABASE_URL`: Conecta ao pooler Supabase AWS US-West-2 na porta 5432 utilizando o usuário de menor privilégio `bd_api_zeiss_worker.bklpztydqllqevekgins`.
- `SENHA_DO_WORKER`: Senha do role `bd_api_zeiss_worker`.
- `ZEISS_API_KEY`: Token de autorização para as APIs da ZEISS.
- `ZEISS_ORDERS_BASE_URL`, `ZEISS_TRACKING_BASE_URL`, `ZEISS_SERVICES_BASE_URL`, `ZEISS_CAMPAIGNS_BASE_URL`, `ZEISS_FINANCIAL_BASE_URL`: Gateways autoritativos AWS da ZEISS.
- `ZEISS_CNPJ`: `48310092000132` (Continental).
- `ZEISS_COUNTRY_ID`: `1`.
- `ZEISS_SAOWEB_CODE`: `33417`.
- `ZEISS_STORE_ID`: `CN043229`.
- `ZEISS_FIN_USER_ID`: `0`.
- `ZEISS_VOUCHER_USER_ID`: `42`.

### 1.4 Modo de Execução Efetivo em Produção
- A variável `RUNTIME_MODE` **não está definida** nas variáveis de ambiente do Railway.
- Conforme lógica de fallback em `src/worker.ts` (`process.env.RUNTIME_MODE || 'legacy'`), o worker opera estritamente em **`RUNTIME_MODE=legacy`**.
- O sistema existente permanece 100% protegido e inalterado.

---

## 2. Serving API Independente

A camada de Serving API foi preparada para execução como um serviço HTTP desacoplado do worker, aproveitando o mesmo repositório e infraestrutura:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INFRAESTRUTURA RAILWAY                            │
│                                                                             │
│  ┌─────────────────────────────────┐     ┌───────────────────────────────┐  │
│  │   Serviço 1: BD_API_ZEISS       │     │  Serviço 2: BD_API_ZEISS_API  │  │
│  │   (Worker de Sincronização)     │     │  (Servidor HTTP Serving API)  │  │
│  │                                 │     │                               │  │
│  │   • Gatilho: Cron */5 * * * *   │     │   • Modo: Contínuo (Web)      │  │
│  │   • Start: npm run worker       │     │   • Start: npm run api        │  │
│  │   • Restart: NEVER              │     │   • Porta: $PORT dinâmica     │  │
│  │   • Port: Nenhuma (batch)       │     │   • Health: /api/v1/health    │  │
│  └────────────────┬────────────────┘     └───────────────┬───────────────┘  │
│                   │                                      │                  │
└───────────────────┼──────────────────────────────────────┼──────────────────┘
                    │                                      │
                    │   Pooler Supabase (TLS / SSL)        │
                    ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 PostgreSQL no Supabase (bklpztydqllqevekgins)               │
│                                                                             │
│   • Schema core: Organizations, Stores, Identities, Credentials             │
│   • Schema zeiss: Orders, Details, Tracking, Campaigns, Receivables         │
│   • Schema integration: Sync Policies, Store State, Store Leases, Auth      │
│   • Schema audit: Operations & Audit Events (Idempotency)                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Requisitos de Runtime Atendidos no Código
1. **Comando Dedicado:** Configurado no `package.json` o script `"api": "node dist/api/server.js"`.
2. **Porta Dinâmica:** Implementada resolução `process.env.PORT || process.env.API_PORT || 3000`.
3. **Health Check Sanitizado (`GET /api/v1/health`):** Retorna unicamente `{"success": true, "data": {"status": "ok", "timestamp": "..."}}`. Zero exposição de credenciais, hosts de banco ou caminhos de arquivos.
4. **HTTPS na Borda:** Ao ser implantado como serviço web no Railway, o tráfego externo recebe terminação TLS automática na borda e é encaminhado para o container na porta `$PORT`.
5. **Segurança de Conexão com o Banco:** Sem exposição pública direta do PostgreSQL. A Serving API conecta via pooler interno com TLS obrigatório.
6. **Timeouts Defensivos na Conexão:**
   - `server.timeout = 30000` (30 segundos).
   - `server.keepAliveTimeout = 65000` (65 segundos, alinhado aos proxies de borda).
   - `server.headersTimeout = 66000` (66 segundos, prevenindo falhas de keep-alive).
7. **Limite de Payload:** Rejeita requisições com corpo superior a 1 MB (`HTTP 400 BAD_REQUEST: Request payload too large`).
8. **Encerramento Gracioso (Graceful Shutdown):** Trata eventos `SIGTERM` e `SIGINT`, fechando o servidor HTTP e o pool de conexões com o PostgreSQL antes do encerramento do processo.

---

## 3. Segurança e Autorização da API

Todos os aspectos de segurança da Serving API foram validados através de testes automatizados com banco isolado:

### 3.1 Matriz de Validação de Segurança
| Dimensão de Segurança | Mecanismo Implementado | Comportamento Validado nos Testes |
|---|---|---|
| **Autenticação de Consumidores** | Hash SHA-256 (`crypto.createHash('sha256')`) persistido em `integration.api_credentials.secret_hash`. | Rejeita tokens ausentes (401), vazios (401), inválidos (401) e desabilitados (403). Suporta `Authorization: Bearer <token>` e `X-API-Key: <token>`. |
| **Revogação de Credenciais** | Coluna `revoked_at` em `integration.api_credentials`. | Invalidação instantânea sem exclusão física do registro (retorna 401 `TOKEN_REVOKED`). |
| **Expiração Temporal** | Coluna `expires_at` em `integration.api_credentials`. | Rejeita tokens com data passada (retorna 401 `TOKEN_EXPIRED`). |
| **Autorização por Escopo** | Array `allowed_scopes` em `integration.api_consumers`. | Consumidor sem escopo específico (ex: `admin:historical:read`) recebe 403 `INSUFFICIENT_SCOPE`. Suporta wildcard `*`. |
| **Isolamento por Loja** | Array `allowed_store_ids` em `integration.api_consumers`. | Tentativa de acessar `store_id` diferente resulta em 403 `STORE_ACCESS_DENIED`. Queries filtram estritamente por `store_id = $1`. |
| **Proteção contra Enumeração** | Consultas individuais por ID (`/orders/:order_number`, `/tracking/:nf_number`). | Se o pedido ou NF pertencer a outra loja ou não existir, retorna 404 `NOT_FOUND` padronizado, impedindo inferência de dados cross-store. |
| **Proteção da Base Histórica** | Registros com `store_id IS NULL`. | Ocultos em todos os endpoints de loja (`/stores/:store_id/*`). Acessíveis unicamente via endpoint administrativo segregado `/admin/unassigned-orders`. |
| **Idempotência de Mutações** | Header `Idempotency-Key` obrigatório em `POST /vouchers/activate` com registro em `integration.api_operations`. | Ausência de header gera 400 `MISSING_IDEMPOTENCY_KEY`. Reenvio com a mesma chave e payload reproduz o resultado anterior com flag `_replayed: true`, sem reenviar chamada à ZEISS. |
| **Tamanho de Payload** | Limite estrito de 1 MB no parsing de streams HTTP. | Payloads maiores são rejeitados com 400 `BAD_REQUEST`. |

---

## 4. Auditoria dos 7.234 Pedidos Históricos da Continental

Em estrito cumprimento às regras de governança, **nenhuma alteração em massa ou mutação de dados foi executada no banco de dados produtivo**.

### 4.1 Diagnóstico do Schema Real do PostgreSQL
A inspeção técnica das tabelas relacionais revelou a seguinte composição dos dados existentes:
- **`zeiss.orders` (7.234 registros):** Todos com `store_id IS NULL`.
- **`zeiss.order_details` (6.749 registros):** Possui colunas `raw_status` e `raw_situacao` (ex: `'Faturado - Aguardando processo logístico'`). As colunas de agregados `timeline_summary`, `occurrences_summary` e `services_summary` estão nulas. Não há colunas nativas `situacao` ou `codcli`.
- **`zeiss.fiscal_documents` (6.701 registros):** Possui colunas `nf_number` e `nf_series`. Não há coluna `metadata` ou `cnpj_destinatario`.

### 4.2 Resultado da Conciliação em Modo Somente-Leitura (Dry-Run)
Como os dados históricos foram ingeridos sem persistência explícita do código SAOWEB ou CNPJ nas tabelas secundárias:
- **Total Auditado:** 7.234 pedidos
- **Correspondências Confirmadas (`CONFIRMED`):** 0
- **Candidatos Inconclusivos (`INCONCLUSIVE`):** **7.234 (100%)**
- **Conflitos Documentais (`CONFLICT`):** 0
- **Mutações Executadas:** **0 (Base Preservada 100%)**
- **Recomendação Canônica:** **`QUARANTINE_LEGACY`** (Quarentena Técnica Legada).

**Conclusão Operacional:**
Os 7.234 pedidos devem permanecer permanentemente com `store_id IS NULL`, acessíveis com exclusividade pelo endpoint administrativo auditado `GET /api/v1/admin/unassigned-orders`. Qualquer tentativa de atribuição automática violaria a integridade da evidência técnica.

---

## 5. Sincronização Central e Herança de Políticas

O mapa central em `integration.sync_policies` foi confirmado como a **única fonte da verdade** para frequências e operações:

### 5.1 Políticas Centrais Ativas no Banco
```sql
SELECT provider, domain, operation, interval_seconds, enabled 
FROM integration.sync_policies 
ORDER BY provider, domain, operation;
```
1. `zeiss:campaigns:sync`: 86.400s (24h), `enabled = true`
2. `zeiss:leads:redeemed`: 1.800s (30m), `enabled = false` (desativado preventivamente)
3. `zeiss:leads:sync`: 1.800s (30m), `enabled = false` (desativado preventivamente)
4. `zeiss:orders:discovery`: 3.600s (1h), `enabled = true`
5. `zeiss:products:sync`: 604.800s (7d), `enabled = true`
6. `zeiss:receivables:sync`: 43.200s (12h), `enabled = true`
7. `zeiss:tracking:sync`: 3.600s (1h), `enabled = true`

### 5.2 Comportamento Homologado do Agendador Central
- O `CentralMultiStoreScheduler` consulta exclusivamente `integration.sync_policies` para determinar **o que** sincronizar e **quando**.
- As lojas ativas (`core.stores.status = 'active'`) são descobertas dinamicamente e participam do mesmo ciclo global.
- Cursores (`integration.store_sync_state`), travas atômicas (`integration.store_sync_leases`) e histórico de saúde (`integration.store_provider_health`) permanecem 100% individualizados por `store_id`.
- Nenhuma sincronização produtiva multi-loja foi ativada nesta etapa.

---

## 6. Documentação dos Contratos de API (OpenAPI 3.1)

A especificação canônica [docs/api/openapi.yaml](file:///C:/Antigravity/BD_API_ZEISS/docs/api/openapi.yaml) reflete a classificação dos endpoints:

### 6.1 Endpoints Homologados no Servidor HTTP (Prontos para Tráfego)
1. `GET /api/v1/health` — Integridade pública da API (sem autenticação).
2. `GET /api/v1/stores/{store_id}/orders` — Pedidos isolados da loja (`orders:read`).
3. `GET /api/v1/stores/{store_id}/orders/{order_number}` — Detalhe do pedido na loja (`orders:read`).
4. `GET /api/v1/stores/{store_id}/tracking/{nf_number}` — Rastreamento fiscal na loja (`tracking:read`).
5. `GET /api/v1/stores/{store_id}/campaigns` — Campanhas vigentes na unidade (`campaigns:read`).
6. `GET /api/v1/stores/{store_id}/campaigns/{campaign_id}/leads` — Leads com e-mail em HMAC (`leads:read`).
7. `POST /api/v1/stores/{store_id}/vouchers/activate` — Resgate idempotente via `Idempotency-Key` (`vouchers:write`).
8. `GET /api/v1/admin/unassigned-orders` — Auditoria dos 7.234 pedidos legados (`admin:historical:read`).

### 6.2 Endpoints Implementados nos Provedores (Não Roteados no HTTP)
- `POST /api/v1/stores/{store_id}/vouchers/generate` (`VouchersProvider.generateVoucher`)
- `GET /api/v1/stores/{store_id}/vouchers/{voucher_code}` (`VouchersProvider.getVoucher`)
- `GET /api/v1/stores/{store_id}/financial/boletos/{boleto_id}` (`FinancialProvider.getBoleto`)
- `GET /api/v1/stores/{store_id}/financial/danfe/{nf_key}` (`FinancialProvider.getDanfe`)
- `POST /api/admin/stores/onboard` (`StoreOnboardingService`)
- `POST /api/admin/stores/{store_id}/bootstrap` (`StoreBootstrapOrchestrator`)

### 6.3 Endpoints Planejados no Roadmap
- `POST /api/v1/stores/{store_id}/vouchers/2fa/confirm`
- `POST /api/v1/stores/{store_id}/vouchers/2fa/resend`
- `POST /api/v1/stores/{store_id}/sales/assisted`

---

## 7. Resultados dos Testes Automatizados e Compilação

Todos os testes automatizados foram expandidos e aprovados com 100% de sucesso:
- **Suítes de Testes Executadas:** **37 de 37 aprovadas (100%)**
- **Testes Unitários e Integrados:** **292 de 292 aprovados (100%)**
- **Erros / Regressões:** **0**
- **Verificação de Tipos TypeScript (`tsc --noEmit`):** **0 erros (Clean)**
- **Compilação de Distribuição (`tsc -p tsconfig.build.json`):** **0 erros (Clean)**

---

## 8. Pendências Objetivas e Comandos Finais de Ativação

### 8.1 Pendências Objetivas (Aguardando Autorização Humana)
1. **Criação do Serviço da API no Railway:** Adicionar um novo serviço web no projeto `BD_API_ZEISS` para executar `npm run api` com geração de domínio público HTTPS.
2. **Definição Formal sobre os Pedidos Históricos:** Confirmar a manutenção definitiva dos 7.234 pedidos históricos como quarentena técnica legada (`store_id IS NULL`).
3. **Emissão de Credenciais Oficiais:** Cadastrar consumidores autorizados em `integration.api_consumers` e emitir hashes SHA-256 em `integration.api_credentials`.
4. **Autorização da Transição do Worker:** Alterar a variável `RUNTIME_MODE=multi_store` no Railway e transicionar `core.stores.status = 'active'` para a Continental.

### 8.2 Comandos Operacionais para a Ativação

#### Passo A: Provisionamento do Serviço da API no Railway (via CLI)
```bash
# 1. Vincular o serviço ou criar novo serviço web no mesmo projeto Railway:
railway service create BD_API_ZEISS_API

# 2. Configurar o comando de inicialização da API:
# Start Command: npm run api

# 3. Gerar domínio público com HTTPS automático:
railway domain --service BD_API_ZEISS_API
```

#### Passo B: Verificação Prévia Local
```bash
# Validação completa de tipos, build e suíte de testes
npm run typecheck
npm run build
npm test -- --forceExit
```

#### Passo C: Ativação da Loja Continental no Supabase
```sql
-- Executar no SQL Editor do Supabase (bklpztydqllqevekgins)
UPDATE core.stores 
SET status = 'active', updated_at = CURRENT_TIMESTAMP 
WHERE id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
```

#### Passo D: Chaveamento do Worker para Multi-Loja no Railway
```bash
# Adicionar ou atualizar a variável RUNTIME_MODE no serviço BD_API_ZEISS
railway variables set RUNTIME_MODE=multi_store --service BD_API_ZEISS
```

#### Passo E: Teste de Saúde em Produção
```bash
# Teste público de integridade da Serving API
curl -i https://<dominio-railway>/api/v1/health

# Teste com credencial autorizada (substituir TOKEN)
curl -i https://<dominio-railway>/api/v1/stores/3cdde1d2-4461-475f-8faf-418bbb3790fd/orders \
  -H "Authorization: Bearer <TOKEN>"
```

#### Passo F: Procedimento de Rollback Imediato (Emergência)
```bash
# 1. Reverter o worker para modo legado no Railway:
railway variables set RUNTIME_MODE=legacy --service BD_API_ZEISS

# 2. Suspender a Continental no PostgreSQL:
# UPDATE core.stores SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';

# 3. Limpar leases residuais:
# DELETE FROM integration.store_sync_leases WHERE store_id = '3cdde1d2-4461-475f-8faf-418bbb3790fd';
```
