const axios = require('axios');
const service115 = require('./service115');
const { recognizeMedia } = require('./recognition');
const { matchCategory } = require('./category');
const yiyiMediaLibrary = require('./yiyiMediaLibrary');

const LINK_PATTERN = /https?:\/\/(?:115\.com|pan\.115\.com|115cdn\.com)\/s\/([a-z0-9]+)/i;
const PASSWORD_PATTERNS = [
    /[?&]password=([^\s&#]+)/i,
    /(?:提取码|访问码|密码|pass|code)[：:\s]*([a-z0-9]{4,8})/i
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractShare(text) {
    const value = String(text || '');
    const linkMatch = value.match(LINK_PATTERN);
    if (!linkMatch) return null;
    const receiveCode = PASSWORD_PATTERNS
        .map(pattern => value.match(pattern)?.[1])
        .find(Boolean) || '';
    return {
        shareCode: linkMatch[1],
        receiveCode
    };
}

function buildFolderName(tmdbInfo) {
    const year = tmdbInfo.year ? ` (${tmdbInfo.year})` : '';
    if (tmdbInfo.tmdbId) {
        return `${tmdbInfo.title}${year} [tmdbid-${tmdbInfo.tmdbId}]`;
    }
    return `${tmdbInfo.title}${year} [未验证]`;
}

function isSingleFolderShare(shareItems) {
    return Array.isArray(shareItems)
        && shareItems.length === 1
        && shareItems[0]?.isFolder;
}

function isAlreadySavedMessage(msg) {
    return /已转存|已经转存|无需转存|已保存|已经保存/.test(String(msg || ''));
}

async function findFolderByName(cookie, parentCid, folderName) {
    const { list } = await service115.getAllFolders(cookie, parentCid, 1000);
    return list.find(folder => folder.name === folderName) || null;
}

async function waitForSavedFolder(cookie, parentCid, beforeCids, expectedNames) {
    const uniqueNames = [...new Set(expectedNames.filter(Boolean))];
    for (let attempt = 0; attempt < 8; attempt++) {
        const { list } = await service115.getAllFolders(cookie, parentCid, 1000);
        const newFolder = list.find(folder => !beforeCids.has(String(folder.cid)));
        if (newFolder) return newFolder;

        const matchedByName = list.filter(folder => uniqueNames.includes(folder.name));
        if (matchedByName.length === 1) return matchedByName[0];

        if (attempt < 7) await sleep(1000);
    }
    return null;
}

async function resolveTargetParent(config, tmdbInfo) {
    const cookie = config.cookie115;
    const rootCid = config.rootCid || '0';
    const categoryName = tmdbInfo.verified ? (matchCategory(tmdbInfo, config.categoryRules) || null) : null;
    if (!categoryName) {
        return {
            parentCid: rootCid,
            parentDisplayPath: '',
            categoryName: null
        };
    }

    try {
        const res = await service115.addFolder(cookie, rootCid, categoryName);
        return {
            parentCid: res.cid,
            parentDisplayPath: categoryName,
            categoryName
        };
    } catch (e) {
        if (!e.message.includes('已存在')) {
            throw e;
        }
        const { list } = await service115.getFolderList(cookie, rootCid);
        const found = list.find(f => f.name === categoryName);
        if (!found) {
            throw new Error(`找不到分类目录: ${categoryName}`);
        }
        return {
            parentCid: found.cid,
            parentDisplayPath: categoryName,
            categoryName
        };
    }
}

async function saveShareIntoNewFolder(config, parentCid, folderName, shareInfo, share) {
    const cookie = config.cookie115;
    const singleFolderShare = isSingleFolderShare(shareInfo.items);
    const fileIds = shareInfo.fileIds;

    if (singleFolderShare) {
        const foldersBeforeSave = await service115.getAllFolders(cookie, parentCid, 1000);
        const beforeCids = new Set(foldersBeforeSave.list.map(folder => String(folder.cid)));
        const sourceFolderName = shareInfo.items[0].name || folderName;
        const saveResult = await service115.saveFiles(cookie, parentCid, share.shareCode, share.receiveCode, fileIds);
        if (!saveResult.success) {
            if (isAlreadySavedMessage(saveResult.msg)) {
                return {
                    alreadySaved: true,
                    folderName,
                    saveCount: 0,
                    message: saveResult.msg
                };
            }
            throw new Error(`转存失败: ${saveResult.msg}`);
        }

        const savedFolder = await waitForSavedFolder(cookie, parentCid, beforeCids, [sourceFolderName, folderName]);
        if (!savedFolder) {
            throw new Error('转存已完成，但无法定位新目录');
        }
        if (savedFolder.name !== folderName) {
            await service115.renameFile(cookie, savedFolder.cid, folderName);
        }
        return {
            folderCid: savedFolder.cid,
            folderName,
            saveCount: saveResult.count
        };
    }

    const tempFolder = await service115.addFolder(cookie, parentCid, folderName);
    const saveResult = await service115.saveFiles(cookie, tempFolder.cid, share.shareCode, share.receiveCode, fileIds);
    if (!saveResult.success) {
        if (isAlreadySavedMessage(saveResult.msg)) {
            await service115.deleteItems(cookie, tempFolder.cid).catch(() => {});
            return {
                alreadySaved: true,
                folderName,
                saveCount: 0,
                message: saveResult.msg
            };
        }
        throw new Error(`转存失败: ${saveResult.msg}`);
    }
    return {
        folderCid: tempFolder.cid,
        folderName,
        saveCount: saveResult.count
    };
}

async function callWebhook(config, folderName, parentDisplayPath) {
    const { url, replacePath, mountPath } = config.webhook || {};
    if (!url) return '';
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

    const res = await axios.post(url, payload, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
    });
    return typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
}

async function processShare(config, share, context = {}) {
    const cookie = config.cookie115;
    const shareInfo = await service115.getShareInfo(cookie, share.shareCode, share.receiveCode);
    const recognition = await recognizeMedia(shareInfo.shareTitle, config);
    const tmdbInfo = recognition.finalInfo;

    if (!tmdbInfo.tmdbId || tmdbInfo.verified === false) {
        return {
            status: 'skipped',
            reason: 'unverified_tmdb',
            shareTitle: shareInfo.shareTitle,
            tmdbInfo
        };
    }

    const libraryCheck = await yiyiMediaLibrary.findFilesByTmdb(config.yiyi, tmdbInfo);
    if (!libraryCheck.enabled) {
        return {
            status: 'skipped',
            reason: 'yiyi_disabled',
            message: libraryCheck.reason,
            shareTitle: shareInfo.shareTitle,
            tmdbInfo
        };
    }
    if (libraryCheck.exists) {
        return {
            status: 'skipped',
            reason: 'exists_in_yiyi',
            shareTitle: shareInfo.shareTitle,
            tmdbInfo,
            existingCount: libraryCheck.files.length
        };
    }

    const folderName = buildFolderName(tmdbInfo);
    const target = await resolveTargetParent(config, tmdbInfo);
    const existingFolder = await findFolderByName(cookie, target.parentCid, folderName);
    const savePath = target.parentDisplayPath ? `${target.parentDisplayPath}/${folderName}` : folderName;
    if (existingFolder) {
        return {
            status: 'skipped',
            reason: 'target_folder_exists',
            shareTitle: shareInfo.shareTitle,
            tmdbInfo,
            savePath
        };
    }

    const saveResult = await saveShareIntoNewFolder(config, target.parentCid, folderName, shareInfo, share);
    if (saveResult.alreadySaved) {
        return {
            status: 'skipped',
            reason: 'already_saved_by_115',
            message: saveResult.message,
            shareTitle: shareInfo.shareTitle,
            tmdbInfo,
            savePath
        };
    }

    const webhookNote = await callWebhook(config, saveResult.folderName, target.parentDisplayPath).catch(e => `Webhook 调用失败: ${e.message}`);
    return {
        status: 'saved',
        shareTitle: shareInfo.shareTitle,
        tmdbInfo,
        categoryName: target.categoryName,
        folderName: saveResult.folderName,
        savePath: target.parentDisplayPath ? `${target.parentDisplayPath}/${saveResult.folderName}` : saveResult.folderName,
        saveCount: saveResult.saveCount,
        webhookNote,
        context
    };
}

module.exports = {
    extractShare,
    processShare,
    buildFolderName
};
