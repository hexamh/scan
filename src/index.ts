export interface Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	TELEGRAM_BOT_TOKEN: string;
	CRAWL_KV: KVNamespace;
	MY_BUCKET: R2Bucket;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
	message_id: number;
	chat: { id: number };
	text?: string;
}

interface TelegramCallbackQuery {
	id: string;
	data: string;
	message: TelegramMessage;
}

interface CrawlOptions {
	includeExternalLinks: boolean;
	includeSubdomains: boolean;
}

interface CrawlConfig {
	limit: number;
	depth: number;
	formats: string[];
	render: boolean;
	options: CrawlOptions;
}

function getDefaultConfig(): CrawlConfig {
	return {
		limit: 50,
		depth: 2,
		formats: ['markdown'],
		render: true,
		options: {
			includeExternalLinks: false,
			includeSubdomains: false
		}
	};
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

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

		if (request.method === 'POST' && url.pathname === '/webhook') {
			try {
				const update: TelegramUpdate = await request.json();
				
				if (update.message && update.message.text) {
					ctx.waitUntil(handleMessage(update.message, env));
				} else if (update.callback_query) {
					ctx.waitUntil(handleCallback(update.callback_query, env));
				}
				
				return new Response('OK', { status: 200 });
			} catch (e) {
				return new Response('Bad Request', { status: 400 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function getUserConfig(chatId: number, env: Env): Promise<CrawlConfig> {
	const stored = await env.CRAWL_KV.get(`chat:${chatId}:config`);
	if (stored) {
		try {
			const parsed = JSON.parse(stored);
			return { 
				...getDefaultConfig(), 
				...parsed,
				options: { ...getDefaultConfig().options, ...(parsed.options || {}) }
			};
		} catch (e) {
			return getDefaultConfig();
		}
	}
	return getDefaultConfig();
}

/**
 * Validates and increments the user's daily submission quota.
 * Limits users to 2 requests per UTC day.
 * Auto-expires keys after 48 hours to prevent KV bloat.
 */
async function consumeDailyRateLimit(chatId: number, env: Env): Promise<boolean> {
	const todayDateString = new Date().toISOString().split('T')[0];
	const rateLimitKey = `ratelimit:${chatId}:${todayDateString}`;
	
	const currentUsageStr = await env.CRAWL_KV.get(rateLimitKey);
	const currentUsage = currentUsageStr ? parseInt(currentUsageStr, 10) : 0;

	if (currentUsage >= 2) {
		return false;
	}

	const newUsage = currentUsage + 1;
	// 172800 seconds = 48 hours. Ensures the key covers all timezones and is safely purged.
	await env.CRAWL_KV.put(rateLimitKey, newUsage.toString(), { expirationTtl: 172800 });
	
	return true;
}

function buildSettingsKeyboard(config: CrawlConfig) {
	return {
		inline_keyboard: [
			[
				{ text: `Limit: ${config.limit === 10 ? '✅ 10' : '10'}`, callback_data: `cfg:limit:10` },
				{ text: config.limit === 50 ? '✅ 50' : '50', callback_data: `cfg:limit:50` },
				{ text: config.limit === 100 ? '✅ 100' : '100', callback_data: `cfg:limit:100` },
				{ text: config.limit === 500 ? '✅ 500' : '500', callback_data: `cfg:limit:500` }
			],
			[
				{ text: `Depth: ${config.depth === 1 ? '✅ 1' : '1'}`, callback_data: `cfg:depth:1` },
				{ text: config.depth === 2 ? '✅ 2' : '2', callback_data: `cfg:depth:2` },
				{ text: config.depth === 5 ? '✅ 5' : '5', callback_data: `cfg:depth:5` },
				{ text: config.depth === 10 ? '✅ 10' : '10', callback_data: `cfg:depth:10` }
			],
			[
				{ text: `Browser Render: ${config.render ? '✅ ON' : '❌ OFF'}`, callback_data: `cfg:render:toggle` },
			],
			[
				{ text: `HTML ${config.formats.includes('html') ? '✅' : '❌'}`, callback_data: `cfg:fmt:html` },
				{ text: `MD ${config.formats.includes('markdown') ? '✅' : '❌'}`, callback_data: `cfg:fmt:markdown` },
				{ text: `JSON ${config.formats.includes('json') ? '✅' : '❌'}`, callback_data: `cfg:fmt:json` }
			],
			[
				{ text: `External Links: ${config.options.includeExternalLinks ? '✅ ON' : '❌ OFF'}`, callback_data: `cfg:ext:toggle` },
			],
			[
				{ text: `Subdomains: ${config.options.includeSubdomains ? '✅ ON' : '❌ OFF'}`, callback_data: `cfg:sub:toggle` }
			]
		]
	};
}

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
	const chatId = message.chat.id;
	const text = message.text?.trim() || '';

	if (text.startsWith('/start')) {
		const welcomeMsg = `🤖 *Crawl Bot*\n\n` + 
			`Send me a URL starting with \`http://\` or \`https://\` to automatically initiate a crawl using your customized settings.\n\n` +
			`*Constraints:*\n` +
			`• Limit: 2 URLs per day\n\n` +
			`*Commands:*\n` +
			`/settings - Configure limits, depths, formats, and behavior.\n` +
			`/status - Check the progress of your active job.\n\n` +
			`_You can also send a raw JSON configuration payload for fully custom scrapes._`;
		
		await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, welcomeMsg);
		return;
	}

	if (text.startsWith('/settings')) {
		await sendSettingsMenu(chatId, env);
		return;
	}

	if (text.startsWith('/status')) {
		const parts = text.split(' ');
		let jobId = parts[1];

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

	if (text.startsWith('http://') || text.startsWith('https://')) {
		const isPermitted = await consumeDailyRateLimit(chatId, env);
		if (!isPermitted) {
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⚠️ *Daily Limit Exceeded*\n\nYou have reached the maximum allowance of 2 URLs per day. Please try again tomorrow.`);
			return;
		}
		await initiateCrawl(text, chatId, env, false);
		return;
	} 
	
	if (text.startsWith('{')) {
		const isPermitted = await consumeDailyRateLimit(chatId, env);
		if (!isPermitted) {
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⚠️ *Daily Limit Exceeded*\n\nYou have reached the maximum allowance of 2 JSON jobs per day. Please try again tomorrow.`);
			return;
		}
		await initiateCrawl(text, chatId, env, true);
		return;
	}

	await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, '⚠️ Please send a valid URL starting with `http://` or `https://`, use `/settings`, or send a JSON configuration object.');
}

async function handleCallback(callbackQuery: TelegramCallbackQuery, env: Env): Promise<void> {
	const chatId = callbackQuery.message.chat.id;
	const messageId = callbackQuery.message.message_id;
	const data = callbackQuery.data;
	
	if (data.startsWith('cfg:')) {
		const parts = data.split(':');
		const key = parts[1];
		const val = parts[2];
		
		const config = await getUserConfig(chatId, env);
		
		if (key === 'limit') config.limit = parseInt(val, 10);
		if (key === 'depth') config.depth = parseInt(val, 10);
		if (key === 'render') config.render = !config.render;
		if (key === 'ext') config.options.includeExternalLinks = !config.options.includeExternalLinks;
		if (key === 'sub') config.options.includeSubdomains = !config.options.includeSubdomains;
		if (key === 'fmt') {
			if (config.formats.includes(val)) {
				if (config.formats.length > 1) {
					config.formats = config.formats.filter((f) => f !== val);
				}
			} else {
				config.formats.push(val);
			}
		}
		
		await env.CRAWL_KV.put(`chat:${chatId}:config`, JSON.stringify(config));
		await sendSettingsMenu(chatId, env, messageId);
	}
	
	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ callback_query_id: callbackQuery.id })
	});
}

