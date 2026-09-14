import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
	address: string;
	family: number;
}

export type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface JinaFallbackOptions {
	allowThirdPartyFallback?: boolean;
	resolve?: ResolveAddresses;
}

const LOCAL_HOST_SUFFIXES = [
	".home",
	".internal",
	".invalid",
	".lan",
	".local",
	".localhost",
	".onion",
	".test",
];

const PUBLIC_CONTENT_PATHS = new Map<string, readonly RegExp[]>([
	["developer.mozilla.org", [/^\/[A-Za-z]{2}(?:-[A-Za-z]{2})?\/docs(?:\/|$)/u]],
	["docs.github.com", [/^\//u]],
	["en.wikipedia.org", [/^\/wiki\//u]],
	["www.rfc-editor.org", [/^\/rfc\//u]],
	["datatracker.ietf.org", [/^\/doc\//u]],
]);

const resolveAddresses: ResolveAddresses = (hostname) =>
	lookup(hostname, { all: true, verbatim: true });

function isPublicIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
	const [first, second, third] = octets;
	return !(
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second! >= 64 && second! <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second! >= 16 && second! <= 31) ||
		(first === 192 && second === 0) ||
		(first === 192 && second === 168) ||
		(first === 192 && second === 88 && third === 99) ||
		(first === 198 && (second === 18 || second === 19)) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113) ||
		first! >= 224
	);
}

function isPublicIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	return !(
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("::ffff:") ||
		normalized.startsWith("100:") ||
		normalized.startsWith("2001:db8:") ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/u.test(normalized) ||
		/^fe[c-f]/u.test(normalized) ||
		normalized.startsWith("ff")
	);
}

function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isPublicIpv4(address);
	if (family === 6) return isPublicIpv6(address);
	return false;
}

export async function eligibleJinaFallbackUrl(
	rawUrl: string,
	resolve: ResolveAddresses = resolveAddresses,
): Promise<string | undefined> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return undefined;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username || url.password || url.search || url.hash) return undefined;
	if (
		url.port &&
		!((url.protocol === "http:" && url.port === "80") ||
			(url.protocol === "https:" && url.port === "443"))
	) {
		return undefined;
	}

	const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
	if (
		!hostname.includes(".") ||
		hostname === "localhost" ||
		isIP(hostname) !== 0 ||
		LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
	) {
		return undefined;
	}
	const allowedPaths = PUBLIC_CONTENT_PATHS.get(hostname);
	if (!allowedPaths?.some((pattern) => pattern.test(url.pathname))) return undefined;

	let addresses: readonly ResolvedAddress[];
	try {
		addresses = await resolve(hostname);
	} catch {
		return undefined;
	}
	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
		return undefined;
	}

	return url.href;
}

export async function runEligibleJinaFallback<T>(
	url: string,
	fallback: (eligibleUrl: string) => Promise<T>,
	options: JinaFallbackOptions = {},
): Promise<T | null> {
	if (options.allowThirdPartyFallback !== true) return null;
	const eligibleUrl = await eligibleJinaFallbackUrl(url, options.resolve);
	return eligibleUrl ? fallback(eligibleUrl) : null;
}
