import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { documentPolicy } from "../server/policy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const common = { absWorkingDir: root, bundle: true, minify: true, write: false, target: "es2022", charset: "utf8" };
const packages = ["react", "react-dom", "scheduler", "@fontsource-variable/vazirmatn"];
const [script, style, template, licenses] = await Promise.all([
  build({ ...common, entryPoints: ["src/main.jsx"], format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ ...common, entryPoints: ["src/styles.css"], loader: { ".woff2": "dataurl" } }),
  readFile(path.join(root, "src/index.html"), "utf8"),
  Promise.all(packages.map(async (name) => {
    const manifest = require.resolve(`${name}/package.json`);
    return `${name}\n${await readFile(path.join(path.dirname(manifest), "LICENSE"), "utf8")}`;
  })),
]);

const html = template
  .replace("{{CSS}}", () => style.outputFiles[0].text)
  .replace("{{JS}}", () => script.outputFiles[0].text);
const policy = documentPolicy(html, { standalone: true });
const notices = licenses.join("\n").replaceAll("-->", "-- >");
const output = html.replace("{{POLICY}}", policy) + `\n<!-- Third-party licenses\n${notices}\n-->\n`;
const fileName = "didamesh (3).html";
const destination = path.join(root, fileName);
const temporary = `${destination}.${process.pid}.tmp`;
await writeFile(temporary, output, "utf8");
await rename(temporary, destination);
console.log(`${fileName} (${Math.round(Buffer.byteLength(output) / 1024)} KiB)`);
