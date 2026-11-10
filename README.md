# Dashboard semanal Paytrack

## Requisitos

- Node.js 22.13 ou mais recente (usa o módulo SQLite integrado do Node).
- Python 3 instalado e disponível como `python` no PowerShell. Se necessário, defina `PYTHON` com o caminho do executável.

## Iniciar

Abra o PowerShell na pasta do projeto, configure a senha administrativa para essa sessão e inicie a aplicação:

```powershell
$secure = Read-Host "Senha administrativa" -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password
npm start
```

Use uma senha exclusiva com pelo menos 12 caracteres. Ela não é armazenada no projeto. Mantenha esse terminal aberto e acesse:

- Dashboard: `http://127.0.0.1:3000`
- Atualização de chamados: `http://127.0.0.1:3000/admin`

O servidor aceita conexões somente do próprio computador. A área administrativa usa autenticação por senha, sessão HttpOnly com validade de 8 horas, proteção contra tentativas repetidas e validação de origem nas operações de escrita. Sem uma senha configurada, não é possível entrar nem importar dados.

Os dados ficam em `data/chamados.sqlite3`. Os nove chamados iniciais estão na semana que contém 1º de setembro de 2026.

## Importar planilha

Na tela `/admin`, entre com a senha definida ao iniciar o servidor e selecione um arquivo `.xlsx` ou `.csv` de até 10 MB. O CSV deve estar em UTF-8. São exigidas as colunas:

| Chamado | Descrição | Tema | Jornada | Data |
|---|---|---|---|---|
| 1234567 | Exemplo de descrição | Exemplo de tema | Exemplo de jornada | 01/09/2026 |

As datas aceitas são `AAAA-MM-DD` e `DD/MM/AAAA`. O Excel lê a primeira aba visível. O arquivo é validado integralmente antes de qualquer gravação. Chamados existentes na mesma semana são atualizados; outras semanas são preservadas. Ao concluir, recarregue o dashboard.

## Testes

```powershell
npm test
python -m unittest discover -s tests
```
