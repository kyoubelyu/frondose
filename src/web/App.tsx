import { useState } from "react";
import { LeadsPanel } from "./LeadsPanel.js";
import { ProvisionPanel } from "./ProvisionPanel.js";
import { WorkersPanel } from "./WorkersPanel.js";

type Tab = "workers" | "leads" | "provision";

const TABS: { id: Tab; label: string }[] = [
  { id: "workers", label: "Workers" },
  { id: "leads", label: "Leads" },
  { id: "provision", label: "Provision" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("workers");
  return (
    <div className="min-h-screen">
      <header className="bg-slate-800 text-white px-6 py-3 flex items-center gap-6">
        <h1 className="text-lg font-semibold">mai server — fleet</h1>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1 rounded text-sm ${tab === t.id ? "bg-slate-600" : "hover:bg-slate-700"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="p-6">
        {tab === "workers" && <WorkersPanel />}
        {tab === "leads" && <LeadsPanel />}
        {tab === "provision" && <ProvisionPanel />}
      </main>
    </div>
  );
}
