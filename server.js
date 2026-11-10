const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const INITIAL_WEEK_DATE = "2026-09-01";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/script.js": ["script.js", "text/javascript; charset=utf-8"],
  "/admin": ["admin.html", "text/html; charset=utf-8"],
  "/admin.html": ["admin.html", "text/html; charset=utf-8"],
  "/admin.css": ["admin.css", "text/css; charset=utf-8"],
  "/admin.js": ["admin.js", "text/javascript; charset=utf-8"]
};

const initialTickets = [
  ["1790969", "Primeiro acesso ao sistema", "Acesso e primeiro acesso", "Onboarding"],
  ["1792483", "Dúvida de prestação de contas", "Prestação de contas", "Gestão de despesas"],
  ["1795766", "Usuário e senha desconhecidos", "Acesso e primeiro acesso", "Acesso"],
  ["1803843", "Recebimento de reembolso", "Recebimento de reembolso", "Reembolso"],
  ["1804612", "Recebimento de reembolso", "Recebimento de reembolso", "Reembolso"],
  ["1805304", "Criação de despesas", "Criação de despesas", "Gestão de despesas"],
  ["1862190", "Criação de despesas no primeiro acesso", "Criação de despesas", "Onboarding"],
  ["1869494", "Criação de despesas no primeiro acesso", "Criação de despesas", "Onboarding"],
  ["1895914", "Dúvida de prestação de contas", "Prestação de contas", "Gestão de despesas"]
];

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === value;
}

function weekStartForDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function createDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);

  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      description TEXT NOT NULL,
      theme TEXT NOT NULL,
      journey TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      week_start TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (ticket_id, week_start)
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_week_start ON tickets (week_start);
    CREATE INDEX IF NOT EXISTS idx_tickets_theme ON tickets (week_start, theme);
  `);

  const count = database.prepare("SELECT COUNT(*) AS count FROM tickets").get().count;
  if (count === 0) {
    const weekStart = weekStartForDate(INITIAL_WEEK_DATE);
    const insert = database.prepare(`
      INSERT INTO tickets (ticket_id, description, theme, journey, opened_at, week_start)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    withTransaction(database, () => {
      for (const [ticketId, description, theme, journey] of initialTickets) {
        insert.run(ticketId, description, theme, journey, INITIAL_WEEK_DATE, weekStart);
      }
    });
  }

  return database;
}

function withTransaction(database, action) {
  database.exec("BEGIN IMMEDIATE");
  try {
    action();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function getClientAddress(request) {
  const address = request.socket.remoteAddress || "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isLocalClient(request) {
  const address = getClientAddress(request);
  return address === "::1" || address === "127.0.0.1";
}

function hasSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || !request.headers.host) return false;
  try {
    const parsed = new URL(origin);
    const requestUrl = new URL(`http://${request.headers.host}`);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    return parsed.protocol === "http:"
      && parsed.host === request.headers.host
      && loopbackHosts.has(requestUrl.hostname);
  } catch {
    return false;
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function getSession(request, sessions) {
  const token = parseCookies(request.headers.cookie).admin_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        request.resume();
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        const error = new Error(`O limite por arquivo é de ${maxBytes / 1024 / 1024} MB.`);
        error.status = 413;
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("error", reject);
  });
}

function runSpreadsheetParser(fileName, content) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || "python";
    const child = spawn(python, [
      path.join(__dirname, "spreadsheet_import.py"),
      "--json",
      fileName
    ], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      if (error.code === "ENOENT") {
        reject(new Error("Python não foi encontrado. Instale o Python e configure PYTHON, se necessário."));
      } else {
        reject(new Error("Não foi possível iniciar o validador de planilhas."));
      }
    });
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "A planilha não passou na validação."));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("O validador retornou dados inválidos."));
      }
    });
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(new Error("Não foi possível enviar a planilha ao validador."));
    });
    child.stdin.end(content);
  });
}

