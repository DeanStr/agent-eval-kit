import { requireDefined, omitUndefinedDeep } from "./invariants.js";
import { mailboxSchema, emailAuthSchema } from "./email/contracts.js";
import { votingSchema, diagnosticPolicySchema } from "./visual/contracts.js";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROVIDERS, type CommandConfig, type EvalConfig, type ProviderId } from "./types.js";

const sensitiveUrlParameter =
  /(?:^|[-_.])(?:api[-_]?key|key|token|jwt|secret|password|passphrase|credential|authorization|auth|cookie|session|signature|sig|code)(?:$|[-_.])/i;
function hasSensitiveUrlParameters(value: string): boolean {
  const parsed = new URL(value);
  if ([...parsed.searchParams.keys()].some((name) => sensitiveUrlParameter.test(name))) return true;
  if (!parsed.hash) return false;

  // OAuth implicit flows commonly return credentials in a fragment. Preserve
  // ordinary anchors and hash-router paths, but reject query-like or opaque
  // key assignments there under the same policy as the URL query.
  const encoded = parsed.hash.slice(1);
  let fragment: string;
  try {
    fragment = decodeURIComponent(encoded);
  } catch {
    fragment = encoded;
  }
  const assignments = /(?:^|[?&;/])\s*([^?&;/:=\s]+)\s*(?:=|:)/g;
  for (const match of fragment.matchAll(assignments)) {
    if (sensitiveUrlParameter.test(requireDefined(match[1], "match[1]"))) return true;
  }
  return false;
}

export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }, "must be an HTTP(S) URL without embedded credentials")
  .refine(
    (value) => !hasSensitiveUrlParameters(value),
    "must not include credential-bearing query or fragment parameters; use captured browser authentication instead",
  );

const allowedOriginSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (/^https?:\/\/\*\.[^\s/:]+(?::\d+)?$/.test(value)) {
      try {
        const parsed = new URL(value.replace("://*.", "://wildcard."));
        return (
          ["http:", "https:"].includes(parsed.protocol) &&
          parsed.hostname.startsWith("wildcard.") &&
          parsed.pathname === "/" &&
          !parsed.search &&
          !parsed.hash
        );
      } catch {
        return false;
      }
    }
    try {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        parsed.pathname === "/" &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }, "must be an exact HTTP(S) origin or wildcard such as https://*.example.com");

const commandSchema = z.union([
  z
    .string()
    .min(1)
    .transform((command): CommandConfig => ({ command })),
  z
    .object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      timeoutSeconds: z.number().positive().optional(),
    })
    .strict(),
]);

export const fingerprintExclusionSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !path.win32.parse(value).root &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "fingerprint exclusions must be project-relative paths",
  )
  .transform((value) => path.posix.normalize(value).replace(/\/$/, ""))
  .refine(
    (value) => value !== "." && value !== ".." && !value.startsWith("../"),
    "fingerprint exclusions cannot name project.root or escape it",
  );

const providerSchema = z
  .object({
    provider: z.enum(PROVIDERS).default("codex"),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().default(1800),
    extraArgs: z.array(z.string()).default([]),
  })
  .strict();

