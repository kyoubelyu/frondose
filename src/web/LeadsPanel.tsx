import { useEffect, useState } from "react";
import { EmptyState, ErrorState, Loading, Panel } from "./ui.js";

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
  const [events, setEvents] = useState<LeadEvent[] | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEvents(null);
    fetch(`/api/web/leads?page=${page}&limit=${LIMIT}`)
      .then((r) => r.json())
      .then((d: { events: LeadEvent[] }) => setEvents(d.events))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [page]);

  return (
    <Panel title="Lead memory">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="rounded bg-slate-200 px-3 py-1 text-sm disabled:opacity-40"
        >
          Prev
        </button>
        <span className="text-sm text-slate-500">Page {page + 1}</span>
        <button
          type="button"
          disabled={!events || events.length < LIMIT}
          onClick={() => setPage((p) => p + 1)}
          className="rounded bg-slate-200 px-3 py-1 text-sm disabled:opacity-40"
        >
          Next
        </button>
      </div>
      {error ? (
        <ErrorState message={`Failed to load leads: ${error}`} />
      ) : events === null ? (
        <Loading what="lead events" />
      ) : events.length === 0 ? (
        <EmptyState message="No lead-memory events on this page." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Person</th>
              <th className="py-2 pr-4 font-medium">Interaction</th>
              <th className="py-2 pr-4 font-medium">Summary</th>
              <th className="py-2 pr-4 font-medium">Worker</th>
              <th className="py-2 pr-4 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-800">{e.person_name}</td>
                <td className="py-2 pr-4">{e.interaction}</td>
                <td className="py-2 pr-4">{e.summary}</td>
                <td className="py-2 pr-4">{e.source_worker_id ?? "—"}</td>
                <td className="py-2 pr-4 text-slate-500">{e.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
