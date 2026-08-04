import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("completed-report review opens an actionable recovery sheet instead of generic Schedule navigation", () => {
  assert.match(app, /Review report/);
  assert.match(app, /Retry saved report/);
  assert.match(app, /Mark checked/);
  assert.match(app, /Keep draft & dismiss/);
  assert.match(app, /item\.reviewError/);
  assert.doesNotMatch(app, /completionQueueSummary\.needsReview \? \(\) => handleNav\("schedule"\)/);
});

test("saved report retries use the existing durable outbox item", () => {
  assert.match(app, /retryCompletionIntent\(authUserId, item\.id\)/);
  assert.match(app, /setScheduleFocus\(\{ sid: item\.sid, date: context\.day\.date \}\)/);
});
