---
kind: phase
name: phase-03-videos
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Receber originais de até 10 GB em multipart retomável, processá-los em segundo plano e disponibilizar ao dono metadados, thumbnail, reprodução por faixas e download.

O plano técnico está disponível para revisão com as evidências de [validation.md](validation.md) e [review-report.md](review-report.md).

## Step Implementations

### SI-03.1 — Baseline

**Technical actions**

- Executar Compose isolado em um banco descartável, instalar a partir do lockfile, verificar readiness, aplicar migrations e executar as suítes existentes em série.
- Registrar totais e falhas da base antes de alterar o backend. Fazer uma medição em repouso que possa ser repetida durante o aceite da transferência.

**Tests** VP-01 do [plano de testes](test-plan.md).

**Dependencies** Nenhuma.

**Acceptance criteria** A revisão consegue reproduzir o baseline e distinguir seus resultados dos testes da Fase 03.

### SI-03.2 — Armazenamento S3 privado

**Technical actions**

- Subir MinIO no Compose com imagem e digest registrados e criar bucket privado.
- Configurar o AWS SDK v3 para assinaturas e operações internas com endpoints apropriados.

| Teste | Camada | Cobertura |
|---|---|---|
| Armazenamento de vídeos | Integração | Operações AWS SDK contra MinIO real e tentativa de leitura anônima. |

**Dependencies** SI-03.1.

**Acceptance criteria** O serviço usa o nome Compose internamente. Um cliente alcança as URLs assinadas com o host configurado para ele.

### SI-03.3 — Modelo de vídeo e autorização

**Technical actions**

- Criar migration e entidade TypeORM com FK para canal, identificação e caminhos únicos, estado, dados de multipart e metadados.
- Reutilizar o JWT existente e resolver `channels.user_id` a partir do `sub`. Consultar recursos por vídeo e canal.

| Teste | Camada | Cobertura |
|---|---|---|
| Migration e entidade de vídeo | Integração | FK, unicidade, padrão de estado e regressão de migrations. |
| Rotas de vídeos | E2E | Isolamento por identidade e dono. |

**Dependencies** SI-03.1.

**Acceptance criteria** Canal inexistente impede a criação. A tentativa de ler ou modificar vídeo de outro canal retorna 404.

### SI-03.4 — Upload multipart retomável

**Technical actions**

- Criar rascunho ao abrir multipart, persistir ID da sessão e fornecer tamanhos de parte esperados.
- Expor listagem das partes armazenadas e assinar somente números válidos da sessão do dono.
- Conferir comprimento, ordenação e presença das partes a partir do storage, antes de concluir. Confirmar o tamanho do objeto por HEAD.

| Teste | Camada | Cobertura |
|---|---|---|
| Regras do upload | E2E e aceite | Quantidade de partes, tamanho da parte final e rejeição acima do limite. |
| Upload de vídeo | Integração | Multipart real, retomada, tamanho divergente e conteúdo faltante. |
| Rotas de vídeos | E2E | Rascunho, assinatura e retomada por HTTP. |

**Dependencies** SI-03.2, SI-03.3.

**Acceptance criteria** Após interrupção o cliente recupera partes que já chegaram. Solicitações incompletas ou incompatíveis com o tamanho registrado não são confirmadas.

### SI-03.5 — Confirmação transacional

**Technical actions**

- Inicializar a fila pg-boss no PostgreSQL existente e adaptar seu executor para o gerenciador transacional TypeORM.
- Atualizar o estado do vídeo e enviar o job na mesma transação, com lock na linha para serializar a confirmação.
- Retomar a confirmação se o storage concluiu e o banco reverteu. Demonstrar rollback e commit com outra conexão.

| Teste | Camada | Cobertura |
|---|---|---|
| Transação de confirmação | Integração | Estado e job juntos, rollback depois do enqueue, commit e confirmações repetidas. |

**Dependencies** SI-03.4.

**Acceptance criteria** Outra conexão observa zero jobs e rascunho depois do rollback. Depois do commit observa processamento e um job. Chamadas repetidas devolvem o estado existente e mantêm um job.

### SI-03.6 — Worker e estados

**Technical actions**

- Subir o worker no Compose com ffprobe e FFmpeg, consumindo a fila real.
- Extrair duração e metadados, gerar thumbnail em JPEG, gravar estado pronto e registrar mídia inválida como erro.
- Usar chaves estáveis e execução tolerante a reentrega. Limpar temporários da execução do worker.

| Teste | Camada | Cobertura |
|---|---|---|
| Processamento de vídeo | E2E | Metadados, imagem, transições e mídia inválida no worker real. |

**Dependencies** SI-03.5.

