"use client";

import { useState, useEffect } from "react";
import { LeadsTable } from "@/components/leads-table";
import type { Lead, RankingResult } from "@/types";

export default function RankerPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [results, setResults] = useState<RankingResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/leads")
      .then((res) => res.json())
      .then(setLeads);
  }, []);

  async function handle_rank() {
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const res = await fetch("/api/rank", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line);
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.results) {
            setResults((prev) => [...prev, ...chunk.results as RankingResult[]]);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ranking failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <div className="header">
        <div>
          <h1>Persona Ranker</h1>
          <p className="subtitle">
            {leads.length} leads loaded
            {results.length > 0 && ` · ${results.filter((r) => r.relevant).length} relevant`}
          </p>
        </div>
        <button onClick={handle_rank} disabled={loading || leads.length === 0}>
          {loading ? "Ranking…" : "Rank Leads"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {leads.length > 0 ? (
        <LeadsTable leads={leads} results={results} />
      ) : (
        <p className="subtitle">Loading leads…</p>
      )}
    </main>
  );
}
