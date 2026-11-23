---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-23
scope_description: "Upload retomável, processamento assíncrono, reprodução e download privado de vídeos."
---

# Decisões técnicas — Fase 03

## TD-01: Armazenamento privado compatível com S3

**Problema.** O vídeo original e a thumbnail precisam persistir fora da API.

**Opções.** MinIO no Compose reproduz o exercício local e suporta as operações S3 requeridas. Um serviço S3 externo reduziria a manutenção local e exigiria conta e credenciais externas. Arquivos no disco da API simplificariam o início e acoplariam a entrega ao processo HTTP.

**Decisão.** MinIO local foi explicitamente escolhido pelo usuário. O servidor Community está arquivado. Fixar tag e digest efetivamente usados e registrar versão e fonte em [library-refs.md](../phases/phase-03-videos/library-refs.md). Usar AWS SDK para JavaScript v3 e separar o endpoint interno do endereço que o cliente usa para URLs assinadas.

**Evidência exigida.** PUT multipart e GET com Range no serviço real, com bucket privado e URLs que funcionam fora do processo da API.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

## TD-02: Upload retomável e limite

**Problema.** Arquivos grandes devem chegar ao armazenamento sem passar pelo processo HTTP da API. A retomada precisa refletir o que o servidor de objetos recebeu.

**Opções.** PUT único simplifica o protocolo e exige reiniciar após falha. Proxy pela API facilita inspeção dos bytes e consome conexões e banda da aplicação. Multipart direto retoma partes e exige gerar links, listar partes e validar o manifesto.

**Decisão.** Multipart direto e retomável exigido pelo usuário. Usar partes de 64 MiB e interpretar 10 GB como 10.000.000.000 bytes, escolhas técnicas registradas para revisão. Conferir quantidade, sequência e comprimento das partes no armazenamento antes de concluir e validar o tamanho do objeto com HEAD. A API recebe metadados e números de partes.

**Evidência exigida.** Retomada depois de interrupção, rejeição de manifesto incompleto ou tamanho real diferente e envio real de 10.000.000.000 bytes com chamadas à API durante o tráfego.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

## TD-03: Persistência, identificação e autorização

**Problema.** Cada vídeo precisa de um identificador estável e de uma autorização baseada no canal da conta autenticada.

**Opções.** Identificador UUID na URL dispensa um gerador de slug. Slug curto separado criaria outra chave e lógica de colisões. Uma sessão em tabela separada serviria a múltiplas sessões por vídeo e complicaria o exercício.

**Decisão.** Tabela `videos` com UUID e caminho único, FK para `channels` e dados de multipart na própria linha. Derivar o canal pelo `sub` autenticado da Fase 02. Responder como recurso ausente quando o vídeo pertence a outro canal. Aplicar a mesma fronteira à retomada, emissão de links, confirmação e consulta.

**Evidência exigida.** Migração com FK e unicidade, criação em rascunho e segundo dono impedido de executar operações sobre o mesmo UUID.

**Libraries:** TypeORM já usado no projeto.

## TD-04: Confirmação idempotente e fila

**Problema.** A mudança do estado do vídeo e a publicação do job devem ser visíveis juntas. Completar no armazenamento e gravar no banco cruzam sistemas distintos.

**Opções.** pg-boss com o executor da transação TypeORM mantém a fila no PostgreSQL existente. Outbox oferece alternativa se a integração transacional não funcionar e exige tabela, despachante e tratamento de duplicidade. Enqueue separado do banco abre janela para perda ou duplicação do job.

**Decisão.** pg-boss é a primeira opção indicada pelo usuário, condicionada à prova de rollback e commit. Serializar a confirmação por vídeo no PostgreSQL. Usar a linha de vídeo e o objeto de chave determinística para permitir nova confirmação quando o storage tiver concluído e o banco tiver falhado. Uma confirmação de vídeo já aceito devolve seu estado corrente sem enviar outro job.

**Evidência exigida.** Outra conexão observa a linha no estado anterior e zero jobs após rollback forçado depois do enqueue. Após commit, observa a mudança de estado e exatamente um job. Confirmações concorrentes e repetidas preservam um job.

**Libraries:** `pg-boss`, TypeORM já usado no projeto.

## TD-05: Processamento e entrega do original

**Problema.** A API precisa permanecer responsiva durante análise e geração de imagem. O original precisa ser reproduzível nos clientes compatíveis e preservado para download.

**Opções.** ffprobe e FFmpeg no worker isolam o custo do processo HTTP. Processamento síncrono economizaria a fila e aumentaria latência. Transcodificação para vários formatos ampliaria a cobertura de reprodução e pertence a outro escopo. Proxy de download também aumentaria o tráfego da API.

**Decisão.** Worker no Compose, ffprobe para metadados e FFmpeg para thumbnail. Proteger as operações com o guard existente. A consulta de um vídeo pronto emite links temporários para thumbnail, Range sobre o original e download do mesmo objeto com disposition de anexo. O suporte de reprodução depende do contêiner e codec do cliente. Formatos aceitos são determinados pela análise do conteúdo. A regra de upload é por tamanho.

**Evidência exigida.** Mídia sintética válida produz metadados e JPEG. Mídia inválida chega a erro. O cliente recebe 206 e os bytes pedidos, reproduz a amostra compatível e confirma o hash do download.

**Libraries:** ffprobe e FFmpeg do ambiente do worker.

## Decisions Summary

| TD | Decisão | Estado |
|---|---|---|
| TD-01 | MinIO no Compose e cliente S3 AWS SDK v3 | Escolha explícita do usuário. Tag, commit e digest executados em [library-refs.md](../phases/phase-03-videos/library-refs.md). |
| TD-02 | Multipart direto retomável, 64 MiB e 10 GB decimal | Fluxo exigido. Tamanho de parte e unidade documentados para revisão. |
| TD-03 | UUID e sessão na tabela de vídeos. Autorização pelo dono | Escopo do usuário com proposta técnica de identificação. |
| TD-04 | pg-boss transacional | Prova com observadora independente e recuperação E2E registrada. |
| TD-05 | Worker FFmpeg, Range e download do original | Escolha explícita do usuário. Jornada com H.264, frame e hash do download demonstrada. |