**Acceptance criteria** A mídia válida fica pronta, com duração e thumbnail. A inválida chega a erro de processamento. O vídeo permanece no storage depois de gerar thumbnail.

### SI-03.7 — Reprodução e download

**Technical actions**

- Enriquecer a consulta do dono para vídeo pronto com links temporários de thumbnail, reprodução do original e download.
- Assinar GET original com disposição de anexo e nome seguro para download.
- Verificar entrega parcial de mídia compatível e igualdade do arquivo baixado.

| Teste | Camada | Cobertura |
|---|---|---|
| Leitura do vídeo | Integração | GET parcial 206 com bytes originais e download com nome e hash. |
| Rotas de vídeos | E2E | Links e metadados disponíveis ao dono. |

**Dependencies** SI-03.6.

**Acceptance criteria** Cliente autorizado recebe as URLs. A mídia compatível é reproduzida e a requisição Range devolve os bytes pedidos.

### SI-03.8 — Aceite e encerramento

**Technical actions**

- Rodar jornada E2E usando autenticação, PostgreSQL, MinIO, fila e worker reais.
- Transferir mídia sintética válida no limite e executar chamadas à API durante o envio. Guardar a comparação com as chamadas em repouso.
- Executar suites finais em série, revisar o diff do lint e registrar decisões, resultados e pendências.

| Teste | Camada | Cobertura |
|---|---|---|
| Jornada de vídeos | E2E | Auth, rascunho, retomada, processamento, acesso de outro canal e entrega do original. |
| Upload no limite | Aceite com Compose | 10.000.000.000 bytes no storage e na API, com comparação de respostas durante a transferência. |

**Dependencies** SI-03.7.

**Acceptance criteria** Critérios mapeados a execução e evidência reproduzível em [test-plan.md](test-plan.md).

## Technical Specifications

### Data Model

| Coluna em `videos` | Tipo | Restrição ou finalidade |
|---|---|---|
| `id` | uuid | Chave primária e identificador estável |
| `channel_id` | uuid | FK obrigatória em `channels.id` |
| `url` | texto | Caminho único do recurso |
| `upload_id` | texto anulável | ID da sessão enquanto houver upload a retomar |
| `title` | varchar de até 255 caracteres | Título do vídeo, separado do nome do arquivo |
| `filename`, `content_type` | texto | Dados de origem e entrega |
| `size_bytes` | bigint | Comprimento declarado e, após confirmar, conferido |
| `status` | enum | `draft`, `processing`, `ready`, `error` |
| `duration_seconds` | double precision anulável | Duração extraída pelo ffprobe |
| `metadata` | jsonb anulável | Metadados úteis do arquivo |
| `original_key` | texto obrigatório | Chave interna do objeto original no MinIO |
| `thumbnail_key` | texto anulável | Chave da imagem gerada |
| `failure_code` | varchar anulável | Indicador de falha de processamento |
| `created_at`, `updated_at` | timestamptz | Datas de criação e atualização |

Um canal pode possuir vários vídeos e a FK é indexada. O servidor gera `videos/{id}/original` ao criar o rascunho e grava o valor em `original_key`. A migration preenche os registros anteriores com esse mesmo caminho, preservando os objetos existentes no MinIO. A retomada multipart, a confirmação, o worker e os links de reprodução e download usam a chave do registro. A chave permanece interna ao contrato HTTP.

### API Contracts

As rotas NestJS abaixo usam `Authorization: Bearer <access_token>` da Fase 02. O corpo de vídeo é compartilhado pelo início, pela consulta e pela confirmação.

| Método e rota | Entrada | Sucesso |
|---|---|---|
| `POST /videos` | JSON com `sizeBytes` inteiro de 1 a 10.000.000.000, `title`, `filename` e `contentType` | 201 com `Location` e o corpo de vídeo em `draft` |
| `GET /videos/:id` | UUID do vídeo | 200 com o corpo de vídeo |
| `GET /videos/:id/upload` | UUID do vídeo | 200 com `{ id, sizeBytes, partSizeBytes, partCount, parts: [{ partNumber, sizeBytes }] }` |
| `POST /videos/:id/upload/parts` | JSON com `partNumbers`, lista de inteiros positivos dentro da sessão | 200 com `{ parts: [{ partNumber, sizeBytes, url }] }` |
| `POST /videos/:id/upload/complete` | UUID do vídeo, sem corpo | 202 com o corpo de vídeo. É idempotente em `processing`, `ready` e `error` |
| `PUT <link temporário de parte>` | Bytes da parte esperada | 200 do MinIO |
| `GET <link temporário do original>` | `Range: bytes=<início>-<fim>` opcional | 206 para faixa satisfazível, 200 para objeto inteiro |
| `GET <link temporário de download>` | Link do original em modo download | 200 com disposição de anexo |

