import { record, redact, safeTitle, type Decision } from "./selector.ts";
export interface Candidate { title: string; style: string; language: string }
export interface Envelope {
  topic: string; candidates: Candidate[]; preferences?: string;
  description?: string; tags?: string[]; suppressed?: number;
}
export function candidateInstructions(manual: boolean): string {
  return "INTERNAL OUTPUT OVERRIDE: Return ONLY strict JSON (no fences, prose or local recommendation). Selection is a later code step, not your task. " +
    'Schema: {"topic":"short generated redacted synopsis, never a transcript excerpt (1..600 chars)","candidates":[{"title":"copy-ready title <=240 chars","style":"Descriptive|Slug|Keyword|Bracket|Outcome-focused|Emoji","language":"English"}],"preferences":"generated short preference synopsis <=400 chars"' +
    (manual ? ',"description":"3-6 sentence summary <=2400 chars","tags":["5-8 lowercase kebab tags"],"suppressed":0}' : "}") +
    " Omit credentials, email/IP addresses, absolute/private paths and unnecessary private identifiers from ALL fields. Preserve proper names and diacritics, and use ordinary hyphens. If the topic is unclear, return an empty candidates array; never invent. " +
    (manual ? "Produce the full suggestion-only skill output in this internal schema, using the User preset unless the explicit user title request overrides it. Include categorized variants for all selected styles and languages, at most 12 variants per language and 36 overall. Respect compact Slug, Keyword, Bracket built-in date handling and other explicit overrides. Include description, tags, and the number of suppressed combinations; do not choose a recommended title yourself."
      : "Generate 1 to 3 distinct Long English Descriptive titles using the User preset's Suffix date with today's UTC date. Each must end in ' - YYYY-MM-DD', aim for 60–180 characters (maximum 240). Set style to Descriptive and language to English. Do not include description or tags.");
}
export function parseEnvelope(raw: string, manual: boolean, validate: (title: string) => string | undefined): Envelope | undefined {
  if (raw.length > 24000) return;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return; }
  if (!record(v) || Object.keys(v).some(k => !["topic", "candidates", "preferences", "description", "tags", "suppressed"].includes(k)) ||
      typeof v.topic !== "string" || !v.topic.trim() || v.topic.length > 600 ||
      !Array.isArray(v.candidates) || !v.candidates.length || v.candidates.length > (manual ? 36 : 3) ||
      (v.preferences !== undefined && (typeof v.preferences !== "string" || v.preferences.length > 400))) return;
  if (manual && (typeof v.description !== "string" || !v.description.trim() || v.description.length > 2400 ||
      !Array.isArray(v.tags) || v.tags.length < 5 || v.tags.length > 8 || v.tags.some((t: unknown) => typeof t !== "string" || t.length > 80) ||
      (v.suppressed !== undefined && (!Number.isSafeInteger(v.suppressed) || v.suppressed < 0 || v.suppressed > 10000)))) return;
  const candidates: Candidate[] = [], counts = new Map<string, number>();
  for (const c of v.candidates) {
    if (!record(c) || Object.keys(c).some(k => !["title", "style", "language"].includes(k)) ||
        typeof c.title !== "string" || c.title.length > 240 ||
        !["Descriptive", "Slug", "Keyword", "Bracket", "Outcome-focused", "Emoji"].includes(c.style) ||
        typeof c.language !== "string" || !/^[\p{L} ()-]{1,40}$/u.test(c.language)) return;
    const count = (counts.get(c.language) ?? 0) + 1; counts.set(c.language, count);
    if (count > 12 || counts.size > 3) return;
    if (!manual && (c.style !== "Descriptive" || c.language !== "English")) return;
    if (safeTitle(c.title) && !/[`<>]/.test(c.title) && (manual || validate(c.title) === c.title)) candidates.push({ title: c.title, style: c.style, language: c.language });
  }
  if (!candidates.length) return;
  return { topic: redact(v.topic).slice(0, 600), candidates, ...(v.preferences ? { preferences: redact(v.preferences).slice(0, 400) } : {}),
    ...(manual ? { description: redact(v.description), tags: v.tags.map((t: string) => redact(t)), suppressed: v.suppressed ?? 0 } : {}) };
}
export function renderManual(envelope: Envelope, decision: Decision): string {
  const provenance = `Titlewise: source=${decision.source}; status=${decision.status}` +
    (decision.model ? `; model=typesafe/${decision.model}` : `; reason=${decision.reason ?? "unavailable"}`);
  const recommendation = decision.status === "skip" ? "No recommended title (abstained)." : `Recommended${decision.status === "keep" ? " (keep current)" : ""}:\n\n\`\`\`\n${decision.title}\n\`\`\``;
  const groups = new Map<string, string[]>();
  for (const c of envelope.candidates) {
    const key = `${c.language} / ${c.style}`;
    groups.set(key, [...(groups.get(key) ?? []), c.title]);
  }
  const variants = [...groups].map(([key, titles]) => `### ${key}\n\n` + titles.map(title => `\`\`\`\n${title}\n\`\`\``).join("\n\n")).join("\n\n");
  return `${provenance}\n\n${recommendation}\n\n${variants}\n\n` +
    (envelope.suppressed ? `${envelope.suppressed} combinations suppressed; narrow language, length, style or date to see more.\n\n` : "") +
    `Description: ${envelope.description}\n\nTags: ${envelope.tags?.join(", ")}\n\nCopy the variant you like and set it using your client's rename/title option. Nothing was renamed.`;
}
