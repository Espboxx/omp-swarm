/**
 * Static-asset path resolution: the one place a request path becomes a file, kept pure and
 * exported so the containment rule can be tested directly.
 *
 * That separation is not decoration. A URL parser normalizes a literal `..` out of a request path
 * before it is ever sent, so an HTTP-level test can only ever reproduce a benign path — the guard
 * that matters is only reachable with a raw path, which a direct unit test supplies.
 */
import { resolve, sep } from "node:path";

export interface AssetResolved {
	ok: true;
	/** Absolute path of the file to serve. */
	target: string;
}

export interface AssetRefused {
	ok: false;
	status: number;
	message: string;
}

export type AssetResolution = AssetResolved | AssetRefused;

/**
 * Map a request path onto a file under `assetsRoot`, or refuse it.
 *
 * `web/assets/**` is served at the root (what `./app.js` inside `index.html` resolves to) and is
 * also accepted under `/assets/...`, so either reference style in the page works. `/` means
 * `index.html`. Anything that would resolve outside `assetsRoot` is a 403, a malformed
 * percent-encoding or a NUL byte is a 400 — never a silent fallback.
 */
export function resolveAssetTarget(assetsRoot: string, rawPath: string): AssetResolution {
	let relative: string;
	try {
		relative = decodeURIComponent(rawPath);
	} catch {
		return { ok: false, status: 400, message: "malformed percent-encoding in the path" };
	}
	if (relative.includes("\0")) return { ok: false, status: 400, message: "bad path" };
	if (relative === "/assets" || relative === "/assets/") relative = "/";
	else if (relative.startsWith("/assets/")) relative = relative.slice("/assets".length);
	if (relative === "" || relative === "/") relative = "/index.html";
	const root = resolve(assetsRoot);
	const target = resolve(root, `.${relative}`);
	if (target !== root && !target.startsWith(root + sep)) {
		return { ok: false, status: 403, message: `refusing to leave the asset root: ${relative}` };
	}
	return { ok: true, target };
}
