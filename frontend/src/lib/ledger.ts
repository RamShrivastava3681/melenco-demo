export type Customer = { id: string; name: string; created_at?: string };

export type Invoice = {
  id: string;
  user_id: string;
  customer_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  amount: number;
  balance: number;
  status: "open" | "closed";
  closed_date: string | null;
  payment_days: number | null;
  late_payment_days: number | null;
  created_at: string;
};

export type Payment = {
  id: string;
  user_id: string;
  customer_id: string;
  payment_date: string;
  amount: number;
  applied_amount: number;
  remaining: number;
  note: string | null;
  created_at: string;
};

export type Allocation = {
  id: string;
  user_id: string;
  payment_id: string;
  invoice_id: string;
  amount_applied: number;
  applied_date: string;
  closed_invoice: boolean;
  created_at: string;
};

export function daysBetween(a: string, b: string) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

export function fmtMoney(n: number) {
  return new Intl.NumberFormat(undefined, {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
