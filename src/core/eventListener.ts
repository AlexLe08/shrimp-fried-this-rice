// The emitter ignores a handler's promise, so a rejection (a cooldown reply
// to an expired interaction, say) would go unhandled and crash the process.
export function toEventListener<Args extends unknown[]>(
	name: string,
	execute: (...args: Args) => unknown,
): (...args: Args) => void {
	return (...args) => {
		(async () => execute(...args))().catch((error: unknown) => {
			console.error(`Unhandled error in the ${name} handler:`, error);
		});
	};
}