O corpo de vídeo contém `id`, `url`, `title`, `filename`, `contentType`, `sizeBytes`,
`status`, `partSizeBytes`, `durationSeconds`, `metadata`, `failureCode`,
`createdAt` e `updatedAt`. Quando pronto, também inclui
`links: { thumbnail, playback, download }` com URLs temporárias.

Se a confirmação falhar após finalizar o objeto no MinIO, o cliente deve repetir `POST /videos/:id/upload/complete`. O backend reencontra o original pelo seu comprimento. A sessão multipart pode já ter sido encerrada no MinIO nesse intervalo.

### Authorization Matrix

| Operação | Anônimo na API | Outro canal | Dono |
|---|---|---|---|
| Criar rascunho | 401 | Cria em seu próprio canal | Permitido |
| Consultar vídeo | 401 | 404 | Permitido |
| Consultar sessão e assinar partes | 401 | 404 | Permitido durante rascunho |
| Confirmar | 401 | 404 | Permitido e repetível |
| Obter URLs de leitura | 401 | 404 | Permitido quando pronto |

O MinIO valida a assinatura temporária e a operação autorizada no link. Emitir links apenas depois da verificação de propriedade. URLs assinadas funcionam como credenciais de curta duração para quem as possuir.

### Error Catalog

O backend usa a estrutura de erros da Fase 02.

| Código ou classe | HTTP | Condição |
|---|---|---|
| `VALIDATION_ERROR` | 400 | UUID inválido, payload inválido ou tamanho declarado fora do limite |
| `INVALID_UPLOAD_PART` | 400 | Número de parte fora do previsto para a sessão |
| Guard JWT da Fase 02 | 401 | Credencial ausente ou inválida |
| `CHANNEL_NOT_FOUND` | 404 | Usuário autenticado sem canal |
| `VIDEO_NOT_FOUND` | 404 | Vídeo ausente ou pertencente a outro canal |
| `VIDEO_NOT_DRAFT` | 409 | Tentativa de retomar ou emitir partes de upload já encerrado |
| `UPLOAD_INCOMPLETE` | 409 | Partes faltantes, fora de ordem ou alteradas durante a confirmação |
| `UPLOAD_SIZE_MISMATCH` | 409 | Comprimento de parte ou objeto divergente |
| `UPLOAD_UNAVAILABLE` | 409 | Operação multipart sobre sessão encerrada no armazenamento |
| `VIDEO_STORAGE_UNAVAILABLE` | 503 | Armazenamento indisponível |
| `VIDEO_QUEUE_UNAVAILABLE` | 503 | Fila indisponível ou falha no enqueue |
| `INVALID_MEDIA` | Estado `error` | A mídia não oferece imagem de vídeo decodificável |
| `PROCESSING_FAILED` | Estado `error` | A última tentativa do job falhou |

### Events/Messages

| Fila | Payload | Produtor | Consumidor | Entrega |
|---|---|---|---|---|
| `video-processing` | `{ videoId: string }` | Confirmação multipart | Worker ffprobe e FFmpeg | Enqueue na transação da confirmação. O worker atualiza apenas vídeos em processamento e grava a imagem em chave determinística. |
| `video-processing-failed` | `{ videoId: string }` | pg-boss quando um job falha definitivamente | Mesmo worker | Registra `PROCESSING_FAILED` apenas se o vídeo ainda estiver em `processing`. |

## Dependency Map

```text
SI-03.1 Baseline
├── SI-03.2 Armazenamento ─┐
└── SI-03.3 Modelo ───────┤
                          └── SI-03.4 Multipart
                              └── SI-03.5 Confirmação
                                  └── SI-03.6 Worker
                                      └── SI-03.7 Entrega
                                          └── SI-03.8 Aceite
```

## Deliverables

- [x] MinIO privado no Compose com tag e digest verificados.
- [x] Migration de vídeos com vínculo ao canal e URL única.
- [x] Multipart retomável e conferência real do tamanho, com confirmação idempotente.
- [x] Evidência de rollback e commit da transação com fila.
- [x] Worker no Compose, metadados, thumbnail e erro de processamento.
- [x] Reprodução por Range e download do original, restritos ao dono na emissão do link.
- [x] Jornada E2E e transferência real de 10 GB com medição.
- [x] Validar migrations, integração, E2E, TypeScript e lint. Ver os resultados no [relatório](review-report.md#validação-após-a-revisão).
- [ ] Revisão final do aluno e submissão à Full Cycle.
- [x] Documentação de decisões, libs e evidências entregue para revisão local.
