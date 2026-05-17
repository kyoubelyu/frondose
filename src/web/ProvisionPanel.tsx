import { useEffect, useState } from "react";
import { ErrorState, Panel } from "./ui.js";

interface Persona {
  id: string;
  fullName: string | null;
  role: string | null;
  company: string | null;
}

interface ProvisionResult {
  ok: boolean;
  curlCommand?: string;
  error?: string;
}

export function ProvisionPanel() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState("");
  const [hostname, setHostname] = useState("");
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/web/personas")
      .then((r) => r.json())
      .then((d: { personas: Persona[] }) => {
        setPersonas(d.personas);
        if (d.personas.length > 0 && d.personas[0]) setPersonaId(d.personas[0].id);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const submit = async () => {
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const body: { personaId: string; hostname?: string } = { personaId };
      if (hostname.trim()) body.hostname = hostname.trim();
      const res = await fetch("/api/web/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setResult((await res.json()) as ProvisionResult);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Provision a worker">
      <div className="max-w-xl space-y-4">
        {error && <ErrorState message={error} />}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-600">Persona</span>
          <select
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1"
          >
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} — {p.fullName ?? "?"}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-600">Hostname (optional)</span>
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={!personaId || busy}
          className="rounded bg-slate-800 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Provisioning…" : "Provision"}
        </button>
        {result?.ok && result.curlCommand && (
          <div>
            <p className="mb-1 text-sm text-slate-600">Run this on the new VM:</p>
            <code className="block break-all rounded bg-slate-100 p-3 text-xs">{result.curlCommand}</code>
          </div>
        )}
        {result && !result.ok && <ErrorState message={`Provision failed: ${result.error ?? "unknown error"}`} />}
      </div>
    </Panel>
  );
}