async function sendSettingsMenu(chatId: number, env: Env, messageId?: number): Promise<void> {
	const config = await getUserConfig(chatId, env);
	
	const text = `⚙️ *Crawl Endpoint Settings*\n\n` +
				 `Configure parameters for the \`/crawl\` endpoint. These settings automatically apply to any URL you submit to the bot.`;
				 
	const keyboard = buildSettingsKeyboard(config);

	if (messageId) {
		await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
	} else {
		await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, keyboard);
	}
}

async function initiateCrawl(input: string, chatId: number, env: Env, isJson: boolean): Promise<void> {
	const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl`;
	
	let payload: Record<string, unknown>;

	if (isJson) {
		try {
			payload = JSON.parse(input);
		} catch (e) {
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *Invalid JSON Configuration.*\nVerify your formatting and try again.`);
			return;
		}
	} else {
		const config = await getUserConfig(chatId, env);
		payload = {
			url: input.trim(),
			formats: config.formats, 
			limit: config.limit,
			depth: config.depth,
			render: config.render,
			options: config.options
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

		if (response.ok && data.success && (data.result?.job_id || data.result?.id)) {
			const jobId = data.result.job_id || data.result.id;
			await env.CRAWL_KV.put(`chat:${chatId}:latest_job`, jobId);

			const cfgFmt = isJson ? "Custom JSON Payload" : `${payload.limit} pages | ${payload.depth} clicks | ${payload.render ? 'Rendered' : 'Static'} | ${(payload.formats as string[]).join(',')}`;
			const successMsg = `✅ *Crawl Job Initiated!*\n\n*Target:* ${payload.url}\n*Job ID:* \`${jobId}\`\n*Config:* ${cfgFmt}\n\nCheck progress anytime by sending:\n\`/status\``;
			
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, successMsg);
		} else {
			const errorMsg = data.errors?.[0]?.message || JSON.stringify(data);
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *Failed to initiate crawl:*\n${errorMsg}`);
		}
	} catch (err) {
		await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ *System Error:* ${String(err)}`);
	}
}

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

		if (response.ok && data.success && data.result) {
			const result = data.result;
			const status = result.status || 'unknown';
			const records = result.records || result.data || result.items;

			if (status === 'completed' && Array.isArray(records)) {
				const fileName = `crawled_content_${jobId}.md`;
				let combinedMarkdown = '';
				
				const existingObject = await env.MY_BUCKET.get(fileName);

				if (existingObject) {
					combinedMarkdown = await existingObject.text();
				} else {
					combinedMarkdown = `# Crawl Results for Job ${jobId}\n\n`;
					
					for (const record of records) {
						combinedMarkdown += `## Source: ${record.url || 'Unknown URL'}\n\n`;
						let hasContent = false;
						
						if (record.markdown || (record.content && record.content.markdown)) {
							combinedMarkdown += (record.markdown || record.content.markdown) + '\n\n';
							hasContent = true;
						}
						
						if (record.html || (record.content && record.content.html)) {
							const htmlStr = record.html || record.content.html;
							combinedMarkdown += `### HTML Content\n\`\`\`html\n${htmlStr}\n\`\`\`\n\n`;
							hasContent = true;
						}
						
						if (record.json || (record.content && record.content.json)) {
							const jsonStr = JSON.stringify(record.json || record.content.json, null, 2);
							combinedMarkdown += `### Structured JSON\n\`\`\`json\n${jsonStr}\n\`\`\`\n\n`;
							hasContent = true;
						}
						
						if (!hasContent) {
							combinedMarkdown += `*No extracted content returned for this page format configuration.*\n\n`;
						}
						combinedMarkdown += `---\n\n`;
					}

					await env.MY_BUCKET.put(fileName, combinedMarkdown, {
						httpMetadata: { contentType: 'text/markdown' }
					});
				}

				await sendTelegramDocument(env.TELEGRAM_BOT_TOKEN, chatId, combinedMarkdown, fileName);
				await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `✅ *Job Completed!* Combined results delivered above.`);
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

async function sendTelegramMessage(token: string, chatId: number, text: string, replyMarkup?: any): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	
	const body: any = {
		chat_id: chatId,
		text,
		parse_mode: 'Markdown'
	};
	if (replyMarkup) body.reply_markup = replyMarkup;

	await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function editTelegramMessage(token: string, chatId: number, messageId: number, text: string, replyMarkup?: any): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/editMessageText`;
	
	const body: any = {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: 'Markdown'
	};
	if (replyMarkup) body.reply_markup = replyMarkup;

	await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

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
