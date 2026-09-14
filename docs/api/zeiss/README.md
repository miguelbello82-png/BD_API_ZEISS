# ZEISS API

Documentação da integração com a API ZEISS.

## Política para Collection Postman
O processo oficial de importação e documentação da API ZEISS via Postman segue o fluxo:
**POSTMAN** (bancada de teste/manual) → **EXPORT BRUTO** (input temporário local) → **.local-input/** → **análise** → **sanitização** → **documentação/contratos** → **remoção do export bruto**.

- **REPOSITÓRIO**: somente catálogo/documentação sanitizados.
- Segredos devem ser convertidos para placeholders: `{{ZEISS_API_KEY}}`.
- PII de exemplos deve ser anonimizada ou sintética.
