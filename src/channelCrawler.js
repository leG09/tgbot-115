const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, Raw } = require('telegram/events');
const input = require('input');
const { extractShare, processShare } = require('./autoSave');

const DEFAULT_PROGRESS_FILE = path.join(__dirname, '..', 'tg_channel_progress.json');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function progressKey(channel) {
    return String(channel.id || channel.username || channel);
}

function messageKey(channel, message) {
    return `${progressKey(channel)}:${message?.id || ''}`;
}

function normalizeChannelConfig(config) {
    const raw = config.telegramUser?.channels || [];
    return raw
        .filter(item => item && item.enabled !== false)
        .map(item => ({
            id: item.id ?? item.channel ?? item.username,
            name: item.name || String(item.id ?? item.channel ?? item.username),
            intervalMs: Math.max(1000, Number(item.intervalMs || item.intervalSeconds * 1000 || 30000)),
            startTime: item.startTime ? new Date(item.startTime) : null,
            ignoreStartTime: Boolean(item.ignoreStartTime)
        }))
        .filter(item => item.id !== undefined && item.id !== null);
}

function getMessageText(message) {
    return [
        message?.message,
        message?.text,
        message?.caption
    ].filter(Boolean).join('\n');
}

function toMessageDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value * 1000);
    return new Date(value);
}

async function createTelegramClient(config) {
    const tg = config.telegramUser || {};
    if (!tg.apiId || !tg.apiHash) {
        throw new Error('缺少 telegramUser.apiId 或 telegramUser.apiHash');
    }

    const stringSession = new StringSession(tg.session || '');
    const client = new TelegramClient(stringSession, Number(tg.apiId), tg.apiHash, {
        connectionRetries: 5
    });

    if (tg.session) {
        await client.connect();
    } else {
        await client.start({
            phoneNumber: async () => input.text('Telegram phone number: '),
            password: async () => input.password('Telegram 2FA password: '),
            phoneCode: async () => input.text('Telegram login code: '),
            onError: err => console.error('[telegram-user] login error:', err.message)
        });
        console.log('[telegram-user] session string:');
        console.log(client.session.save());
        console.log('[telegram-user] 请把上面的字符串填入 config.json 的 telegramUser.session');
    }

    return client;
}

function createProgressStore(config) {
    const configuredPath = config.telegramUser?.progressFile;
    const filePath = configuredPath
        ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(__dirname, '..', configuredPath))
        : DEFAULT_PROGRESS_FILE;
    return {
        get(channel) {
            return Number(loadJson(filePath, {})[progressKey(channel)] || 0);
        },
        set(channel, messageId) {
            const progress = loadJson(filePath, {});
            progress[progressKey(channel)] = Number(messageId);
            writeJson(filePath, progress);
        }
    };
}

function createReporter(bot, config) {
    const chatId = config.telegramUser?.notifyChatId;
    return async function report(text) {
        console.log(text.replace(/<[^>]+>/g, ''));
        if (!chatId || !bot?.telegram) return;
        try {
            await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('[telegram-user] notify failed:', e.message);
        }
    };
}

async function processMessage(config, report, channel, message, processingMessages) {
    const key = messageKey(channel, message);
    if (processingMessages?.has(key)) {
        return { handled: false, reason: 'processing' };
    }
    processingMessages?.add(key);
    try {
        const text = getMessageText(message);
        const share = extractShare(text);
        if (!share) {
            return { handled: false, reason: 'no_share' };
        }

        const result = await processShare(config, share, {
            channelId: channel.id,
            channelName: channel.name,
            messageId: message.id
        });

        if (result.status === 'saved') {
            await report([
                `✅ 自动转存成功`,
                `📣 <code>${escapeHtml(channel.name)}</code> #${message.id}`,
                `🎞️ <b>${escapeHtml(result.tmdbInfo.title)}</b>${result.tmdbInfo.year ? ` (${result.tmdbInfo.year})` : ''}`,
                `📂 <code>${escapeHtml(result.savePath)}</code>`,
                `📊 文件数量: ${result.saveCount}`
            ].join('\n'));
        } else if (config.telegramUser?.notifySkipped !== false) {
            await report([
                `⏭️ 自动转存跳过`,
                `📣 <code>${escapeHtml(channel.name)}</code> #${message.id}`,
                `原因: <code>${escapeHtml(result.reason || '')}</code>`,
                result.tmdbInfo?.title ? `🎞️ <b>${escapeHtml(result.tmdbInfo.title)}</b>${result.tmdbInfo.year ? ` (${result.tmdbInfo.year})` : ''}` : '',
                result.existingCount ? `📊 YiYi 已有关联文件: ${result.existingCount}` : '',
                result.savePath ? `📂 <code>${escapeHtml(result.savePath)}</code>` : '',
                result.message ? `ℹ️ ${escapeHtml(result.message)}` : ''
            ].filter(Boolean).join('\n'));
        }

        return { handled: true, result };
    } finally {
        processingMessages?.delete(key);
    }
}

