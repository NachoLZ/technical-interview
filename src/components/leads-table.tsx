import type { Lead, RankingResult } from "@/types";

type Props = {
  leads: Lead[];
  results: RankingResult[];
};

export function LeadsTable({ leads, results }: Props) {
  const result_map = new Map(results.map((r) => [r.lead_id, r]));
  const has_results = results.length > 0;

  const sorted = [...leads].sort((a, b) => {
    if (!has_results) return 0;
    const ra = result_map.get(a.id);
    const rb = result_map.get(b.id);
    if (!ra && !rb) return 0;
    if (!ra) return 1;
    if (!rb) return -1;
    if (ra.relevant !== rb.relevant) return ra.relevant ? -1 : 1;
    return rb.score - ra.score;
  });

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Title</th>
            <th>Company</th>
            <th>Employees</th>
            <th>Industry</th>
            {has_results && (
              <>
                <th>Relevant</th>
                <th>Score</th>
                <th>Reasoning</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead) => {
            const result = result_map.get(lead.id);
            const irrelevant = result && !result.relevant;
            return (
              <tr key={lead.id} className={irrelevant ? "irrelevant" : ""}>
                <td>
                  {lead.first_name} {lead.last_name}
                </td>
                <td>{lead.job_title || <span className="empty">—</span>}</td>
                <td>{lead.company}</td>
                <td>{lead.employee_range || <span className="empty">—</span>}</td>
                <td>{lead.industry || <span className="empty">—</span>}</td>
                {has_results && (
                  <>
                    <td className={`relevance ${result?.relevant ? "yes" : "no"}`}>
                      {result ? (result.relevant ? "Yes" : "No") : "—"}
                    </td>
                    <td className="score">{result?.relevant ? result.score : "—"}</td>
                    <td className="reasoning">{result?.reasoning ?? "—"}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
