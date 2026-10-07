/**
 * Presentation helpers for the dashboard's own DOM. No framework, no build step: plain ES modules,
 * and every function here is PURE so it can be unit-tested without a browser (see
 * `tests/unit/web-format.test.ts` for the {@link breakablePath} contract).
 */

/**
 * A path that may only break AT ITS SEPARATORS.
 *
 * The page sets `overflow-wrap: anywhere` globally, and a Windows path contains no break opportunity
 * at all, so a long one was hard-split mid-token: the operator saw `C:\Users\93715\code\test` with a
 * bare `4` on the next line. A zero-width space after each `/` or `\` gives the browser a LEGAL break
 * point, which it always prefers over an emergency mid-token break, so a wrapped path breaks cleanly
 * after an separator and never leaves a stray fragment. Nothing is lost: stripping the invisible
 * characters returns the input unchanged.
 */
export function breakablePath(value) {
	return String(value ?? "").replace(/([/\\])/g, "$1\u200B");
}
