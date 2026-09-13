import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetPassword } from "../src/password-reset.js";
import { refresh, signIn } from "../src/sessions.js";
import { resetStore } from "../src/store.js";

beforeEach(resetStore);

test("sessions issued before a password reset stop working", () => {
  const token = signIn("u1");
  resetPassword("u1");
  assert.equal(refresh(token).status, 401);
});

test("sessions issued after a password reset keep working", () => {
  resetPassword("u1");
  assert.equal(refresh(signIn("u1")).status, 200);
});
