/**
 * Types for `format.js`, which the page loads as a plain ES module (no build step). Tests import the
 * module directly, so this declaration is what gives those imports real types instead of `any`.
 */

/**
 * The same path with a zero-width space after every `/` or `\`, i.e. with a legal break point at each
 * separator. Lossless: stripping `\u200B` returns the input.
 */
export function breakablePath(value: unknown): string;
