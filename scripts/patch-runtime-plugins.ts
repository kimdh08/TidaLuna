import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";

const rootDir = process.cwd();
const pluginsDir = join(rootDir, "plugins");
const distDir = join(rootDir, "dist");
const lunaBundlePath = join(distDir, "luna.mjs");
const storeJsonPath = join(distDir, "store.json");

type PluginMeta = {
	folder: string;
	packageName?: string;
	bundleName?: string;
};

type FilterConfig = {
	envKeys: string[];
	argKeys: string[];
};

const pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
const pluginMeta = await Promise.all(
	pluginEntries.filter((entry) => entry.isDirectory()).map((entry) => resolvePluginMeta(entry.name)),
);

const excludeFilters = buildFilterSet({
	envKeys: ["LUNA_RUNTIME_EXCLUDE", "LUNA_EXCLUDE_PLUGINS", "LUNA_SKIP_PLUGINS"],
	argKeys: ["--exclude", "--exclude-plugin", "--exclude-plugins", "--skip", "--skip-plugin", "--skip-plugins"],
});

const targetPlugins = pluginMeta.filter((meta) => shouldExclude(meta, excludeFilters));

if (targetPlugins.length === 0) {
	console.log("[patch-runtime-plugins] No matching plugins to strip. Skipping patch.");
	process.exit(0);
}

await patchLunaBundle(targetPlugins);
await patchStoreJson(targetPlugins);
await removePluginArtifacts(targetPlugins);

console.log(
	`[patch-runtime-plugins] Patched runtime to exclude: ${targetPlugins
		.map((meta) => meta.packageName ?? meta.bundleName ?? meta.folder)
		.join(", ")}`,
);

async function resolvePluginMeta(folder: string): Promise<PluginMeta> {
	const meta: PluginMeta = { folder };
	try {
		const pkgPath = join(pluginsDir, folder, "package.json");
		const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { name?: string; lunaBundleName?: string };
		meta.packageName = pkg.name;
		meta.bundleName = pkg.lunaBundleName;
	} catch {
		// ignore
	}
	return meta;
}

async function patchLunaBundle(plugins: PluginMeta[]) {
	let source = await readFile(lunaBundlePath, "utf8");
	let modified = source;
	for (const meta of plugins) {
		const bundleId = getBundleName(meta);
		const url = `https://luna/${bundleId}`;
		const escapedUrl = escapeRegExp(url);
		const patterns = [
			new RegExp(`,\s*await G\\.fromStorage\\(\\{[^}]*url:"${escapedUrl}"[^}]*\\}\\)`, "g"),
			new RegExp(`await G\\.fromStorage\\(\\{[^}]*url:"${escapedUrl}"[^}]*\\}\\),\s*`, "g"),
			new RegExp(`await G\\.fromStorage\\(\\{[^}]*url:"${escapedUrl}"[^}]*\\}\\)`, "g"),
		];
		let removed = false;
		for (const pattern of patterns) {
			const next = modified.replace(pattern, () => {
				removed = true;
				return "";
			});
			modified = next;
		}
		if (!removed) {
			console.warn(`[patch-runtime-plugins] Warning: could not find runtime load for ${bundleId}`);
		}
	}
	if (source !== modified) {
		await writeFile(lunaBundlePath, modified);
	} else {
		console.warn("[patch-runtime-plugins] No changes applied to dist/luna.mjs");
	}
}

async function patchStoreJson(plugins: PluginMeta[]) {
	try {
		const raw = await readFile(storeJsonPath, "utf8");
		const store = JSON.parse(raw) as { plugins?: string[] };
		if (Array.isArray(store.plugins)) {
			const bundleNamesToRemove = new Set(plugins.map((meta) => `${getBundleName(meta)}.mjs`));
			store.plugins = store.plugins.filter((entry) => !bundleNamesToRemove.has(entry));
			await mkdir(distDir, { recursive: true });
			await writeFile(storeJsonPath, JSON.stringify(store));
		}
	} catch (error) {
		console.warn("[patch-runtime-plugins] Skipping store.json patch:", error instanceof Error ? error.message : error);
	}
}

async function removePluginArtifacts(plugins: PluginMeta[]) {
	for (const meta of plugins) {
		const bundleId = getBundleName(meta);
		const targets = [
			`${bundleId}.mjs`,
			`${bundleId}.mjs.map`,
			`${bundleId}.json`,
		];
		await Promise.all(
			targets.map(async (name) => {
				const filePath = join(distDir, name);
				await rm(filePath, { force: true }).catch(() => {});
			}),
		);
	}
}

function getBundleName(meta: PluginMeta) {
	return meta.bundleName ?? sanitizePackageName(meta.packageName ?? meta.folder);
}

function sanitizePackageName(value: string) {
	return value.replace(/@/g, "").replace(/\//g, ".");
}

function buildFilterSet({ envKeys, argKeys }: FilterConfig) {
	const envTokens = envKeys.flatMap((key) => splitTokens(process.env[key]));
	const argTokens = collectArgValues(argKeys).flatMap(splitTokens);
	return new Set([...envTokens, ...argTokens].map(normalizeToken).filter(Boolean));
}

function splitTokens(value?: string) {
	if (!value) return [];
	return value
		.split(/[\s,]+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function collectArgValues(flags: string[]) {
	const values: string[] = [];
	for (let index = 2; index < process.argv.length; index++) {
		const arg = process.argv[index];
		const inlineFlag = flags.find((flag) => arg.startsWith(`${flag}=`));
		if (inlineFlag) {
			values.push(arg.slice(inlineFlag.length + 1));
			continue;
		}
		if (flags.includes(arg)) {
			const next = process.argv[index + 1];
			if (next && !next.startsWith("--")) {
				values.push(next);
				index++;
			}
		}
	}
	return values;
}

function shouldExclude(meta: PluginMeta, excludes: Set<string>) {
	if (excludes.size === 0) return false;
	const tokens = new Set([
		normalizeToken(meta.folder),
		normalizeToken(meta.packageName),
		normalizeToken(meta.bundleName),
	]);
	return hasIntersection(tokens, excludes);
}

function normalizeToken(value?: string) {
	if (!value) return "";
	return value.trim().toLowerCase().replace(/^@luna\//, "").replace(/^luna\./, "");
}

function hasIntersection(source: Set<string>, target: Set<string>) {
	for (const token of source) {
		if (token && target.has(token)) return true;
	}
	return false;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
