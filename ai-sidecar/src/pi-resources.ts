import path from "node:path";
import { loadSkillsFromDir, type LoadSkillsResult, type Skill } from "@earendil-works/pi-coding-agent";

export const nativeSkillsRoot = () => path.join(import.meta.dirname, "..", "skills", "native");
export const scientificSkillsRoot = () => path.join(import.meta.dirname, "..", "skills", "scientific");

export function loadFilteredPiSkills(allowed: string[]): LoadSkillsResult {
  const approved = new Set(allowed);
  const scientific = loadSkillsFromDir({ dir: scientificSkillsRoot(), source: "signalfold-scientific" });
  const native = loadSkillsFromDir({ dir: nativeSkillsRoot(), source: "signalfold-native" });
  const all = [...scientific.skills, ...native.skills];
  const byName = new Map(all.map((skill) => [skill.name, skill]));
  const missing = [...approved].filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`Approved Pi skills are unavailable: ${missing.join(", ")}`);
  return { skills: [...approved].map((name) => byName.get(name) as Skill), diagnostics: [...scientific.diagnostics, ...native.diagnostics] };
}

/** Load EVERY skill that loads from disk (scientific + native), unfiltered. The
 *  free-form execution plane hands the agent the whole palette and lets it pick;
 *  network skills remain inert until a broker tool exists, but they still load. */
export function loadAllPiSkills(): LoadSkillsResult {
  const scientific = loadSkillsFromDir({ dir: scientificSkillsRoot(), source: "signalfold-scientific" });
  const native = loadSkillsFromDir({ dir: nativeSkillsRoot(), source: "signalfold-native" });
  return { skills: [...scientific.skills, ...native.skills], diagnostics: [...scientific.diagnostics, ...native.diagnostics] };
}
