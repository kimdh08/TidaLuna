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

export const getCredentials = findModuleProperty<() => Promise<TidalCredentials>>(
	(key, value) => key === "getCredentials" && typeof value === "function"
)!.value!;
