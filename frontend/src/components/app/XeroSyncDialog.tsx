import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Users,
  Building2,
  ChevronRight,
  ChevronLeft,
  Calendar,
  Check,
  X,
  Loader2,
  Search,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

type ContactType = "customers" | "suppliers";

interface XeroContact {
  id: string;
  name: string;
  email: string;
  isCustomer: boolean;
  isSupplier: boolean;
}

interface XeroSyncDialogProps {
  open: boolean;
  onClose: () => void;
}

type Step = "choose-type" | "select-contacts" | "date-filter" | "payment-terms" | "preview" | "importing" | "done";

export function XeroSyncDialog({ open, onClose }: XeroSyncDialogProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("choose-type");
  const [contactType, setContactType] = useState<ContactType | null>(null);
  const [contacts, setContacts] = useState<XeroContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [paymentTerms, setPaymentTerms] = useState<Record<string, number>>({});
  const [previewData, setPreviewData] = useState<{
    invoices: Array<{
      contactId: string;
      contactName: string;
      invoiceNumber: string;
      issueDate: string;
      dueDate: string;
      amount: number;
      balance: number;
      status: string;
      closedDate: string | null;
    }>;
    summary: { totalInvoices: number; totalContacts: number; totalAmount: number };
  } | null>(null);
  const [results, setResults] = useState<{
    contacts: { created: number; updated: number };
    invoices: { created: number; updated: number };
    payments: { created: number };
  } | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setStep("choose-type");
      setContactType(null);
      setContacts([]);
      setSelectedIds(new Set());
      setSearchQuery("");
      setPage(1);
      setDateFrom("");
      setDateTo("");
      setPaymentTerms({});
      setPreviewData(null);
      setResults(null);
      setFetchError(null);
    }
  }, [open]);

  // Fetch contacts mutation
  const fetchContactsMut = useMutation({
    mutationFn: (type: ContactType) => api.fetchXeroContacts(type),
    onSuccess: (data) => {
      setContacts(data.contacts);
      setPage(1);
      // Select all by default
      setSelectedIds(new Set(data.contacts.map((c) => c.id)));
      setFetchError(null);
      setStep("select-contacts");
    },
    onError: (err: any) => {
      setFetchError(err.message || "Failed to fetch contacts");
      toast.error(err.message || "Failed to fetch contacts from Xero");
    },
  });

  // Preview mutation
  const previewMut = useMutation({
    mutationFn: () =>
      api.previewXeroImport({
        contactIds: Array.from(selectedIds),
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        paymentTerms,
      }),
    onSuccess: (data) => {
      setPreviewData(data);
      setStep("preview");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to preview invoices");
    },
  });

  // Import mutation
  const importMut = useMutation({
    mutationFn: () =>
      api.importXeroContacts({
        contactIds: Array.from(selectedIds),
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        paymentTerms,
      }),
    onSuccess: (data) => {
      setResults(data);
      setStep("done");
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Import completed successfully!");
    },
    onError: (err: any) => {
      toast.error(err.message || "Import failed");
      setStep("date-filter");
    },
  });

  // Handlers
  const handleTypeSelect = (type: ContactType) => {
    setContactType(type);
    fetchContactsMut.mutate(type);
  };

  const toggleContact = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredContacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredContacts.map((c) => c.id)));
    }
  };

  const handlePreview = () => {
    if (selectedIds.size === 0) {
      toast.error("Select at least one contact to import");
      return;
    }
    // Initialize payment terms for selected contacts that don't have them
    const updated = { ...paymentTerms };
    for (const id of selectedIds) {
      if (!updated[id]) {
        updated[id] = 30; // Default to Net 30
      }
    }
    setPaymentTerms(updated);
    setStep("payment-terms");
  };

  const handleImport = () => {
    setStep("importing");
    importMut.mutate();
  };

  const handleClose = () => {
    if (step === "importing") return; // Don't close while importing
    onClose();
  };

  // Filter contacts by search
  const filteredContacts = contacts.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedContacts = filteredContacts.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );
  const pageStart = (safePage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * PAGE_SIZE, filteredContacts.length);

  // Reset page when search changes
  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  const allSelected = contacts.length > 0 && selectedIds.size === filteredContacts.length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-xl mx-4 bg-card border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-primary/60" />
              <div className="h-2 w-2 rounded-full bg-primary/40" />
              <div className="h-2 w-2 rounded-full bg-primary/20" />
            </div>
            <h2 className="text-lg font-semibold">Sync from Xero</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={step === "importing"}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Progress steps */}
        <div className="flex items-center gap-1 px-6 py-3 bg-muted/30 border-b">
          {[
            { key: "choose-type", label: "Type" },
            { key: "select-contacts", label: "Contacts" },
            { key: "date-filter", label: "Date" },
            { key: "payment-terms", label: "Terms" },
            { key: "preview", label: "Review" },
            { key: "importing", label: step === "importing" || step === "done" ? "Import" : "Import" },
          ].map((s, i) => {
            const stepOrder = ["choose-type", "select-contacts", "date-filter", "payment-terms", "preview", "importing"];
            const currentIdx = stepOrder.indexOf(step);
            const thisIdx = stepOrder.indexOf(s.key);
            const isActive = currentIdx >= thisIdx;
            const isCurrent = step === s.key || (step === "done" && s.key === "importing");

            return (
              <div key={s.key} className="flex items-center gap-1 flex-1">
                <div
                  className={`flex items-center justify-center h-6 w-6 rounded-full text-xs font-medium transition-all duration-300 ${
                    isCurrent
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : isActive
                      ? "bg-primary/20 text-primary"
                      : "bg-muted-foreground/20 text-muted-foreground"
                  }`}
                >
                  {isActive ? <Check className="h-3 w-3" /> : i + 1}
                </div>
                <span
                  className={`text-xs font-medium ${
                    isCurrent ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {s.label}
                </span>
                {i < stepOrder.length - 1 && <div className="flex-1 h-px bg-border mx-1" />}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="px-6 py-5 max-h-[60vh] overflow-y-auto">
          {/* Step 1: Choose contact type */}
          {step === "choose-type" && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">What would you like to import?</h3>
                <p className="text-xs text-muted-foreground">
                  Choose whether to import customers or suppliers from Xero.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => handleTypeSelect("customers")}
                  disabled={fetchContactsMut.isPending}
                  className="group relative flex flex-col items-center gap-3 rounded-xl border-2 border-border p-6 transition-all hover:border-primary hover:bg-primary/5 hover:shadow-md"
                >
                  {fetchContactsMut.isPending && contactType === "customers" ? (
                    <Loader2 className="h-10 w-10 text-primary animate-spin" />
                  ) : (
                    <div className="rounded-full bg-primary/10 p-3 group-hover:bg-primary/15 transition-colors">
                      <Users className="h-10 w-10 text-primary" />
                    </div>
                  )}
                  <span className="font-semibold text-sm">Customers</span>
                  <span className="text-xs text-muted-foreground text-center">
                    Import customer contacts and their invoices
                  </span>
                </button>

                <button
                  onClick={() => handleTypeSelect("suppliers")}
                  disabled={fetchContactsMut.isPending}
                  className="group relative flex flex-col items-center gap-3 rounded-xl border-2 border-border p-6 transition-all hover:border-primary hover:bg-primary/5 hover:shadow-md"
                >
                  {fetchContactsMut.isPending && contactType === "suppliers" ? (
                    <Loader2 className="h-10 w-10 text-primary animate-spin" />
                  ) : (
                    <div className="rounded-full bg-amber-500/10 p-3 group-hover:bg-amber-500/15 transition-colors">
                      <Building2 className="h-10 w-10 text-amber-500" />
                    </div>
                  )}
                  <span className="font-semibold text-sm">Suppliers</span>
                  <span className="text-xs text-muted-foreground text-center">
                    Import supplier contacts and their bills
                  </span>
                </button>
              </div>

              {fetchError && (
                <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{fetchError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => contactType && fetchContactsMut.mutate(contactType)}
                    className="ml-auto shrink-0 gap-1"
                  >
                    <RefreshCw className="h-3 w-3" /> Retry
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Select contacts */}
          {step === "select-contacts" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">
                  Select {contactType === "customers" ? "Customers" : "Suppliers"}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {contacts.length} {contactType === "customers" ? "customers" : "suppliers"} found. Choose which ones to import.
                </p>
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={`Search ${contactType === "customers" ? "customers" : "suppliers"}...`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* Select all / deselect all */}
              {filteredContacts.length > 0 && (
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <div
                    className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                      allSelected
                        ? "bg-primary border-primary text-primary-foreground"
                        : selectedIds.size > 0
                        ? "border-primary bg-primary/20"
                        : "border-muted-foreground/40"
                    }`}
                  >
                    {allSelected && <Check className="h-3 w-3" />}
                  </div>
                  {allSelected
                    ? "Deselect all"
                    : `Select all (${filteredContacts.length})`}
                </button>
              )}

              {/* Contact list */}
              <div className="space-y-1 max-h-64 overflow-y-auto rounded-lg border">
                {filteredContacts.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                    <Search className="h-8 w-8 opacity-40" />
                    <p className="text-sm">No contacts found</p>
                  </div>
                ) : (
                  paginatedContacts.map((contact) => {
                    const isSelected = selectedIds.has(contact.id);
                    return (
                      <button
                        key={contact.id}
                        onClick={() => toggleContact(contact.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent ${
                          isSelected ? "bg-primary/5" : ""
                        }`}
                      >
                        <div
                          className={`h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-all ${
                            isSelected
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-muted-foreground/40"
                          }`}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">
                            {contact.name}
                          </p>
                          {contact.email && (
                            <p className="text-xs text-muted-foreground truncate">
                              {contact.email}
                            </p>
                          )}
                        </div>
                        {contact.isCustomer && contact.isSupplier && (
                          <span className="shrink-0 text-[10px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                            BOTH
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Pagination */}
              {filteredContacts.length > PAGE_SIZE && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {pageStart}–{pageEnd} of {filteredContacts.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="flex items-center justify-center h-7 w-7 rounded text-xs transition-colors hover:bg-accent disabled:opacity-30 disabled:pointer-events-none"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      // Smart page number display: show pages around current
                      let pageNum: number;
                      if (totalPages <= 7) {
                        pageNum = i + 1;
                      } else {
                        const half = Math.floor(6 / 2);
                        let start = safePage - half;
                        if (start < 1) start = 1;
                        if (start + 6 > totalPages) start = totalPages - 6;
                        pageNum = start + i;
                      }
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setPage(pageNum)}
                          className={`flex items-center justify-center h-7 w-7 rounded text-xs font-medium transition-colors ${
                            safePage === pageNum
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="flex items-center justify-center h-7 w-7 rounded text-xs transition-colors hover:bg-accent disabled:opacity-30 disabled:pointer-events-none"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{selectedIds.size} of {contacts.length} selected</span>
                {searchQuery && filteredContacts.length < contacts.length && (
                  <span>Showing {filteredContacts.length} matching</span>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Date filter */}
          {step === "date-filter" && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Filter Invoices by Date</h3>
                <p className="text-xs text-muted-foreground">
                  Optionally choose a date to only import invoices from that date onward.
                  Leave empty to import all invoices.
                </p>
              </div>

              <div className="rounded-xl border bg-muted/20 p-5 space-y-5">
                {/* From Date */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-primary/10 p-2.5">
                      <Calendar className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1">
                      <label className="text-sm font-medium">From Date</label>
                      <p className="text-xs text-muted-foreground">
                        Only import invoices issued on or after this date
                      </p>
                    </div>
                  </div>

                  <div className="relative">
                    <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="pl-9"
                      max={dateTo || new Date().toISOString().split("T")[0]}
                    />
                  </div>

                  {dateFrom && (
                    <button
                      onClick={() => setDateFrom("")}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear date filter
                    </button>
                  )}
                </div>

                {/* Divider */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground font-medium">AND</span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                {/* To Date */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-primary/10 p-2.5">
                      <Calendar className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1">
                      <label className="text-sm font-medium">To Date</label>
                      <p className="text-xs text-muted-foreground">
                        Only import invoices issued on or before this date
                      </p>
                    </div>
                  </div>

                  <div className="relative">
                    <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="pl-9"
                      min={dateFrom || undefined}
                      max={new Date().toISOString().split("T")[0]}
                    />
                  </div>

                  {dateTo && (
                    <button
                      onClick={() => setDateTo("")}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear date filter
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  <strong className="text-foreground">{selectedIds.size}</strong>{" "}
                  {contactType === "customers" ? "customers" : "suppliers"} selected for import
                  {dateFrom || dateTo
                    ? ` with invoices${dateFrom ? ` from ${new Date(dateFrom).toLocaleDateString()}` : ""}${dateTo ? ` to ${new Date(dateTo).toLocaleDateString()}` : ""}`
                    : " with all invoices"}
                </p>
              </div>
            </div>
          )}

          {/* Step 4: Payment Terms */}
          {step === "payment-terms" && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Set Payment Terms</h3>
                <p className="text-xs text-muted-foreground">
                  Set the net payment terms for each contact. The due date will be automatically
                  calculated from the invoice issue date.
                </p>
              </div>

              <div className="space-y-3">
                {contacts
                  .filter((c) => selectedIds.has(c.id))
                  .map((contact) => (
                    <div
                      key={contact.id}
                      className="flex items-center justify-between rounded-lg border p-3 gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{contact.name}</p>
                        {contact.email && (
                          <p className="text-xs text-muted-foreground truncate">{contact.email}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <label className="text-xs text-muted-foreground">Net</label>
                        <select
                          value={paymentTerms[contact.id] || 30}
                          onChange={(e) =>
                            setPaymentTerms((prev) => ({
                              ...prev,
                              [contact.id]: parseInt(e.target.value),
                            }))
                          }
                          className="h-9 rounded-lg border bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                          <option value={0}>0 (Due on issue)</option>
                          <option value={7}>7 days</option>
                          <option value={15}>15 days</option>
                          <option value={30}>30 days</option>
                          <option value={45}>45 days</option>
                          <option value={60}>60 days</option>
                          <option value={90}>90 days</option>
                          <option value={120}>120 days</option>
                        </select>
                        <span className="text-xs text-muted-foreground">days</span>
                      </div>
                    </div>
                  ))}
              </div>

              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  <strong className="text-foreground">{selectedIds.size}</strong>{" "}
                  {contactType === "customers" ? "customers" : "suppliers"} selected
                  {dateFrom || dateTo
                    ? ` with invoices${dateFrom ? ` from ${new Date(dateFrom).toLocaleDateString()}` : ""}${dateTo ? ` to ${new Date(dateTo).toLocaleDateString()}` : ""}`
                    : " with all invoices"}
                </p>
              </div>
            </div>
          )}

          {/* Step 5: Preview */}
          {step === "preview" && previewData && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Review Import</h3>
                <p className="text-xs text-muted-foreground">
                  Review the invoices that will be imported. The due dates are calculated based on
                  your payment terms.
                </p>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-3">
                <Card className="p-3 text-center">
                  <p className="text-2xl font-bold text-primary">{previewData.summary.totalContacts}</p>
                  <p className="text-xs text-muted-foreground">Contacts</p>
                </Card>
                <Card className="p-3 text-center">
                  <p className="text-2xl font-bold text-primary">{previewData.summary.totalInvoices}</p>
                  <p className="text-xs text-muted-foreground">Invoices</p>
                </Card>
                <Card className="p-3 text-center">
                  <p className="text-2xl font-bold text-primary">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                    }).format(previewData.summary.totalAmount)}
                  </p>
                  <p className="text-xs text-muted-foreground">Total amount</p>
                </Card>
              </div>

              {/* Invoice table */}
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Contact</th>
                      <th className="text-left px-3 py-2 font-medium">Invoice #</th>
                      <th className="text-left px-3 py-2 font-medium">Issued</th>
                      <th className="text-left px-3 py-2 font-medium">Due</th>
                      <th className="text-right px-3 py-2 font-medium">Amount</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.invoices.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-muted-foreground">
                          No invoices found for the selected filters
                        </td>
                      </tr>
                    ) : (
                      previewData.invoices.map((inv, idx) => (
                        <tr
                          key={`${inv.invoiceNumber}-${idx}`}
                          className="border-t hover:bg-muted/20 transition-colors"
                        >
                          <td className="px-3 py-2 truncate max-w-[120px]">{inv.contactName}</td>
                          <td className="px-3 py-2 font-medium">{inv.invoiceNumber}</td>
                          <td className="px-3 py-2">{inv.issueDate}</td>
                          <td className="px-3 py-2">{inv.dueDate}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {new Intl.NumberFormat("en-US", {
                              style: "currency",
                              currency: "USD",
                            }).format(inv.amount)}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                inv.status === "closed"
                                  ? "bg-emerald-500/10 text-emerald-600"
                                  : "bg-amber-500/10 text-amber-600"
                              }`}
                            >
                              {inv.status === "closed" ? "Paid" : "Open"}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Step 6: Importing */}
          {step === "importing" && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <div className="relative">
                <Loader2 className="h-12 w-12 text-primary animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-3 w-3 rounded-full bg-primary/30 animate-ping" />
                </div>
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold">Importing from Xero...</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Please wait while we sync your data
                </p>
              </div>
            </div>
          )}

          {/* Step 5: Done */}
          {step === "done" && results && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="rounded-full bg-emerald-500/10 p-3">
                  <Check className="h-8 w-8 text-emerald-500" />
                </div>
                <div className="text-center">
                  <h3 className="text-sm font-semibold text-foreground">Import Complete!</h3>
                  <p className="text-xs text-muted-foreground">
                    Your data has been successfully synced from Xero.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Card className="p-3 text-center">
                  <p className="text-2xl font-bold text-primary">{results.contacts.created}</p>
                  <p className="text-xs text-muted-foreground">New contacts</p>
                </Card>
                <Card className="p-3 text-center">
                  <p className="text-2xl font-bold text-primary">
                    {results.invoices.created + results.invoices.updated}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Invoices ({results.invoices.created} new, {results.invoices.updated} updated)
                  </p>
                </Card>
                <Card className="p-3 text-center">
                  <p className="text-2xl font-bold text-primary">{results.payments.created}</p>
                  <p className="text-xs text-muted-foreground">New payments</p>
                </Card>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-muted/20">
          {/* Back buttons */}
          {step === "select-contacts" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep("choose-type");
                setFetchError(null);
              }}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {step === "date-filter" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep("select-contacts")}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {step === "payment-terms" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep("date-filter")}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {step === "preview" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep("payment-terms")}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {step === "choose-type" && fetchContactsMut.isPending && (
            <Button variant="ghost" size="sm" disabled className="gap-1">
              <Loader2 className="h-4 w-4 animate-spin" /> Fetching...
            </Button>
          )}
          {(step === "done" || step === "importing") && (
            <div /> // Spacer
          )}

          {/* Next / Import / Close */}
          <div className="ml-auto">
            {step === "choose-type" && !fetchContactsMut.isPending && (
              <p className="text-xs text-muted-foreground">Select a type to continue</p>
            )}

            {step === "select-contacts" && (
              <Button
                size="sm"
                onClick={() => setStep("date-filter")}
                disabled={selectedIds.size === 0}
                className="gap-1"
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            )}

            {step === "date-filter" && (
              <Button
                size="sm"
                onClick={handlePreview}
                className="gap-1.5"
              >
                <Calendar className="h-4 w-4" /> Set Payment Terms
              </Button>
            )}

            {step === "payment-terms" && (
              <Button
                size="sm"
                onClick={() => previewMut.mutate()}
                disabled={previewMut.isPending}
                className="gap-1.5"
              >
                {previewMut.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Previewing...</>
                ) : (
                  <><Search className="h-4 w-4" /> Preview Invoices</>
                )}
              </Button>
            )}

            {step === "preview" && (
              <Button
                size="sm"
                onClick={handleImport}
                disabled={importMut.isPending}
                className="gap-1.5"
              >
                <RefreshCw className="h-4 w-4" /> Approve & Import {previewData?.summary.totalInvoices || 0} invoices
              </Button>
            )}

            {step === "done" && (
              <Button size="sm" onClick={onClose} className="gap-1.5">
                <Check className="h-4 w-4" /> Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
