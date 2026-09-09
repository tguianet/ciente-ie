# Briefing — Página de Resumo do Atleta (Ciente IE)

Documento de implementação. Referência visual: `resumo-atleta.html` (mockup estático com dados fictícios).

---

## 1. Objetivo

Criar uma página de resumo do atleta que responda, em uma tela e sem cliques, à pergunta
"como esse atleta chegou hoje e o que aconteceu com ele na última semana".

Hoje o modal do dashboard entrega abas e indicadores crus. A página substitui a navegação por
abas por uma leitura vertical única, com os blocos na ordem de decisão de quem lê (comissão
técnica e departamento médico).

**Não faz parte deste escopo:**
- Nenhum veredito/rótulo de estado no topo (removido).
- Nenhum texto interpretativo gerado por IA nesta página. A página exibe apenas dado medido
  e classificação determinística. Justificativa da IA continua vivendo na Prescrição de Sessão.
- Edição de dados. A página é leitura, com exceção dos CTAs de coleta pendente.

---

## 2. Entrada e navegação

- Rota sugerida: `resumo_atleta.html?clubId={clubId}&atletaId={atletaId}`
- Origem: clique no card do atleta no dashboard.
- **Decisão a confirmar:** o modal atual permanece como visão rápida (3 números + botão
  "Resumo completo") ou é substituído de vez pela página? Recomendação: manter o modal enxuto,
  porque o uso à beira do campo é de 3 segundos.
- Respeitar isolamento multi-tenant por `clubId` e as regras de role (`admin` / `staff` / `atleta`).
  Perfil `atleta` só acessa o próprio resumo.

---

## 3. Estrutura da página

```
┌──────────────────────────────────────────────┐
│ [avatar]  NOME DO ATLETA          [tags]     │
│           Posição · idade                    │
├──────────────────────┬───────────────────────┤
│ PRONTIDÃO (IGP)      │ TENDÊNCIA (ISP)       │
│ 68 /100              │ -4,2% por semana      │
│ Atenção leve         │ r² 0,71 · 4 semanas   │
├──────────────────────┴───────────────────────┤
│ FADIGA    [Aguda]  [Residual]  [Persistente] │
├──────────────────────────────────────────────┤
│ TESTES DA SEMANA         (n de 4 eixos)      │
│ CMJ · qua 02/09        34,2 cm      −6,1%    │
│ VFC (RMSSD) · qui      94 ms        +8,3%    │
│ Hooper · 5 de 7 dias   14 pts       +2       │
├──────────────────────────────────────────────┤
│ CARGA DA SEMANA                              │
│ [Treino] [PSE média] [Distância] [HSR]       │
├──────────────────────────────────────────────┤
│ JOGOS · ÚLTIMOS 10 DIAS         (3 jogos)    │
│ 94 min por jogo                              │
│ (Alta exposição)                             │
│ [90' 24/08] →4d→ [98' 28/08] →3d→ [95' 31/08]│
├──────────────────────────────────────────────┤
│ DOR RELATADA NA SEMANA                       │
│ Tibial anterior esq.  ▪▪▪▪▪▫▫▫▫▫    5/10     │
├──────────────────────────────────────────────┤
│ Período · última atualização                 │
└──────────────────────────────────────────────┘
```

A ordem dos blocos é fixa e faz parte da especificação: estado atual → direção → fadiga →
o que foi medido → o que foi feito → exposição competitiva → sintoma.

---

## 4. Blocos, dados e regras

> **Antes de escrever código:** mapear cada campo abaixo para o schema atual do Firestore.
> Os nomes usados aqui são descritivos, não são nomes de campo. Reaproveitar o que já existe
> (cálculo do IGP, ISP Tendência, bloco `scores.fadiga`, coleções de testes, PSE, GPS) em vez de
> recalcular na página. Se algum índice hoje só é calculado em outra tela, extrair para um módulo
> comum antes de duplicar a lógica.

### 4.1 Cabeçalho
Nome, posição, idade, foto ou iniciais. Tags à direita indicam quais fontes o atleta tem ativas
na semana (VFC, CMJ, GPS, Hooper) — funcionam como legenda de cobertura de coleta.

### 4.2 Prontidão global (IGP)
- Valor 0–100 e tier: ≥70 Estável · 60–69 Atenção leve · 50–59 Atenção · <50 Crítico.
- Linha de apoio: qual sistema puxou o índice para baixo (pior dos quatro do MIHBD-TE).
- Cor vem do tier, nunca escolhida à mão.

### 4.3 Tendência (ISP)
- Variação semanal, classificação por r², janela de 4 semanas.
- Linha de apoio: r² e número de semanas efetivamente disponíveis.

### 4.4 Fadiga
- Três chips: aguda, residual, persistente. Usar os níveis já produzidos pelo flagging por z-score/MAD.
- Cada chip carrega nome + nível, com cor por severidade.

