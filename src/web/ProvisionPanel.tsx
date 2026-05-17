import { useEffect, useState } from "react";

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
    }
  };

  return (
    <div className="max-w-xl">
      <h2 className="text-base font-semibold mb-3">Provision a worker</h2>
      {error && <p className="text-red-600 mb-3">{error}</p>}
      <label className="block mb-3 text-sm">
        Persona
        <select
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
          className="block mt-1 w-full border border-slate-300 rounded px-2 py-1"
        >
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} — {p.fullName ?? "?"}
            </option>
          ))}
        </select>
      </label>
      <label className="block mb-3 text-sm">
        Hostname (optional)
        <input
          type="text"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          className="block mt-1 w-full border border-slate-300 rounded px-2 py-1"
        />
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={!personaId}
        className="px-4 py-1.5 rounded bg-slate-800 text-white text-sm disabled:opacity-40"
      >
        Provision
      </button>
      {result?.ok && result.curlCommand && (
        <div className="mt-4">
          <p className="text-sm text-slate-600 mb-1">Run this on the new VM:</p>
          <code className="block bg-slate-100 p-3 rounded text-xs break-all">{result.curlCommand}</code>
        </div>
      )}
      {result && !result.ok && <p className="text-red-600 mt-3">Provision failed: {result.error ?? "unknown error"}</p>}
    </div>
  );
}
