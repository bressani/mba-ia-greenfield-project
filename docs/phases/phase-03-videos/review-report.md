# StreamTube — Relatório da Fase 03

A fase entrega upload multipart retomável de até 10 GB, processamento assíncrono e acesso do dono à thumbnail e ao original. O contrato usa o JWT da Fase 02. [Plano técnico](phase-03-videos.md) · [Decisões](../../decisions/technical-decisions-phase-03-videos.md) · [Plano de testes](test-plan.md)

## Persistência da chave do original

O servidor gera a chave `videos/<id>/original` ao criar o rascunho. O PostgreSQL guarda essa chave junto à da thumbnail. Retomada, confirmação, recuperação da confirmação, worker e entrega consultam o valor persistido. A chave interna fica fora da resposta da API. [Migration `1795435209268-AddVideoOriginalKey`](../../../nestjs-project/src/database/migrations/1795435209268-AddVideoOriginalKey.ts)

A migration aplica o mesmo caminho aos registros legados e torna a coluna obrigatória. A prova de upgrade com PostgreSQL e MinIO leu o mesmo objeto pela chave gravada. SHA-256, ETag e data de última modificação permaneceram iguais. O rollback preservou título, arquivo, thumbnail e original. A reaplicação recuperou a chave. [Teste de migrations](../../../nestjs-project/src/database/migrations.integration-spec.ts)

## Validação após a revisão

O Compose isolado executou PostgreSQL, MinIO, Mailpit e o worker do perfil `videos`. Os bancos de integração, E2E e upgrade eram descartáveis e separados. As verificações npm e npx rodaram no serviço `nestjs-api`. [Configuração do Compose](../../../nestjs-project/compose.yaml) · [Guia do backend](../../../nestjs-project/CLAUDE.md#video-uploads-and-processing) · [Referências e versões](library-refs.md)

| Verificação | Exit | Resultado |
|---|---:|---|
| `npm ci` e `npm run migration:run` | 0 | Cinco migrations aplicadas nos bancos de integração e E2E |
| Integração focada com `npm test -- --runInBand --runTestsByPath` | 0 | 10 testes em 3 suítes, cobrindo migrations, storage e fila |
| `npm run test:e2e -- --runInBand --runTestsByPath test/videos.e2e-spec.ts` | 0 | 3 testes de vídeo |
| `npm test -- --runInBand` | 0 | 152 testes em 25 suítes |
| `npm run test:e2e -- --runInBand` | 0 | 55 testes em 4 suítes |
| `npx tsc --noEmit` | 0 | Sem diagnósticos |
| `npx eslint "{src,apps,libs,test}/**/*.ts"` | 0 | Sem autofix, erros ou avisos |
| `npm run openapi:export` e `diff -u` | 0 | JSON idêntico byte a byte, exportado em cópia descartável |

Uma conexão independente observou zero jobs e vídeo em `draft` após rollback. Após commit, observou um job e vídeo em `processing`. Confirmações repetidas recuperaram um original já finalizado e mantiveram um job. A expiração terminal de jobs com destino de falha levou o vídeo a `error`. [Integração transacional da fila](../../../nestjs-project/src/videos/video-queue.integration-spec.ts)

A jornada de vídeo validou cadastro, confirmação por Mailpit, login e isolamento por canal. A requisição anônima recebeu 401 e outro canal recebeu 404. A integração de storage fez HEAD no MinIO com a chave fornecida. O E2E verificou a chave canônica no rascunho e, com uma chave alternativa no banco, comprovou a retomada, a confirmação, a abertura pelo worker e a entrega pela chave persistida. Também verificou metadados, thumbnail, Range 206 e integridade SHA-256 do download. [Integração de storage](../../../nestjs-project/src/videos/video-storage.integration-spec.ts) · [Suíte E2E](../../../nestjs-project/test/videos.e2e-spec.ts)

## Nova execução de 10 GB

O harness de aceite foi executado no ambiente isolado da validação. [Harness](../../../nestjs-project/test/video-10gb-acceptance.mjs)

```bash
cd nestjs-project
docker compose --profile videos exec -T \
  -e MEDIA_CONNECT_ORIGIN=http://minio:9000 nestjs-api \
  node test/video-10gb-acceptance.mjs upload
```

O harness enviou **10.000.000.000 bytes em 150 partes, em 334,61 s**, e saiu com código 0. A API recusou a declaração de 10.000.000.001 bytes com HTTP 400.

| Rota durante o envio | Respostas HTTP 200 | p50 | p95 | Máximo |
|---|---:|---:|---:|---:|
| `GET /` | 1.673/1.673 | 1,49 ms | 2,05 ms | 7,54 ms |
| `GET /videos/:id` autenticado | 48/48 | 4,62 ms | 7,94 ms | 13,18 ms |

O mesmo vídeo chegou a `ready` com H.264 de 2 s, resolução 160×90 e thumbnail JPEG de 314 bytes. O Range retornou 206 com `Content-Range: bytes 0-511/10000000000` e os bytes esperados. A consulta final em PostgreSQL confirmou as chaves persistidas, 10.000.000.000 bytes e job `completed` com zero retries. A mídia sintética foi removida com os volumes descartáveis.

## Limitação e entrega

Ambientes com jobs enfileirados por uma versão intermediária sem destino de falha podem manter vídeos em `processing` quando esses jobs expiram. A instalação validada parte da Fase 02. A revisão final do aluno e a submissão à Full Cycle estão pendentes. [Validação](validation.md) · [Resumo por etapa](progress.md)
