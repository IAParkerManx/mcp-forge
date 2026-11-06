// Build REA-shaped Evidence from a HAR without running REA, so unit and
// end-to-end tests stay offline. Mirrors REA's transport-credential handling:
// Cookie / Set-Cookie / Authorization values become null.
import type { ReaEvidence } from "../src/rea/client.ts";

const CREDENTIAL_HEADERS = new Set(["cookie", "set-cookie", "authorization"]);

interface HarEntry {
  request: { headers: { name: string; value: string }[] };
  response: { headers: { name: string; value: string }[] };
}

export function evidenceFromHar(har: { log: { entries: HarEntry[] } }, id = "ev_test0000000000000000"): ReaEvidence {
  const records = har.log.entries.map((entry, ordinal) => {
    const reported = structuredClone(entry);
    for (const side of [reported.request, reported.response]) {
      for (const h of side.headers) if (CREDENTIAL_HEADERS.has(h.name.toLowerCase())) (h as { value: string | null }).value = null;
    }
    return { ordinal, reported };
  });
  return {
    evidence_id: id,
    operation: "inspect_web_network_capture",
    confidence: "observed",
    normalized_result: { format: "har", total_records: records.length, records },
  };
}
