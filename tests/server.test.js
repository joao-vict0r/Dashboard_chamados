const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createAppServer } = require("../server");

const ADMIN_PASSWORD = "local-admin-password";
let directory;
let server;
let baseUrl;
let sessionCookie;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paytrack-admin-"));
  server = createAppServer({
    databasePath: path.join(directory, "tickets.sqlite3"),
    adminPassword: ADMIN_PASSWORD
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("write operations reject unauthenticated and cross-origin requests", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/admin/import`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "X-File-Name": "tickets.csv"
    },
    body: "Chamado,Descrição,Tema,Jornada,Data\n1,Teste,Acesso,Acesso,2026-09-01"
  });
  assert.equal(unauthenticated.status, 401);

  const crossOrigin = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { Origin: "http://example.com", "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  assert.equal(crossOrigin.status, 403);
});

test("admin login imports, updates, and preserves weekly ticket history", async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  sessionCookie = login.headers.get("set-cookie").split(";")[0];

  const csv = [
    "Chamado,Descrição,Tema,Jornada,Data",
    "1790969,Descrição revisada,Conta e acesso,Onboarding,01/09/2026",
    "2000001,Novo chamado,Reembolso,Financeiro,10/09/2026"
  ].join("\n");
  const imported = await fetch(`${baseUrl}/api/admin/import`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-File-Name": "tickets.csv"
    },
    body: csv
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { added: 1, updated: 1, weeks: 2 });

  const initialWeek = await fetch(`${baseUrl}/api/tickets?week_start=2026-08-31`);
  const initialTickets = await initialWeek.json();
  assert.equal(initialTickets.length, 9);
  assert.equal(initialTickets.find(ticket => ticket.ticket_id === "1790969").description, "Descrição revisada");

  const weeks = await fetch(`${baseUrl}/api/weeks`);
  const weekData = await weeks.json();
  assert.equal(weekData.length, 2);
  assert.equal(weekData.find(week => week.week_start === "2026-09-07").ticket_count, 1);
});

test("invalid spreadsheets make no database changes", async () => {
  const invalidCsv = [
    "Chamado,Descrição,Tema,Jornada,Data",
    "2000002,Chamado inválido,Acesso,Onboarding,not-a-date"
  ].join("\n");
  const response = await fetch(`${baseUrl}/api/admin/import`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-File-Name": "invalid.csv"
    },
    body: invalidCsv
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Data inválida/);

  const weeks = await fetch(`${baseUrl}/api/weeks`);
  assert.equal((await weeks.json()).length, 2);
});
