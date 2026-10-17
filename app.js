"use strict";

(() => {
  const palette = ["#28785d", "#d88b4a", "#6684bd", "#b96f8b", "#76a7a0", "#aa9955", "#8474af", "#89928c"];
  const categories = ["Housing", "Utilities", "Education", "Groceries & toiletries", "Transport", "Health", "Entertainment", "Other"];
  const incomeCategories = ["Salary", "Freelance", "Benefits", "Other income"];
  const today = new Date();
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const formatMoney = (amount) => new Intl.NumberFormat("en-ZA", {
    style: "currency", currency: "ZAR", maximumFractionDigits: 0
  }).format(amount).replace(/\u00a0/g, " ");
  const dateForMonth = (month, day) => `${month}-${String(day).padStart(2, "0")}`;
  let selectedMonth = currentMonth;
  let state = null;
  let toastTimer;
  const monthPicker = document.getElementById("monthPicker");
  monthPicker.value = selectedMonth;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }

  async function refreshDashboard() {
    state = await api(`/api/dashboard?month=${encodeURIComponent(selectedMonth)}`);
    document.getElementById("appError").hidden = true;
    render();
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function formatDate(value) {
    const date = new Date(`${value}T12:00:00`);
    return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short" }).format(date);
  }

  function renderSummary() {
    const { income, expenses, budget } = state.summary;
    document.getElementById("incomeTotal").textContent = formatMoney(income);
    document.getElementById("expenseTotal").textContent = formatMoney(expenses);
    const remaining = document.getElementById("remainingTotal");
    remaining.textContent = formatMoney(income - expenses);
    remaining.style.color = income - expenses < 0 ? "var(--red)" : "";
    document.getElementById("budgetTotal").textContent = formatMoney(budget);
  }

  function renderTransactions() {
    const rows = document.getElementById("transactionRows");
    const transactions = state.transactions;
    if (!transactions.length) {
      rows.innerHTML = '<tr><td colspan="5" class="empty-row">No transactions this month. Add one to get started.</td></tr>';
      return;
    }
    rows.innerHTML = transactions.map((transaction) => `
      <tr>
        <td><div class="transaction-name">${escapeHtml(transaction.description)}</div>${transaction.note ? `<div class="transaction-meta">${escapeHtml(transaction.note)}</div>` : ""}</td>
        <td><span class="type-pill">${escapeHtml(transaction.type === "income" ? "Income · " + transaction.category : transaction.category)}</span></td>
        <td>${formatDate(transaction.date)}</td>
        <td class="${transaction.type === "income" ? "amount-income" : "amount-expense"}">${transaction.type === "income" ? "+" : "−"}${formatMoney(transaction.amount)}</td>
        <td><button class="button danger" data-delete-transaction="${escapeHtml(transaction.id)}" aria-label="Delete ${escapeHtml(transaction.description)}">Delete</button></td>
      </tr>`).join("");
    rows.querySelectorAll("[data-delete-transaction]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await api(`/api/transactions/${encodeURIComponent(button.dataset.deleteTransaction)}`, { method: "DELETE" });
          await refreshDashboard();
          showToast("Transaction deleted.");
        } catch (error) {
          showToast(error.message);
        }
      });
    });
  }

  function renderBudgets() {
    const list = document.getElementById("budgetList");
    const sorted = Object.entries(state.budgets).filter(([, amount]) => amount > 0);
    if (!sorted.length) {
      list.innerHTML = '<div class="goal-empty">No monthly budgets set. Choose “Edit budgets” to add one.</div>';
      return;
    }
    list.innerHTML = sorted.map(([name, limit]) => {
      const spent = state.budgetSpending[name] || 0;
      const percent = limit > 0 ? Math.min(spent / limit * 100, 100) : 0;
      const over = spent > limit;
      return `<div><div class="budget-row-top"><span class="budget-category">${escapeHtml(name)}</span><span class="budget-numbers">${formatMoney(spent)} / ${formatMoney(limit)}${over ? " · over budget" : ""}</span></div><div class="progress" role="progressbar" aria-label="${escapeHtml(name)} budget used" aria-valuenow="${Math.min(spent, limit)}" aria-valuemin="0" aria-valuemax="${limit}"><span class="${over ? "over" : ""}" style="width:${percent}%"></span></div></div>`;
    }).join("");
  }

  function renderGoals() {
    const list = document.getElementById("goalList");
    if (!state.goals.length) {
      list.innerHTML = '<div class="goal-empty">No savings goals yet. Add a goal and start building toward it.</div>';
      return;
    }
    list.innerHTML = state.goals.map((goal) => {
      const percent = Math.min(goal.saved / goal.target * 100, 100);
      return `<div class="goal-item"><div class="goal-heading"><strong>${escapeHtml(goal.name)}</strong><button class="button danger" data-contribute="${escapeHtml(goal.id)}">+ Add savings</button></div><div class="goal-amount">${formatMoney(goal.saved)} saved of ${formatMoney(goal.target)}${goal.date ? ` · target ${formatDate(goal.date)}` : ""}</div><div class="progress" role="progressbar" aria-label="${escapeHtml(goal.name)} progress" aria-valuenow="${goal.saved}" aria-valuemin="0" aria-valuemax="${goal.target}"><span style="width:${percent}%"></span></div></div>`;
    }).join("");
    list.querySelectorAll("[data-contribute]").forEach((button) => {
      button.addEventListener("click", () => openContribution(button.dataset.contribute));
    });
  }

  function renderCategories() {
    const entries = state.categorySpending;
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    document.getElementById("donutTotal").textContent = formatMoney(total);
    const legend = document.getElementById("categoryLegend");
    if (!entries.length) {
      document.getElementById("categoryDonut").style.background = "conic-gradient(#e8eae5 0deg 360deg)";
      legend.innerHTML = '<div class="section-hint">No expenses recorded this month.</div>';
      return;
    }
    let current = 0;
    const stops = entries.map((entry, index) => {
      const start = current;
      current += entry.amount / total * 360;
      return `${palette[index % palette.length]} ${start}deg ${current}deg`;
    });
    document.getElementById("categoryDonut").style.background = `conic-gradient(${stops.join(", ")})`;
    legend.innerHTML = entries.map((entry, index) => `
      <div class="legend-row">
        <div class="legend-name"><span class="swatch" style="background:${palette[index % palette.length]}"></span><span>${escapeHtml(entry.category)}</span></div>
        <span class="legend-value">${formatMoney(entry.amount)} · ${entry.percentage.toFixed(1)}%</span>
      </div>`).join("");
  }

  function renderChart() {
    const canvas = document.getElementById("cashflowChart");
    const empty = document.getElementById("chartEmpty");
    const year = Number(selectedMonth.slice(0, 4));
    const monthlyTotals = state.monthlyTotals;
    const hasData = monthlyTotals.some((month) => month.income > 0 || month.expense > 0);
    empty.hidden = hasData;
    canvas.setAttribute("aria-label", `Bar chart of monthly income and expenses for ${year}.`);
    if (!hasData) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const width = rect.width, height = rect.height;
    const left = 42, right = 8, top = 9, bottom = 25;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const maxValue = Math.max(1, ...monthlyTotals.flatMap((month) => [month.income, month.expense]));
    const step = plotWidth / 12;
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    for (let line = 0; line <= 3; line++) {
      const y = top + plotHeight * line / 3;
      const value = maxValue * (3 - line) / 3;
      ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      ctx.fillStyle = "#ffe5eb";
      const short = value >= 1000 ? `R${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : `R${Math.round(value)}`;
      ctx.fillText(short, left - 7, y + 3);
    }
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    monthlyTotals.forEach((data, index) => {
      const center = left + step * (index + .5);
      const barWidth = Math.max(2, Math.min(8, step * .29));
      const incomeHeight = data.income / maxValue * plotHeight;
      const expenseHeight = data.expense / maxValue * plotHeight;
      ctx.fillStyle = "#61d49d";
      ctx.beginPath(); ctx.roundRect(center - barWidth - 1, top + plotHeight - incomeHeight, barWidth, Math.max(incomeHeight, data.income ? 2 : 0), 2); ctx.fill();
      ctx.fillStyle = "#ffd084";
      ctx.beginPath(); ctx.roundRect(center + 1, top + plotHeight - expenseHeight, barWidth, Math.max(expenseHeight, data.expense ? 2 : 0), 2); ctx.fill();
      ctx.fillStyle = "#ffe5eb"; ctx.textAlign = "center"; ctx.fillText(monthNames[index], center, height - 7);
    });
  }

  function render() {
    renderSummary();
    renderTransactions();
    renderBudgets();
    renderGoals();
    renderCategories();
    renderChart();
  }

  function openModal(title, fields, onSubmit, submitText) {
    const backdrop = document.getElementById("modalBackdrop");
    const form = document.getElementById("modalForm");
    document.getElementById("modalTitle").textContent = title;
    form.innerHTML = fields + '<div class="form-error" id="formError" role="alert"></div><div class="form-actions"><button type="button" class="button secondary" id="cancelModal">Cancel</button><button type="submit" class="button">' + escapeHtml(submitText || "Save") + "</button></div>";
    backdrop.classList.add("open");
    form.querySelector("[data-autofocus]")?.focus();
    document.getElementById("closeModal").onclick = closeModal;
    document.getElementById("cancelModal").onclick = closeModal;
    backdrop.onclick = (event) => { if (event.target === backdrop) closeModal(); };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      try {
        const error = await onSubmit(new FormData(form));
        if (error) {
          document.getElementById("formError").textContent = error;
          return;
        }
        closeModal();
        try {
          await refreshDashboard();
        } catch (error) {
          showToast(`Saved, but the dashboard could not refresh: ${error.message}`);
        }
      } catch (error) {
        document.getElementById("formError").textContent = error.message;
      } finally {
        if (submitButton.isConnected) submitButton.disabled = false;
      }
    };
  }

  function closeModal() {
    document.getElementById("modalBackdrop").classList.remove("open");
  }

  function openTransaction() {
    const categoryOptions = (items) => items.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
    openModal("Add transaction", `
      <div class="field"><label for="transactionType">Type</label><select id="transactionType" name="type"><option value="expense">Expense</option><option value="income">Income</option></select></div>
      <div class="field"><label for="description">Description</label><input id="description" name="description" maxlength="80" required data-autofocus placeholder="e.g. Salary or water bill"></div>
      <div class="field"><label for="category">Category</label><select id="category" name="category">${categoryOptions(categories)}</select></div>
      <div class="field"><label for="amount">Amount (R)</label><input id="amount" name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></div>
      <div class="field"><label for="transactionDate">Date</label><input id="transactionDate" name="date" type="date" value="${dateForMonth(selectedMonth, 1)}" required></div>
      <div class="field"><label for="note">Note (optional)</label><input id="note" name="note" maxlength="120" placeholder="Add a short note"></div>`,
      async (form) => {
        const date = String(form.get("date"));
        await api("/api/transactions", {
          method: "POST",
          body: JSON.stringify({
            description: String(form.get("description")).trim(),
            category: String(form.get("category")),
            type: String(form.get("type")),
            amount: Number(form.get("amount")),
            date,
            note: String(form.get("note")).trim()
          })
        });
        selectedMonth = date.slice(0, 7);
        monthPicker.value = selectedMonth;
        showToast("Transaction added.");
        return "";
      }, "Add transaction");
    const typeField = document.getElementById("transactionType");
    const categoryField = document.getElementById("category");
    typeField.addEventListener("change", () => {
      categoryField.innerHTML = categoryOptions(typeField.value === "income" ? incomeCategories : categories);
    });
  }

  function openBudgets() {
    const fields = categories.map((category) => `
      <div class="field"><label for="budget-${escapeHtml(category)}">${escapeHtml(category)} monthly limit (R)</label>
      <input id="budget-${escapeHtml(category)}" name="budget:${escapeHtml(category)}" type="number" min="0" step="0.01" value="${Number(state.budgets[category] || 0)}" required></div>`).join("");
    openModal("Edit monthly budgets", fields, async (form) => {
      const budgets = {};
      for (const category of categories) {
        const value = Number(form.get(`budget:${category}`));
        if (!Number.isFinite(value) || value < 0) return "Budget amounts must be zero or more.";
        budgets[category] = value;
      }
      await api("/api/budgets", { method: "PUT", body: JSON.stringify({ budgets }) });
      showToast("Budgets updated.");
      return "";
    }, "Save budgets");
  }

  function openGoal() {
    openModal("Create savings goal", `
      <div class="field"><label for="goalName">Goal name</label><input id="goalName" name="name" maxlength="60" required data-autofocus placeholder="e.g. Emergency fund"></div>
      <div class="field"><label for="goalTarget">Savings target (R)</label><input id="goalTarget" name="target" type="number" min="0.01" step="0.01" required placeholder="0.00"></div>
      <div class="field"><label for="goalSaved">Already saved (R)</label><input id="goalSaved" name="saved" type="number" min="0" step="0.01" value="0" required></div>
      <div class="field"><label for="goalDate">Target date (optional)</label><input id="goalDate" name="date" type="date"></div>`,
      async (form) => {
        await api("/api/goals", {
          method: "POST",
          body: JSON.stringify({
            name: String(form.get("name")).trim(),
            target: Number(form.get("target")),
            saved: Number(form.get("saved")),
            date: String(form.get("date"))
          })
        });
        showToast("Savings goal added.");
        return "";
      }, "Create goal");
  }

  function openContribution(id) {
    const goal = state.goals.find((item) => item.id === id);
    if (!goal) return;
    openModal(`Add savings to ${goal.name}`, `
      <div class="section-hint">Current progress: ${formatMoney(goal.saved)} of ${formatMoney(goal.target)}</div>
      <div class="field"><label for="contribution">Amount to add (R)</label><input id="contribution" name="amount" type="number" min="0.01" step="0.01" required data-autofocus placeholder="0.00"></div>`,
      async (form) => {
        await api(`/api/goals/${encodeURIComponent(goal.id)}/contributions`, {
          method: "POST",
          body: JSON.stringify({ amount: Number(form.get("amount")) })
        });
        showToast("Savings contribution recorded.");
        return "";
      }, "Add savings");
  }

  monthPicker.addEventListener("change", async () => {
    if (!monthPicker.value) return;
    selectedMonth = monthPicker.value;
    try {
      await refreshDashboard();
    } catch (error) {
      showToast(error.message);
    }
  });
  document.getElementById("addTransaction").addEventListener("click", openTransaction);
  document.getElementById("editBudgets").addEventListener("click", openBudgets);
  document.getElementById("addGoal").addEventListener("click", openGoal);
  document.querySelectorAll("[data-target]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-target]").forEach((item) => item.classList.toggle("active", item.dataset.target === button.dataset.target));
    document.getElementById(button.dataset.target).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  window.addEventListener("resize", () => { if (state) renderChart(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

  refreshDashboard().catch((error) => {
    const appError = document.getElementById("appError");
    appError.textContent = `Could not connect to the SQLite database. Start the app with “npm start” from its folder, then open http://127.0.0.1:3000. Details: ${error.message}`;
    appError.hidden = false;
  });
})();
