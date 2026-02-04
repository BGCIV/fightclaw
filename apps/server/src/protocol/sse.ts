export const formatSse = (event: string, data: unknown) => {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
};
