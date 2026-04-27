const { Telegraf, Markup } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const service115 = require('./service115');
const tmdbService = require('./tmdb');
const { matchCategory } = require('./category');
const sessions = require('./sessions');

const LINK_PATTERN = /https?:\/\/(?:115\.com|pan\.115\.com|115cdn\.com)\/s\/([a-z0-9]+)/i;
const PASSWORD_PATTERN = /[?&]password=([^\s&#]+)/i;
const PAGE_SIZE = 8;

function createBot(config) {
    const proxyUrl = config.telegram?.proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    const bot = new Telegraf(config.telegram.token, agent ? { telegram: { agent } } : {});

    const cookie = config.cookie115;
    const rootCid = config.rootCid || '0';       // 115 根目录 CID
    const categoryRules = config.categoryRules;   // 分类规则

    // ──────────────────────────────────────────
    // 工具函数
    // ──────────────────────────────────────────

    function isAllowed(ctx) {
        const ids = config.telegram.allowedChatIds;
        if (!ids || ids.length === 0) return true;
        return ids.includes(ctx.chat.id) || ids.includes(String(ctx.chat.id));
    }

    async function safeEdit(chatId, messageId, text, extra = {}) {
        try {
            await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
                parse_mode: 'HTML',
                ...extra
            });
        } catch (e) {
            if (!e.message?.includes('message is not modified')) {
                console.error('editMessage error:', e.message);
            }
        }
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function buildFolderName(tmdbInfo) {
        const year = tmdbInfo.year ? ` (${tmdbInfo.year})` : '';
        return `${tmdbInfo.title}${year} [tmdbid-${tmdbInfo.tmdbId}]`;
    }

    function buildDisplayPath(pathArr) {
        if (!pathArr || pathArr.length <= 1) return '';
        return pathArr.slice(1).map(p => p.name).join('/');
    }

    function isSingleFolderShare(shareItems) {
        return Array.isArray(shareItems)
            && shareItems.length === 1
            && shareItems[0]?.isFolder;
    }

    // ──────────────────────────────────────────
    // 显示「确认转存」摘要（含自动/手动目录信息）
    // ──────────────────────────────────────────
    async function showAutoConfirm(session) {
        const { tmdbInfo, categoryName, manualPath } = session;
        const folderName = buildFolderName(tmdbInfo);

        const typeStr = tmdbInfo.isTV ? '📺 剧集' : '🎬 电影';
        const year = tmdbInfo.year ? ` (${tmdbInfo.year})` : '';
        const rating = tmdbInfo.rating && tmdbInfo.rating !== 'NaN' ? ` ⭐${tmdbInfo.rating}` : '';
        const overview = tmdbInfo.overview
            ? `\n<i>${escapeHtml(tmdbInfo.overview.substring(0, 150))}${tmdbInfo.overview.length > 150 ? '…' : ''}</i>`
            : '';

        // 目录路径显示
        let dirLine;
        if (manualPath !== null && manualPath !== undefined) {
            dirLine = `📁 <b>手动目录</b>: <code>${escapeHtml(manualPath || '根目录')}</code>`;
        } else if (categoryName) {
            dirLine = `📁 <b>自动分类</b>: <code>${escapeHtml(categoryName)}</code>`;
        } else {
            dirLine = `📁 <b>未匹配分类</b>，将保存到根目录`;
        }

        const savePath = manualPath !== null && manualPath !== undefined
            ? `${manualPath ? manualPath + '/' : ''}${folderName}`
            : `${categoryName ? categoryName + '/' : ''}${folderName}`;

        const msg = [
            `${typeStr} <b>${escapeHtml(tmdbInfo.title)}${year}</b>${rating}${overview}`,
            '',
            dirLine,
            `📂 <code>${escapeHtml(savePath)}</code>`,
            `🆔 tmdbid-${tmdbInfo.tmdbId}`,
        ].join('\n');

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ 确认转存', '115:confirm'),
                Markup.button.callback('📁 修改目录', '115:change_dir'),
            ],
            [
                Markup.button.callback('✏️ 修改TMDB ID', '115:manual'),
                Markup.button.callback('❌ 取消', '115:cancel'),
            ],
        ]);

        await safeEdit(session.chatId, session.botMessageId, msg, keyboard);
        session.step = 'auto_confirm';
        sessions.set(session.userId, session);
    }

    // ──────────────────────────────────────────
    // 文件夹浏览器
    // ──────────────────────────────────────────
    function buildFolderKeyboard(folders, page, isAtRoot) {
        const start = page * PAGE_SIZE;
        const rows = folders.slice(start, start + PAGE_SIZE).map(f => [
            Markup.button.callback(`📁 ${f.name.substring(0, 28)}`, `115:nav:${f.cid}`)
        ]);

        const ctrlRow = [];
        if (!isAtRoot) ctrlRow.push(Markup.button.callback('⬆️ 上级', '115:back'));
        ctrlRow.push(Markup.button.callback('✅ 选此目录', '115:sel'));
        ctrlRow.push(Markup.button.callback('❌ 取消', '115:cancel'));
        rows.push(ctrlRow);

        if (folders.length > PAGE_SIZE) {
            const pRow = [];
            if (page > 0) pRow.push(Markup.button.callback('◀️', '115:prev'));
            pRow.push(Markup.button.callback(`${page + 1}/${Math.ceil(folders.length / PAGE_SIZE)}`, '115:noop'));
            if (start + PAGE_SIZE < folders.length) pRow.push(Markup.button.callback('▶️', '115:next'));
            rows.push(pRow);
        }
        return Markup.inlineKeyboard(rows);
    }

    async function showFolderBrowser(session, cid, page = 0) {
        let folderData;
        try {
            folderData = await service115.getFolderList(cookie, cid);
        } catch (e) {
            await safeEdit(session.chatId, session.botMessageId, `❌ 获取目录失败: ${e.message}`);
            sessions.delete(session.userId);
            return;
        }

        const { list, path } = folderData;
        session.currentCid = cid;
        session.currentPage = page;
        session.currentFolders = list;
        session.currentPath = path || [];
        session.step = 'folder';
        sessions.set(session.userId, session);

        const isAtRoot = cid === rootCid || cid === '0';
        const pathStr = path?.length > 0 ? path.map(p => p.name).join(' > ') : '根目录';

        const msg = [
            `📂 <b>选择转存目录</b>`,
            `路径: <code>${escapeHtml(pathStr)}</code>`,
            list.length === 0 ? '（此目录无子目录，可直接选择）' : `共 ${list.length} 个子目录`,
        ].join('\n');

        await safeEdit(session.chatId, session.botMessageId, msg,
            buildFolderKeyboard(list, page, isAtRoot));
    }

    // ──────────────────────────────────────────
    // 选择媒体类型（找不到 TMDB 时）
    // ──────────────────────────────────────────
    async function showTypeSelection(session, reason = '') {
        session.step = 'tmdb_type';
        sessions.set(session.userId, session);
        const prefix = reason ? `${reason}\n\n` : '';
        await safeEdit(session.chatId, session.botMessageId,
            `${prefix}请选择媒体类型，然后回复 TMDB ID（纯数字）：`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🎬 电影', '115:type:movie'), Markup.button.callback('📺 剧集/动漫', '115:type:tv')],
                [Markup.button.callback('❌ 取消', '115:cancel')],
            ]));
    }

    // ──────────────────────────────────────────
    // TMDB 搜索 + 分类 + 显示确认
    // ──────────────────────────────────────────
    async function searchAndClassify(session) {
        await safeEdit(session.chatId, session.botMessageId,
            `🔍 正在搜索影视信息...\n<code>${escapeHtml(session.shareTitle)}</code>`);

        try {
            const tmdbInfo = await tmdbService.searchTmdb(
                session.shareTitle, config.tmdb.apiKey, config.tmdb.language);

            if (!tmdbInfo) {
                await showTypeSelection(session,
                    `🔍 未找到匹配影视信息\n搜索词: <code>${escapeHtml(session.shareTitle)}</code>`);
                return;
            }

            session.tmdbInfo = tmdbInfo;
            session.categoryName = matchCategory(tmdbInfo, categoryRules) || null;
            // 清除手动目录选择
            session.manualCid = undefined;
            session.manualPath = undefined;
            sessions.set(session.userId, session);

            await showAutoConfirm(session);
        } catch (e) {
            await showTypeSelection(session, `⚠️ TMDB搜索异常: ${escapeHtml(e.message)}`);
        }
    }

    // ──────────────────────────────────────────
    // 执行转存 + Webhook
    // ──────────────────────────────────────────
    async function doSaveAndWebhook(session) {
        const { tmdbInfo, shareCode, receiveCode, fileIds, shareItems, categoryName, manualCid, manualPath } = session;
        const folderName = buildFolderName(tmdbInfo);
        const singleFolderShare = isSingleFolderShare(shareItems);

        await safeEdit(session.chatId, session.botMessageId,
            `⏳ 正在转存...\n📁 <code>${escapeHtml(folderName)}</code>`);

        // 确定父目录 CID
        let parentCid, parentDisplayPath;
        if (manualCid !== undefined && manualCid !== null) {
            // 用户手动选择了目录
            parentCid = manualCid;
            parentDisplayPath = manualPath || '';
        } else if (categoryName) {
            // 自动分类：创建分类目录，已存在则查找其 CID
            try {
                const res = await service115.addFolder(cookie, rootCid, categoryName);
                parentCid = res.cid;
            } catch (e) {
                if (e.message.includes('已存在')) {
                    const { list } = await service115.getFolderList(cookie, rootCid);
                    const found = list.find(f => f.name === categoryName);
                    if (!found) {
                        await safeEdit(session.chatId, session.botMessageId,
                            `❌ 找不到分类目录: ${categoryName}`);
                        sessions.delete(session.userId);
                        return;
                    }
                    parentCid = found.cid;
                } else {
                    await safeEdit(session.chatId, session.botMessageId,
                        `❌ 创建分类目录失败: ${e.message}`);
                    sessions.delete(session.userId);
                    return;
                }
            }
            parentDisplayPath = categoryName;
        } else {
            // 未匹配分类，保存到 rootCid
            parentCid = rootCid;
            parentDisplayPath = '';
        }

        let finalFolderName = folderName;
        let saveCount = 0;

        if (singleFolderShare) {
            let foldersBeforeSave;
            try {
                const { list } = await service115.getFolderList(cookie, parentCid);
                foldersBeforeSave = list;
            } catch (e) {
                await safeEdit(session.chatId, session.botMessageId,
                    `❌ 获取目标目录失败: ${e.message}`);
                sessions.delete(session.userId);
                return;
            }

            if (foldersBeforeSave.some(folder => folder.name === folderName)) {
                await safeEdit(session.chatId, session.botMessageId,
                    `❌ 目录已存在: <code>${escapeHtml(folderName)}</code>`);
                sessions.delete(session.userId);
                return;
            }

            const beforeCids = new Set(foldersBeforeSave.map(folder => String(folder.cid)));
            const sourceFolderName = shareItems[0].name || session.shareTitle || folderName;
            const saveResult = await service115.saveFiles(
                cookie, parentCid, shareCode, receiveCode, fileIds);

            if (!saveResult.success) {
                await safeEdit(session.chatId, session.botMessageId,
                    `❌ 转存失败: ${saveResult.msg}`);
                sessions.delete(session.userId);
                return;
            }
            saveCount = saveResult.count;

            let savedFolder;
            try {
                const { list } = await service115.getFolderList(cookie, parentCid);
                savedFolder = list.find(folder => !beforeCids.has(String(folder.cid)))
                    || list.find(folder => folder.name === sourceFolderName && !beforeCids.has(String(folder.cid)));
            } catch (e) {
                await safeEdit(session.chatId, session.botMessageId,
                    `⚠️ 转存已完成，但无法识别新目录: ${escapeHtml(e.message)}`);
                sessions.delete(session.userId);
                return;
            }

            if (!savedFolder) {
                await safeEdit(session.chatId, session.botMessageId,
                    `⚠️ 转存已完成，但无法定位新目录，未执行重命名。`);
                sessions.delete(session.userId);
                return;
            }

            if (savedFolder.name !== folderName) {
                try {
                    await service115.renameFile(cookie, savedFolder.cid, folderName);
                } catch (e) {
                    finalFolderName = savedFolder.name;
                    const partialPath = parentDisplayPath
                        ? `${parentDisplayPath}/${finalFolderName}`
                        : finalFolderName;
                    await safeEdit(session.chatId, session.botMessageId, [
                        `⚠️ 转存已完成，但重命名失败`,
                        `📂 <code>${escapeHtml(partialPath)}</code>`,
                        `📝 目标名称: <code>${escapeHtml(folderName)}</code>`,
                        `原因: ${escapeHtml(e.message)}`,
                    ].join('\n'));
                    sessions.delete(session.userId);
                    return;
                }
            }
        } else {
            // 多文件/多目录分享仍沿用外层媒体目录，避免内容散落到父目录
            let mediaFolder;
            try {
                mediaFolder = await service115.addFolder(cookie, parentCid, folderName);
            } catch (e) {
                await safeEdit(session.chatId, session.botMessageId,
                    `❌ 创建目录失败: ${e.message}`);
                sessions.delete(session.userId);
                return;
            }

            const saveResult = await service115.saveFiles(
                cookie, mediaFolder.cid, shareCode, receiveCode, fileIds);
            if (!saveResult.success) {
                await safeEdit(session.chatId, session.botMessageId,
                    `❌ 转存失败: ${saveResult.msg}`);
                sessions.delete(session.userId);
                return;
            }
            saveCount = saveResult.count;
        }

        const savePath = parentDisplayPath
            ? `${parentDisplayPath}/${finalFolderName}` : finalFolderName;

        // 调用 Webhook（未配置则跳过）
        let webhookNote = '';
        if (config.webhook?.url) {
            try {
                const webhookResp = await callWebhook(finalFolderName, parentDisplayPath);
                webhookNote = `\n🔄 Webhook: <code>${escapeHtml(webhookResp)}</code>`;
            } catch (e) {
                webhookNote = `\n⚠️ Webhook 调用失败: <code>${escapeHtml(e.message)}</code>`;
            }
        }

        await safeEdit(session.chatId, session.botMessageId, [
            `✅ <b>转存成功！</b>`,
            `📂 <code>${escapeHtml(savePath)}</code>`,
            `📊 文件数量: ${saveCount}`,
            webhookNote,
        ].join('\n'));

        sessions.delete(session.userId);
    }

    async function callWebhook(folderName, parentDisplayPath) {
        const { url, mountPath } = config.webhook || {};
        if (!url) return;
        const parts = [parentDisplayPath, folderName].filter(Boolean);
        let fullPath = parts.join('/').replace(/\/+/g, '/');
        // 去掉 mountPath（115挂载点），得到相对路径
        if (mountPath) {
            const mount = mountPath.replace(/\/+$/, '');
            if (fullPath.startsWith(mount + '/')) fullPath = fullPath.slice(mount.length + 1);
            else if (fullPath === mount) fullPath = '';
        }
        if (fullPath && !fullPath.startsWith('/')) fullPath = '/' + fullPath;

        // POST {url}&path={fullPath}，无请求体
        const reqUrl = url + (url.includes('?') ? '&' : '?') + 'path=' + encodeURIComponent(fullPath);
        console.log('[webhook] POST', reqUrl);
        const res = await axios.post(reqUrl, null, { timeout: 15000 });
        const respStr = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
        console.log('[webhook] response', respStr);
        return respStr;
    }

    // ──────────────────────────────────────────
    // 加载分享信息（通用）
    // ──────────────────────────────────────────
    async function loadShareInfo(session, shareCode, receiveCode) {
        try {
            const info = await service115.getShareInfo(cookie, shareCode, receiveCode);
            session.fileIds = info.fileIds;
            session.shareItems = info.items;
            session.shareTitle = info.shareTitle;
            sessions.set(session.userId, session);

            await safeEdit(session.chatId, session.botMessageId,
                `📦 <b>${escapeHtml(info.shareTitle)}</b>  共 ${info.count} 个文件`);

            await searchAndClassify(session);
        } catch (e) {
            const msg = e.message;
            if (msg.includes('提取码') || msg.includes('密码') || msg.includes('receive_code')) {
                session.step = 'awaiting_password';
                sessions.set(session.userId, session);
                await safeEdit(session.chatId, session.botMessageId,
                    '🔒 该链接需要提取码，请直接回复提取码：');
            } else {
                await safeEdit(session.chatId, session.botMessageId,
                    `❌ 获取链接失败: ${escapeHtml(msg)}`);
                sessions.delete(session.userId);
            }
        }
    }

    // ──────────────────────────────────────────
    // 消息处理
    // ──────────────────────────────────────────
    bot.on('message', async (ctx) => {
        console.log('[msg] chatId:', ctx.chat.id, 'userId:', ctx.from.id, 'text:', ctx.message?.text?.substring(0, 60));
        if (!isAllowed(ctx)) { console.log('[msg] blocked'); return; }
        const text = ctx.message?.text;
        if (!text) return;

        const userId = ctx.from.id;
        const chatId = ctx.chat.id;

        // 检测 115 链接
        const linkMatch = text.match(LINK_PATTERN);
        if (linkMatch) {
            const shareCode = linkMatch[1];
            const pwdMatch = text.match(PASSWORD_PATTERN);
            const receiveCode = pwdMatch ? pwdMatch[1] : '';

            const sent = await ctx.reply('🔍 检测到115分享链接，正在处理...',
                { reply_to_message_id: ctx.message.message_id });

            const session = {
                userId, chatId,
                botMessageId: sent.message_id,
                shareCode, receiveCode,
                fileIds: [], shareTitle: '',
                currentCid: rootCid, currentPath: [], currentFolders: [], currentPage: 0,
                categoryName: null, manualCid: undefined, manualPath: undefined,
                tmdbInfo: null, mediaType: null,
                step: 'loading',
            };
            sessions.set(userId, session);
            await loadShareInfo(session, shareCode, receiveCode);
            return;
        }

        // 处理进行中的会话文本输入
        const session = sessions.get(userId);
        if (!session) return;

        if (session.step === 'awaiting_password') {
            const rc = text.trim();
            session.receiveCode = rc;
            sessions.set(userId, session);
            await safeEdit(session.chatId, session.botMessageId, '🔍 正在验证提取码...');
            await loadShareInfo(session, session.shareCode, rc);
            return;
        }

        if (session.step === 'tmdb_id') {
            const tmdbId = text.trim().replace(/[^0-9]/g, '');
            if (!tmdbId) {
                await ctx.reply('❌ 请输入纯数字 TMDB ID', { reply_to_message_id: ctx.message.message_id });
                return;
            }
            await safeEdit(session.chatId, session.botMessageId, `🔍 查询 TMDB ID: ${tmdbId}...`);
            try {
                let info;
                if (session.mediaType === 'tv') {
                    info = await tmdbService.getTmdbById(tmdbId, 'tv', config.tmdb.apiKey, config.tmdb.language);
                } else if (session.mediaType === 'movie') {
                    info = await tmdbService.getTmdbById(tmdbId, 'movie', config.tmdb.apiKey, config.tmdb.language);
                } else {
                    try { info = await tmdbService.getTmdbById(tmdbId, 'movie', config.tmdb.apiKey, config.tmdb.language); }
                    catch { info = await tmdbService.getTmdbById(tmdbId, 'tv', config.tmdb.apiKey, config.tmdb.language); }
                }
                session.tmdbInfo = info;
                session.categoryName = matchCategory(info, categoryRules) || null;
                session.manualCid = undefined;
                session.manualPath = undefined;
                sessions.set(userId, session);
                await showAutoConfirm(session);
            } catch (e) {
                await showTypeSelection(session, `❌ 查询失败: ${escapeHtml(e.message)}`);
            }
        }
    });

    // ──────────────────────────────────────────
    // Callback Query
    // ──────────────────────────────────────────
    bot.on('callback_query', async (ctx) => {
        const data = ctx.callbackQuery?.data;
        if (!data || !data.startsWith('115:')) return;
        await ctx.answerCbQuery().catch(() => {});

        const userId = ctx.from.id;
        const session = sessions.get(userId);
        if (!session) {
            try { await ctx.editMessageText('⏰ 会话已过期，请重新发送链接'); } catch (e) {}
            return;
        }
        if (session.userId !== userId) return;

        const parts = data.split(':');
        const action = parts[1];
        const arg = parts[2];

        try {
            switch (action) {

                // ── 确认转存 ──
                case 'confirm': {
                    if (!session.tmdbInfo) { await ctx.answerCbQuery('❌ 状态异常'); return; }
                    session.step = 'saving';
                    sessions.set(userId, session);
                    await doSaveAndWebhook(session);
                    break;
                }

                // ── 修改目录（打开文件夹浏览器）──
                case 'change_dir': {
                    await showFolderBrowser(session, rootCid, 0);
                    break;
                }

                // ── 文件夹导航 ──
                case 'nav': {
                    await showFolderBrowser(session, arg, 0);
                    break;
                }

                // ── 返回上级 ──
                case 'back': {
                    const path = session.currentPath || [];
                    const parentCid = path.length >= 2
                        ? String(path[path.length - 2].cid)
                        : rootCid;
                    await showFolderBrowser(session, parentCid, 0);
                    break;
                }

                // ── 选定手动目录，返回确认页 ──
                case 'sel': {
                    session.manualCid = session.currentCid;
                    session.manualPath = buildDisplayPath(session.currentPath);
                    sessions.set(userId, session);
                    await showAutoConfirm(session);
                    break;
                }

                // ── 翻页 ──
                case 'next': {
                    const np = (session.currentPage || 0) + 1;
                    if (np < Math.ceil((session.currentFolders?.length || 0) / PAGE_SIZE)) {
                        session.currentPage = np;
                        sessions.set(userId, session);
                        const isAtRoot = session.currentCid === rootCid || session.currentCid === '0';
                        await safeEdit(session.chatId, session.botMessageId,
                            `📂 <b>选择转存目录</b>\n路径: <code>${escapeHtml(session.currentPath?.map(p => p.name).join(' > ') || '')}</code>`,
                            buildFolderKeyboard(session.currentFolders, np, isAtRoot));
                    }
                    break;
                }
                case 'prev': {
                    const pp = Math.max(0, (session.currentPage || 0) - 1);
                    session.currentPage = pp;
                    sessions.set(userId, session);
                    const isAtRoot = session.currentCid === rootCid || session.currentCid === '0';
                    await safeEdit(session.chatId, session.botMessageId,
                        `📂 <b>选择转存目录</b>\n路径: <code>${escapeHtml(session.currentPath?.map(p => p.name).join(' > ') || '')}</code>`,
                        buildFolderKeyboard(session.currentFolders, pp, isAtRoot));
                    break;
                }

                // ── 手动 TMDB ──
                case 'manual': {
                    await showTypeSelection(session);
                    break;
                }

                // ── 选媒体类型 ──
                case 'type': {
                    session.mediaType = arg;
                    session.step = 'tmdb_id';
                    sessions.set(userId, session);
                    const label = arg === 'movie' ? '🎬 电影' : '📺 剧集/动漫';
                    await safeEdit(session.chatId, session.botMessageId,
                        `${label} 请直接回复 TMDB ID（纯数字）：\n可在 https://www.themoviedb.org 搜索`);
                    break;
                }

                // ── 取消 ──
                case 'cancel': {
                    await safeEdit(session.chatId, session.botMessageId, '❌ 已取消操作');
                    sessions.delete(userId);
                    break;
                }

                case 'noop':
                default:
                    break;
            }
        } catch (e) {
            console.error(`[cb:${action}]`, e.message);
            await safeEdit(session.chatId, session.botMessageId,
                `❌ 操作失败: ${escapeHtml(e.message)}`).catch(() => {});
        }
    });

    // ──────────────────────────────────────────
    // 指令
    // ──────────────────────────────────────────
    bot.command('start', ctx => ctx.reply(
        '👋 <b>115转存机器人</b>\n\n' +
        '发送115分享链接，自动识别影视信息并分类转存。\n\n' +
        '链接格式: <code>https://115.com/s/XXXXX?password=XXXX</code>',
        { parse_mode: 'HTML' }
    ));

    return bot;
}

module.exports = { createBot };
