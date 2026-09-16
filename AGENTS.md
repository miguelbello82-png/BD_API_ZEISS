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

---

# REGRA PERMANENTE DE ISOLAMENTO DO WORKSPACE

Raiz local canônica: `C:\Antigravity\BD_API_ZEISS`
Projeto Supabase canônico: `BD_API_ZEISS` (ref: `bklpztydqllqevekgins`)

---

## 1. PRINCÍPIO ABSOLUTO DE ISOLAMENTO

Trate BD_API_ZEISS como uma plataforma totalmente independente, como se nenhum projeto, app, repositório, integração, documentação ou aplicação consumidora anterior tivesse existido.

- BD_API_ZEISS é uma plataforma independente de dados/integração ZEISS.
- Foco exclusivo na plataforma até entrega.
- Arquitetura, contratos, mapeamentos, persistência, comportamento de sincronização, segurança, documentação e evidências devem ser derivados unicamente deste projeto e de suas fontes autorizadas da ZEISS.

---

## 2. FONTES VÁLIDAS DE IMPLEMENTAÇÃO E EVIDÊNCIA

São fontes válidas exclusivamente:
1. Arquivos contidos estritamente em `C:\Antigravity\BD_API_ZEISS`;
2. Documentação oficial da ZEISS explicitamente incorporada ao BD_API_ZEISS;
3. Respostas reais de APIs da ZEISS obtidas pelo BD_API_ZEISS;
4. O projeto Supabase dedicado `BD_API_ZEISS` (ref: `bklpztydqllqevekgins`);
5. Especificações, testes, evidências de runtime e código criados dentro do BD_API_ZEISS.

---

## 3. FONTES E COMPORTAMENTOS ESTRITAMENTE PROIBIDOS

Nunca inspecione, pesquise, leia, copie, deduza de, compare contra ou use como referência:
- Suite_RMG / Suite RMG
- Mais ZEISS
- app_suite
- Qualquer aplicação consumidora
- Qualquer outro repositório
- Qualquer outro projeto local
- Qualquer outro projeto Supabase
- Qualquer integração legada com a ZEISS
- Qualquer documento originalmente criado para outro projeto
- Qualquer código fora de `C:\Antigravity\BD_API_ZEISS`

Esta proibição aplica-se mesmo que tais arquivos estejam facilmente acessíveis localmente no sistema.
Não utilize artefatos externos ou legados para preencher lacunas de evidência (evidence gaps).

Se uma informação requerida não estiver disponível dentro do BD_API_ZEISS ou em evidências autorizadas da ZEISS:
- **PARE E REPORTE A LACUNA (STOP AND REPORT THE GAP).**
- Jamais procure a resposta em outro projeto.

---

## 4. DIREÇÃO ARQUITETURAL

A única direção de dependência permitida é:
```text
ZEISS APIs
    ↓
BD_API_ZEISS
    ↓
futuras aplicações consumidoras
```
- BD_API_ZEISS NUNCA deve depender de uma aplicação consumidora.
- Nenhuma dependência funcional de qualquer app consumidor.
- Aplicações consumidoras poderão futuramente consumir a Serving API do BD_API_ZEISS.
- Aplicações consumidoras não controlam sync, não controlam scheduler e não definem o comportamento do BD_API_ZEISS.
- Mutations ZEISS nunca entram em sync automático.
- Não hardcodar dados operacionais.

---

## 5. ISOLAMENTO DO BANCO DE DADOS (SUPABASE)

- Para qualquer atividade do BD_API_ZEISS, use UNICAMENTE o projeto Supabase:
  - Nome: `BD_API_ZEISS`
  - Ref: `bklpztydqllqevekgins`
- Nunca inspecione ou utilize outro projeto Supabase a menos que o usuário autorize explicitamente aquele projeto específico para aquela tarefa específica.
- Supabase READ-ONLY por padrão.
- Qualquer alteração remota exige o ciclo rigoroso:
  `PLAN -> REVIEW -> AUTHORIZATION EXPLÍCITA -> EXECUTION -> VALIDATION`.

---

## 6. FRONTEIRA DO WORKSPACE (WORKSPACE BOUNDARY)

- Todas as operações de arquivo para este projeto devem permanecer estritamente sob `C:\Antigravity\BD_API_ZEISS`.
- Não navegue por diretórios pai ou irmãos em busca de exemplos, documentação, código, esquemas ou contexto histórico.

---

## 7. ENFORCEMENT PERMANENTE

Antes de usar qualquer fonte ou tomar qualquer decisão técnica, faça a pergunta interna:
*"Isto pertence canonicamente ao BD_API_ZEISS?"*
- Se **NÃO**: ignore sumariamente.
- Se **INCERTO**: PARE E REPORTE.
- Não solicite confirmações repetitivas ao usuário para passos operacionais dentro de uma tarefa já explicitamente autorizada.
- Esta é uma regra permanente do workspace e aplica-se a todas as tarefas presentes e futuras do BD_API_ZEISS.
