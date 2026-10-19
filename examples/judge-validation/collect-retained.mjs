import fs from "node:fs";
import path from "node:path";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const scope = fs.readFileSync(context.sources.scope.path, "utf8").trim();
if (scope === "withheld") {
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "blocked",
      summary: "The historical version-history checkpoint is withheld from this review package.",
      observations: [
        "No version history, latest marker, or successful version download is supplied.",
      ],
      images: [],
      files: [],
    }),
  );
} else if (scope === "observed") {
  const record = JSON.parse(fs.readFileSync(context.sources.record.path, "utf8"));
  if (typeof record.imageExtraction !== "string" || !record.imageExtraction.trim())
    throw new Error("Retained evidence requires an explicit image extraction description");
  const images = record.images.map(({ label, source }) => {
    const file = `${label}.png`;
    fs.copyFileSync(context.sources[source].path, path.join(context.outputDir, file));
    return {
      label,
      path: file,
      source,
      extraction: record.imageExtraction,
    };
  });
  fs.copyFileSync(context.sources.previous.path, path.join(context.outputDir, "previous.pdf"));
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "completed",
      summary: record.summary,
      observations: record.observations,
      images,
      files: [
        {
          label: "previous",
          path: "previous.pdf",
          filename: "deck-v1.pdf",
          mediaType: "application/pdf",
        },
      ],
    }),
  );
} else {
  throw new Error(`Unknown historical review scope: ${scope}`);
}
