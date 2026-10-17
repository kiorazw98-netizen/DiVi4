# Dephine Monthly Budget

A personal finance tracker with a JavaScript interface and a local SQLite database. Your records stay on this computer in `data/finance.sqlite`.

## Run it

1. Install Node.js 22.13 or newer.
2. Open a terminal in this folder and run `npm start`.
3. Open <http://127.0.0.1:3000> in your browser.

Keep the terminal running while using the tracker. Stop the local server with `Ctrl+C`. The first run creates the database, seeds the listed monthly expenses and budgets, and saves them for future runs.

To run the automated checks, use `npm test`.

The monthly college budget is R1,300, calculated by spreading the R15,600 annual fee over 12 months. The monthly report groups expense totals by category and calculates each category's percentage of that month's spending.
