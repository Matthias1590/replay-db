import { AwsClient } from "aws4fetch";
import { readReplayGameVersion } from "./replay-header";

const REPLAY_HEADER_READ_SIZE = 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
	"http://127.0.0.1:3000",
	"http://localhost:3000",
	"https://matthias1590.github.io",
]);

function withCors(request: Request, response: Response): Response {
	const origin = request.headers.get("Origin");

	if (!origin || !ALLOWED_ORIGINS.has(origin)) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Vary", "Origin");

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			const origin = request.headers.get("Origin");

			if (!origin || !ALLOWED_ORIGINS.has(origin)) {
				return new Response(null, { status: 403 });
			}

			return new Response(null, {
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": origin,
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization, Content-Type",
					"Access-Control-Max-Age": "86400",
					"Vary": "Origin",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/stats") {
			const ip = request.headers.get("CF-Connecting-IP") || "unknown";
			const { success } = await env.STATS_RATE_LIMITER.limit({ key: ip });

			if (!success) {
				return withCors(request, Response.json(
					{ error: "Rate limit exceeded" },
					{ status: 429 },
				));
			}

			const auth = request.headers.get("Authorization");
			let uploaderReplays = 0;

			if (auth?.startsWith("Bearer ")) {
				const token = auth.slice("Bearer ".length).trim();
				const uploader = await env.replay_db
					.prepare("SELECT successful_uploads FROM uploaders WHERE token = ?")
					.bind(token)
					.first<{ successful_uploads: number }>();

				if (uploader) {
					uploaderReplays = uploader.successful_uploads;
				}
			}

			const total = await env.replay_db
				.prepare("SELECT total_replays AS replays, total_bytes AS bytes FROM stats WHERE id = 1")
				.first<{ replays: number; bytes: number }>();

			return withCors(request, Response.json({
				uploader: {
					replays: uploaderReplays,
				},
				total: {
					replays: total?.replays ?? 0,
					bytes: total?.bytes ?? 0,
				},
			}));
		}

		if (request.method === "POST" && url.pathname === "/uploaders") {
			const ip = request.headers.get("CF-Connecting-IP") || "unknown";

			const { success } = await env.UPLOADERS_RATE_LIMITER.limit({
				key: ip,
			});

			if (!success) {
				return withCors(request, Response.json(
					{ error: "Rate limit exceeded" },
					{ status: 429 },
				));
			}

			const token = crypto.randomUUID();

			await env.replay_db
				.prepare("INSERT INTO uploaders (token) VALUES (?)")
				.bind(token)
				.run();

			return withCors(request, Response.json({ token }));
		}

		if (request.method === "POST" && url.pathname === "/upload") {
			const ip = request.headers.get("CF-Connecting-IP") || "unknown";

			const { success } = await env.UPLOAD_RATE_LIMITER.limit({
				key: ip,
			});

			if (!success) {
				return withCors(request, Response.json(
					{ error: "Rate limit exceeded" },
					{ status: 429 },
				));
			}

			const auth = request.headers.get("Authorization");

			if (!auth?.startsWith("Bearer ")) {
				return withCors(request, Response.json(
					{ error: "Missing bearer token" },
					{ status: 401 },
				));
			}

			const token = auth.slice("Bearer ".length).trim();

			const uploader = await env.replay_db
				.prepare("SELECT token FROM uploaders WHERE token = ?")
				.bind(token)
				.first();

			if (!uploader) {
				return withCors(request, Response.json(
					{ error: "Invalid token" },
					{ status: 401 },
				));
			}

			let body: {
				hash: string;
				size: number;
			};

			try {
				body = await request.json();
			} catch {
				return withCors(request, Response.json(
					{ error: "Invalid JSON" },
					{ status: 400 },
				));
			}

			const MAX_SIZE = 100 * 1024 * 1024;

			if (
				!Number.isInteger(body.size) ||
				body.size < 0 ||
				body.size > MAX_SIZE
			) {
				return withCors(request, Response.json(
					{ error: "File too large" },
					{ status: 413 },
				));
			}

			if (!/^[A-Za-z0-9+/]{22}==$/.test(body.hash)) {
				return withCors(request, Response.json(
					{ error: "Invalid hash" },
					{ status: 400 },
				));
			}

			const hash = body.hash;

			const existing = await env.replay_db
				.prepare(
					"SELECT verified_hash FROM replays WHERE verified_hash = ?",
				)
				.bind(hash)
				.first();

			if (existing) {
				return withCors(request, Response.json(
					{ error: "Replay already exists" },
					{ status: 409 },
				));
			}

			const key = crypto.randomUUID();

			const client = new AwsClient({
				accessKeyId: env.R2_ACCESS_KEY_ID,
				secretAccessKey: env.R2_SECRET_ACCESS_KEY,
				service: "s3",
				region: "auto",
			});

			const uploadUrl = new URL(`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/valorant-replays/${key}`);
			uploadUrl.searchParams.set("X-Amz-Expires", "900");

			const signed = await client.sign(
				new Request(uploadUrl, {
					method: "PUT",
					headers: {
						"x-amz-meta-uploader-token": token,
						"content-md5": hash,
						"content-length": body.size.toString(),
					},
				}),
				{
					aws: {
						signQuery: true,
						allHeaders: true,
						service: "s3",
						region: "auto",
					},
				}
			);

			return withCors(request, Response.json({
				upload_url: signed.url,
			}));
		}

		return withCors(request, new Response("Not found", { status: 404 }));
	},

	async queue(batch, env) {
		for (const message of batch.messages) {
			const event = message.body as {
				action: string;
				bucket: string;
				object: {
					key: string;
					size: number;
				};
			};

			const object = await env.valorant_replays.get(
				event.object.key,
				{
					range: {
						offset: 0,
						length: REPLAY_HEADER_READ_SIZE,
					},
				},
			);

			if (!object) {
				console.log(
					"Object not found:",
					event.object.key,
				);
				continue;
			}

			const uploaderToken =
				object.customMetadata?.["uploader-token"];

			if (!uploaderToken) {
				console.log(
					"Missing uploader token:",
					event.object.key,
				);

				await env.valorant_replays.delete(
					event.object.key,
				);

				continue;
			}

			const checksum = object.checksums?.md5;

			if (!checksum) {
				console.log(
					"Missing MD5 checksum:",
					event.object.key,
				);

				await env.valorant_replays.delete(
					event.object.key,
				);

				continue;
			}

			const hash = Buffer.from(checksum).toString("base64");

			const existing = await env.replay_db
				.prepare(`
					SELECT
						verified_hash,
						storage_key
					FROM replays
					WHERE verified_hash = ?
				`)
				.bind(hash)
				.first<{
					verified_hash: string;
					storage_key: string;
				}>();

			if (existing) {
				// Queue retry for the exact same object.
				if (existing.storage_key === event.object.key) {
					console.log(
						"Replay already inserted:",
						hash,
					);

					continue;
				}

				// Different object with the same verified hash.
				await env.valorant_replays.delete(
					event.object.key,
				);

				await env.replay_db
					.prepare(`
						UPDATE uploaders
						SET duplicate_uploads =
							duplicate_uploads + 1
						WHERE token = ?
					`)
					.bind(uploaderToken)
					.run();

				console.log(
					"Duplicate replay:",
					hash,
				);

				continue;
			}

			let gameVersion: string;

			try {
				gameVersion = readReplayGameVersion(
					new Uint8Array(await object.arrayBuffer()),
				);
			} catch (error) {
				console.log(
					"Invalid replay header:",
					event.object.key,
					error,
				);

				await env.valorant_replays.delete(
					event.object.key,
				);

				await env.replay_db
					.prepare(`
						UPDATE uploaders
						SET invalid_uploads = invalid_uploads + 1
						WHERE token = ?
					`)
					.bind(uploaderToken)
					.run();

				continue;
			}

			try {
				await env.replay_db.batch([
					env.replay_db.prepare(`
						INSERT INTO replays (
							verified_hash,
							storage_key,
							uploader_token,
							size_bytes,
							game_version
						)
						VALUES (?, ?, ?, ?, ?)
					`)
					.bind(
						hash,
						event.object.key,
						uploaderToken,
						object.size,
						gameVersion,
					)
					,
					env.replay_db.prepare(`
						UPDATE uploaders
						SET successful_uploads = successful_uploads + 1
						WHERE token = ?
					`).bind(uploaderToken),
					env.replay_db.prepare(`
						UPDATE stats
						SET total_replays = total_replays + 1,
							total_bytes = total_bytes + ?
						WHERE id = 1
					`).bind(object.size),
				]);
			} catch (error) {
				// IMPORTANT:
				// Don't treat arbitrary D1 errors as duplicates.
				// Throwing makes the Queue retry the message.
				console.error(
					"Failed to insert replay:",
					error,
				);

				throw error;
			}

			console.log(
				"Valid replay stored:",
				hash,
			);
		}
	},
} satisfies ExportedHandler<Env>;
