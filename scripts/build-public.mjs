import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, "public");

await fs.mkdir(path.join(publicDir, "data"), { recursive: true });
await fs.copyFile(path.join(root, "chest-pain-workflow-v8_1.html"), path.join(root, "index.html"));
await fs.copyFile(path.join(root, "chest-pain-workflow-v8_1.html"), path.join(publicDir, "index.html"));
await fs.copyFile(path.join(root, "app.js"), path.join(publicDir, "app.js"));
await fs.copyFile(
  path.join(root, "data", "chest-pain-clinical-data.json"),
  path.join(publicDir, "data", "chest-pain-clinical-data.json"),
);

console.log("Static Vercel output prepared in public/");
