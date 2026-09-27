// The bundled holiday list is plain data, so tsc never touches it. Copy it next to the built
// program: the packaged app ships dist/, public/ and node_modules, never the repository's data/
// folder. Only this one file is copied; the evaluation suites have their own copy step.
// The owner's handbook is the same kind of thing — plain Markdown the app serves to itself through
// `GET /api/help/<chapter>` — so it travels the same way.
import { mkdir, copyFile, readdir, cp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

await mkdir(resolve("dist"), { recursive: true });
// Wave mac5: local-models.json, the list of models offered with one click.
// mac7/connect: channel-setup.json, how to get each chat app and make its bot.
// The release notes for What's new, and the connector catalogue.
for (const name of ["holidays.json", "providers.json", "memory-retrieval.json", "channels.json", "local-models.json", "channel-setup.json", "release-notes.json", "mcp-catalogue.json"])
  await copyFile(resolve("data", name), resolve("dist", name));

const handbook = resolve("dist/handbook");
await mkdir(handbook, { recursive: true });
for (const name of await readdir(resolve("docs/handbook")))
  if (name.endsWith(".md")) await copyFile(resolve("docs/handbook", name), join(handbook, name));

// bucket-15: the add-ons that come with Branch, looked at (never installed) from Customize, Plugins.
await rm(resolve("dist/bundled-add-ons"), { recursive: true, force: true });
await cp(resolve("data/add-ons"), resolve("dist/bundled-add-ons"), { recursive: true });
