import fs from "node:fs";
import path from "node:path";

export const SCIENTIFIC_SKILL_IDS = [
  "pyopenms", "pydeseq2", "pathway-enrichment", "scanpy", "statistical-power",
  "experimental-design", "statsmodels", "networkx", "gget", "bioservices",
  "database-lookup", "citation-management", "scientific-visualization", "matplotlib",
  "exploratory-data-analysis", "markitdown", "liteparse",
] as const;

export type ScientificSkillId = typeof SCIENTIFIC_SKILL_IDS[number];
export type NetworkPolicy = "offline" | "approved-external" | "prohibited-undeclared" | "prohibited-secondary-llm";
export type DeterminismClass = "deterministic" | "seeded" | "stochastic" | "live-external-state" | "instruction-only" | "not-verified" | "exact-rerun-verified";
export type ReadinessState = "declared" | "lock-generated" | "dependencies-installed" | "smoke-tested" | "unavailable" | "reference-only";

export interface ScientificSkillPolicy {
  id: ScientificSkillId;
  version: string;
  license: string;
  executionClass: "python-script" | "python-library" | "reference" | "network-client";
  environmentId: string;
  networkPolicy: NetworkPolicy;
  determinism: DeterminismClass;
  allowedScripts: string[];
  restrictedScripts: string[];
  prohibitedScripts: string[];
  readiness: ReadinessState;
  /** Hosts a NETWORK skill is permitted to reach, in network mode, through the
   *  per-job egress proxy (the union across approved skills + curated sources is
   *  the job allowlist). Sourced from each skill's SKILL.md. Empty/undefined for
   *  offline skills, which run --network none and never egress. */
  egressDomains?: string[];
  diagnostic: string;
}

const network = "Vendored and locked; disabled until brokered egress prevents direct network bypass.";

