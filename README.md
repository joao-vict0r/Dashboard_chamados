# Dashboard semanal Paytrack

## Requisitos

- Node.js 22.13 ou mais recente (usa o módulo SQLite integrado do Node).

## Iniciar

No terminal, entre na pasta do projeto e execute:

```powershell
npm start
```

Abra `http://127.0.0.1:3000`. Os dados são armazenados em `data/chamados.sqlite3`.

## Atualizar a base

Na página, importe um CSV separado por ponto e vírgula ou vírgula, com uma linha de cabeçalho e estas colunas:

```text
Chamado;Descrição;Tema;Jornada;Data
```

A data aceita `AAAA-MM-DD` ou `DD/MM/AAAA`. Os nomes de cabeçalho aceitam variações sem acentos, como `Descricao` e `Data do chamado`. A semana ISO vai de segunda-feira a domingo. O mesmo chamado pode ser atualizado dentro da semana ou aparecer em semanas diferentes, mantendo o histórico semanal.

Os nove chamados iniciais estão na semana que contém 1º de setembro de 2026.
