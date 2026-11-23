# Fase 03 — Plano de testes

Rodar comandos npm e npx no contêiner. Usar PostgreSQL e bucket de teste descartáveis. Rodar as suítes em série para evitar interferência entre casos. Guardar códigos HTTP, hashes, tamanhos e tempos. Omitir credenciais e URLs assinadas.

| ID | Camada | Cenário e critério |
|---|---|---|
| VP-01 | Baseline | Aplicar migrations de Fases 01 e 02 e rodar suítes existentes antes de alterar o backend. Registrar comandos, contagens, estado da infraestrutura e falhas pré-existentes. |
| VP-02 | Integração | Rodar migration de vídeos, provar FK ao canal, estado padrão, caminhos únicos e reversão sem afetar tabelas anteriores. |
| VP-03 | Integração e E2E | Criar rascunho, enviar uma parte real com URL temporária, interromper e pedir status. A parte persistida aparece e o fluxo retoma com as restantes. Bucket privado. |
| VP-04 | Integração | Omitir parte, adulterar tamanho declarado e simular discrepância de bytes. A confirmação falha; nenhum job e nenhum estado de processamento persistem. |
| VP-05 | Integração | Forçar exceção depois de inserir o job na transação. Outra conexão observa o rascunho e zero jobs. Depois de commit, outra conexão observa o estado de processamento e um job. Repetir e concorrer confirmações e conferir que o total continua um. |
| VP-06 | Integração via jornada E2E | Usar fila, storage e FFmpeg reais. Mídia válida produz duração, metadados, estado pronto e thumbnail JPEG acessível. Mídia inválida chega a erro. |
| VP-07 | Integração | GET original com `Range: bytes=0-31` retorna 206, `Content-Range` correto e 32 bytes correspondentes. GET de download contém disposição de anexo e hash idêntico ao original. |
| VP-08 | E2E | Cadastrar, confirmar e autenticar pela estrutura existente. Criar rascunho, enviar e retomar partes, confirmar, aguardar o worker e consultar o resultado. Verificar metadados, thumbnail, faixa, reprodução representativa e download. Repetir com outro dono sobre o mesmo recurso e esperar recusa de todas as operações. Uma rota sem autenticação retorna 401. |
| VP-09 | Aceite com Compose | Gerar mídia sintética válida de exatamente 10.000.000.000 bytes, enviar todos os bytes reais e confirmar tamanho no storage e API. Comparar o `GET /` da Fase 02 em repouso com o da Fase 03 durante o upload e registrar também chamadas autenticadas ao vídeo em envio. Validar processamento e leitura parcial do original. Guardar a evidência. |
| VP-10 | Fechamento | Rodar `npm test -- --runInBand`, `npm run test:e2e -- --runInBand`, `npx tsc --noEmit` e `npm run lint`. Inspecionar o diff produzido pelo lint. |

Para a prova de VP-05, deixar o consumidor desligado até a contagem e executar a falha depois de registrar o ID devolvido pelo enqueue. Consultar os jobs por fila e ID do vídeo com um cliente PostgreSQL ou outro DataSource que usa sua própria conexão. Verificar a linha e o job após o encerramento da transação. Testar repetição depois de commit e depois de uma falha que tenha deixado o objeto já concluído.

Para VP-09, usar cadência de 200 ms para a rota de referência `GET /`. Durante o upload, medir também a rota autenticada `GET /videos/:id`, com cadência de 7 s devido ao limite da Fase 02. O cliente gera um MP4 válido com uma caixa de preenchimento ISO BMFF `free` e transmite os bytes dessa caixa diretamente em partes.
