# ZEISS API Catalog

Domínios mapeados a partir da Collection Postman:

## Mutabilidade e Segurança
Endpoints que alteram estado no fornecedor externo (ex: criação de pedido, ativação/geração de voucher) devem ser explicitamente classificados como `EXTERNAL MUTATION`.
Regra: `ALLOW_EXTERNAL_MUTATIONS=false`. Estes endpoints nunca devem ser executados automaticamente por CI, contract tests normais, smoke tests ou agentes AI sem autorização humana explícita.

*(Nota: A collection original `API ZEISS.postman_collection.json` ainda não está disponível no workspace em `.local-input/` para a extração detalhada de cada request).*

## Pedidos
RESPONSE CONTRACT: PENDING FORMALIZATION

## Tracking
RESPONSE CONTRACT: PENDING FORMALIZATION

## Campanhas
RESPONSE CONTRACT: PENDING FORMALIZATION

## Vouchers
RESPONSE CONTRACT: PENDING FORMALIZATION

## Leads
LEAD-001 documented response:
direct array
HTTP 404: "Campanha não encontrada ou inexistência de leads registrados na campanha" (ambíguo)

LEAD-001 observed runtime response:
{ resumo: object, dados: array }

LEAD-002 observed runtime behavior:
direct array

LEAD Event Identity Model:
Uniqueness is empirically validated against current runtime data, not contractually guaranteed by ZEISS.
IDENTITY_MODEL = LEAD_EVENT
Natural Event Key = campaign_id + voucher_code + email_hmac

Raw PII (nome, email, telefone, cpf, etc) MUST NOT be persisted. Email is used transiently only to derive HMAC.

OBSERVED_RUNTIME_BEHAVIOR
(Note: This is runtime evidence and not an official contractual guarantee)

## Produtos
RESPONSE CONTRACT: PENDING FORMALIZATION

## Financeiro
RESPONSE CONTRACT: PENDING FORMALIZATION

## Serviços por Produto
RESPONSE CONTRACT: PENDING FORMALIZATION
