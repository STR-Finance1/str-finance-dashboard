"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Google Sheets CSV links (published)
 * Leave blank if you only want uploads.
 */
const BOOKINGS_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSp05U5ICd_RYWgGMZb2uAa0s9LKky8CEgH_grP1P82FzUi1p2i_VyPCBZw_XOhTPVB3dA36WYOLeKm/pub?gid=0&single=true&output=csv";

const EXPENSES_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSp05U5ICd_RYWgGMZb2uAa0s9LKky8CEgH_grP1P82FzUi1p2i_VyPCBZw_XOhTPVB3dA36WYOLeKm/pub?gid=1482291786&single=true&output=csv";

type FixedVar = "fixed" | "variable" | undefined;

type Txn = {
  dateISO: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  amount: number; // +income, -expense
  category: string;
  property: string;
  source: "booking" | "expense";
  fixedVariable?: FixedVar;
};

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Minimal CSV parser (no dependencies).
 * Handles quoted fields and commas inside quotes.
 */
function parseCSV(text: string): Record<string, unknown>[] {
  const clean = text.replace(/\r/g, "");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const splitLine = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        // escaped quote ""
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
        continue;
      }

      cur += ch;
    }

    out.push(cur);
    return out.map((s) => s.trim());
  };

  const headers = splitLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(splitLine);

  return rows.map((r) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? "";
    });
    return obj;
  });
}

function parseMoney(val: unknown): number {
  if (val === null || val === undefined) return NaN;
  const s0 = String(val).trim();
  if (!s0) return NaN;

  const neg = s0.startsWith("(") && s0.endsWith(")");
  const cleaned = s0.replace(/[\$,()\s]/g, "").replace(/,/g, "");
  const num = Number(cleaned);
  if (Number.isNaN(num)) return NaN;
  return neg ? -num : num;
}

