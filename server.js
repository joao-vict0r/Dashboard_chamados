const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10000;
const INITIAL_WEEK_DATE = "2026-09-01";
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/script.js": ["script.js", "text/javascript; charset=utf-8"]
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

function normalizeHeader(value) {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function splitCsvRow(line, delimiter) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  if (quoted) {
    throw new Error("CSV inválido: há um campo com aspas sem fechamento.");
  }

  values.push(value);
  return values;
}

function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      row.push(value);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      value = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      value += character;
    }
  }

  if (quoted) {
    throw new Error("CSV inválido: há um campo com aspas sem fechamento.");
  }

  row.push(value);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

function parseCsv(text) {
  const content = text.replace(/^\uFEFF/, "");
  const firstLine = content.split(/\r\n|\n|\r/, 1)[0];
  if (!firstLine.trim()) {
    throw new Error("O CSV precisa ter um cabeçalho e pelo menos um chamado.");
  }

  const semicolons = splitCsvRow(firstLine, ";").length;
  const commas = splitCsvRow(firstLine, ",").length;
  const delimiter = semicolons > commas ? ";" : ",";
  const rows = parseCsvRows(content, delimiter);
  if (rows.length < 2) {
    throw new Error("O CSV precisa ter um cabeçalho e pelo menos um chamado.");
  }

  const headers = rows[0].map(normalizeHeader);
  const findColumn = (...aliases) => headers.findIndex(header => aliases.includes(header));
  const columns = {
    id: findColumn("chamado", "numerodochamado", "id", "ticket", "ticketid"),
    description: findColumn("descricao", "descricaodochamado", "description"),
    theme: findColumn("tema", "theme", "assunto"),
    journey: findColumn("jornada", "journey"),
    date: findColumn("data", "datadochamado", "dataabertura", "dataatendimento", "openedat")
  };
  const missing = Object.entries(columns)
    .filter(([, index]) => index === -1)
    .map(([name]) => ({ id: "Chamado", description: "Descrição", theme: "Tema", journey: "Jornada", date: "Data" })[name]);

  if (missing.length) {
    throw new Error(`Faltam colunas obrigatórias no CSV: ${missing.join(", ")}.`);
  }

  if (rows.length - 1 > MAX_IMPORT_ROWS) {
    throw new Error(`O limite por importação é de ${MAX_IMPORT_ROWS} chamados.`);
  }

  const records = [];
  const seen = new Set();

  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    const read = column => (values[column] || "").trim();
    const ticketId = read(columns.id);
    const description = read(columns.description);
    const theme = read(columns.theme);
    const journey = read(columns.journey);
    const rawDate = read(columns.date);
    const rowNumber = index + 1;

    if (!/^\d+$/.test(ticketId)) {
      throw new Error(`Linha ${rowNumber}: o número do chamado deve conter apenas dígitos.`);
    }

    const date = normalizeDate(rawDate);
    if (!date) {
      throw new Error(`Linha ${rowNumber}: data inválida "${rawDate}". Use AAAA-MM-DD ou DD/MM/AAAA.`);
    }

    if (!description || !theme || !journey) {
      throw new Error(`Linha ${rowNumber}: descrição, tema e jornada são obrigatórios.`);
    }

    const weekStart = weekStartForDate(date);
    const key = `${ticketId}:${weekStart}`;
    if (seen.has(key)) {
      throw new Error(`Linha ${rowNumber}: o chamado ${ticketId} aparece mais de uma vez na mesma semana.`);
    }
    seen.add(key);
    records.push({ ticketId, description, theme, journey, date, weekStart });
  }

  return records;
}

function normalizeDate(value) {
  let isoDate = value;
  const localDate = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(value);

  if (localDate) {
    isoDate = `${localDate[3]}-${localDate[2]}-${localDate[1]}`;
  }

  return isValidDate(isoDate) ? isoDate : null;
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

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceededLimit = false;

    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_CSV_BYTES) exceededLimit = true;
      else if (!exceededLimit) chunks.push(chunk);
    });

    request.on("end", () => {
      if (exceededLimit) reject(new Error("O arquivo CSV ultrapassa o limite de 5 MB."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function createAppServer(options = {}) {
  const databasePath = options.databasePath || path.join(__dirname, "data", "chamados.sqlite3");
  const database = createDatabase(databasePath);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

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

    if (request.method === "POST" && url.pathname === "/api/import") {
      try {
        const contentType = request.headers["content-type"] || "";
        if (!contentType.toLowerCase().includes("text/csv")) {
          sendJson(response, 415, { error: "Envie o arquivo como CSV (text/csv)." });
          return;
        }

        const records = parseCsv(await readRequestBody(request));
        const findExisting = database.prepare(
          "SELECT 1 FROM tickets WHERE ticket_id = ? AND week_start = ?"
        );
        const insert = database.prepare(`
          INSERT INTO tickets (ticket_id, description, theme, journey, opened_at, week_start)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(ticket_id, week_start) DO UPDATE SET
            description = excluded.description,
            theme = excluded.theme,
            journey = excluded.journey,
            opened_at = excluded.opened_at,
            imported_at = CURRENT_TIMESTAMP
        `);
        let added = 0;
        let updated = 0;

        withTransaction(database, () => {
          for (const record of records) {
            if (findExisting.get(record.ticketId, record.weekStart)) {
              updated += 1;
            } else {
              added += 1;
            }
            insert.run(
              record.ticketId,
              record.description,
              record.theme,
              record.journey,
              record.date,
              record.weekStart
            );
          }
        });

        sendJson(response, 200, { imported: records.length, added, updated });
      } catch (error) {
        if (error.message.includes("5 MB")) {
          sendJson(response, 413, { error: error.message });
          return;
        }
        sendJson(response, 400, { error: error.message || "Não foi possível importar o CSV." });
      }
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
        "Cache-Control": "no-cache"
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

module.exports = { createAppServer, parseCsv, weekStartForDate };
