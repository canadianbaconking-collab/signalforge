export type CollectedItem = {
  title: string;
  url: string;
  snippet: string;
  published_at: string | null;
  source: string;
  /** Optional explicit provenance. Collectors must not infer these from prose. */
  claim_key?: string;
  stance?: "supports" | "refutes" | "neutral";
  primary_url?: string;
  originator_id?: string;
  timestamp_basis?: "platform" | "publisher" | "inferred";
  metadata_origin?: "collector" | "operator";
};
