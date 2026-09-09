import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright";
export async function loadTerrain(root) {
  const browser = await chromium.launch({ headless: true });
  let assets;
  try {
    const page = await browser.newPage();
    await page.setContent(
      await fs.readFile(path.join(root, "docs/marketing/hill-climbing.svg"), "utf8"),
    );
    assets = await page.evaluate(() => {
      const svg = document.querySelector("svg");
      const routes = [...svg.querySelectorAll(".route, [data-branch]")].map((el) => ({
        step: Number(el.getAttribute("data-route") ?? el.getAttribute("data-branch")),
        d: (el.querySelector(".trail") ?? el).getAttribute("d"),
      }));
      if (routes.length !== 5 || routes.some((r) => !r.d))
        throw new Error(
          "Terrain must contain exactly five named routes. Regenerate the marketing SVG.",
        );
      const points = Object.fromEntries(
        [...svg.querySelectorAll(".point")].map((el) => {
          const halo = el.querySelector(".halo");
          return [
            el.getAttribute("data-step"),
            [Number(halo.getAttribute("cx")), Number(halo.getAttribute("cy"))],
          ];
        }),
      );
      if (
        Object.keys(points).join(",") !== "0,1,2,3,4,5" ||
        Object.values(points)
          .flat()
          .some((value) => !Number.isFinite(value))
      )
        throw new Error("Terrain must contain six checkpoints with numeric coordinates.");
      svg
        .querySelectorAll("text, .point, .route, [data-branch], title, desc")
        .forEach((el) => el.remove());
      [...svg.children]
        .filter(
          (el) =>
            el.tagName === "circle" ||
            el.tagName === "ellipse" ||
            el.getAttribute("d") === "M0 0h1600v1040H0z" ||
            (el.tagName === "g" && el.getAttribute("stroke") === "#283542"),
        )
        .forEach((el) => el.remove());
      svg.setAttribute("viewBox", "0 255 1600 580");
      svg.setAttribute("width", "2400");
      svg.setAttribute("height", "870");
      return { svg: new XMLSerializer().serializeToString(svg), routes, points };
    });
  } finally {
    await browser.close();
  }
  const png = await sharp(Buffer.from(assets.svg)).png().toBuffer();
  const terrain = `data:image/png;base64,${png.toString("base64")}`;
  return { terrain, routes: assets.routes, points: assets.points };
}
