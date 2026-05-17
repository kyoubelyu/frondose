import { useState } from "react";
import { LeadsPanel } from "./LeadsPanel.js";
import { ProvisionPanel } from "./ProvisionPanel.js";
import { SshPanel } from "./SshPanel.js";
import { VncPanel } from "./VncPanel.js";
import { WorkersPanel } from "./WorkersPanel.js";

type Tab = "workers" | "leads" | "provision" | "ssh" | "vnc";

const TABS: { id: Tab; label: string }[] = [
  { id: "workers", label: "Workers" },
  { id: "leads", label: "Leads" },
  { id: "provision", label: "Provision" },
  { id: "ssh", label: "SSH Terminal" },
  { id: "vnc", label: "VNC Viewer" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("workers");
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-3">
          <h1 className="text-base font-semibold tracking-tight">
            mai server <span className="font-normal text-slate-400">— fleet console</span>
          </h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${
                  tab === t.id ? "bg-white/15 font-medium" : "text-slate-300 hover:bg-white/10"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        {tab === "workers" && <WorkersPanel />}
        {tab === "leads" && <LeadsPanel />}
        {tab === "provision" && <ProvisionPanel />}
        {tab === "ssh" && <SshPanel />}
        {tab === "vnc" && <VncPanel />}
      </main>
    </div>
  );
}
