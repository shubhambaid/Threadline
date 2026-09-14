import { describe, expect, it } from "vitest";
import {
  compileSecretPatterns,
  detectSecret,
  REDACTED,
  redactSecrets,
  scanForSecrets,
} from "../../src/validate/secrets.js";

// Secret-shaped samples are assembled at runtime so no literal token appears in source.
const SAMPLES: Record<string, string> = {
  "private key": `-----BEGIN RSA PRIVATE${" KEY-----"}\nMIIE...`,
  "AWS access key id": `key ${"AKIA"}IOSFODNN7EXAMPLE here`,
  "Google API key": `AIza${"S".repeat(35)}`,
  "GitHub token": `gh${"p_"}${"A1".repeat(18)}`,
  "GitLab token": `gl${"pat-"}${"x".repeat(20)}`,
  "Slack token": `xo${"xb-"}1234567890-abcdef`,
  "Stripe key": `sk${"_live_"}${"a1".repeat(12)}`,
  "Anthropic API key": `sk-${"ant-"}api03-${"a".repeat(30)}`,
  "OpenAI API key": `sk-${"proj-"}${"A1b2".repeat(8)}`,
  JWT: `ey${"JhbGciOiJIUzI1NiJ9"}.ey${"JzdWIiOiIxMjM0NTY3ODkwIn0"}.abcdefghijk`,
  "credentials in URL": `postgres://admin:${"S3cr3tPass"}@db.internal:5432/app`,
  "credential assignment": `password=${"hunter2Hunter2"}`,
};

const BENIGN = [
  "Session token: invalidated on reset",
  "Add token_version column to users",
  "postgres://user:password@localhost/db",
  "api_key: <your-key>",
  "password: ********",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text under test
  "secret: ${DB_SECRET}",
  "token: expired-after-reset",
  "83fa2de5b0c4a1d2e3f40516273849506a7b8c9d",
  "task-session-reset-invalidation",
  "Refresh tokens are cached in Redis for 15 minutes.",
];

const { patterns } = compileSecretPatterns();

describe("secret detection", () => {
  it.each(Object.entries(SAMPLES))("detects %s", (name, sample) => {
    expect(detectSecret(sample, patterns)).toBe(name);
  });

  it.each(BENIGN)("ignores %j", (text) => {
    expect(detectSecret(text, patterns)).toBeUndefined();
  });

  it("reports field paths without echoing the secret", () => {
    const token = SAMPLES["GitHub token"] as string;
    const findings = scanForSecrets(
      { summary: "ok", evidence: { checks: ["fine", `GITHUB_TOKEN=${token}`] } },
      patterns,
    );
    expect(findings).toEqual([{ path: "evidence.checks[1]", pattern: "GitHub token" }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  it("scans mapping keys", () => {
    const key = SAMPLES["Stripe key"] as string;
    expect(scanForSecrets({ fingerprints: { [key]: "x" } }, patterns)).toEqual([
      { path: `fingerprints.${key}`, pattern: "Stripe key" },
    ]);
  });

  it("supports project patterns and reports invalid ones", () => {
    const compiled = compileSecretPatterns(["acme_live_[A-Za-z0-9]{24}", "("]);
    expect(compiled.invalid.map((i) => i.pattern)).toEqual(["("]);
    expect(detectSecret(`acme_live_${"Z".repeat(24)}`, compiled.patterns)).toMatch(
      /project pattern/,
    );
  });
});

describe("redaction", () => {
  it("replaces secrets and keeps surrounding output", () => {
    const token = SAMPLES["Anthropic API key"] as string;
    const text = `FAIL auth.test.ts\nANTHROPIC_API_KEY=${token}\npostgres://user:password@localhost/db`;
    const redacted = redactSecrets(text, patterns);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain(REDACTED);
    expect(redacted).toContain("FAIL auth.test.ts");
    expect(redacted).toContain("postgres://user:password@localhost/db");
  });
});
