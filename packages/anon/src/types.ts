export type Severity = "high" | "medium" | "low";

export type FindingLocation =
  | { kind: "pdf"; page: number }
  | { kind: "source"; file: string; line: number }
  | { kind: "metadata"; field: string }
  | { kind: "file"; file: string; field?: string };

export type RuleId =
  | "identifier"
  | "email"
  | "repo-link"
  | "acknowledgments"
  | "funding"
  | "author-command"
  | "pdf-metadata"
  | "embedded-path"
  | "self-citation"
  | "thanks"
  | "institution"
  | "image-metadata"
  | "final-option"
  | "comment-name";

export interface Finding {
  severity: Severity;
  rule: RuleId;
  title: string;
  location: FindingLocation;
  /** Short quoted context, whitespace-collapsed. */
  snippet: string;
  /** Optional advice shown under the snippet. */
  hint?: string;
}

export const severityOrder: Severity[] = ["high", "medium", "low"];
