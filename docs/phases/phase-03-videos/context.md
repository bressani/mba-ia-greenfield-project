---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-23T08:46:07-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-23T09:14:01-03:00"
---

# Fase 03 — Contexto

## Scope

O plano geral descreve armazenamento de vídeos e thumbnails, fila, upload de até 10 GB, criação automática do rascunho, processamento, thumbnail, URL única, reprodução por streaming e download. Esta fase usa o backend NestJS e o Compose. A edição e publicação entram na Fase 04. A visualização pública entra na Fase 05. [Plano geral](../../project-plan.md)

A fase usa MinIO local, cliente AWS SDK v3, multipart retomável, processamento assíncrono, autenticação da Fase 02 e comprovação com serviços reais.

## Decisions Index

| ID | Scope | Status | Decisão | Bibliotecas |
|---|---|---|---|---|
| TD-01 | Infraestrutura | decided | MinIO privado e endpoint separado de assinatura | AWS SDK v3 |
| TD-02 | Infraestrutura e API | decided | Multipart direto e retomável | AWS SDK v3 |
| TD-03 | Banco e API | decided | Identificar dono pelo canal existente | TypeORM |
| TD-04 | Fila | decided | pg-boss vinculado à transação TypeORM com prova em PostgreSQL | pg-boss |
| TD-05 | Worker e entrega | decided | ffprobe, FFmpeg, Range e anexo original | FFmpeg |

## Capability Coverage

| Capacidade | Decisão |
|---|---|
| Serviço de armazenamento | TD-01 |
| Upload de até 10 GB, retomada e rascunho | TD-02, TD-03 |
| URL única e controle do dono | TD-03 |
| Processamento assíncrono e confirmação idempotente | TD-04 |
| Metadados, thumbnail, Range e download | TD-05 |

## Decisions Detail

Os detalhes, alternativas, trade-offs e testes de decisão estão no [registro de decisões](../../decisions/technical-decisions-phase-03-videos.md). O tamanho de parte, a unidade decimal e os nomes de contratos são escolhas de implementação registradas para revisão. A atomicidade entre a linha e o job foi observada de outra conexão no teste de rollback e commit.

## Inherited Decisions Detail

Usar o guard JWT existente e `CurrentUser().sub` para resolver `channels.user_id`. Manter `class-validator`, a validação global e a resposta de erro do backend. Aplicar migrations TypeORM com `synchronize: false` na aplicação. [Decisões da Fase 02](../../decisions/technical-decisions-phase-02-auth.md)

## Inherited Conventions

- Configuração de infraestrutura por variáveis de ambiente e nomes dos serviços no Compose.
- Comandos do projeto dentro do contêiner. Integração e E2E em série contra o banco de teste.
- A branch de entrega `feature/phase-03-videos` tem como base `dev`.

## Testing Requirements

Usar `*.spec.ts` para unidades, `*.integration-spec.ts` para contratos reais com PostgreSQL, MinIO ou worker e `*.e2e-spec.ts` para o fluxo HTTP via autenticação existente. Aplicar os mesmos pipes e filtros em testes que inicializam NestJS fora de `main.ts`. [Guia do backend](../../../.claude/skills/testing-guide-nestjs-project/SKILL.md)