const rawConfigSchema = z
  .object({
    mailboxes: z.record(z.string().min(1), mailboxSchema).optional(),
    emailAuth: z.record(z.string().min(1), emailAuthSchema).optional(),
    suite: z.string().min(1).optional(),
    version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1),
        root: z.string().default("."),
      })
      .strict(),
    target: z
      .object({
        kind: z.enum(["web", "repository", "command"]),
        url: httpUrlSchema.optional(),
        allowedOrigins: z.array(allowedOriginSchema).default([]),
        setup: commandSchema.optional(),
        start: commandSchema.optional(),
        allowExternalServer: z.boolean().optional(),
        fingerprint: z
          .object({
            exclude: z
              .array(fingerprintExclusionSchema)
              .max(50)
              .refine(
                (paths) => new Set(paths).size === paths.length,
                "fingerprint exclusions must be unique",
              ),
          })
          .strict()
          .optional(),
        ready: z
          .object({
            url: httpUrlSchema.optional(),
            command: z.string().min(1).optional(),
            timeoutSeconds: z.number().positive().default(120),
            intervalMs: z.number().int().positive().default(500),
          })
          .strict()
          .refine(
            (value) => Boolean(value.url) !== Boolean(value.command),
            "ready needs exactly one of url or command",
          )
          .optional(),
      })
      .strict(),
    agent: providerSchema.default({ provider: "codex", timeoutSeconds: 1800, extraArgs: [] }),
    judge: providerSchema
      .extend({
        voting: votingSchema.optional(),
        concurrency: z.number().int().min(1).max(8).optional(),
        capacityRetries: z.number().int().min(0).max(5).optional(),
      })
      .default({ provider: "codex", timeoutSeconds: 1800, extraArgs: [] }),
    paths: z
      .object({
        specs: z.string().default("evals/specs"),
        fixtures: z.string().optional(),
        runs: z.string().default(".agent-eval/runs"),
        auth: z.string().default(".agent-eval/auth"),
        baselines: z.string().default("evals/baselines"),
        references: z.string().default("evals/text-references"),
      })
      .strict()
      .default({
        specs: "evals/specs",
        runs: ".agent-eval/runs",
        auth: ".agent-eval/auth",
        baselines: "evals/baselines",
        references: "evals/text-references",
      }),
    browser: z
      .object({
        headless: z.boolean().default(true),
        viewport: z
          .object({
            width: z
              .number()
              .int()
              .positive()
              .max(2_000, "must not exceed the 2000px evidence-image limit"),
            height: z
              .number()
              .int()
              .positive()
              .max(2_000, "must not exceed the 2000px evidence-image limit"),
          })
          .strict()
          .default({ width: 1280, height: 800 }),
        actionTimeoutMs: z.number().int().positive().default(10_000),
        diagnostics: diagnosticPolicySchema.optional(),
        screenshotFormat: z.enum(["jpeg", "png"]).optional(),
        readOnlyFrames: z
          .array(
            z
              .object({
                pathPrefix: z
                  .string()
                  .regex(/^\/(?:[^?#]*\/)?$/, "must be an absolute pathname prefix ending in /"),
                selector: z.string().trim().min(1),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict()
      .default({ headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 10_000 }),
    scoring: z
      .object({
        partialCredit: z.number().min(0).max(1).default(0.5),
        minimumCoverage: z.number().min(0).max(100).default(60),
      })
      .strict()
      .default({ partialCredit: 0.5, minimumCoverage: 60 }),
    promotion: z
      .object({
        minimumCoverage: z.number().min(0).max(100).default(100),
        minimumScore: z.number().min(0).max(100).optional(),
        split: z.enum(["development", "evaluation", "all"]).default("all"),
        includeOptional: z.boolean().default(false),
      })
      .strict()
      .optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    instructions: z.string().optional(),
  })
  .strict();

export interface ConfigOverrides {
  suite?: string;
  targetUrl?: string;
  agentProvider?: ProviderId;
  judgeProvider?: ProviderId;
  agentModel?: string;
  judgeModel?: string;
  maxTurns?: number;
  headed?: boolean;
}

function expandEnvironment(value: string, source: string): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_whole, name: string) => {
    const found = process.env[name];
    if (found === undefined) {
      throw new Error(`${source} references missing environment variable ${name}`);
    }
    return found;
  });
}

function expandDeep(value: unknown, source: string): unknown {
  if (typeof value === "string") return expandEnvironment(value, source);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, source));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandDeep(item, source)]),
    );
  }
  return value;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "config"}: ${issue.message}`)
    .join("\n  - ");
}

export function loadConfig(
  configFile = "evalkit.yaml",
  overrides: ConfigOverrides = {},
): EvalConfig {
  return readConfig(configFile, overrides, false);
}

/** Read a sealed, already expanded snapshot without consulting the environment. */
export function loadResolvedConfig(
  configFile: string,
  overrides: ConfigOverrides = {},
): EvalConfig {
  return readConfig(configFile, overrides, true);
}

function readConfig(configFile: string, overrides: ConfigOverrides, resolved: boolean): EvalConfig {
  const absoluteConfig = path.resolve(configFile);
  if (!fs.existsSync(absoluteConfig)) {
    throw new Error(`No config file at ${absoluteConfig}. Run \`aek init\` first.`);
  }
  if (!resolved)
    try {
      process.loadEnvFile(path.join(path.dirname(absoluteConfig), ".env"));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
      // A project may supply variables through the real environment instead.
    }
  let parsed: z.infer<typeof rawConfigSchema>;
  try {
    const yaml = YAML.parse(fs.readFileSync(absoluteConfig, "utf8"));
    const parsedYaml = z
      .record(z.string(), z.unknown())
      .parse(resolved ? yaml : expandDeep(yaml, absoluteConfig));
    if (!resolved && parsedYaml.suites !== undefined) {
      const suites = z
        .record(z.string().min(1), z.record(z.string(), z.unknown()))
        .parse(parsedYaml.suites);
      const selected = overrides.suite ?? parsedYaml.suite;
      if (typeof selected !== "string" || !Object.hasOwn(suites, selected))
        throw new Error(
          `Select a named suite with --suite <name>. Known suites: ${Object.keys(suites).join(", ")}`,
        );
      delete parsedYaml.suites;
      const merge = (base: Record<string, unknown>, overlay: Record<string, unknown>) => {
        const result = { ...base };
        for (const [key, value] of Object.entries(overlay)) {
          if (!["agent", "judge", "paths", "scoring", "instructions"].includes(key))
            throw new Error(
              `Unsupported suite override ${key}; use agent, judge, paths, scoring, or instructions`,
            );
          if (key === "instructions") result[key] = value;
          else {
            const section = z.record(z.string(), z.unknown()).parse(value);
            const defaults =
              base[key] === undefined ? {} : z.record(z.string(), z.unknown()).parse(base[key]);
            result[key] = { ...defaults, ...section };
          }
        }
        return result;
      };
      for (const overlay of Object.values(suites))
        rawConfigSchema.parse(merge(parsedYaml, overlay));
      Object.assign(parsedYaml, merge(parsedYaml, suites[selected]!));
      parsedYaml.suite = selected;
    } else if (overrides.suite !== undefined && overrides.suite !== parsedYaml.suite) {
      throw new Error(`Unknown suite ${overrides.suite}; this config has no matching suite`);
    }
    parsed = rawConfigSchema.parse(parsedYaml);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${absoluteConfig}:\n  - ${formatZodError(error)}`);
    }
    throw error;
  }

  if (overrides.targetUrl && parsed.target.kind !== "web") {
    throw new Error(`Invalid override: --url can be used only when target.kind is web`);
  }
  const targetUrl = overrides.targetUrl ?? parsed.target.url;
  if (overrides.targetUrl) {
    const result = httpUrlSchema.safeParse(overrides.targetUrl);
    if (!result.success)
      throw new Error(
        `Invalid --url: ${result.error.issues[0]?.message ?? "expected an HTTP(S) URL"}`,
      );
  }
  if (parsed.target.kind === "web" && !targetUrl) {
    throw new Error(`Invalid ${absoluteConfig}: target.url is required when target.kind is web`);
  }

  const configDir = path.dirname(absoluteConfig);
  for (const [persona, flow] of Object.entries(parsed.emailAuth ?? {})) {
    if (persona === "anonymous")
      throw new Error("emailAuth requires a named persona, not anonymous");
    if (!Object.hasOwn(parsed.mailboxes ?? {}, flow.mailbox))
      throw new Error(`emailAuth.${persona} references an unknown mailbox`);
    if (!targetUrl || parsed.target.kind !== "web")
      throw new Error("emailAuth requires a web target");
    httpUrlSchema.parse(new URL(flow.startPath, new URL(targetUrl).origin).toString());
  }
  const root = path.resolve(configDir, parsed.project.root);
  const resolveFromRoot = (candidate: string) => path.resolve(root, candidate);
  const defaultOrigin = targetUrl ? new URL(targetUrl).origin : undefined;
  const configuredOrigin = parsed.target.url ? new URL(parsed.target.url).origin : undefined;
  const additionalOrigins =
    overrides.targetUrl && configuredOrigin
      ? parsed.target.allowedOrigins.filter(
          (origin) => origin.includes("*") || new URL(origin).origin !== configuredOrigin,
        )
      : parsed.target.allowedOrigins;
  const allowedOrigins = [
    ...new Set([...(defaultOrigin ? [defaultOrigin] : []), ...additionalOrigins]),
  ];
  const ready = parsed.target.ready
    ? (() => {
        if (
          !overrides.targetUrl ||
          !parsed.target.ready.url ||
          !configuredOrigin ||
          !defaultOrigin
        ) {
          return parsed.target.ready;
        }
        const configuredReady = new URL(parsed.target.ready.url);
        if (configuredReady.origin !== configuredOrigin) return parsed.target.ready;
        const override = new URL(overrides.targetUrl);
        configuredReady.protocol = override.protocol;
        configuredReady.host = override.host;
        return { ...parsed.target.ready, url: configuredReady.toString() };
      })()
    : undefined;

  return omitUndefinedDeep({
    ...parsed,
    project: { ...parsed.project, root },
    target: {
      ...parsed.target,
      ...(targetUrl === undefined ? {} : { url: targetUrl }),
      allowedOrigins,
      ...(ready === undefined ? {} : { ready: ready }),
      setup: parsed.target.setup
        ? {
            ...parsed.target.setup,
            cwd: path.resolve(
              root,
              ("cwd" in parsed.target.setup ? parsed.target.setup.cwd : undefined) ?? ".",
            ),
          }
        : undefined,
      start: parsed.target.start
        ? {
            ...parsed.target.start,
            cwd: path.resolve(
              root,
              ("cwd" in parsed.target.start ? parsed.target.start.cwd : undefined) ?? ".",
            ),
          }
        : undefined,
    },
    agent: {
      ...parsed.agent,
      provider: overrides.agentProvider ?? parsed.agent.provider,
      model: overrides.agentModel ?? parsed.agent.model,
      maxTurns: overrides.maxTurns ?? parsed.agent.maxTurns,
    },
    judge: {
      ...parsed.judge,
      provider: overrides.judgeProvider ?? parsed.judge.provider,
      model: overrides.judgeModel ?? parsed.judge.model,
    },
    paths: {
      specs: resolveFromRoot(parsed.paths.specs),
      fixtures: parsed.paths.fixtures ? resolveFromRoot(parsed.paths.fixtures) : undefined,
      runs: resolveFromRoot(parsed.paths.runs),
      auth: resolveFromRoot(parsed.paths.auth),
      baselines: resolveFromRoot(parsed.paths.baselines),
      references: resolveFromRoot(parsed.paths.references),
    },
    browser: {
      ...parsed.browser,
      headless: overrides.headed ? false : parsed.browser.headless,
    },
  });
}

export function redactConfig(config: EvalConfig): EvalConfig {
  const sensitive =
    /token|secret|password|passphrase|api[-_]?key|credential|authorization|cookie|session|private[-_]?key/i;
  const redactString = (value: string) =>
    value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g,
        "[REDACTED]",
      )
      .replace(
        /((?:--)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|password|passphrase|token|secret)(?:\s*(?:=|:)\s*|\s+))(?:("[^"]*")|('[^']*')|[^\s"']+)/gi,
        (_match, prefix: string, doubleQuoted?: string, singleQuoted?: string) => {
          // Preserve delimiters so redacting a sealed snapshot again cannot
          // consume adjacent selector syntax and change its fingerprint.
          const quote = doubleQuoted ? '"' : singleQuoted ? "'" : "";
          return `${prefix}${quote}[REDACTED]${quote}`;
        },
      )
      // Connection strings are commonly stored under names such as
      // DATABASE_URL, which are not intrinsically secret, and use schemes such
      // as postgres, mysql, mongodb, or redis. Strip URI userinfo passwords for
      // every valid scheme before the resolved config is retained.
      .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1[REDACTED]@");
  const redact = (value: unknown, key = "", redactKeys = true): unknown => {
    if (redactKeys && sensitive.test(key)) return "[REDACTED]";
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, "", redactKeys));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, redact(v, k, redactKeys)]),
      );
    }
    return value;
  };
  // Preserve declaration keys (including persona names, apiKeyEnv and
  // credential extraction rules), but still redact secrets in string values.
  return {
    ...(redact(config) as EvalConfig),
    ...(config.mailboxes === undefined
      ? {}
      : { mailboxes: redact(config.mailboxes, "", false) as NonNullable<EvalConfig["mailboxes"]> }),
    ...(config.emailAuth === undefined
      ? {}
      : { emailAuth: redact(config.emailAuth, "", false) as NonNullable<EvalConfig["emailAuth"]> }),
  };
}
