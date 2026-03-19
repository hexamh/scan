/**
 * Cloudflare Worker Telegram Bot - Web Crawler
 * Integrated with Browser Rendering /crawl endpoint, Workers KV (Settings), and R2 (File Storage).
 */

export interface Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	TELEGRAM_BOT_TOKEN: string;
	CRAWL_KV: KVNamespace;
	MY_BUCKET: R2Bucket;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Setup Webhook endpoint
		if (request.method === 'GET' && url.pathname === '/setup_webhook') {
			const webhookUrl = `${url.origin}/webhook`;
			const telegramApi = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
			
			try {
				const res = await fetch(telegramApi);
				const result = await res.json();
				return Response.json({ success: true, webhookUrl, telegramResponse: result });
			} catch (e) {
				return Response.json({ success: false, error: String(e) }, { status: 500 });
			}
		}

		// Webhook receiver
		if (request.method === 'POST' && url.pathname === '/webhook') {
			try {
				const update: any = await request.json();
				
				if (update.message && update.message.text) {
					ctx.waitUntil(handleMessage(update.message, env));
				}
				
				return new Response('OK', { status: 200 });
			} catch (e) {
				return new Response('Bad Request', { status: 400 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Route commands and messages
 */
async function handleMessage(message: any, env: Env): Promise<void> {
	const chatId = message.chat.id;
	const text = message.text.trim();

	if (text.startsWith('/start')) {
		const welcomeMsg = `🤖 *Crawl Bot*\n\n` + 
			`Send me a URL to crawl, or a JSON payload for authenticated scraping.\n\n` +
			`Use \`/status\` to check the progress of your latest job, or \`/status <job_id>\` for a specific run.`;
		
		await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, welcomeMsg);
		return;
	}

	if (text.startsWith('/status')) {
		const parts = text.split(' ');
		let jobId = parts[1];

		// KV: Look up the last known job if the user just typed `/status`
		if (!jobId) {
			jobId = await env.CRAWL_KV.get(`chat:${chatId}:latest_job`) as string;
			if (!jobId) {
				await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, '❌ No recent jobs found. Please provide a job ID or start a new crawl.\n*Example:* `/status 1234abcd-5678...`');
				return;
			}
		}

		await checkCrawlStatus(jobId, chatId, env);
		return;
	}

	// Handle standard URLs or JSON Configs
	if (text.startsWith('{')) {
		await initiateCrawl(text, chatId, env, true);
		return;
	} else if (text.startsWith('http://') || text.startsWith('https://')) {
		await initiateCrawl(text, chatId, env, false);
		return;
	}

	await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, '⚠️ Please send a valid URL starting with `http://` or `https://` (or a JSON configuration object).');
}

/**
 * Initiates a new crawl and saves state to KV
 */
async function initiateCrawl(input: string, chatId: number, env: Env, isJson: boolean): Promise<void> {
	const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl`;
	
	let payload: Record<string, unknown>;

	if (isJson) {
		try {
			payload = JSON.parse(input);
			if (!payload.formats) payload.formats = ["markdown"];
		} catch (e) {
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *Invalid JSON Configuration.*\nVerify your formatting and try again.`);
			return;
		}
	} else {
		payload = {
			url: input,
			formats: ["markdown"], 
			limit: 10,
			depth: 1
		};
	}

	try {
		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const data: any = await response.json();

		if (data.success && (data.result?.job_id || data.result?.id)) {
			const jobId = data.result.job_id || data.result.id;
			
			// KV: Cache this ID as the active job for the user for ease of access
			await env.CRAWL_KV.put(`chat:${chatId}:latest_job`, jobId);

			const successMsg = `✅ *Crawl Job Initiated!*\n\n*Target:* ${payload.url}\n*Job ID:* \`${jobId}\`\n\nCheck progress anytime by sending:\n\`/status\``;
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, successMsg);
		} else {
			const errorMsg = data.errors?.[0]?.message || 'Unknown error occurred.';
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *Failed to initiate crawl:*\n${errorMsg}`);
		}
	} catch (err) {
		await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *System Error:* ${String(err)}`);
	}
}

/**
 * Validates job status and leverages R2 for document generation and caching
 */
async function checkCrawlStatus(jobId: string, chatId: number, env: Env): Promise<void> {
	const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl/${jobId}`;
	
	try {
		const response = await fetch(apiUrl, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json'
			}
		});

		const data: any = await response.json();

		if (data.success && data.result) {
			const result = data.result;
			const status = result.status || 'unknown';
			const records = result.records || result.data || result.items;

			if (status === 'completed' && Array.isArray(records)) {
				const fileName = `crawled_content_${jobId}.md`;
				let combinedMarkdown = '';
				
				// R2: Check if we have already compiled and stored this document
				const existingObject = await env.MY_BUCKET.get(fileName);

				if (existingObject) {
					// File exists in R2, fetch the text
					combinedMarkdown = await existingObject.text();
				} else {
					// Compile markdown from the raw API records
					combinedMarkdown = `# Crawl Results for Job ${jobId}\n\n`;
					
					for (const record of records) {
						combinedMarkdown += `## Source: ${record.url || 'Unknown URL'}\n\n`;
						const md = record.markdown || (record.content && record.content.markdown) || '';
						
						if (md) {
							combinedMarkdown += md + '\n\n';
						} else {
							combinedMarkdown += `*No markdown returned for this page. (Ensure 'formats': ['markdown'] was set)*\n\n`;
						}
						combinedMarkdown += `---\n\n`;
					}

					// R2: Save the compiled Markdown file to the bucket for future access
					await env.MY_BUCKET.put(fileName, combinedMarkdown, {
						httpMetadata: { contentType: 'text/markdown' }
					});
				}

				await sendTelegramDocument(env.TELEGRAM_BOT_TOKEN, chatId, combinedMarkdown, fileName);
				await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `✅ *Job Completed!* Markdown file delivered above.`);
			} else {
				let msg = `📊 *Job Status:* \`${status.toUpperCase()}\`\n\n`;
				msg += `*Total Pages:* ${result.total || 0}\n*Finished:* ${result.finished || 0}\n*Skipped:* ${result.skipped || 0}`;
				await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
			}
		} else {
			const errorMsg = data.errors?.[0]?.message || 'Unknown error fetching status.';
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *Failed to fetch status:*\n${errorMsg}`);
		}
	} catch (err) {
		await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *Error fetching status:* ${String(err)}`);
	}
}

/**
 * Standard text dispatcher
 */
async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'Markdown'
		}),
	});
}

/**
 * High-fidelity file delivery using Form-Data and Blobs natively supported in Workers
 */
async function sendTelegramDocument(token: string, chatId: number, fileContent: string, fileName: string): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/sendDocument`;
	
	const formData = new FormData();
	formData.append('chat_id', chatId.toString());
	
	const blob = new Blob([fileContent], { type: 'text/markdown' });
	formData.append('document', blob, fileName);

	await fetch(url, {
		method: 'POST',
		body: formData
	});
}
