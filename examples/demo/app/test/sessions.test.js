import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { refresh, signIn } from "../src/sessions.js";
import { resetStore } from "../src/store.js";

beforeEach(resetStore);

test("a new session refreshes", () => {
  assert.equal(refresh(signIn("u1")).status, 200);
});

test("an unknown token is rejected", () => {
  assert.equal(refresh("not-a-token").status, 401);
});
