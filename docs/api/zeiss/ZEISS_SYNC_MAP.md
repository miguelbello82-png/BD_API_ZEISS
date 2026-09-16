# Mapa Canônico das APIs ZEISS e Estratégia de Sincronização

**Documento Vivo — BD_API_ZEISS**
**Objetivo:** Consolidar a classificação estrutural de todas as APIs ZEISS consumidas pela plataforma antes da definição de papéis de banco (roles), agendadores (schedulers) e políticas temporais.

---

## 1. PERIODIC_SYNC

Operações executadas automaticamente pelo `sync_worker` em cadência configurada, alimentando o banco de dados proativamente.

| API | DOMAIN | OPERATION | PERSISTÊNCIA | OBJETIVO E REGRAS |
|---|---|---|---|---|
| **PRD-001** | products | `sync` | REQUIRED | Sincroniza ativamente o catálogo mestre de produtos e serviços associados. |
| **CAM-001** | campaigns | `sync` | REQUIRED | Atualiza as campanhas ativas e vigentes disponíveis para a unidade. |
| **LEAD-001** | leads | `sync` | REQUIRED | Sincroniza leads pertencentes a uma campanha. |
| **LEAD-002** | leads | `redeemed` | REQUIRED | Sincroniza resgates de vouchers (leads ativados) vinculados a uma campanha. |
| **FIN-001** | financial | `receivables` | REQUIRED | Sincronização de RECEIVABLES / contas a receber da ZEISS. |
| **ORD-001** | orders | `hot` | REQUIRED | Varredura de pedidos sobre uma **janela recente configurável**, garantindo reflexo imediato no BD. |
| **ORD-001** | orders | `reconciliation` | REQUIRED | Varredura de pedidos sobre uma **janela histórica maior configurável**, objetivando resgatar eventuais falhas ou atualizações antigas e silenciosas. |

*Nota sobre ORD-001:* As operations `hot` e `reconciliation` utilizam a **MESMA** API (ORD-001). São operações separadas unicamente por possuírem finalidade e política temporal diferentes. Ambas convergem atomicamente para `zeiss.orders` com persistência idempotente através de UPSERT pela chave natural, prevenindo duplicações.

---

## 2. SELECTIVE_SYNC

Operações executadas pelo `sync_worker`, mas engatilhadas de maneira seletiva baseada no estado de dados já presentes no sistema.

| API | DOMAIN | OPERATION | PERSISTÊNCIA | OBJETIVO E REGRAS |
|---|---|---|---|---|
| **ORD-002** | orders | `detail` | REQUIRED | ORD-002 é a fonte autoritativa de detalhe operacional. Refresca pedidos mutáveis e desconhecidos descobertos por ORD-001. A atualização recorrente de detalhe é interrompida quando o pedido atinge "Faturado - Aguardando processo logístico". Autoridade primária sobre expected_date atual, podendo substituir previsões antigas (mas nunca apagando com nulo, e nunca sobrescrevendo entry_date). |
| **TRK-001** | tracking | `sync` | REQUIRED | TRK-001 torna-se elegível a partir do estado de logística ("Faturado - Aguardando processo logístico") + NF presente (proveniente de ORD-002). O estado defasado de ORD-001 não deve bloquear o tracking. Condição de parada permanece atrelada aos status terminais da logística ZEISS. |

---

## 3. ON_DEMAND

Operações engatilhadas unicamente por requisições originárias de um consumidor ou UI externa. Operam sob o futuro `api_runtime` e não possuem scheduler ou automação de background.

| API | DOMAIN | OPERATION | PERSISTÊNCIA | OBJETIVO E REGRAS |
|---|---|---|---|---|
| **VCH-001** | vouchers | - | NO (Inicial) | Recuperação imediata de detalhes em tempo de atendimento. Depende de `campaignId` e `voucherCode` providos pelo consumidor ou fluxos paralelos (não há dependência estrita forçada com LEAD-001, embora este possa fornecer dados). |
| **FIN-002** | financial | - | NO (Inicial) | Recuperação transitória de boleto via UI. Recebe identificadores que podem vir do fluxo de FIN-001 ou de outro consumidor. O cache dessa estrutura permanece estritamente como *OPTIONAL FUTURE CAPABILITY*. |
| **FIN-003** | financial | - | NO (Inicial) | Recuperação transitória de DANFE/XML. *(Nota: Contrato e provider validados, smoke test real permaneceu BLOCKED apenas por ausência momentânea de massa de teste - NFs geradas).* |

---

## 4. MUTATIONS

Operações destinadas exclusivamente à modificação transacional e intencional no sistema ZEISS (interação humana ou fluxos de negócio ativos). Permanecem apartadas do ecossistema do `sync_worker` e inteiramente isentas de agendamentos ou rotinas de políticas de sync automáticas.

- **VCH-002**: Geração de Vouchers.
- **VCH-003**: Resgate/Ativação de Vouchers.
- **VCH-2FA-001**: Confirmação 2FA (PIN/Hash).
- **VCH-2FA-002**: Reenvio de e-mail 2FA.
- **Assisted Sale**: Venda assistida.

---

## 5. DEPENDÊNCIAS CONCEITUAIS BÁSICAS

As dependências refletem a precondição de obtenção de identificadores mínimos exigidos pelo contrato da API para que esta possa operar (não indicam necessariamente qual módulo as acionará).

- **ORD-002**: Requer ID do pedido, rotineiramente provido pelo espelhamento consolidado via **ORD-001**.
- **TRK-001**: Requer identificadores contratuais que podem se originar das rotinas de **ORD-001** ou **ORD-002** (ex: `numnf`).
- **LEAD-001 / LEAD-002**: Requerem `campaignId`, usualmente oriundo de **CAM-001**.
- **FIN-002 / FIN-003**: Requerem chaves fiscais que podem se originar, respectivamente, da base de Receivables (**FIN-001**) ou do detalhamento completo do faturamento (**ORD-002**).

---

## 6. UNRESOLVED DECISIONS

Decisões de negócios que não possuem resposta canônica da ZEISS neste instante de documentação. Nenhum *guesswork* foi imputado na construção das rotinas.

- **TRACKING_TERMINAL_STATUS = UNRESOLVED** (Quais IDs operacionais representam de fato a finalização lógica de um envio na DRIVIN da ZEISS?).
- **CAMPAIGN_INACTIVE_BEHAVIOR = UNRESOLVED** (Quando uma campanha encerra ou é inativada, a ZEISS a omite da matriz `ativas` de CAM-001 ou altera flags no próprio payload?).
