/**
 * Path variables for filesystem rules.
 *
 * A rule may reference three variables instead of a literal path, which is
 * what makes worktree writes portable: worktree directories are machine- and
 * branch-specific, so hard-coding them in `sandbox.json` cannot work.
 *
 * | Variable     | Value                                                  |
 * |--------------|--------------------------------------------------------|
 * | `$repo`      | main checkout root (shared by every worktree)          |
 * | `$worktree`  | toplevel of the worktree the command runs in           |
 * | `$worktrees` | every worktree root, main checkout first (**multi**)   |
 *
 * `$worktrees` is multi-valued: one rule expands into one rule per worktree,
 * so `allowWrite: ["$worktrees"]` covers every linked worktree, including
 * ones created after the session started (expansion re-runs per command).
 *
 * A literal `$` is written `\$`. Unknown `$name` references are reported by
 * `findUnknownVariables` and left untouched, so they resolve to a path that
 * does not exist and are dropped like any other unmatched rule.
 *
 * Both the bwrap layer (config.ts) and the tool policy (policy.ts) expand
 * through this module, so the two never drift apart.
 */

export interface PathVariableContext {
	repo: string;
	worktree: string;
	/** Every worktree root, main checkout first. Falls back to `[worktree]`. */
	worktrees: string[];
}

export const PATH_VARIABLE_NAMES = ["repo", "worktree", "worktrees"] as const;
export type PathVariableName = (typeof PATH_VARIABLE_NAMES)[number];

/** The multi-valued variable; a rule using it produces one rule per worktree. */
export const MULTI_VALUE_VARIABLE: PathVariableName = "worktrees";

interface Token {
	literal?: string;
	variable?: string;
}

/** Split a rule into literal chunks and `$name` references; `\$` is a literal `$`. */
function tokenize(rule: string): Token[] {
	const tokens: Token[] = [];
	let literal = "";
	const flush = () => {
		if (literal) {
			tokens.push({ literal });
			literal = "";
		}
	};

	for (let i = 0; i < rule.length; i++) {
		const char = rule[i];
		if (char === "\\" && rule[i + 1] === "$") {
			literal += "$";
			i++;
			continue;
		}
		if (char === "$") {
			const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rule.slice(i + 1));
			if (match) {
				flush();
				tokens.push({ variable: match[0] });
				i += match[0].length;
				continue;
			}
		}
		literal += char;
	}
	flush();
	return tokens;
}

function variableValues(name: string, context: PathVariableContext): string[] | null {
	switch (name) {
		case "repo":
			return [context.repo];
		case "worktree":
			return [context.worktree];
		case "worktrees":
			return context.worktrees.length > 0 ? context.worktrees : [context.worktree];
		default:
			return null;
	}
}

/** True when the rule references any `$variable` (including unknown ones). */
export function hasVariables(rule: string): boolean {
	return tokenize(rule).some((token) => token.variable !== undefined);
}

/** True when the rule references at least one known variable. */
export function usesKnownVariable(rule: string): boolean {
	return tokenize(rule).some(
		(token) => token.variable !== undefined && variableValues(token.variable, EMPTY_CONTEXT) !== null,
	);
}

/** Variable names the rule references that are not one of `$repo`/`$worktree`/`$worktrees`. */
export function findUnknownVariables(rule: string): string[] {
	const unknown = tokenize(rule)
		.map((token) => token.variable)
		.filter((name): name is string => name !== undefined && variableValues(name, EMPTY_CONTEXT) === null);
	return [...new Set(unknown)];
}

const EMPTY_CONTEXT: PathVariableContext = { repo: "", worktree: "", worktrees: [] };

/**
 * Substitute variables, returning one concrete rule per `$worktrees` value.
 * Rules without variables are returned unchanged, except that `\$` is
 * unescaped (a rule may legitimately need a literal `$` in a path).
 */
export function expandVariables(rule: string, context: PathVariableContext): string[] {
	const tokens = tokenize(rule);
	if (!tokens.some((token) => token.variable !== undefined)) {
		// No substitution, but `\$` still has to become a literal `$`.
		const literal = tokens.map((token) => token.literal ?? "").join("");
		return [literal];
	}

	let results = [""];
	for (const token of tokens) {
		if (token.literal !== undefined) {
			const literal = token.literal;
			results = results.map((prefix) => prefix + literal);
			continue;
		}
		const name = token.variable as string;
		const values = variableValues(name, context);
		if (values === null) {
			// Unknown variable: keep it verbatim so the rule simply never matches.
			results = results.map((prefix) => `${prefix}$${name}`);
			continue;
		}
		results = results.flatMap((prefix) => values.map((value) => prefix + value));
	}
	return [...new Set(results)];
}

/** Build the variable context from a resolved project. */
export function pathVariableContext(input: {
	projectRoot: string;
	worktreeRoot: string;
	worktrees?: string[];
}): PathVariableContext {
	const worktrees = input.worktrees?.length ? input.worktrees : [input.worktreeRoot];
	return { repo: input.projectRoot, worktree: input.worktreeRoot, worktrees };
}
