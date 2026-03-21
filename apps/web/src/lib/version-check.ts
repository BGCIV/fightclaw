function isLocalOrigin(origin: string) {
	try {
		const url = new URL(origin);
		const host = url.host;
		return (
			host === "localhost" ||
			host.startsWith("localhost:") ||
			host === "127.0.0.1" ||
			host.startsWith("127.0.0.1:") ||
			host === "[::1]" ||
			host.startsWith("[::1]:")
		);
	} catch {
		return false;
	}
}

export function shouldProbeServerVersion(
	serverUrl: string,
	windowOrigin: string,
	isDev: boolean,
) {
	if (!serverUrl) return false;
	try {
		const serverOrigin = new URL(serverUrl).origin;
		if (!isDev) return true;
		if (serverOrigin === windowOrigin) return true;
		if (isLocalOrigin(serverOrigin) && isLocalOrigin(windowOrigin)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}