function isValidImportedRecord(record) {
  return record && typeof record === "object"
    && /^[0-9]+$/.test(record.ticket_id)
    && typeof record.description === "string" && record.description.length > 0
    && typeof record.theme === "string" && record.theme.length > 0
    && typeof record.journey === "string" && record.journey.length > 0
    && isValidDate(record.opened_at)
    && isValidDate(record.week_start)
    && weekStartForDate(record.opened_at) === record.week_start;
}

function createAppServer(options = {}) {
  const databasePath = options.databasePath || path.join(__dirname, "data", "chamados.sqlite3");
  const database = createDatabase(databasePath);
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? "";
  const adminConfigured = adminPassword.length >= 12;
  const sessions = new Map();
  const loginAttempts = new Map();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname.startsWith("/api/admin/") && !isLocalClient(request)) {
      sendJson(response, 403, { error: "A área administrativa só aceita conexões locais." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/session") {
      sendJson(response, 200, {
        configured: adminConfigured,
        authenticated: adminConfigured && Boolean(getSession(request, sessions))
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/login") {
      if (!hasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não autorizada." });
        return;
      }
      if (!adminConfigured) {
        sendJson(response, 503, { error: "Configure ADMIN_PASSWORD com pelo menos 12 caracteres antes de usar a área administrativa." });
        return;
      }

      const address = getClientAddress(request);
      const now = Date.now();
      const attempt = loginAttempts.get(address);
      if (attempt && attempt.windowEndsAt > now && attempt.count >= MAX_LOGIN_ATTEMPTS) {
        response.setHeader("Retry-After", Math.ceil((attempt.windowEndsAt - now) / 1000));
        sendJson(response, 429, { error: "Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente." });
        return;
      }

      try {
        const body = await readRequestBody(request, 8 * 1024);
        const credentials = JSON.parse(body.toString("utf8"));
        const provided = typeof credentials.password === "string" ? credentials.password : "";
        const expectedBytes = Buffer.from(adminPassword);
        const providedBytes = Buffer.from(provided);
        const passwordMatches = expectedBytes.length === providedBytes.length
          && timingSafeEqual(expectedBytes, providedBytes);

        if (!passwordMatches) {
          const current = attempt && attempt.windowEndsAt > now
            ? attempt
            : { count: 0, windowEndsAt: now + LOGIN_WINDOW_MS };
          current.count += 1;
          loginAttempts.set(address, current);
          sendJson(response, 401, { error: "Senha incorreta." });
          return;
        }

        loginAttempts.delete(address);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, { expiresAt: now + SESSION_DURATION_MS });
        response.setHeader("Set-Cookie", [
          `admin_session=${token}`,
          "HttpOnly",
          "SameSite=Strict",
          "Path=/",
          `Max-Age=${SESSION_DURATION_MS / 1000}`
        ].join("; "));
        sendJson(response, 200, { authenticated: true });
      } catch (error) {
        sendJson(response, error.status || 400, { error: error.status ? error.message : "Solicitação de login inválida." });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
      if (!hasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não autorizada." });
        return;
      }
      const token = getSession(request, sessions);
      if (token) sessions.delete(token);
      response.setHeader("Set-Cookie", "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      sendJson(response, 200, { authenticated: false });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/import") {
      if (!hasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não autorizada." });
        return;
      }
      if (!adminConfigured || !getSession(request, sessions)) {
        sendJson(response, 401, { error: "Entre na área administrativa antes de importar." });
        return;
      }

      try {
        let fileName;
        try {
          fileName = decodeURIComponent(request.headers["x-file-name"] || "");
        } catch {
          sendJson(response, 400, { error: "Nome de arquivo inválido." });
          return;
        }
        if (path.basename(fileName) !== fileName || ![".csv", ".xlsx"].includes(path.extname(fileName).toLowerCase())) {
          sendJson(response, 400, { error: "Envie uma planilha .xlsx ou um arquivo .csv." });
          return;
        }

        const content = await readRequestBody(request, MAX_UPLOAD_BYTES);
        const records = await runSpreadsheetParser(fileName, content);
        if (!Array.isArray(records) || records.length === 0 || !records.every(isValidImportedRecord)) {
          sendJson(response, 400, { error: "A planilha contém registros inválidos." });
          return;
        }

        const existing = database.prepare(
          "SELECT 1 FROM tickets WHERE ticket_id = ? AND week_start = ?"
        );
        const upsert = database.prepare(`
          INSERT INTO tickets (ticket_id, description, theme, journey, opened_at, week_start)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (ticket_id, week_start) DO UPDATE SET
            description = excluded.description,
            theme = excluded.theme,
            journey = excluded.journey,
            opened_at = excluded.opened_at,
            imported_at = CURRENT_TIMESTAMP
        `);
        let added = 0;
        let updated = 0;
        const weeks = new Set(records.map(record => record.week_start));
        withTransaction(database, () => {
          for (const record of records) {
            if (existing.get(record.ticket_id, record.week_start)) updated += 1;
            else added += 1;
            upsert.run(
              record.ticket_id,
              record.description,
              record.theme,
              record.journey,
              record.opened_at,
              record.week_start
            );
          }
        });

        sendJson(response, 200, { added, updated, weeks: weeks.size });
      } catch (error) {
        if (error.status) {
          sendJson(response, error.status, { error: error.message });
        } else {
          console.error("Falha ao importar planilha:", error);
          sendJson(response, 400, { error: error.message || "Não foi possível importar a planilha." });
        }
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/weeks") {
      const weeks = database.prepare(`
        SELECT
          week_start,
          COUNT(*) AS ticket_count,
          (
            SELECT theme
            FROM tickets AS ranked
            WHERE ranked.week_start = tickets.week_start
            GROUP BY theme
            ORDER BY COUNT(*) DESC, theme COLLATE NOCASE ASC
            LIMIT 1
          ) AS top_theme,
          (
            SELECT COUNT(*)
            FROM tickets AS top
            WHERE top.week_start = tickets.week_start
              AND top.theme = (
                SELECT theme
                FROM tickets AS ranked
                WHERE ranked.week_start = tickets.week_start
                GROUP BY theme
                ORDER BY COUNT(*) DESC, theme COLLATE NOCASE ASC
                LIMIT 1
              )
          ) AS top_theme_count
        FROM tickets
        GROUP BY week_start
        ORDER BY week_start DESC
      `).all().map(week => ({
        ...week,
        week_end: addDays(week.week_start, 6),
        top_theme_share: week.top_theme_count / week.ticket_count
      }));

      sendJson(response, 200, weeks);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tickets") {
      const weekStart = url.searchParams.get("week_start");
      if (!weekStart || !isValidDate(weekStart) || weekStartForDate(weekStart) !== weekStart) {
        sendJson(response, 400, { error: "Informe o início da semana ISO no formato AAAA-MM-DD." });
        return;
      }

      const tickets = database.prepare(`
        SELECT ticket_id, description, theme, journey, opened_at
        FROM tickets
        WHERE week_start = ?
        ORDER BY opened_at, ticket_id
      `).all(weekStart);

      sendJson(response, 200, tickets);
      return;
    }

    if (request.method === "GET" && STATIC_FILES[url.pathname]) {
      const [fileName, contentType] = STATIC_FILES[url.pathname];
      let contents;
      try {
        contents = fs.readFileSync(path.join(__dirname, fileName));
      } catch (error) {
        console.error(`Falha ao carregar ${fileName}:`, error);
        sendJson(response, 500, { error: "Não foi possível carregar os arquivos da aplicação." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ...(url.pathname.startsWith("/admin") ? { "X-Robots-Tag": "noindex, nofollow" } : {})
      });
      response.end(contents);
      return;
    }

    sendJson(response, 404, { error: "Rota não encontrada." });
  });

  server.on("close", () => database.close());
  return server;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Dashboard disponível em http://127.0.0.1:${server.address().port}`);
    console.log("Banco SQLite: data/chamados.sqlite3");
  });
}

module.exports = { createAppServer, weekStartForDate };
