/**
 * 会话状态管理（内存存储，重启后清空）
 *
 * session 结构:
 * {
 *   userId: number,
 *   chatId: number,
 *   botMessageId: number,      // bot 发出的消息 ID（用于 editMessage）
 *   shareCode: string,
 *   receiveCode: string,
 *   shareTitle: string,
 *   fileIds: string[],
 *   currentCid: string,        // 当前浏览目录 cid
 *   currentPath: Array<{cid,name}>,  // 从根到当前的路径面包屑
 *   currentFolders: Array<{cid,name}>,  // 当前目录下的子目录列表
 *   currentPage: number,       // 分页页码
 *   selectedCid: string|null,  // 用户选定的目标目录 cid
 *   selectedPath: string|null, // 目标目录对应的 115 显示路径
 *   tmdbInfo: object|null,
 *   mediaType: 'movie'|'tv'|null,
 *   step: 'loading'|'folder'|'tmdb_search'|'tmdb_confirm'|'tmdb_type'|'tmdb_id'|'awaiting_password'|'saving'|'done'
 * }
 */
class SessionStore {
    constructor(ttlMs = 15 * 60 * 1000) {
        this.store = new Map();
        this.ttl = ttlMs;
        setInterval(() => this._cleanup(), 5 * 60 * 1000);
    }

    set(userId, data) {
        this.store.set(String(userId), { ...data, _ts: Date.now() });
    }

    get(userId) {
        const item = this.store.get(String(userId));
        if (!item) return null;
        if (Date.now() - item._ts > this.ttl) {
            this.store.delete(String(userId));
            return null;
        }
        item._ts = Date.now();
        return item;
    }

    delete(userId) {
        this.store.delete(String(userId));
    }

    _cleanup() {
        const now = Date.now();
        for (const [key, item] of this.store) {
            if (now - item._ts > this.ttl) this.store.delete(key);
        }
    }
}

module.exports = new SessionStore();
