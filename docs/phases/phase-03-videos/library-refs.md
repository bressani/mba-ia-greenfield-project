# Fase 03 — Referências de bibliotecas

As consultas Context7 usaram o endpoint MCP público e `resolve-library-id` / `query-docs`. As consultas de versão e as fontes primárias foram cruzadas com o lockfile, os manuais e os testes locais.

| Componente | Consulta Context7 | API conferida e fonte primária |
|---|---|---|
| AWS SDK v3 `3.996.0` | `/aws/aws-sdk-js-v3/v3.996.0` | `getSignedUrl`, `signableHeaders`, configuração de checksum e `forcePathStyle`. [Presigner versionado](https://github.com/aws/aws-sdk-js-v3/blob/v3.996.0/packages/s3-request-presigner/README.md) · [Configuração de clientes](https://github.com/aws/aws-sdk-js-v3/blob/v3.996.0/supplemental-docs/CLIENTS.md) |
| S3 multipart e download | AWS SDK v3 na consulta acima | `ListParts` informa tamanho e ETag, `CompleteMultipartUpload` recebe os ETags ordenados e `GetObject` aceita Range e disposição de anexo. [ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html) · [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html) · [GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) |
| TypeORM `0.3.28` | `/typeorm/typeorm/0.3.28` | Gerenciador da transação e conexão isolada por QueryRunner. [Transações](https://github.com/typeorm/typeorm/blob/0.3.28/docs/docs/advanced-topics/2-transactions.md) |
| pg-boss `10.4.0` | `/timgit/pg-boss/10.4.0` | `send` usa o executor `db.executeSql` fornecido por chamada, que retorna `{ rows }`. [Contrato](https://github.com/timgit/pg-boss/blob/10.4.0/docs/api/jobs.md) · [Implementação](https://github.com/timgit/pg-boss/blob/10.4.0/src/manager.js#L314-L359) |
| FFmpeg/ffprobe `5.1.9` | `/websites/ffmpeg_documentation` retornou a documentação corrente. A tentativa versionada `/ffmpeg/ffmpeg/n5.1` retornou sem conteúdo. | `-show_entries`, saída JSON, `-map` e `-frames:v 1` conferidos nos manuais Bookworm da série instalada. [ffprobe](https://manpages.debian.org/bookworm/ffmpeg/ffprobe.1.en.html) · [FFmpeg](https://manpages.debian.org/bookworm/ffmpeg/ffmpeg.1.en.html) |

## Imagem MinIO Community

O upstream está arquivado e a distribuição Community passou a oferecer a última release por código-fonte. Os pulls de duas tags antigas no Quay retornaram HTTP 401 e o Docker Hub retornou acesso negado. O Compose constrói a release oficial `RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`, com as bases Go e Debian identificadas por digest em [Dockerfile.minio](../../../nestjs-project/Dockerfile.minio). O Dockerfile do upstream aponta para uma imagem que estava indisponível neste ambiente. [Repositório arquivado](https://github.com/minio/minio) · [Release oficial](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)

O ambiente final executou `streamtube-minio@sha256:ec399540639ea18cb5af97be59766130a4077f3d3ae66fc51f90d5979a1f2167` em linux/amd64. O digest do índice OCI saiu do `--metadata-file` do Buildx e correspondeu a `docker image inspect` e `docker inspect` do serviço. O binário confirmou o commit da release e Go 1.24.8. O índice é local ao build verificado. Para reproduzir em outro daemon, construir o Dockerfile fixado e usar o digest do build disponível naquele daemon.
