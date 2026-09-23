const FILE_MAGIC = 0x43f4efdd;
const NETWORK_MAGIC = 0x2cf5a13d;
const MAX_CUSTOM_VERSIONS = 1024;
const MAX_STRING_BYTES = 1024 * 1024;

export class ReplayHeaderError extends Error {}

class Reader {
	private offset = 0;

	constructor(private readonly bytes: Uint8Array) {}

	private take(length: number, field: string): Uint8Array {
		if (length < 0 || this.offset + length > this.bytes.length) {
			throw new ReplayHeaderError(`Truncated replay while reading ${field}`);
		}

		const value = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	uint32(field: string): number {
		const value = this.take(4, field);
		return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
	}

	int32(field: string): number {
		const value = this.take(4, field);
		return new DataView(value.buffer, value.byteOffset, 4).getInt32(0, true);
	}

	skip(length: number, field: string): void {
		this.take(length, field);
	}

	fstring(field: string): string {
		const length = this.int32(`${field} length`);
		if (length === 0) return "";

		const wide = length < 0;
		const byteLength = wide ? -length * 2 : length;
		if (byteLength > MAX_STRING_BYTES) {
			throw new ReplayHeaderError(`${field} is too large`);
		}

		const value = this.take(byteLength, field);
		const terminatorLength = wide ? 2 : 1;
		for (let i = 0; i < terminatorLength; i++) {
			if (value[value.length - 1 - i] !== 0) {
				throw new ReplayHeaderError(`${field} is not null-terminated`);
			}
		}

		return new TextDecoder(wide ? "utf-16le" : "utf-8", {
			fatal: true,
			ignoreBOM: true,
		})
			.decode(value.subarray(0, value.length - terminatorLength));
	}

	position(): number {
		return this.offset;
	}
}

export function readReplayGameVersion(bytes: Uint8Array): string {
	const reader = new Reader(bytes);

	if (reader.uint32("file magic") !== FILE_MAGIC) {
		throw new ReplayHeaderError("Invalid replay file magic");
	}

	reader.skip(4, "file version");
	const customVersionCount = reader.int32("custom version count");
	if (customVersionCount < 0 || customVersionCount > MAX_CUSTOM_VERSIONS) {
		throw new ReplayHeaderError(`Invalid custom version count: ${customVersionCount}`);
	}
	reader.skip(customVersionCount * 20, "custom versions");

	reader.skip(12, "replay summary");
	reader.fstring("friendly name");
	reader.skip(20, "replay flags and timestamp");
	const encryptionKeyLength = reader.int32("encryption key length");
	if (encryptionKeyLength < 0 || encryptionKeyLength > MAX_STRING_BYTES) {
		throw new ReplayHeaderError(`Invalid encryption key length: ${encryptionKeyLength}`);
	}
	reader.skip(encryptionKeyLength, "encryption key");

	if (reader.uint32("first chunk type") !== 0) {
		throw new ReplayHeaderError("First replay chunk is not a header");
	}
	const headerSize = reader.int32("header size");
	if (headerSize < 0) throw new ReplayHeaderError(`Invalid header size: ${headerSize}`);
	const headerStart = reader.position();

	if (reader.uint32("network magic") !== NETWORK_MAGIC) {
		throw new ReplayHeaderError("Invalid replay network magic");
	}
	reader.skip(4, "network version");
	const headerCustomVersionCount = reader.int32("header custom version count");
	if (headerCustomVersionCount < 0 || headerCustomVersionCount > MAX_CUSTOM_VERSIONS) {
		throw new ReplayHeaderError(
			`Invalid header custom version count: ${headerCustomVersionCount}`,
		);
	}
	reader.skip(headerCustomVersionCount * 20, "header custom versions");
	reader.skip(38, "network metadata and replay version numbers");
	const branch = reader.fstring("replay branch");

	if (reader.position() - headerStart > headerSize) {
		throw new ReplayHeaderError("Replay branch extends beyond the header chunk");
	}

	const match = branch.trim().match(/(\d+\.\d+(?:\.\d+)?)$/);
	if (!match) {
		throw new ReplayHeaderError(`Replay branch has no game version: ${branch}`);
	}
	return match[1];
}
