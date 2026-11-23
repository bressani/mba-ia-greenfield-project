# Fase 03 — Especificação

## Jornadas

### US-01 — Enviar e retomar um vídeo

Dado um usuário autenticado pela Fase 02 com seu canal existente, quando ele informa nome, tipo e tamanho, a API cria um rascunho com URL única. O cliente obtém links para as partes, envia os bytes ao MinIO e, após interrupção, consulta as partes armazenadas para enviar as que faltam.

### US-02 — Confirmar e processar automaticamente

Dado um upload completo, quando o dono confirma, a API confere as partes e o tamanho real, finaliza o objeto e confirma o processamento em fila. A repetição da chamada preserva um job. O worker processa o vídeo e expõe na consulta do dono os metadados e a thumbnail quando pronto. Quando a mídia é inválida, o vídeo chega ao estado de erro.

### US-03 — Assistir e baixar

Dado um vídeo pronto, quando o dono consulta o vídeo, recebe links temporários. Um cliente compatível reproduz o original com requisições HTTP Range e pode salvá-lo por download. Para outro canal, o vídeo não é acessível pelas rotas da API.

## Requisitos funcionais

| ID | Requisito | Verificação |
|---|---|---|
| RF-01 | Guardar original e thumbnail em MinIO privado usando S3 | VP-03, VP-06 |
| RF-02 | Persistir rascunho, canal, URL única e informações de retomada | VP-02, VP-03 |
| RF-03 | Suportar upload direto em partes até 10.000.000.000 bytes e retomar a sessão | VP-03, VP-09 |
| RF-04 | Recusar confirmação com partes ausentes ou tamanho real divergente | VP-04 |
| RF-05 | Confirmar em fila uma vez, com estado e job atômicos | VP-05 |
| RF-06 | Processar duração e metadados, gerar thumbnail e registrar falhas da mídia | VP-06, VP-08 |
| RF-07 | Servir faixas e entregar o original no download | VP-07, VP-08 |
| RF-08 | Autorizar pelo canal do JWT existente em todas as rotas | VP-08 |
| RF-09 | Manter a API funcional durante transferência real no limite | VP-09 |

## Restrições

Usar apenas o backend e serviços Compose. O vídeo pode ser inválido mesmo quando satisfaz o limite de bytes, e essa falha é reportada pelo worker. A reprodução depende da compatibilidade do cliente com o original. O upload de aceitação deve usar mídia sintética válida. [Plano de testes](test-plan.md)