function toISODate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // date range like "7/14/2025 - 7/25/2025" -> use first date
  const range = s.match(
    /^(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})$/
  );
  if (range) s = range[1];

  // YYYY-MM -> first day
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // M/D/YYYY
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const mm = m1[1].padStart(2, "0");
    const dd = m1[2].padStart(2, "0");
    const yyyy = m1[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // M-D-YYYY
  const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    const mm = m2[1].padStart(2, "0");
    const dd = m2[2].padStart(2, "0");
    const yyyy = m2[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function monthFromISO(dateISO: string) {
  return dateISO.slice(0, 7);
}

function pickRowValue(row: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    if (row[k] !== undefined) return row[k];
  }
  return undefined;
}

function normalizeFixedVar(x: unknown): FixedVar {
  const s = (x ? String(x).trim().toLowerCase() : "").replace(/\s+/g, "");
  if (s === "fixed") return "fixed";
  if (s === "variable") return "variable";
  return undefined;
}

export default function Home() {
  const [month, setMonth] = useState<string>("ALL");
  const [propertyFilter, setPropertyFilter] = useState<string>("All");
  const [txns, setTxns] = useState<Txn[]>([]);
  const [status, setStatus] = useState<string>("No data loaded yet.");

  const bookingsRef = useRef<HTMLInputElement | null>(null);
  const expensesRef = useRef<HTMLInputElement | null>(null);

  // Auto-refresh every 60 seconds + once on load
  useEffect(() => {
    refreshFromGoogleSheets();
    const id = setInterval(refreshFromGoogleSheets, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function parseBookingsCSV(text: string) {
    const data = parseCSV(text);

    const out: Txn[] = [];
    let rowsSeen = data.length;
    let created = 0;

    for (const row of data) {
      const dateRaw = pickRowValue(row, ["Date", "date"]);
      const propRaw = pickRowValue(row, ["Property", "property"]);
      const netRaw = pickRowValue(row, ["Our Net", "OurNet", "our net"]);
      const feesRaw = pickRowValue(row, ["Fees Due Landmark", "Fees Due", "Fees"]);
      const sourceRaw = pickRowValue(row, ["Source", "source"]);

      const dateISO = toISODate(dateRaw);
      if (!dateISO) continue;

      const property = (propRaw ? String(propRaw).trim() : "Unknown") || "Unknown";
      const source = (sourceRaw ? String(sourceRaw).trim() : "") || "";

      const ourNet = parseMoney(netRaw);
      if (!Number.isNaN(ourNet) && ourNet !== 0) {
        out.push({
          dateISO,
          month: monthFromISO(dateISO),
          amount: ourNet,
          category: source ? `Income (${source})` : "Income",
          property,
          source: "booking",
        });
        created++;
      }

      const fees = parseMoney(feesRaw);
      if (!Number.isNaN(fees) && fees > 0) {
        out.push({
          dateISO,
          month: monthFromISO(dateISO),
          amount: -fees,
          category: "Landmark Fees",
          property,
          source: "booking",
          fixedVariable: "variable",
        });
        created++;
      }
    }

    return { txns: out, rowsSeen, created };
  }

  async function parseExpensesCSV(text: string) {
    const data = parseCSV(text);

    const out: Txn[] = [];
    let rowsSeen = data.length;
    let created = 0;

    for (const row of data) {
      const dateRaw = pickRowValue(row, ["Date", "date", "Month", "month"]);
      const propRaw = pickRowValue(row, ["Property", "property"]);
      const catRaw = pickRowValue(row, ["Category", "category"]);
      const amtRaw = pickRowValue(row, ["Amount", "amount"]);
      const fvRaw = pickRowValue(row, ["Fixed/Variable", "FixedVariable", "fixed/variable"]);

      const dateISO = toISODate(dateRaw);
      if (!dateISO) continue;

      const property = (propRaw ? String(propRaw).trim() : "Unknown") || "Unknown";
      const category = (catRaw ? String(catRaw).trim() : "Uncategorized") || "Uncategorized";

      const amt = parseMoney(amtRaw);
      if (Number.isNaN(amt) || amt === 0) continue;

      const expenseAmt = amt > 0 ? -amt : amt;
      const fixedVariable = normalizeFixedVar(fvRaw);

      out.push({
        dateISO,
        month: monthFromISO(dateISO),
        amount: expenseAmt,
        category,
        property,
        source: "expense",
        fixedVariable,
      });
      created++;
    }

    return { txns: out, rowsSeen, created };
  }

  async function loadBookings(files: FileList | null) {
    if (!files || files.length === 0) return;
    setStatus(`Loading bookings (${files.length} file(s))...`);

    let rows = 0;
    let created = 0;
    const all: Txn[] = [];

    for (const f of Array.from(files)) {
      const text = await f.text();
      const res = await parseBookingsCSV(text);
      rows += res.rowsSeen;
      created += res.created;
      all.push(...res.txns);
    }

    setTxns((prev) => [...prev.filter((t) => t.source !== "booking"), ...all]);
    setStatus(`Bookings loaded. Rows scanned: ${rows}. Booking txns: ${created}.`);
  }

  async function loadExpenses(files: FileList | null) {
    if (!files || files.length === 0) return;
    setStatus(`Loading expenses (${files.length} file(s))...`);

    let rows = 0;
    let created = 0;
    const all: Txn[] = [];

    for (const f of Array.from(files)) {
      const text = await f.text();
      const res = await parseExpensesCSV(text);
      rows += res.rowsSeen;
      created += res.created;
      all.push(...res.txns);
    }

    setTxns((prev) => [...prev.filter((t) => t.source !== "expense"), ...all]);
    setStatus(`Expenses loaded. Rows scanned: ${rows}. Expense txns: ${created}.`);
  }

  async function refreshFromGoogleSheets() {
    if (!BOOKINGS_URL || !EXPENSES_URL) {
      setStatus("Add BOOKINGS_URL and EXPENSES_URL at the top of page.tsx to enable refresh.");
      return;
    }

    try {
      setStatus("Refreshing from Google Sheets...");

      const bookingsText = await fetch(`${BOOKINGS_URL}&_t=${Date.now()}`, {
        cache: "no-store",
      }).then((r) => r.text());

      const expensesText = await fetch(`${EXPENSES_URL}&_t=${Date.now()}`, {
        cache: "no-store",
      }).then((r) => r.text());

      const b = await parseBookingsCSV(bookingsText);
      const e = await parseExpensesCSV(expensesText);

      setTxns([...b.txns, ...e.txns]);
      setStatus(`Live data loaded ✓ (Bookings: ${b.created}, Expenses: ${e.created})`);
    } catch (err) {
      setStatus(`Refresh failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  const properties = useMemo(() => {
    const set = new Set<string>();
    for (const t of txns) set.add(t.property);
    return ["All", ...Array.from(set).sort()];
  }, [txns]);

  const months = useMemo(() => {
    const set = new Set<string>();
    for (const t of txns) set.add(t.month);
    return ["ALL", ...Array.from(set).sort()];
  }, [txns]);

  const report = useMemo(() => {
    const filtered = txns.filter((t) => {
      const monthOk = month === "ALL" ? true : t.month === month;
      const propOk = propertyFilter === "All" ? true : t.property === propertyFilter;
      return monthOk && propOk;
    });

    const income = filtered.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const expensesAbs = filtered.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);

    const fixedAbs = filtered
      .filter((t) => t.amount < 0 && t.fixedVariable === "fixed")
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    const variableAbs = filtered
      .filter((t) => t.amount < 0 && t.fixedVariable === "variable")
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    const byCategory = new Map<string, number>();
    for (const t of filtered) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amount);

    const rows = Array.from(byCategory.entries())
      .map(([category, net]) => ({ category, net }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    return { income, expensesAbs, net: income - expensesAbs, fixedAbs, variableAbs, rows, count: filtered.length };
  }, [txns, month, propertyFilter]);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 30, fontWeight: 900 }}>STR Finance Dashboard</h1>
      <div style={{ color: "#aaa", marginTop: 6 }}>{status}</div>

      <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          ref={bookingsRef}
          type="file"
          multiple
          accept=".csv"
          style={{ display: "none" }}
          onChange={(e) => loadBookings(e.target.files)}
        />
        <button onClick={() => bookingsRef.current?.click()} style={btnStyle()}>
          Upload Bookings CSV
        </button>

        <input
          ref={expensesRef}
          type="file"
          multiple
          accept=".csv"
          style={{ display: "none" }}
          onChange={(e) => loadExpenses(e.target.files)}
        />
        <button onClick={() => expensesRef.current?.click()} style={btnStyle()}>
          Upload Expenses CSV
        </button>

        <button onClick={refreshFromGoogleSheets} style={btnStyle()}>
          Refresh from Google Sheets
        </button>

        <label style={{ fontWeight: 800, color: "white" }}>
          Month:&nbsp;
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle()}>
            {months.map((m) => (
              <option key={m} value={m} style={{ color: "black" }}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontWeight: 800, color: "white" }}>
          Property:&nbsp;
          <select value={propertyFilter} onChange={(e) => setPropertyFilter(e.target.value)} style={inputStyle()}>
            {properties.map((p) => (
              <option key={p} value={p} style={{ color: "black" }}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <div style={{ color: "#aaa", fontSize: 12 }}>Txns in view: {report.count}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginTop: 16 }}>
        <Card title="Income" value={fmtUSD(report.income)} />
        <Card title="Expenses" value={fmtUSD(report.expensesAbs)} />
        <Card title="Net" value={fmtUSD(report.net)} />
        <Card title="Fixed" value={fmtUSD(report.fixedAbs)} />
        <Card title="Variable" value={fmtUSD(report.variableAbs)} />
      </div>

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 900, color: "white" }}>By Category (Net)</h2>
        <div style={{ border: "1px solid #444", borderRadius: 14, marginTop: 10, overflow: "hidden" }}>
          {report.rows.length === 0 ? (
            <div style={{ padding: 12, color: "#aaa" }}>No transactions in this selection.</div>
          ) : (
            report.rows.map((r, i) => (
              <div
                key={r.category}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderTop: i === 0 ? "none" : "1px solid #333",
                  color: "white",
                }}
              >
                <span>{r.category}</span>
                <span>{fmtUSD(r.net)}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <div style={{ marginTop: 10, color: "#777", fontSize: 12 }}>
        Date ranges like <b>7/14/2025 - 7/25/2025</b> count in the month of the first date (check-in).
      </div>
    </main>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid #555",
    background: "#111",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
  };
}

function inputStyle(): React.CSSProperties {
  return {
    padding: 8,
    borderRadius: 10,
    border: "1px solid #555",
    background: "#111",
    color: "white",
    marginLeft: 6,
  };
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div style={{ border: "1px solid #444", borderRadius: 14, padding: 14, background: "#0b0b0b" }}>
      <div style={{ color: "#aaa", fontSize: 12, fontWeight: 900 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 950, marginTop: 8, color: "white" }}>{value}</div>
    </div>
  );
}