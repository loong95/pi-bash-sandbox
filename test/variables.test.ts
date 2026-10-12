import assert from "node:assert/strict";
import test from "node:test";
import {
	expandVariables,
	findUnknownVariables,
	pathVariableContext,
	usesKnownVariable,
} from "../src/variables.ts";

const CTX = {
	repo: "/repo",
	worktree: "/repo-worktrees/feature",
	worktrees: ["/repo", "/repo-worktrees/feature", "/repo-worktrees/other"],
};

test("rules without variables pass through untouched", () => {
	assert.deepEqual(expandVariables(".", CTX), ["."]);
	assert.deepEqual(expandVariables("~/.ssh", CTX), ["~/.ssh"]);
	assert.deepEqual(expandVariables("/abs/path", CTX), ["/abs/path"]);
	assert.deepEqual(expandVariables("*.pem", CTX), ["*.pem"]);
});

test("$repo, $worktree, $worktrees expand to the git layout", () => {
	assert.deepEqual(expandVariables("$repo", CTX), ["/repo"]);
	assert.deepEqual(expandVariables("$worktree", CTX), ["/repo-worktrees/feature"]);
	assert.deepEqual(expandVariables("$worktrees", CTX), [
		"/repo",
		"/repo-worktrees/feature",
		"/repo-worktrees/other",
	]);
});

test("$worktrees is multi-valued and combines with literals and globs", () => {
	assert.deepEqual(expandVariables("$worktrees/src", CTX), [
		"/repo/src",
		"/repo-worktrees/feature/src",
		"/repo-worktrees/other/src",
	]);
	assert.deepEqual(expandVariables("$worktrees/**/*.ts", CTX), [
		"/repo/**/*.ts",
		"/repo-worktrees/feature/**/*.ts",
		"/repo-worktrees/other/**/*.ts",
	]);
});

test("two variables in one rule produce the cross product", () => {
	assert.deepEqual(expandVariables("$repo/../$worktree", CTX), ["/repo/..//repo-worktrees/feature"]);
	assert.deepEqual(expandVariables("$worktrees:$repo", CTX), [
		"/repo:/repo",
		"/repo-worktrees/feature:/repo",
		"/repo-worktrees/other:/repo",
	]);
});

test("duplicate expansions are removed", () => {
	const ctx = { repo: "/same", worktree: "/same", worktrees: ["/same", "/same"] };
	assert.deepEqual(expandVariables("$worktrees", ctx), ["/same"]);
});

test("a literal $ is written \\$", () => {
	assert.deepEqual(expandVariables("\\$repo", CTX), ["$repo"]);
	assert.deepEqual(expandVariables("a\\$b/$repo", CTX), ["a$b//repo"]);
});

test("unknown variables are preserved verbatim so the rule never matches", () => {
	assert.deepEqual(expandVariables("$bogus", CTX), ["$bogus"]);
	assert.deepEqual(expandVariables("$repo/$nope/x", CTX), ["/repo/$nope/x"]);
	assert.deepEqual(findUnknownVariables("$repo/$nope/x"), ["nope"]);
});

test("usesKnownVariable distinguishes known from unknown references", () => {
	assert.equal(usesKnownVariable("$repo"), true);
	assert.equal(usesKnownVariable("$worktree"), true);
	assert.equal(usesKnownVariable("$worktrees"), true);
	assert.equal(usesKnownVariable("$bogus"), false);
	assert.equal(usesKnownVariable("/plain"), false);
	assert.equal(usesKnownVariable("$bogus/$worktrees"), true);
});

test("a bare $ and trailing $ are treated as literals", () => {
	assert.deepEqual(expandVariables("price$", CTX), ["price$"]);
	assert.deepEqual(expandVariables("a$1", CTX), ["a$1"]);
});

test("pathVariableContext falls back to the current worktree", () => {
	assert.deepEqual(pathVariableContext({ projectRoot: "/r", worktreeRoot: "/r/wt" }), {
		repo: "/r",
		worktree: "/r/wt",
		worktrees: ["/r/wt"],
	});
	assert.deepEqual(
		pathVariableContext({ projectRoot: "/r", worktreeRoot: "/r/wt", worktrees: ["/r", "/r/wt"] }),
		{ repo: "/r", worktree: "/r/wt", worktrees: ["/r", "/r/wt"] },
	);
});
