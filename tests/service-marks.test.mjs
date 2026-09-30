/* UI-121: a service shows its licensed mark or a neutral glyph, never an invented letter logo; saved sign-ins show the
   mark of an exact known host, else a neutral key (public/app/core/logos.js). */
import test from "node:test";
import assert from "node:assert/strict";
import { logo, signInLogo } from "../public/app/core/logos.js";

test("known services keep their marks, unknown ones get a neutral glyph instead of initials", () => {
  assert.match(logo("gotify"), /art\/channels\/gotify\.svg/);
  assert.match(logo("gotify"), /CC BY 4\.0/, "the licence's credit travels with the mark");
  assert.match(logo("cli-claude-code-sonnet"), /claudecode\.svg/, "a Claude variant keeps its program's mark");
  assert.match(logo("openai-work"), /openai\.svg/);
  const unknown = logo("acme-thing", "Acme Thing");
  assert.match(unknown, /neutral-mark/);
  assert.doesNotMatch(unknown, /<b[ >]/, "no letters stand in for a logo");
  assert.match(logo("msteams"), /neutral-mark/, "Microsoft's marks are never drawn");
  assert.match(logo("pipeline-tool"), /neutral-mark/, "a service name inside another word is not a match");
});

test("saved sign-ins: an exact known host gets its mark, anything else a neutral key", () => {
  assert.match(signInLogo("github.com"), /providers\/github\.svg/);
  assert.match(signInLogo("GitHub.com "), /providers\/github\.svg/);
  for (const site of ["github.com.example.net", "evil-github.com", "", null]) assert.match(signInLogo(site), /neutral-mark/, String(site));
});
