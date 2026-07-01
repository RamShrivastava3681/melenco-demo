import XLSX from "xlsx";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create data matching the template: invoice_number, issue_date, due_date, amount
const data = [
  { invoice_number: "TEST-001", issue_date: "2025-01-15", due_date: "2025-02-14", amount: 1500.00 },
  { invoice_number: "TEST-002", issue_date: "2025-01-20", due_date: "2025-02-19", amount: 2750.50 },
  { invoice_number: "TEST-003", issue_date: "2025-03-01", due_date: "2025-03-31", amount: 99.99 },
  { invoice_number: "TEST-004", issue_date: "2025-04-10", due_date: "2025-05-10", amount: 5000.00 },
  { invoice_number: "TEST-005", issue_date: "2025-05-15", due_date: "2025-06-14", amount: 1234.56 },
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(data);
XLSX.utils.book_append_sheet(wb, ws, "Invoices");
const outPath = path.resolve(__dirname, "test-invoices.xlsx");
XLSX.writeFile(wb, outPath);
console.log("Created:", outPath);
console.log("Data:", JSON.stringify(data, null, 2));
