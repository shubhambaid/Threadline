export interface SecretPattern {
  name: string;
  regex: RegExp;
  /** Optional check on a match to filter out placeholders and prose. */
  accept?: (match: RegExpMatchArray) => boolean;
}

export interface SecretFinding {
  /** Dotted field path. The matched value is never included. */
  path: string;
  pattern: string;
}

const PLACEHOLDER =
  /^(?:\*+|x+|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{.*\}\}|changeme|placeholder|redacted|\[redacted\]|example\w*|dummy|null|none|true|false|undefined|process\.env\.\w+)$/i;

const PLACEHOLDER_WORDS =
  /^(?:password|passwd|pass|pwd|secret|user|username|changeme|\*+|x+|<[^>]*>)$/i;

/** Values with at least two character classes (lower, upper, digit, symbol). Plain words are not secrets. */
function looksSecret(value: string): boolean {
  if (PLACEHOLDER.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9._-]/].filter((re) => re.test(value));
  return classes.length >= 2;
}

export const BUILTIN_SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private key", regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "AWS access key id", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  {
    name: "GitHub token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/,
  },
  { name: "GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "Slack token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Slack webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: "Stripe key", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    name: "credentials in URL",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?<password>[^\s@/]+)@/i,
    accept: (match) => !PLACEHOLDER_WORDS.test(match.groups?.password ?? ""),
  },
  {
    name: "credential assignment",
    regex:
      /\b(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|api[_-]?key)["']?\s*[:=]\s*["']?(?<value>[^\s"',;]{8,})/i,
    accept: (match) => looksSecret(match.groups?.value ?? ""),
  },
];

export interface CompiledPatterns {
  patterns: SecretPattern[];
  invalid: { pattern: string; error: string }[];
}

/** Built-in patterns plus the manifest's `privacy.extra_secret_patterns`. */
export function compileSecretPatterns(extra: readonly string[] = []): CompiledPatterns {
  const patterns: SecretPattern[] = [...BUILTIN_SECRET_PATTERNS];
  const invalid: CompiledPatterns["invalid"] = [];
  for (const source of extra) {
    try {
      patterns.push({ name: `project pattern /${source}/`, regex: new RegExp(source) });
    } catch (error) {
      invalid.push({ pattern: source, error: (error as Error).message });
    }
  }
  return { patterns, invalid };
}

function globalCopy(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
}

/** Name of the first pattern with an accepted match in `text`, if any. */
export function detectSecret(text: string, patterns: readonly SecretPattern[]): string | undefined {
  for (const pattern of patterns) {
    for (const match of text.matchAll(globalCopy(pattern.regex))) {
      if (!pattern.accept || pattern.accept(match)) return pattern.name;
    }
  }
  return undefined;
}

/** Scans every string (and mapping key) in a value. Reports one finding per field. */
export function scanForSecrets(
  value: unknown,
  patterns: readonly SecretPattern[],
  path = "$",
): SecretFinding[] {
  if (typeof value === "string") {
    const pattern = detectSecret(value, patterns);
    return pattern ? [{ path, pattern }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scanForSecrets(item, patterns, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const childPath = path === "$" ? key : `${path}.${key}`;
      const keyPattern = detectSecret(key, patterns);
      return [
        ...(keyPattern ? [{ path: childPath, pattern: keyPattern }] : []),
        ...scanForSecrets(item, patterns, childPath),
      ];
    });
  }
  return [];
}

export const REDACTED = "[REDACTED]";

/** Replaces every accepted match with [REDACTED]. */
export function redactSecrets(text: string, patterns: readonly SecretPattern[]): string {
  let out = text;
  for (const pattern of patterns) {
    out = out.replace(globalCopy(pattern.regex), (...args) => {
      const groups =
        typeof args.at(-1) === "object" ? (args.at(-1) as Record<string, string>) : undefined;
      const match = Object.assign([args[0] as string], { groups }) as unknown as RegExpMatchArray;
      return !pattern.accept || pattern.accept(match) ? REDACTED : (args[0] as string);
    });
  }
  return out;
}
