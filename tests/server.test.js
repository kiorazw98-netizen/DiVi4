"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createServer } = require("../server");

let directory;
let databasePath;
let server;
let baseUrl;

async function startServer() {
  server = createServer({ databasePath });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  const currentServer = server;
  server = null;
  await new Promise((resolve, reject) => {
    currentServer.close((error) => error ? reject(error) : resolve());
  });
}

async function request(route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  return { status: response.status, body: await response.json() };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "dephine-budget-"));
  databasePath = path.join(directory, "finance.sqlite");
  await startServer();
});

after(async () => {
  await stopServer();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("SQL dashboard calculates monthly and category spending", async () => {
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const { status, body } = await request(`/api/dashboard?month=${month}`);

  assert.equal(status, 200);
  assert.equal(body.summary.expenses, 7670);
  assert.equal(body.summary.budget, 7670);
  assert.deepEqual(body.categorySpending.map(({ category, amount }) => [category, amount]), [
    ["Housing", 3000],
    ["Groceries & toiletries", 1500],
    ["Education", 1300],
    ["Utilities", 1070],
    ["Transport", 800]
  ]);
  assert.equal(body.categorySpending.reduce((sum, item) => sum + item.percentage, 0), 100);
  assert.equal(body.monthlyTotals[new Date().getMonth()].expense, 7670);
  assert.equal(body.transactions.length, 6);
});

test("transactions, budgets, and savings goals persist in SQLite", async () => {
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const date = `${month}-15`;
  const income = await request("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Salary O'Brien",
      category: "Salary",
      type: "income",
      amount: 10000,
      date,
      note: ""
    })
  });
  assert.equal(income.status, 201);

  const expense = await request("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Extra groceries",
      category: "Groceries & toiletries",
      type: "expense",
      amount: 250.5,
      date,
      note: ""
    })
  });
  assert.equal(expense.status, 201);

  const budgetValues = {
    Housing: 3000, Utilities: 1070, Education: 1300,
    "Groceries & toiletries": 1750, Transport: 800, Health: 0, Entertainment: 0, Other: 0
  };
  assert.equal((await request("/api/budgets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budgets: budgetValues })
  })).status, 200);

  const goal = await request("/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Emergency fund", target: 2000, saved: 200, date: "" })
  });
  assert.equal(goal.status, 201);
  assert.equal((await request(`/api/goals/${goal.body.id}/contributions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: 100 })
  })).status, 200);

  const invalidDate = await request("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Invalid",
      category: "Housing",
      type: "expense",
      amount: 10,
      date: "2026-02-30"
    })
  });
  assert.equal(invalidDate.status, 400);

  await stopServer();
  await startServer();
  const { status, body } = await request(`/api/dashboard?month=${month}`);
  assert.equal(status, 200);
  assert.equal(body.summary.income, 10000);
  assert.equal(body.summary.expenses, 7920.5);
  assert.equal(body.budgets["Groceries & toiletries"], 1750);
  assert.equal(body.categorySpending.find((item) => item.category === "Groceries & toiletries").percentage, 22.1);
  assert.equal(body.goals[0].saved, 300);
  assert.equal(body.transactions.some((transaction) => transaction.description === "Salary O'Brien"), true);
});