### 4.5 Testes da semana
- Lista os testes efetivamente realizados nos últimos 7 dias: CMJ, VFC (RMSSD), Hooper, NeuroScore.
- Cada linha: nome, quando foi feito, valor + unidade, e **delta contra o baseline individual** do atleta.
- O delta é obrigatório. Valor absoluto sozinho não é legível para quem não decorou o baseline.
- Contador no cabeçalho do bloco: quantos dos 4 eixos têm coleta na semana.
- Hooper mostra aderência ("5 de 7 dias") no lugar da data.

### 4.6 Carga da semana
Quatro métricas, últimos 7 dias:
| Métrica | Valor | Linha de apoio |
|---|---|---|
| Treino | minutos totais | número de sessões |
| PSE média | UA | maior PSE da semana e o dia |
| Distância | km | comparação com a média do atleta |
| HSR | m | comparação com a média do atleta |

### 4.7 Jogos — últimos 10 dias
- Número grande = **média de minutos por jogo** (não o total de jogos).
- Classificação de exposição:
  - `> 75 min/jogo` → **Alta exposição**
  - `40 a 74 min/jogo` → **Exposição intermediária**
  - `< 40 min/jogo` → **Baixa exposição**
- Total de jogos vai no canto do cabeçalho do bloco.
- Timeline horizontal: um chip por jogo (minutos + data) com o intervalo em dias entre eles.
- Alerta textual quando houver intervalo inferior a 5 dias entre partidas.
- Sem jogos no período: mostrar "Sem jogos nos últimos 10 dias" e suprimir a classificação.

### 4.8 Dor relatada na semana
- Uma linha por região relatada: região, escala visual de 10 marcas preenchida até o EVA, valor `n/10`.
- Ordenar por EVA decrescente.
- Cor por faixa de EVA.
- Sem relato: "Nenhuma dor relatada nos 7 dias" — isso é informação, não vazio.

### 4.9 Rodapé
Período coberto (datas) e horário da última atualização dos dados.

---

## 5. Definição das janelas

- **Semana** = últimos 7 dias corridos a partir de hoje, para todos os blocos que dizem "da semana".
  *Confirmar:* se a comissão raciocina por microciclo (jogo a jogo), a janela deveria acompanhar o
  microciclo em vez do calendário. Vale decidir antes de implementar, porque muda a leitura de carga.
- **Jogos** = últimos 10 dias corridos, conforme especificado.
- Fuso horário do clube. Datas em `dd/mm`.

---

## 6. Estados vazios — requisito central

A maioria dos atletas não terá todos os blocos preenchidos. Layout denso com buracos fica pior
que layout simples. Regras:

1. **Nenhum bloco mostra "Sem dados".** Toda ausência declara o que falta e quanto falta:
   "Faltam 3 dias de Hooper e 1 CMJ para calcular."
2. Quando existe ação possível, o bloco vazio traz um CTA que leva direto ao registro da coleta.
3. Ausência estrutural (ISP sem 4 semanas de histórico) explica a exigência e não oferece CTA.
4. Métrica isolada sem dado dentro de um bloco preenchido: traço `—` e o motivo na linha de apoio
   ("GPS não coletado").
5. Blocos vazios usam tratamento visual distinto (fundo neutro, borda tracejada) para não competirem
   com dado real na varredura.

O mockup tem um alternador entre atleta completo e atleta com coleta parcial. **Testar contra o
caso parcial primeiro** — ele é o caso comum no dia a dia.

---

## 7. Implementação

- Stack: HTML/JS vanilla + Firestore, seguindo o padrão dos módulos existentes.
- Uma leitura por bloco, com skeleton enquanto carrega. Blocos renderizam conforme chegam; a página
  não fica em branco esperando o último.
- Cores derivam sempre de tiers/classificações calculadas, nunca hardcoded por bloco.
- Tokens de cor em `:root`, com variantes de tema escuro.
- Responsivo até 360px: blocos de duas colunas viram uma; a grade de carga vira 2×2; a timeline de
  jogos quebra em linha.
- Foco visível no teclado nos CTAs.
- Sem chamadas de IA nesta página.

---

## 8. Critérios de aceite

- [ ] Atleta com coleta completa renderiza os 8 blocos com dados reais do Firestore.
- [ ] Atleta com apenas Hooper renderiza a página inteira sem nenhum "Sem dados" e sem buraco visual.
- [ ] Tier do IGP e classificação de exposição batem com os limiares definidos, testados nas bordas
      (69/70, 39/40, 74/75).
- [ ] Delta dos testes usa baseline individual do atleta, não média do elenco.
- [ ] Jogos: média de minutos, contagem e intervalos conferem contra a fonte.
- [ ] Isolamento por `clubId` validado; perfil `atleta` acessa apenas o próprio resumo.
- [ ] Legível em 360px sem rolagem horizontal.

---

## 9. Pendências para decidir

1. Modal permanece como visão rápida ou é substituído pela página?
2. Janela "semana": 7 dias corridos ou microciclo?
3. Comparações de carga (distância e HSR) usam média das últimas 4 semanas do atleta ou outro
   referencial?
4. Origem do relato de dor: entra pelo Hooper diário, pelo módulo médico, ou pelos dois?
