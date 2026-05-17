import { useEffect, useState } from "react";

interface LeadEvent {
  id: string;
  profile_url: string;
  person_name: string;
  interaction: string;
  summary: string;
  next_action: string | null;
  created_at: string;
  source_worker_id: string | null;
  source_persona: string | null;
}

const LIMIT = 50;

export function LeadsPanel() {
  const [events, setEvents] = useState<LeadEvent[]>([]);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/web/leads?page=${page}&limit=${LIMIT}`)
      .then((r) => r.json())
      .then((d: { events: LeadEvent[] }) => setEvents(d.events))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [page]);

  if (error) return <p className="text-red-600">Failed to load leads: {error}</p>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="px-3 py-1 rounded bg-slate-200 text-sm disabled:opacity-40"
        >
          Prev
        </button>
        <span className="text-sm text-slate-600">Page {page + 1}</span>
        <button
          type="button"
          disabled={events.length < LIMIT}
          onClick={() => setPage((p) => p + 1)}
          className="px-3 py-1 rounded bg-slate-200 text-sm disabled:opacity-40"
        >
          Next
        </button>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left border-b border-slate-300">
            <th className="py-2 pr-4">Person</th>
            <th className="py-2 pr-4">Interaction</th>
            <th className="py-2 pr-4">Summary</th>
            <th className="py-2 pr-4">Worker</th>
            <th className="py-2 pr-4">When</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-slate-200">
              <td className="py-2 pr-4">{e.person_name}</td>
              <td className="py-2 pr-4">{e.interaction}</td>
              <td className="py-2 pr-4">{e.summary}</td>
              <td className="py-2 pr-4">{e.source_worker_id ?? "—"}</td>
              <td className="py-2 pr-4">{e.created_at}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td className="py-3 text-slate-500" colSpan={5}>
                No lead-memory events.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
