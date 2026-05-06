const { Telegraf, Markup } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const service115 = require('./service115');
const tmdbService = require('./tmdb');
const { recognizeMedia } = require('./recognition');
const { matchCategory } = require('./category');
const sessions = require('./sessions');
const { logMergeSkip } = require('./logger');

const LINK_PATTERN = /https?:\/\/(?:115\.com|pan\.115\.com|115cdn\.com)\/s\/([a-z0-9]+)/i;
const PASSWORD_PATTERN = /[?&]password=([^\s&#]+)/i;
const PAGE_SIZE = 8;
const MAX_SAVE_COUNT = 20;
const MERGE_THROTTLE_MIN_MS = 100;
const MERGE_THROTTLE_MAX_MS = 300;

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
        if (tmdbInfo.tmdbId) {
            return `${tmdbInfo.title}${year} [tmdbid-${tmdbInfo.tmdbId}]`;
        }
        return `${tmdbInfo.title}${year} [未验证]`;
    }

    function buildRecognitionLabel(tmdbInfo) {
        if (tmdbInfo.aiGuess?.source === 'heuristic') {
            return '启发式识别';
        }
        if (tmdbInfo.aiGuess?.source === 'ai') {
            return 'AI识别';
        }
        return '识别结果';
    }

    function isAlreadySavedMessage(msg) {
        return /已转存|已经转存|无需转存|已保存|已经保存/.test(String(msg || ''));
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

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function throttleMergeOp() {
        const ms = MERGE_THROTTLE_MIN_MS + Math.floor(Math.random() * (MERGE_THROTTLE_MAX_MS - MERGE_THROTTLE_MIN_MS + 1));
        await sleep(ms);
    }

    async function waitForSavedFolder(parentCid, beforeCids, expectedNames) {
        const uniqueNames = [...new Set(expectedNames.filter(Boolean))];
        for (let attempt = 0; attempt < 8; attempt++) {
            const { list } = await service115.getAllFolders(cookie, parentCid, 1000);
            console.log('[save] waitForSavedFolder', JSON.stringify({
                attempt: attempt + 1,
                parentCid,
                folderCount: list.length,
                expectedNames: uniqueNames
            }));
            const newFolder = list.find(folder => !beforeCids.has(String(folder.cid)));
            if (newFolder) {
                console.log('[save] new folder detected by cid diff', JSON.stringify(newFolder));
                return newFolder;
            }

            const matchedByName = list.filter(folder => uniqueNames.includes(folder.name));
            if (matchedByName.length === 1) {
                console.log('[save] new folder detected by unique name', JSON.stringify(matchedByName[0]));
                return matchedByName[0];
            }

            if (attempt < 7) {
                await sleep(1000);
            }
        }
        console.log('[save] waitForSavedFolder timeout', JSON.stringify({
            parentCid,
            expectedNames: uniqueNames
        }));
        return null;
    }

    async function waitForFolderAbsent(parentCid, folderName) {
        for (let attempt = 0; attempt < 10; attempt++) {
            const existing = await findFolderByName(parentCid, folderName);
            if (!existing) return true;
            await sleep(1000);
        }
        return false;
    }

    function buildConflictKeyboard() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('A. 自动合并', '115:merge:auto')],
            [Markup.button.callback('B. 重命名合并', '115:merge:rename')],
            [Markup.button.callback('C. 覆盖', '115:merge:overwrite')],
            [Markup.button.callback('❌ 取消', '115:cancel')],
        ]);
    }

    function buildOverwriteConfirmKeyboard() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('⚠️ 确认覆盖', '115:merge_confirm:overwrite')],
            [Markup.button.callback('返回选项', '115:merge_back')],
            [Markup.button.callback('❌ 取消', '115:cancel')],
        ]);
    }

    async function resolveTargetParent(session) {
        if (session.manualCid !== undefined && session.manualCid !== null) {
            return {
                parentCid: session.manualCid,
                parentDisplayPath: session.manualPath || ''
            };
        }

        if (session.categoryName) {
            try {
                const res = await service115.addFolder(cookie, rootCid, session.categoryName);
                return {
                    parentCid: res.cid,
                    parentDisplayPath: session.categoryName
                };
            } catch (e) {
                if (!e.message.includes('已存在')) {
                    throw e;
                }
                const { list } = await service115.getFolderList(cookie, rootCid);
                const found = list.find(f => f.name === session.categoryName);
                if (!found) {
                    throw new Error(`找不到分类目录: ${session.categoryName}`);
                }
                return {
                    parentCid: found.cid,
                    parentDisplayPath: session.categoryName
                };
            }
        }

        return {
            parentCid: rootCid,
            parentDisplayPath: ''
        };
    }

    async function findFolderByName(parentCid, folderName) {
        const { list } = await service115.getAllFolders(cookie, parentCid, 1000);
        return list.find(folder => folder.name === folderName) || null;
    }

    async function showConflictResolution(session, parentDisplayPath, folderName) {
        const fullPath = parentDisplayPath ? `${parentDisplayPath}/${folderName}` : folderName;
        session.step = 'conflict';
        sessions.set(session.userId, session);
        await safeEdit(session.chatId, session.botMessageId, [
            `⚠️ 目标目录已存在`,
            `📂 <code>${escapeHtml(fullPath)}</code>`,
            '',
            `请选择处理方式：`,
            `A. 自动合并：并入已有目录，重名文件跳过`,
            `B. 重命名合并：旧目录临时改名，新目录导入后再合并`,
            `C. 覆盖：删除已有目录后重新转存`,
        ].join('\n'), buildConflictKeyboard());
    }

    async function ensureConflictStrategy(session, parentCid, parentDisplayPath, folderName) {
        const existingFolder = await findFolderByName(parentCid, folderName);
        if (!existingFolder) return { existingFolder: null, shouldPause: false };

        if (!session.mergeMode) {
            session.pendingConflict = {
                parentCid,
                parentDisplayPath,
                folderName,
                existingCid: existingFolder.cid
            };
            sessions.set(session.userId, session);
            await showConflictResolution(session, parentDisplayPath, folderName);
            return { existingFolder, shouldPause: true };
        }

        return { existingFolder, shouldPause: false };
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
        const verificationTag = tmdbInfo.verified === false
            ? ' ⚠️未验证'
            : (tmdbInfo.verificationStatus === 'tmdb_override' ? ' ⚠️TMDB已纠偏' : ' ✅已验证');
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
            `${typeStr} <b>${escapeHtml(tmdbInfo.title)}${year}</b>${rating}${verificationTag}${overview}`,
            '',
            dirLine,
            `📂 <code>${escapeHtml(savePath)}</code>`,
            tmdbInfo.tmdbId
                ? `🆔 tmdbid-${tmdbInfo.tmdbId}`
                : `🧠 ${buildRecognitionLabel(tmdbInfo)}: <code>${escapeHtml(tmdbInfo.aiGuess?.title || tmdbInfo.title)}</code>`,
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
            `🧠 正在识别影视信息...\n<code>${escapeHtml(session.shareTitle)}</code>`);

        try {
            const recognition = await recognizeMedia(session.shareTitle, config);
            const tmdbInfo = recognition.finalInfo;
            session.tmdbInfo = tmdbInfo;
            session.aiRecognition = recognition.aiResult;
            session.categoryName = tmdbInfo.verified ? (matchCategory(tmdbInfo, categoryRules) || null) : null;
            // 清除手动目录选择
            session.manualCid = undefined;
            session.manualPath = undefined;
            session.mergeMode = null;
            session.pendingConflict = null;
            sessions.set(session.userId, session);

            await showAutoConfirm(session);
        } catch (e) {
            await showTypeSelection(session, `⚠️ TMDB搜索异常: ${escapeHtml(e.message)}`);
        }
    }

    // ──────────────────────────────────────────
    // 执行转存 + Webhook
    // ──────────────────────────────────────────
    async function mergeFolderContents(sourceFolderCid, targetFolderCid, skipped, pathPrefix = '') {
        const [sourceRes, targetRes] = await Promise.all([
            service115.getFolderEntries(cookie, sourceFolderCid),
            service115.getFolderEntries(cookie, targetFolderCid)
        ]);
        const targetByName = new Map(targetRes.list.map(item => [item.name, item]));

        for (const sourceItem of sourceRes.list) {
            const currentPath = pathPrefix ? `${pathPrefix}/${sourceItem.name}` : sourceItem.name;
            const targetItem = targetByName.get(sourceItem.name);

            if (!targetItem) {
                await throttleMergeOp();
                await service115.moveItems(cookie, sourceItem.id, targetFolderCid);
                continue;
            }

            if (sourceItem.isFolder && targetItem.isFolder) {
                await mergeFolderContents(sourceItem.cid, targetItem.cid, skipped, currentPath);
                await throttleMergeOp();
                await service115.deleteItems(cookie, sourceItem.id).catch(() => {});
                continue;
            }

            skipped.push(currentPath);
            logMergeSkip({
                sourceFolderCid,
                targetFolderCid,
                skippedPath: currentPath
            });
            await throttleMergeOp();
            await service115.deleteItems(cookie, sourceItem.id).catch(() => {});
        }
    }

    async function saveShareIntoNewFolder(parentCid, folderName, singleFolderShare, shareItems, shareCode, receiveCode, fileIds) {
        let finalFolderName = folderName;
        let saveCount = 0;

        if (singleFolderShare) {
            const foldersBeforeSave = await service115.getAllFolders(cookie, parentCid, 1000);
            const beforeCids = new Set(foldersBeforeSave.list.map(folder => String(folder.cid)));
            const sourceFolderName = shareItems[0].name || folderName;
            const saveResult = await service115.saveFiles(cookie, parentCid, shareCode, receiveCode, fileIds);
            if (!saveResult.success) {
                if (isAlreadySavedMessage(saveResult.msg)) {
                    return {
                        alreadySaved: true,
                        folderCid: null,
                        folderName: finalFolderName,
                        saveCount: 0,
                        message: saveResult.msg
                    };
                }
                throw new Error(`转存失败: ${saveResult.msg}`);
            }
            saveCount = saveResult.count;

            const savedFolder = await waitForSavedFolder(parentCid, beforeCids, [sourceFolderName, folderName]);
            if (!savedFolder) {
                throw new Error('转存已完成，但无法定位新目录');
            }

            if (savedFolder.name !== folderName) {
                await service115.renameFile(cookie, savedFolder.cid, folderName);
            }

            return {
                folderCid: savedFolder.cid,
                folderName: finalFolderName,
                saveCount
            };
        }

        const tempFolder = await service115.addFolder(cookie, parentCid, folderName);
        const saveResult = await service115.saveFiles(cookie, tempFolder.cid, shareCode, receiveCode, fileIds);
        if (!saveResult.success) {
            if (isAlreadySavedMessage(saveResult.msg)) {
                await service115.deleteItems(cookie, tempFolder.cid).catch(() => {});
                return {
                    alreadySaved: true,
                    folderCid: null,
                    folderName,
                    saveCount: 0,
                    message: saveResult.msg
                };
            }
            throw new Error(`转存失败: ${saveResult.msg}`);
        }
        saveCount = saveResult.count;

        return {
            folderCid: tempFolder.cid,
            folderName,
            saveCount
        };
    }

    async function createUniqueTempName(parentCid, baseName) {
        const existing = await service115.getAllFolders(cookie, parentCid, 1000);
        const names = new Set(existing.list.map(folder => folder.name));
        for (let attempt = 0; attempt < 20; attempt++) {
            const suffix = attempt === 0
                ? `.__merge__${Date.now()}`
                : `.__merge__${Date.now()}_${attempt}`;
            const tempName = `${baseName}${suffix}`;
            if (!names.has(tempName)) {
                return tempName;
            }
        }
        throw new Error('生成临时目录名称失败');
    }

    async function createUniqueTempFolder(parentCid, baseName) {
        let attempt = 0;
        while (attempt < 5) {
            const tempName = await createUniqueTempName(parentCid, baseName);
            try {
                return await service115.addFolder(cookie, parentCid, tempName);
            } catch (e) {
                attempt += 1;
                if (attempt >= 5) throw e;
            }
        }
        throw new Error('创建临时目录失败');
    }

    async function handleExistingFolder(session, existingFolder, parentCid, folderName, singleFolderShare) {
        const skipped = [];

        if (session.mergeMode === 'overwrite') {
            await service115.deleteItems(cookie, existingFolder.cid);
            const deleted = await waitForFolderAbsent(parentCid, folderName);
            if (!deleted) {
                throw new Error('已有目录删除超时，请稍后重试');
            }
            return {
                ...await saveShareIntoNewFolder(parentCid, folderName, singleFolderShare, session.shareItems, session.shareCode, session.receiveCode, session.fileIds),
                skipped
            };
        }

        if (session.mergeMode === 'rename') {
            const tempExistingName = `${folderName}.__old__${Date.now()}`;
            await service115.renameFile(cookie, existingFolder.cid, tempExistingName);
            try {
                const imported = await saveShareIntoNewFolder(parentCid, folderName, singleFolderShare, session.shareItems, session.shareCode, session.receiveCode, session.fileIds);
                if (imported.alreadySaved) {
                    await service115.renameFile(cookie, existingFolder.cid, folderName).catch(() => {});
                    return {
                        folderCid: existingFolder.cid,
                        folderName,
                        saveCount: 0,
                        skipped,
                        noNewContent: true,
                        message: imported.message || '分享内容已转存过，无新增内容可合并'
                    };
                }
                // B模式固定采用“小目录并入大目录”：将新导入目录并入旧目录，再恢复旧目录原名
                await mergeFolderContents(imported.folderCid, existingFolder.cid, skipped);
                await throttleMergeOp();
                await service115.deleteItems(cookie, imported.folderCid).catch(() => {});
                await service115.renameFile(cookie, existingFolder.cid, folderName);

                return {
                    folderCid: existingFolder.cid,
                    folderName,
                    saveCount: imported.saveCount,
                    skipped
                };
            } catch (e) {
                await service115.renameFile(cookie, existingFolder.cid, folderName).catch(() => {});
                throw e;
            }
        }

        const tempFolderName = await createUniqueTempName(parentCid, folderName);
        const imported = singleFolderShare
            ? await saveShareIntoNewFolder(parentCid, tempFolderName, true, session.shareItems, session.shareCode, session.receiveCode, session.fileIds)
            : await (async () => {
                const tempFolder = await service115.addFolder(cookie, parentCid, tempFolderName);
                const saveResult = await service115.saveFiles(cookie, tempFolder.cid, session.shareCode, session.receiveCode, session.fileIds);
                if (!saveResult.success) {
                    if (isAlreadySavedMessage(saveResult.msg)) {
                        await service115.deleteItems(cookie, tempFolder.cid).catch(() => {});
                        return {
                            alreadySaved: true,
                            folderCid: null,
                            folderName: tempFolder.name,
                            saveCount: 0,
                            message: saveResult.msg
                        };
                    }
                    throw new Error(`转存失败: ${saveResult.msg}`);
                }
                return {
                    folderCid: tempFolder.cid,
                    folderName: tempFolder.name,
                    saveCount: saveResult.count
                };
            })();

        if (imported.alreadySaved) {
            return {
                folderCid: existingFolder.cid,
                folderName,
                saveCount: 0,
                skipped,
                noNewContent: true,
                message: imported.message || '分享内容已转存过，无新增内容可合并'
            };
        }

        await mergeFolderContents(imported.folderCid, existingFolder.cid, skipped);
        await service115.deleteItems(cookie, imported.folderCid).catch(() => {});

        return {
            folderCid: existingFolder.cid,
            folderName,
            saveCount: imported.saveCount,
            skipped
        };
    }

    async function doSaveAndWebhook(session) {
        if (session.saveInProgress) {
            console.log('[save] duplicate request ignored', JSON.stringify({
                userId: session.userId,
                shareCode: session.shareCode
            }));
            return;
        }
        session.saveInProgress = true;
        sessions.set(session.userId, session);

        const { tmdbInfo, shareCode, receiveCode, fileIds, shareItems, categoryName, manualCid, manualPath } = session;
        const folderName = buildFolderName(tmdbInfo);
        const singleFolderShare = isSingleFolderShare(shareItems);
        console.log('[save] start', JSON.stringify({
            shareCode,
            receiveCode: receiveCode ? '***' : '',
            fileIds,
            shareItems,
            folderName,
            categoryName,
            manualCid,
            manualPath,
            singleFolderShare
        }));

        await safeEdit(session.chatId, session.botMessageId,
            `⏳ 正在转存...\n📁 <code>${escapeHtml(folderName)}</code>`);

        let parentCid, parentDisplayPath;
        try {
            ({ parentCid, parentDisplayPath } = await resolveTargetParent(session));
        } catch (e) {
            session.saveInProgress = false;
            await safeEdit(session.chatId, session.botMessageId,
                `❌ 目标目录准备失败: ${escapeHtml(e.message)}`);
            sessions.delete(session.userId);
            return;
        }
        console.log('[save] target parent resolved', JSON.stringify({
            parentCid,
            parentDisplayPath
        }));

        let finalFolderName = folderName;
        let saveCount = 0;
        let skipped = [];
        let noNewContent = false;
        let noNewContentMessage = '';
        try {
            const conflict = await ensureConflictStrategy(session, parentCid, parentDisplayPath, folderName);
            if (conflict.shouldPause) {
                session.saveInProgress = false;
                sessions.set(session.userId, session);
                return;
            }

            const needsMergeCountLimit = conflict.existingFolder
                && (session.mergeMode === 'auto' || session.mergeMode === 'rename');
            if (needsMergeCountLimit && session.shareCount > MAX_SAVE_COUNT) {
                session.saveInProgress = false;
                await safeEdit(session.chatId, session.botMessageId, [
                    `❌ 该分享包含 <b>${session.shareCount}</b> 个文件，超过限制`,
                    `仅目录合并限制不超过 <b>${MAX_SAVE_COUNT}</b> 个文件；如需直接替换原目录，请选择 <b>覆盖</b>。`
                ].join('\n'));
                sessions.delete(session.userId);
                return;
            }

            if (conflict.existingFolder) {
                const result = await handleExistingFolder(session, conflict.existingFolder, parentCid, folderName, singleFolderShare);
                finalFolderName = result.folderName;
                saveCount = result.saveCount;
                skipped = result.skipped || [];
                noNewContent = Boolean(result.noNewContent);
                noNewContentMessage = result.message || '';
            } else {
                const result = await saveShareIntoNewFolder(parentCid, folderName, singleFolderShare, shareItems, shareCode, receiveCode, fileIds);
                if (result.alreadySaved) {
                    noNewContent = true;
                    noNewContentMessage = result.message || '';
                }
                finalFolderName = result.folderName;
                saveCount = result.saveCount;
            }
        } catch (e) {
            session.saveInProgress = false;
            await safeEdit(session.chatId, session.botMessageId,
                `❌ 转存失败: ${escapeHtml(e.message)}`);
            sessions.delete(session.userId);
            return;
        }

        const savePath = parentDisplayPath
            ? `${parentDisplayPath}/${finalFolderName}` : finalFolderName;
        console.log('[save] completed', JSON.stringify({
            savePath,
            saveCount
        }));

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
            noNewContent ? `✅ <b>无需重复转存</b>` : `✅ <b>转存成功！</b>`,
            `📂 <code>${escapeHtml(savePath)}</code>`,
            `📊 文件数量: ${saveCount}`,
            noNewContentMessage ? `ℹ️ ${escapeHtml(noNewContentMessage)}` : '',
            skipped.length ? `⏭️ 跳过重名项: ${skipped.length}` : '',
            tmdbInfo.verified === false ? `⚠️ 当前结果为 AI 识别，TMDB 未验证` : '',
            webhookNote,
        ].join('\n'));

        session.mergeMode = null;
        session.pendingConflict = null;
        session.saveInProgress = false;
        sessions.delete(session.userId);
    }

    async function callWebhook(folderName, parentDisplayPath) {
        const { url, replacePath, mountPath } = config.webhook || {};
        if (!url) return;
        const parts = [parentDisplayPath, folderName].filter(Boolean);
        let fullPath = parts.join('/').replace(/\/+/g, '/');
        if (fullPath && !fullPath.startsWith('/')) fullPath = '/' + fullPath;
        const payload = {
            data: [fullPath]
        };
        const effectiveReplacePath = replacePath ?? mountPath;
        if (effectiveReplacePath) {
            payload.replace_path = effectiveReplacePath;
        }

        console.log('[webhook] POST', url, JSON.stringify(payload));
        const res = await axios.post(url, payload, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
        });
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
            session.shareCount = Number(info.count || 0);
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
                shareCount: 0,
                currentCid: rootCid, currentPath: [], currentFolders: [], currentPage: 0,
                categoryName: null, manualCid: undefined, manualPath: undefined,
                tmdbInfo: null, mediaType: null,
                aiRecognition: null, mergeMode: null, pendingConflict: null, saveInProgress: false,
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
                session.tmdbInfo = {
                    ...info,
                    verified: true,
                    verificationStatus: 'manual_tmdb',
                    recognitionSource: 'manual_tmdb'
                };
                session.categoryName = matchCategory(info, categoryRules) || null;
                session.manualCid = undefined;
                session.manualPath = undefined;
                session.mergeMode = null;
                session.pendingConflict = null;
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

                case 'merge': {
                    session.mergeMode = arg;
                    sessions.set(userId, session);
                    if (arg === 'overwrite') {
                        const pending = session.pendingConflict || {};
                        const fullPath = pending.parentDisplayPath
                            ? `${pending.parentDisplayPath}/${pending.folderName}`
                            : pending.folderName;
                        await safeEdit(session.chatId, session.botMessageId, [
                            `⚠️ 覆盖将删除已有目录后重新转存`,
                            `📂 <code>${escapeHtml(fullPath || '')}</code>`,
                            `此操作不可撤销，请二次确认。`
                        ].join('\n'), buildOverwriteConfirmKeyboard());
                        break;
                    }
                    await doSaveAndWebhook(session);
                    break;
                }

                case 'merge_confirm': {
                    session.mergeMode = arg;
                    sessions.set(userId, session);
                    await doSaveAndWebhook(session);
                    break;
                }

                case 'merge_back': {
                    const pending = session.pendingConflict;
                    if (!pending) {
                        await showAutoConfirm(session);
                        break;
                    }
                    session.mergeMode = null;
                    sessions.set(userId, session);
                    await showConflictResolution(session, pending.parentDisplayPath, pending.folderName);
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
