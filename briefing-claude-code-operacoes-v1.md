# Briefing para Claude Code — Módulo Operações (Jogos e Viagens) V1

## Contexto
Plataforma Ciente IE (vanilla HTML/JS + Firebase/Firestore, multi-tenant por `clubId`, papéis `admin`/`staff`/`atleta` já existentes). Este briefing cobre a implementação do novo módulo **Operações**, que substitui o antigo item de menu "Logística" e cobre jogos, viagens, convocação, itinerário, checklist e geração de PDF. Arquitetura já revisada em 4 rodadas e congelada — este documento é a especificação final pra V1.

## Objetivo da V1
Permitir que o staff cadastre jogos, crie a operação logística (viagem) vinculada, convoque atletas automaticamente a partir dos grupos já definidos na página Planejamento (G1/G2/G3), monte o itinerário do evento, controle um checklist operacional, e gere um PDF (a única forma de entrega da informação ao atleta — ele não acessa a plataforma).

## Coleções Firestore (todas sob `clubs/{clubId}/`)

```
jogos/{jogoId}
  adversario: string
  competicao: string
  mando: "casa" | "fora"
  dataHoraJogo: timestamp   // âncora, precisão de horário
  local: { estadio, cidade, uf }
  viagemId: string | null   // única referência jogo↔viagem
  status: "agendado" | "em_andamento" | "concluido"

viagens/{viagemId}
  tipoOperacao: "viagem_no_dia" | "concentracao"
  periodo: { inicio: timestamp, fim: timestamp }
  gruposConvocados: string[]   // ex: ["G1","G2"]
  hospedagem: { hotel, endereco, checkin, checkout }
  status: "planejamento" | "confirmada" | "em_andamento" | "concluida"
  criadoPor, criadoEm, atualizadoEm

viagens/{viagemId}/participantes/{participanteId}
  tipo: "atleta" | "staff" | "outro"
  pessoaId: string
  nomeSnapshot: string
  origem: "grupo" | "staff" | "manual"
  grupoOrigem: string | null
  status: "convocado" | "confirmado" | "pendente" | "cortado"
  quarto: string | null
  assentoTransporte: string | null
  observacaoInterna: string | null   // NUNCA entra no PDF
  observacaoPublica: string | null   // pode entrar no PDF

viagens/{viagemId}/itinerario/{eventoId}
  dataHora: timestamp
  tipo: "transporte" | "refeicao" | "treino" | "reuniao" | "concentracao" | "jogo" | "retorno"
  titulo: string
  local: string
  responsavel: string | null
  escopo: "todos" | "grupos" | "atletas"
  destinatarios: string[]   // ids de grupo ou de atleta, conforme escopo
  jogoId: string | null     // obrigatório quando tipo = "jogo"
  transporte: {             // só preenchido quando tipo = "transporte"
    tipoTransporte: "onibus" | "van" | "aviao",
    origem, destino, empresa, numeroVoo, localizador
  } | null
  status: "previsto" | "confirmado" | "alterado"
  criadoEm, criadoPor, atualizadoEm, atualizadoPor

viagens/{viagemId}/checklist/{itemId}
  item: string
  categoria: "material" | "medico" | "documentos" | "uniforme" | "alimentacao" | "outros"
  responsavel: string | null
  prazo: timestamp | null
  status: "pendente" | "ok"
  concluidoPor, concluidoEm
```

## Regras de negócio críticas (não simplificar)

1. **Jogo↔viagem tem fonte única.** Só o jogo guarda `viagemId`. Nunca adicionar `jogoIds[]` na viagem — listar jogos de uma viagem sempre via query `jogos where viagemId == X`.
2. **Convocação automática é snapshot.** Ao selecionar grupos na criação da viagem, gerar os documentos de `participantes` (tipo "atleta", origem "grupo") no momento da criação. Mudanças posteriores no grupo do atleta (feitas no Planejamento) **não** devem alterar retroativamente convocações já geradas.
3. **Staff da comissão é selecionado à parte**, não vem de grupo — participantes com `tipo: "staff"`, `origem: "staff"`.
4. **`observacaoInterna` nunca aparece em PDF gerado**, só `observacaoPublica`. Tratar isso na camada de geração do PDF, não confiar em omissão manual.
5. **Auditoria obrigatória no itinerário** — todo update de evento deve gravar `atualizadoEm`/`atualizadoPor`, habilitando histórico de mudanças de horário.
6. **Atleta não tem acesso à plataforma neste módulo.** Não implementar tela ou regra de leitura para papel `atleta` em `viagens/*`. Entrega é só via PDF.

## Regras de segurança (Firestore rules) — direção geral
- `admin`/`staff` do `clubId`: read/write completo em `jogos`, `viagens` e subcoleções
- `atleta`: sem acesso a `viagens/*` (nem leitura)
- Todas as coleções isoladas por `clubId`, seguindo o padrão já usado no resto da plataforma

## Ordem de implementação (seguir esta sequência)

1. `jogos` — CRUD (formulário + lista)
2. `viagens` — dados gerais + hospedagem (CRUD)
3. `participantes` — seleção de grupos (G1/G2/G3) gera atletas automaticamente; tela separada pra adicionar staff/outros manualmente; ajuste de status individual
4. `itinerario` — CRUD de eventos genérico, com escopo/destinatários múltiplos, campo `jogoId` condicional, bloco `transporte` condicional, auditoria automática em toda escrita
5. `checklist` — CRUD com categoria/prazo/responsável
6. **PDF** — geração Geral / Por grupo / Individual, filtrando por escopo e excluindo `observacaoInterna`
7. Telas de resumo — detalhe da viagem com abas (Visão Geral / Convocação / Itinerário / Hotel / Checklist), card "Próxima Operação" na home

## Fora de escopo da V1 (não implementar ainda)
- Geração automática dos eventos MD/MD-1 a partir de `dataHoraJogo` (planejado como V1.5, logo em seguida)
- Módulo financeiro da operação (custos, fornecedores)
- Notificações automáticas de mudança de horário
- Rooming list visual / roll call de ônibus

## Menu / navegação
Renomear item de menu de "Logística" para **Operações**, com sub-abas: Jogos | Viagens | Próxima Operação.
