"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const CATEGORIES = [
  "Housing", "Utilities", "Education", "Groceries & toiletries",
  "Transport", "Health", "Entertainment", "Other"
];
const INCOME_CATEGORIES = ["Salary", "Freelance", "Benefits", "Other income"];
const DEFAULT_BUDGETS = {
  Housing: 3000,
  Utilities: 1070,
  Education: 1300,
  "Groceries & toiletries": 1500,
  Transport: 800,
  Health: 0,
  Entertainment: 0,
  Other: 0
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toCents(value, { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new HttpError(400, allowZero ? "Enter a valid amount of zero or more." : "Enter an amount greater than zero.");
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) {
    throw new HttpError(400, "Amount is too large or has invalid precision.");
  }
  if (Math.abs(value * 100 - cents) > 1e-7) {
    throw new HttpError(400, "Amounts can have no more than two decimal places.");
  }
  return cents;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.toISOString().slice(0, 10) === value;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          reject(new HttpError(400, "Request body must be a JSON object."));
          return;
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function initializeDatabase(db) {
  const schema = fs.readFileSync(path.join(ROOT, "database", "schema.sql"), "utf8");
  db.exec(schema);

  const seedExists = db.prepare("SELECT value FROM app_meta WHERE key = ?").get("initial-data-seeded");
  if (seedExists) return;

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const seedTransactions = [
    ["rent", "Rent", "Housing", 300000, "Monthly rent"],
    ["electricity", "Electricity", "Utilities", 40000, "Monthly estimate"],
    ["wifi", "Rain WiFi", "Utilities", 67000, "Monthly"],
    ["college", "Whitestone College (monthly allocation)", "Education", 130000, "R15,600 annual fee divided over 12 months"],
    ["groceries", "Groceries & toiletries", "Groceries & toiletries", 150000, "Monthly"],
    ["transport", "Transportation", "Transport", 80000, "Monthly"]
  ];

  db.exec("BEGIN");
  try {
    const insertBudget = db.prepare("INSERT OR IGNORE INTO budgets (category, limit_cents) VALUES (?, ?)");
    for (const category of CATEGORIES) {
      insertBudget.run(category, Math.round((DEFAULT_BUDGETS[category] || 0) * 100));
    }
    const insertTransaction = db.prepare(`
      INSERT OR IGNORE INTO transactions
        (id, description, category, type, amount_cents, transaction_date, note)
      VALUES (?, ?, ?, 'expense', ?, ?, ?)
    `);
    for (const [id, description, category, cents, note] of seedTransactions) {
      insertTransaction.run(id, description, category, cents, `${month}-01`, note);
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run("initial-data-seeded", "1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getDashboard(db, month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new HttpError(400, "Choose a valid report month.");
  }
  const year = month.slice(0, 4);
  const nextMonthDate = new Date(`${month}-01T00:00:00Z`);
  nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
  const nextMonth = nextMonthDate.toISOString().slice(0, 7);

  const transactions = db.prepare(`
    SELECT id, description, category, type, amount_cents, transaction_date, note
    FROM transactions
    WHERE transaction_date >= ? AND transaction_date < ?
    ORDER BY transaction_date DESC, created_at DESC, id
  `).all(`${month}-01`, `${nextMonth}-01`).map((transaction) => ({
    id: transaction.id,
    description: transaction.description,
    category: transaction.category,
    type: transaction.type,
    amount: transaction.amount_cents / 100,
    date: transaction.transaction_date,
    note: transaction.note
  }));

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END), 0) AS income_cents,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense_cents
    FROM transactions
    WHERE transaction_date >= ? AND transaction_date < ?
  `).get(`${month}-01`, `${nextMonth}-01`);

  const budgetRows = db.prepare("SELECT category, limit_cents FROM budgets ORDER BY category").all();
  const budgetSpending = Object.fromEntries(db.prepare(`
    SELECT category, SUM(amount_cents) AS amount_cents
    FROM transactions
    WHERE type = 'expense' AND transaction_date >= ? AND transaction_date < ?
    GROUP BY category
  `).all(`${month}-01`, `${nextMonth}-01`).map((row) => [row.category, row.amount_cents / 100]));

  const categorySpending = db.prepare(`
    SELECT
      category,
      SUM(amount_cents) AS amount_cents,
      ROUND(100.0 * SUM(amount_cents) / (
        SELECT SUM(amount_cents)
        FROM transactions
        WHERE type = 'expense' AND transaction_date >= ? AND transaction_date < ?
      ), 1) AS percentage
    FROM transactions
    WHERE type = 'expense' AND transaction_date >= ? AND transaction_date < ?
    GROUP BY category
    ORDER BY amount_cents DESC, category
  `).all(`${month}-01`, `${nextMonth}-01`, `${month}-01`, `${nextMonth}-01`).map((row) => ({
    category: row.category,
    amount: row.amount_cents / 100,
    percentage: row.percentage
  }));

  const monthlyTotalsByMonth = db.prepare(`
    SELECT
      strftime('%m', transaction_date) AS month_number,
      SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END) AS income_cents,
      SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END) AS expense_cents
    FROM transactions
    WHERE transaction_date >= ? AND transaction_date < ?
    GROUP BY strftime('%m', transaction_date)
  `).all(`${year}-01-01`, `${Number(year) + 1}-01-01`);
  const byMonth = new Map(monthlyTotalsByMonth.map((row) => [Number(row.month_number) - 1, row]));
  const monthlyTotals = Array.from({ length: 12 }, (_, index) => {
    const row = byMonth.get(index);
    return {
      income: row ? row.income_cents / 100 : 0,
      expense: row ? row.expense_cents / 100 : 0
    };
  });

  const goals = db.prepare(`
    SELECT id, name, target_cents, saved_cents, target_date
    FROM savings_goals
    ORDER BY created_at, name
  `).all().map((goal) => ({
    id: goal.id,
    name: goal.name,
    target: goal.target_cents / 100,
    saved: goal.saved_cents / 100,
    date: goal.target_date || ""
  }));

  return {
    transactions,
    budgets: Object.fromEntries(budgetRows.map((row) => [row.category, row.limit_cents / 100])),
    budgetSpending,
    goals,
    summary: {
      income: totals.income_cents / 100,
      expenses: totals.expense_cents / 100,
      budget: budgetRows.reduce((sum, row) => sum + row.limit_cents, 0) / 100
    },
    categorySpending,
    monthlyTotals
  };
}

function createServer({ databasePath = process.env.FINANCE_DB_PATH || path.join(ROOT, "data", "finance.sqlite") } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  initializeDatabase(db);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url, db);
        return;
      }

      const file = url.pathname === "/" || url.pathname === "/index.html"
        ? path.join(ROOT, "index.html")
        : url.pathname === "/app.js" ? path.join(ROOT, "app.js") : null;
      if (!file) {
        sendJson(response, 404, { error: "Page not found." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      handleError(response, error);
    }
  });

  server.on("close", () => db.close());
  return server;
}

async function handleApi(request, response, url, db) {
  try {
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(response, 200, getDashboard(db, url.searchParams.get("month")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/transactions") {
      const body = await readJson(request);
      const description = typeof body.description === "string" ? body.description.trim() : "";
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (description.length < 1 || description.length > 80) throw new HttpError(400, "Description must be 1 to 80 characters.");
      if (note.length > 120) throw new HttpError(400, "Note must be 120 characters or fewer.");
      if (body.type !== "income" && body.type !== "expense") throw new HttpError(400, "Choose income or expense.");
      const allowedCategories = body.type === "income" ? INCOME_CATEGORIES : CATEGORIES;
      if (!allowedCategories.includes(body.category)) throw new HttpError(400, "Choose a valid category for this transaction.");
      if (!isValidDate(body.date)) throw new HttpError(400, "Choose a valid transaction date.");
      const id = randomUUID();
      db.prepare(`
        INSERT INTO transactions (id, description, category, type, amount_cents, transaction_date, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, description, body.category, body.type, toCents(body.amount), body.date, note);
      sendJson(response, 201, { id });
      return;
    }
    const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
    if (request.method === "DELETE" && transactionMatch) {
      const result = db.prepare("DELETE FROM transactions WHERE id = ?").run(transactionMatch[1]);
      if (!result.changes) throw new HttpError(404, "Transaction was not found.");
      sendJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/budgets") {
      const body = await readJson(request);
      if (!body.budgets || typeof body.budgets !== "object" || Array.isArray(body.budgets)) {
        throw new HttpError(400, "Provide monthly budget amounts by category.");
      }
      const budgetEntries = CATEGORIES.map((category) => {
        if (!Object.hasOwn(body.budgets, category)) throw new HttpError(400, `Missing budget for ${category}.`);
        return [category, toCents(body.budgets[category], { allowZero: true })];
      });
      const update = db.prepare(`
        INSERT INTO budgets (category, limit_cents) VALUES (?, ?)
        ON CONFLICT(category) DO UPDATE SET limit_cents = excluded.limit_cents
      `);
      db.exec("BEGIN");
      try {
        for (const [category, cents] of budgetEntries) update.run(category, cents);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(response, 200, { saved: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/goals") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 1 || name.length > 60) throw new HttpError(400, "Goal name must be 1 to 60 characters.");
      const targetCents = toCents(body.target);
      const savedCents = toCents(body.saved ?? 0, { allowZero: true });
      const date = body.date || null;
      if (date !== null && !isValidDate(date)) throw new HttpError(400, "Choose a valid target date.");
      const id = randomUUID();
      db.prepare(`
        INSERT INTO savings_goals (id, name, target_cents, saved_cents, target_date)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, targetCents, savedCents, date);
      sendJson(response, 201, { id });
      return;
    }
    const contributionMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/contributions$/);
    if (request.method === "POST" && contributionMatch) {
      const body = await readJson(request);
      const cents = toCents(body.amount);
      const result = db.prepare("UPDATE savings_goals SET saved_cents = saved_cents + ? WHERE id = ?")
        .run(cents, contributionMatch[1]);
      if (!result.changes) throw new HttpError(404, "Savings goal was not found.");
      sendJson(response, 200, { saved: true });
      return;
    }
    throw new HttpError(404, "API endpoint not found.");
  } catch (error) {
    handleError(response, error);
  }
}

function handleError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error("Finance tracker request failed:", error);
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  sendJson(response, status, {
    error: status === 500 ? "The server could not complete the request." : error.message
  });
}

if (require.main === module) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Dephine Monthly Budget is running at http://${host}:${port}`);
    console.log("SQLite data is stored locally in data/finance.sqlite.");
  });
  server.on("error", (error) => {
    console.error("Could not start the finance tracker server:", error);
    process.exitCode = 1;
  });
}

module.exports = { CATEGORIES, createServer, getDashboard, isValidDate, toCents };
