import { readFile } from "node:fs/promises";
import { createDidameshServer } from "./http.js";

const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be between 1 and 65535.");
const html = await readFile(new URL("../didamesh (3).html", import.meta.url), "utf8");
const server = createDidameshServer({ html });
server.on("error", (error) => {
  console.error(`Didamesh could not listen on 127.0.0.1:${port} (${error.code ?? error.name}).`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`Didamesh is running at http://127.0.0.1:${port}/`));
