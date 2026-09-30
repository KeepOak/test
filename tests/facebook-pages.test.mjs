/* RES-119: Facebook Page posts. Off as Branch ships (it sends to other people); once the owner opts in, a post needs
   an exact, single-use review of that Page and text (src/personal/facebook-pages.ts). No Meta service is reached here. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("Facebook Page posting ships off, and a post needs one exact, single-use owner review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-facebook-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const pages = app.personal.facebook;
  assert.equal(pages.settings().readEnabled, false);
  assert.equal(pages.settings().publishEnabled, false, "posting to other people ships off");
  await assert.rejects(pages.compose({ message: "Hello" }), /off\/incomplete/);
  assert.throws(() => pages.configure({ publishEnabled: true, readEnabled: false, pageId: "123", tokenSecret: "FB_PAGE_TOKEN", termsAndRightsAcknowledged: true }),
    /readback access/, "posting without reading back is refused");
  assert.throws(() => pages.configure({ readEnabled: true, pageId: "123", tokenSecret: "FB_PAGE_TOKEN" }), /terms/);
  pages.configure({ readEnabled: true, publishEnabled: true, pageId: "123", tokenSecret: "FB_PAGE_TOKEN", termsAndRightsAcknowledged: true });
  const draft = await pages.compose({ message: "Open on Sunday" });
  assert.equal(draft.status, "local draft, not posted");
  assert.throws(() => pages.review({ draftId: draft.draftId, sha256: "0".repeat(64), exactPageAndTextReviewed: true }), /changed/,
    "the review names the exact text");
  const review = pages.review({ draftId: draft.draftId, sha256: draft.sha256, exactPageAndTextReviewed: true });
  assert.match(pages.target(review.reviewId), /Facebook Page 123; exact text SHA256/);
  assert.throws(() => pages.review({ draftId: draft.draftId, sha256: draft.sha256, exactPageAndTextReviewed: true }), /single-use/);
  assert.throws(() => pages.target("11111111-1111-4111-8111-111111111111"), /No unexpired owner review/);
  pages.configure({ readEnabled: false, publishEnabled: false });
  assert.throws(() => pages.target(review.reviewId), /No unexpired owner review|off/, "switching it off drops every approval");
});
