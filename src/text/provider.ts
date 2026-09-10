import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJson } from "../io.js";
import { runProvider } from "../providers/index.js";
import type { EvalConfig } from "../types.js";

/** All direct text votes use the same tool-free provider and retained error boundary. */
export async function invokeTextJudge<T>(options: {
  config: EvalConfig;
  directory: string;
  prompt: string;
  schema: z.ZodType;
  validate: (value: unknown) => T;
  label: string;
}): Promise<T> {
  const { config, directory, prompt, schema, validate, label } = options;
  const promptFile = path.join(directory, "prompt.md"),
    schemaFile = path.join(directory, "schema.json");
  fs.writeFileSync(promptFile, prompt);
  writeJson(schemaFile, z.toJSONSchema(schema));
  const result = await runProvider(config.judge.provider, {
    purpose: "judge",
    cwd: directory,
    promptFile,
    outputFile: path.join(directory, "provider-final.json"),
    outputSchemaFile: schemaFile,
    eventLogFile: path.join(directory, "provider-events.ndjson"),
    stderrFile: path.join(directory, "provider-stderr.log"),
    ...(config.judge.model === undefined ? {} : { model: config.judge.model }),
    ...(config.judge.effort === undefined ? {} : { effort: config.judge.effort }),
    ...(config.judge.maxTurns === undefined ? {} : { maxTurns: config.judge.maxTurns }),
    timeoutSeconds: config.judge.timeoutSeconds,
    extraArgs: config.judge.extraArgs,
    images: [],
    additionalDirs: [],
    allowWorkspaceTools: false,
  });
  writeJson(path.join(directory, "provider-run.json"), result);
  if (result.timedOut || result.exitCode !== 0 || result.policyViolations?.length)
    throw new Error(`${label} execution failed; see ${directory}`);
  try {
    return validate(schema.parse(result.structured));
  } catch (error) {
    throw new Error(
      `${label} returned invalid output in ${directory}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}