export const SCIENTIFIC_SKILL_POLICIES: ScientificSkillPolicy[] = [
  { id: "pyopenms", version: "2.0", license: "BSD-3-Clause", executionClass: "python-script", environmentId: "omics-pyopenms", networkPolicy: "offline", determinism: "deterministic", allowedScripts: ["scripts/mass_calculator.py"], restrictedScripts: ["scripts/*.py"], prohibitedScripts: [], readiness: "smoke-tested", diagnostic: "pyOpenMS 3.5.0 uv environment and unchanged mass_calculator.py passed on macOS arm64." },
  { id: "pydeseq2", version: "1.1", license: "MIT", executionClass: "python-script", environmentId: "omics-pydeseq2", networkPolicy: "offline", determinism: "deterministic", allowedScripts: ["scripts/run_deseq2_analysis.py"], restrictedScripts: [], prohibitedScripts: [], readiness: "smoke-tested", diagnostic: "PyDESeq2 0.5.4 uv environment and unchanged bounded analysis script passed on macOS arm64." },
  { id: "pathway-enrichment", version: "1.0", license: "MIT", executionClass: "network-client", environmentId: "external-database", networkPolicy: "approved-external", determinism: "live-external-state", allowedScripts: ["scripts/run_enrichment.py"], restrictedScripts: [], prohibitedScripts: [], readiness: "smoke-tested", egressDomains: ["maayanlab.cloud", "biit.cs.ut.ee", "data.broadinstitute.org"], diagnostic: "gseapy enrichr (ORA) reached Enrichr (maayanlab.cloud) through the per-job egress proxy and returned ranked pathways; egress allowlisted + audited; non-allowlisted hosts and outbound exfil blocked." },
  { id: "scanpy", version: "1.3", license: "BSD-3-Clause", executionClass: "python-script", environmentId: "omics-scanpy", networkPolicy: "offline", determinism: "deterministic", allowedScripts: ["scripts/inspect_data.py"], restrictedScripts: ["scripts/*.py"], prohibitedScripts: [], readiness: "smoke-tested", diagnostic: "Scanpy 1.12.1 uv environment and unchanged inspect_data.py passed on macOS arm64." },
  { id: "statistical-power", version: "1.0", license: "MIT", executionClass: "python-library", environmentId: "statistics-design", networkPolicy: "offline", determinism: "seeded", allowedScripts: ["scripts/power.py", "scripts/simulate_power.py"], restrictedScripts: [], prohibitedScripts: [], readiness: "dependencies-installed", diagnostic: "Pinned host-compatible dependencies detected; bounded gateway smoke test required per invocation." },
  { id: "experimental-design", version: "1.0", license: "MIT", executionClass: "python-library", environmentId: "statistics-design", networkPolicy: "offline", determinism: "seeded", allowedScripts: ["scripts/randomization.py"], restrictedScripts: ["scripts/doe_designs.py"], prohibitedScripts: [], readiness: "dependencies-installed", diagnostic: "Randomization path is dependency-light; pyDOE3-backed DOE path remains restricted until its lock is installed." },
  { id: "statsmodels", version: "1.1", license: "BSD-3-Clause", executionClass: "reference", environmentId: "statistics-design", networkPolicy: "offline", determinism: "instruction-only", allowedScripts: [], restrictedScripts: [], prohibitedScripts: [], readiness: "reference-only", diagnostic: "Instruction/reference skill; activation does not imply script execution." },
  { id: "networkx", version: "1.1", license: "BSD-3-Clause", executionClass: "reference", environmentId: "statistics-network", networkPolicy: "offline", determinism: "instruction-only", allowedScripts: [], restrictedScripts: [], prohibitedScripts: [], readiness: "reference-only", diagnostic: "Instruction/reference skill; NetworkX dependency is not installed in the pinned environment." },
  { id: "gget", version: "1.1", license: "BSD-2-Clause", executionClass: "network-client", environmentId: "external-database", networkPolicy: "approved-external", determinism: "live-external-state", allowedScripts: [], restrictedScripts: ["scripts/*.py"], prohibitedScripts: [], readiness: "unavailable", egressDomains: ["rest.ensembl.org", "rest.uniprot.org", "eutils.ncbi.nlm.nih.gov", "www.ebi.ac.uk", "rest.kegg.jp", "alphafold.ebi.ac.uk", "api.platform.opentargets.org"], diagnostic: network },
  { id: "bioservices", version: "1.2", license: "GPL-3.0", executionClass: "network-client", environmentId: "external-database-gpl", networkPolicy: "approved-external", determinism: "live-external-state", allowedScripts: [], restrictedScripts: ["scripts/*.py"], prohibitedScripts: [], readiness: "unavailable", egressDomains: ["www.uniprot.org", "rest.kegg.jp", "www.ebi.ac.uk", "reactome.org", "string-db.org", "www.ncbi.nlm.nih.gov"], diagnostic: `${network} GPL-3.0 package is inventoried separately and must not be represented as MIT.` },
  { id: "database-lookup", version: "1.1", license: "MIT", executionClass: "network-client", environmentId: "external-database", networkPolicy: "approved-external", determinism: "live-external-state", allowedScripts: [], restrictedScripts: ["scripts/**"], prohibitedScripts: [], readiness: "unavailable", egressDomains: ["eutils.ncbi.nlm.nih.gov", "rest.uniprot.org", "www.ebi.ac.uk"], diagnostic: `${network} The 78-DB registry is gated to a reviewed host subset; do not allow the full registry.` },
  { id: "citation-management", version: "1.2", license: "MIT", executionClass: "network-client", environmentId: "external-database", networkPolicy: "approved-external", determinism: "live-external-state", allowedScripts: [], restrictedScripts: ["scripts/doi_to_bibtex.py", "scripts/search_pubmed.py", "scripts/format_bibtex.py", "scripts/validate_citations.py"], prohibitedScripts: ["scripts/generate_schematic_ai.py"], readiness: "unavailable", egressDomains: ["api.crossref.org", "eutils.ncbi.nlm.nih.gov", "export.arxiv.org"], diagnostic: `${network} Secondary-LLM helper is structurally prohibited.` },
  { id: "scientific-visualization", version: "1.0", license: "MIT", executionClass: "python-library", environmentId: "visualization", networkPolicy: "offline", determinism: "deterministic", allowedScripts: ["scripts/style_presets.py", "scripts/figure_export.py"], restrictedScripts: [], prohibitedScripts: [], readiness: "dependencies-installed", diagnostic: "Matplotlib helpers are available for controlled workspace glue code." },
  { id: "matplotlib", version: "1.1", license: "Matplotlib-PSF", executionClass: "python-script", environmentId: "visualization", networkPolicy: "offline", determinism: "deterministic", allowedScripts: ["scripts/plot_template.py", "scripts/style_configurator.py"], restrictedScripts: [], prohibitedScripts: [], readiness: "dependencies-installed", diagnostic: "Pinned host-compatible Matplotlib is installed; bounded gateway smoke test required per invocation." },
  { id: "exploratory-data-analysis", version: "1.0", license: "MIT", executionClass: "python-script", environmentId: "base-tabular", networkPolicy: "offline", determinism: "deterministic", allowedScripts: ["scripts/eda_analyzer.py"], restrictedScripts: [], prohibitedScripts: [], readiness: "dependencies-installed", diagnostic: "Real upstream analyzer is enabled through the execution gateway." },
  { id: "markitdown", version: "1.1", license: "MIT", executionClass: "python-script", environmentId: "document-ingestion", networkPolicy: "offline", determinism: "not-verified", allowedScripts: [], restrictedScripts: ["scripts/batch_convert.py", "scripts/convert_literature.py"], prohibitedScripts: ["scripts/convert_with_ai.py", "scripts/generate_schematic_ai.py"], readiness: "unavailable", diagnostic: "Offline paths remain restricted until the document lock is installed; OpenRouter helpers are prohibited." },
  { id: "liteparse", version: "1.0", license: "Apache-2.0", executionClass: "python-script", environmentId: "document-ingestion", networkPolicy: "offline", determinism: "not-verified", allowedScripts: [], restrictedScripts: ["scripts/batch_parse_dir.py"], prohibitedScripts: [], readiness: "unavailable", diagnostic: "Vendored and locked; LiteParse runtime has not passed a bounded platform smoke test." },
];

export const scientificSkillsRoot = () => path.join(import.meta.dirname, "..", "..", "skills", "scientific");

export function loadScientificSkillLock(filename = path.join(scientificSkillsRoot(), "scientific-skills.lock.json")) {
  return JSON.parse(fs.readFileSync(filename, "utf8")) as {
    schemaVersion: string; upstream: { repository: string; commit: string };
    skills: Array<ScientificSkillPolicy & { folderHash: string; fileCount: number }>;
  };
}

export function selectableScientificSkills() {
  return SCIENTIFIC_SKILL_POLICIES.filter((item) => item.readiness !== "unavailable");
}
