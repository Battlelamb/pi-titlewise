// Offline fixtures: neither native auth nor network may be reached.
import { selectTitle, type Selector } from "./selector.ts";
export const fakeSelector: Selector = (input, signal) => selectTitle(input, signal, 100, {
  auth: async () => undefined,
  fetch: async () => { throw new Error("network must not run"); },
});
export function generated(title: string): string {
  return JSON.stringify({ topic: "Session title integration and validation", candidates: [{ title, style: "Descriptive", language: "English" }],
    preferences: "Long English descriptive with suffix date", description: "Title integration was tested. Lifecycle guards were preserved. Naming remains bounded.",
    tags: ["titlewise", "tests", "integration", "lifecycle", "validation"], suppressed: 0 });
}
