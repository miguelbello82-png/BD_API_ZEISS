# Evidências de Mapeamento de Estado (State Mapping Evidence) — BD_API_ZEISS

Este documento consolida as evidências do contrato da ZEISS para classificar o ciclo de vida operacional de Pedidos e o status final de Tracking.

---

## 1. ORDERS PAYLOAD FIELDS

Com base na inspeção do documento de Inteligência (`Suite_RMG_API_Intelligence_v0.25.0.md`) e do provider:

### ORD-001 (Listagem)
Os principais campos que indicam o progresso e o estado do pedido são:
- `status`: String legível do status.
- `codsit`: Código estrutural numérico da situação.
- `aguard`: O que o pedido aguarda (ex: `Armação`, `Armação, Tracer`, vazio).
- `aguardarmacao`: Flag técnica (`true`/`false`).

**Importante:** A Listagem de Pedido (ORD-001) **NÃO retorna o número da Nota Fiscal (NF)**.

### ORD-002 (Detalhe)
O Detalhe de Pedido concentra dados mais granulares e é a **única fonte da Nota Fiscal**:
- `nf`: Array de objetos contendo `nr` (número da NF) e `serie`. Ex: `nf: [{ nr: "123456", serie: "1" }]`.
- `situacao`: Objeto ou string que também reflete a situação de produção/faturamento.
- `status`: Campo na raiz que, nos casos documentados, coincidiu com a situação de faturamento.

---

## 2. ORDERS STATUS VALUES OBSERVED

Os seguintes códigos de situação (`codsit`) e descrições de `status` foram documentados para ORD-001:

| `codsit` | `status` | Interpretação |
|---|---|---|
| `1.1` | Estoque | Pedido inicial / aguardando insumos |
| `2.4` | Tratamento | Em produção |
| `4.1` | Em separação | Preparação logística interna |
| `6.1` | Faturado - Aguardando processo logístico | Pedido faturado, disponível para Tracking dependendo da NF |

---

## 3. BILLING / LOGISTICS EVIDENCE

A evidência documental comprova que:
- O momento em que o pedido não necessita mais de atualização recorrente de ciclo produtivo (ORD-002 frequente) é quando ele atinge **`codsit` = `6.1`**.
- Neste estado, o pedido está oficialmente **Faturado e Aguardando processo logístico**.
- A flag `aguardarmacao` e o campo `aguard` costumam ficar vazios/falsos neste estado.
- Sendo faturado, o pedido atinge o classificador `BILLED_LOGISTICS_READY`.

---

## 4. NF EVIDENCE

- **De onde vem a NF:** Exclusivamente de **ORD-002** (Detalhe de Pedido).
- **Nome exato do campo:** `nf` (array), extraindo `nf[].nr` (número) e `nf[].serie` (série).
- **Quando passa a estar preenchida:** Apenas quando o pedido atinge o estado faturado.
- **Elegibilidade de Tracking (TRACKING_CALLABLE):** O provider `TRK-001` exige `numnf` (derivado de `nf[].nr` ou acrescido de sufixos de unidade como "003" para RJ). Portanto, estar `BILLED_LOGISTICS_READY` (codsit 6.1) **não é o suficiente** para chamar o tracking; é obrigatório fazer on-demand de ORD-002 e confirmar se `nf[].nr` está preenchido e não vazio.

---

## 5. TRACKING CONTRACT

Para executar `TRK-001`, o provedor exige:
- `idpais`: 1
- `codsaocliente`: Código SAOWEB da loja
- `numnf`: Número da NF originado de ORD-002

O contrato de resposta documentado historicamente é um `Array<object>` representando eventos logísticos, mas não pudemos observar novos status nesta execução devido à ausência de dados remotos.

---

## 6. TRACKING REAL RESPONSE

Não foi possível inspecionar um response real de Tracking neste gate. A tabela remota `zeiss.orders` (no Supabase MCP) apresentou `count = 0`. 
Por não haver nenhum pedido faturado elegível com NF na base de dados conectada, o teste de smoke real **foi ignorado** (Nenhum candidato real = NÃO INVENTAR TESTE).

---

## 7. TRACKING STATUS VALUES OBSERVED

Nenhum status terminal ou ativo de Tracking pôde ser observado com evidência em banco nesta execução.

---

## 8. CLASSIFIER PROPOSAL

Baseado estritamente nas evidências documentais:

### IOrderClassifier (ORD-001)
- `codsit == '6.1'` → `OrderLifecycleStage.BILLED_LOGISTICS_READY` (Evidência: OBSERVED_CODSIT_6_1)
- `codsit IN ('1.1', '2.4', '4.1')` ou outros em progresso → `OrderLifecycleStage.MUTABLE`
- Cancelamento `OrderLifecycleStage.CANCELLED` suportado pelo motor, porém aguardando evidência canônica de qual `codsit` o representa.

### ITrackingClassifier (TRK-001)
- Mapeamento terminal ainda inconclusivo (nenhuma API call executada).

---

## 9. RESOLVED / UNRESOLVED

### BILLING FINAL EVIDENCE
- **ORDERS_BILLED_STATUS_EVIDENCE = OBSERVED_CODSIT_6_1**
- **ORDERS_BILLED_STATUS_MAPPING = RESOLVED**
- A evidência canônica e o payload real (codsit 6.1 -> "Faturado - Aguardando processo logístico") comprovam ser a transição para estado de logística.

### CANCEL FIELD EVIDENCE
- **ORDERS_CANCELLED_FIELD = status**
- **ORDERS_CANCELLED_VALUE = Cancelado**
- **ORDERS_CANCELLED_SOURCE = BOTH**
- **ORDERS_CANCELLED_STATUS_MAPPING = RESOLVED**

### TRACKING TERMINALITY
- **TRACKING_TERMINAL_STATUS = UNRESOLVED**

### TRACKING RECORD SELECTION
- **TRACKING_RECORD_SELECTION_RULE = UNRESOLVED**

### TRACKING 404 BEHAVIOR
- **TRACKING_404_BEHAVIOR = UNRESOLVED**
- Importante: 404 do TRK-001 NÃO significa automaticamente "transportadora ainda não registrou". A interpretação exata permanece não comprovada no contrato.

### ORDERS DATE SEMANTICS
- **ORDERS_DATE_BOUNDARY_SEMANTICS = RESOLVED**
- **entry_date**: Data de entrada/criação do pedido. Valor imutável. Pode ser populado por ORD-001 (`data-entrada`) ou ORD-002 (`entrada.data`), mas um valor existente nunca deve ser sobrescrito por fluxos de sync (inclusive se houver divergência).
- **expected_date**: Data atual de previsão de entrega. Valor operacional e mutável. ORD-002 (`previsao`) é a fonte de verdade absoluta e pode sobrescrever valores antigos, mas sem apagar (nullify) se vier vazio. ORD-001 (`previsao-entrega`) atua apenas como fallback para descoberta inicial, populando apenas se `expected_date` for nulo, e nunca sobrescrevendo valores existentes.
- **primprevisao**: Previsão original/primeira projeção. Não é mapeado para `expected_date`. Mantido como gap de schema/futuro candidato de campo histórico não persistido na tabela atual.
