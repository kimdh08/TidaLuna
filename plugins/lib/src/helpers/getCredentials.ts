import { findModuleProperty } from "@luna/core";

type TidalCredentials = {
	clientId: string;
	clientUniqueKey: string;
	expires: number;
	grantedScopes: string[];
	requestedScopes: string[];
	token: string;
	userId: string;
};


let credModule: (() => Promise<TidalCredentials>) | undefined;
export const getCredentials = findModuleProperty<() => Promise<TidalCredentials>>(
	(key, value) => key === "getCredentials" && typeof value === "function"
)?.value || (async () => {
	try {
		if (!credModule) {
			credModule = findModuleProperty<() => Promise<TidalCredentials>>(
				(key, value) => key === "getCredentials" && typeof value === "function",
			)?.value;
			if (!credModule) throw new Error("Could not find Tidal credentials module");
		}
		return credModule();
	} catch (err) {
		throw new Error(`Failed to get Tidal credentials: ${(err as Error).message}`);
	}
});
