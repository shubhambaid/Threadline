import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateAgainst } from "../validate/schema.js";
import type { Finding } from "./findings.js";
import { parseYaml, yamlFinding } from "./format.js";
import { exists } from "./fs.js";
import { THREADLINE_DIR } from "./paths.js";

export const MANIFEST_FILE = `${THREADLINE_DIR}/manifest.yaml`;

export interface Manifest {
  format_version: 1;
  project: { name: string };
  defaults: { budget: number; lease_minutes: number; default_branch: string };
  privacy: { extra_secret_patterns: string[]; forbidden_globs: string[] };
  staleness: { changed_lines_threshold: number };
  limits: { max_glob_matches: number; max_fingerprints_per_record: number };
  trust: { ci_provenance: "none" | "github-attestation" };
}

export interface RawManifest {
  project: { name: string };
  defaults?: Partial<Manifest["defaults"]>;
  privacy?: Partial<Manifest["privacy"]>;
  staleness?: Partial<Manifest["staleness"]>;
  limits?: Partial<Manifest["limits"]>;
  trust?: Partial<Manifest["trust"]>;
}

export const MANIFEST_DEFAULTS: Omit<Manifest, "format_version" | "project"> = {
  defaults: { budget: 2500, lease_minutes: 240, default_branch: "main" },
  privacy: { extra_secret_patterns: [], forbidden_globs: [] },
  staleness: { changed_lines_threshold: 20 },
  limits: { max_glob_matches: 2000, max_fingerprints_per_record: 50 },
  trust: { ci_provenance: "none" },
};

/** Fills in defaults for a schema-valid manifest. */
export function resolveManifest(raw: RawManifest): Manifest {
  return {
    format_version: 1,
    project: { name: raw.project.name },
    defaults: { ...MANIFEST_DEFAULTS.defaults, ...raw.defaults },
    privacy: { ...MANIFEST_DEFAULTS.privacy, ...raw.privacy },
    staleness: { ...MANIFEST_DEFAULTS.staleness, ...raw.staleness },
    limits: { ...MANIFEST_DEFAULTS.limits, ...raw.limits },
    trust: { ...MANIFEST_DEFAULTS.trust, ...raw.trust },
  };
}

/** The manifest written by `threadline init`. JSON strings are valid YAML scalars. */
export function defaultManifestYaml(projectName: string, defaultBranch: string): string {
  return `# Threadline manifest. See docs/spec.md §7.
format_version: 1
project:
  name: ${JSON.stringify(projectName)}
defaults:
  budget: 2500 # approximate briefing size for resume, estimated as characters / 4
  lease_minutes: 240
  default_branch: ${JSON.stringify(defaultBranch)}
privacy:
  extra_secret_patterns: []
  forbidden_globs:
    - "**/*.env"
    - "**/*.pem"
    - "**/id_rsa*"
staleness:
  changed_lines_threshold: 20
limits:
  max_glob_matches: 2000
  max_fingerprints_per_record: 50
trust:
  ci_provenance: none # ci-verified is rejected until trusted CI provenance is configured
`;
}

export async function isInitialized(root: string): Promise<boolean> {
  return exists(path.join(root, MANIFEST_FILE));
}

export interface ManifestLoad {
  manifest?: Manifest;
  findings: Finding[];
}

export async function loadManifest(root: string): Promise<ManifestLoad> {
  let text: string;
  try {
    text = await readFile(path.join(root, MANIFEST_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      findings: [
        {
          severity: "error",
          code: "manifest-missing",
          file: MANIFEST_FILE,
          message: "manifest.yaml is missing",
          hint: "Run `threadline init`.",
        },
      ],
    };
  }

  const parsed = parseYaml(text);
  if (parsed.problems.length > 0) {
    return { findings: parsed.problems.map((problem) => yamlFinding(MANIFEST_FILE, problem)) };
  }
  const result = validateAgainst("manifest", parsed.data);
  if (!result.valid) {
    return {
      findings: result.issues.map(
        (issue): Finding => ({
          severity: "error",
          code: "schema",
          file: MANIFEST_FILE,
          path: issue.path,
          message: issue.message,
          hint: "See docs/spec.md §7.",
        }),
      ),
    };
  }
  return { manifest: resolveManifest(parsed.data as RawManifest), findings: [] };
}
