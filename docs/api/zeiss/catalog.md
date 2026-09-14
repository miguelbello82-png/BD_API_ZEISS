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
RESPONSE CONTRACT: PENDING FORMALIZATION

## Produtos
RESPONSE CONTRACT: PENDING FORMALIZATION

## Financeiro
RESPONSE CONTRACT: PENDING FORMALIZATION

## Serviços por Produto
RESPONSE CONTRACT: PENDING FORMALIZATION