async function channelWorker(client, config, progressStore, report, channel, processingMessages) {
    await report(`▶️ 启动频道爬取: <code>${escapeHtml(channel.name)}</code>`);
    const entity = channel.entity || channel.id;
    while (true) {
        try {
            const lastId = progressStore.get(channel);
            const messages = await client.getMessages(entity, {
                limit: 1,
                minId: lastId,
                reverse: true
            });

            if (!messages.length) {
                await sleep(channel.intervalMs);
                continue;
            }

            const message = messages[0];
            const messageDate = toMessageDate(message.date);
            if (channel.startTime && !channel.ignoreStartTime && messageDate && messageDate < channel.startTime) {
                progressStore.set(channel, message.id);
                continue;
            }

            await processMessage(config, report, channel, message, processingMessages);
            progressStore.set(channel, message.id);
        } catch (e) {
            console.error(`[telegram-user] channel ${channel.name} failed:`, e.message);
            await report(`❌ 频道爬取异常: <code>${escapeHtml(channel.name)}</code>\n<code>${escapeHtml(e.message)}</code>`);
            await sleep(Math.max(channel.intervalMs, 10000));
        }
    }
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeExternalChannelId(value) {
    if (value === undefined || value === null) return '';
    const raw = String(value).replace(/^-/, '');
    return raw.startsWith('100') ? `-100${raw.slice(3)}` : `-100${raw}`;
}

function findChannelForMessage(channels, message) {
    const chatId = message?.chatId ? String(message.chatId) : '';
    const peerChannelId = message?.peerId?.channelId ? normalizeExternalChannelId(message.peerId.channelId) : '';
    return channels.find(item => {
        const wanted = String(item.id);
        return wanted === chatId
            || wanted === normalizeExternalChannelId(chatId)
            || wanted === peerChannelId;
    });
}

async function startChannelCrawler(config, bot) {
    if (!config.telegramUser?.enabled) {
        return null;
    }

    const channels = normalizeChannelConfig(config);
    if (!channels.length) {
        console.log('[telegram-user] enabled but no channels configured');
        return null;
    }

    const client = await createTelegramClient(config);
    const progressStore = createProgressStore(config);
    const report = createReporter(bot, config);
    const processingMessages = new Set();

    for (const channel of channels) {
        try {
            channel.entity = await client.getEntity(channel.id);
        } catch (e) {
            await report(`❌ 频道解析失败，已跳过: <code>${escapeHtml(channel.name)}</code>\n<code>${escapeHtml(e.message)}</code>`);
            continue;
        }
        channelWorker(client, config, progressStore, report, channel, processingMessages).catch(e => {
            console.error(`[telegram-user] worker crashed ${channel.name}:`, e);
        });
    }

    client.addEventHandler(async event => {
        const message = event.message;
        if (!message) return;
        const channel = findChannelForMessage(channels, message);
        if (!channel) return;
        try {
            await processMessage(config, report, channel, message, processingMessages);
            progressStore.set(channel, message.id);
        } catch (e) {
            console.error(`[telegram-user] realtime message failed ${channel.name}:`, e.message);
        }
    }, new NewMessage({}));

    client.addEventHandler(async update => {
        const message = update?.message;
        if (!message || !String(update.className || '').includes('Edit')) return;
        const channel = findChannelForMessage(channels, message);
        if (!channel) return;
        try {
            await processMessage(config, report, channel, message, processingMessages);
            progressStore.set(channel, message.id);
        } catch (e) {
            console.error(`[telegram-user] edited message failed ${channel.name}:`, e.message);
        }
    }, new Raw({}));

    return {
        client,
        stop: async () => client.disconnect()
    };
}

module.exports = {
    startChannelCrawler
};
