import { loadConfig } from "../../dist/config.js";
import {
  loadFixtures,
  loadSpecs,
  assertScenarioTargetCompatibility,
  assertEmailConfiguration,
} from "../../dist/specs.js";
import { graderMethodInputs } from "../../dist/judging/command-inputs.js";
import { collectorInputs } from "../../dist/collectors/inputs.js";
import { textInputs } from "../../dist/text/inputs.js";
import { validateVisualInputs } from "../../dist/visual/inputs.js";

// Candidate outputs do not exist yet. Validate contracts and fixed methods with
// AEK's existing readers, without substituting placeholder subject evidence.
export async function validateEvaluator(configFile) {
  const config = loadConfig(configFile);
  const specs = loadSpecs(config.paths.specs);
  assertScenarioTargetCompatibility(specs, config.target);
  assertEmailConfiguration(specs, config);
  const graders = graderMethodInputs(config, specs, "all");
  const collectors = collectorInputs(config, specs, "all", undefined, "methods");
  const references = textInputs(config, specs, "all", "textReferences");
  // This existing validation mode checks visual declarations and fixed images
  // without requiring collector subjects, which candidates have not submitted.
  await validateVisualInputs(config, specs, "all", undefined, true);
  loadFixtures(config.paths.fixtures);
  return {
    areas: specs.length,
    graderMethods: Object.keys(graders).length,
    collectorMethods: Object.keys(collectors).length,
    textReferences: Object.keys(references).length,
  };
}
