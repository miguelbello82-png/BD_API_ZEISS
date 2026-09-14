# GOVERNANÇA DO PROJETO BD_API_ZEISS

- BD_API_ZEISS é independente de qualquer app.
- Foco exclusivo na plataforma até entrega.
- Supabase READ-ONLY por padrão.
- Qualquer alteração remota exige: PLAN -> REVIEW -> AUTHORIZATION EXPLÍCITA -> EXECUTION -> VALIDATION.
- Não hardcodar dados operacionais.
- ZEISS é fonte externa oficial.
- Apps consumidores não controlam sync.
- Mutations ZEISS nunca entram em sync automático.
- Nenhuma dependência funcional da Suite_RMG.
