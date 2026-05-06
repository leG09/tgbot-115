const axios = require('axios');
const qs = require('querystring');
const https = require('https');

class Service115 {
    constructor() {
        this.agent = new https.Agent({ keepAlive: true });
        this.headers = {
            "Host": "webapi.115.com",
            "Connection": "keep-alive",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36 MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF XWEB/30626",
            "Referer": "https://servicewechat.com/wx2c744c010a61b0fa/94/page-frame.html",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept": "*/*"
        };
    }

    _getHeaders(cookie, host = "webapi.115.com") {
        return { ...this.headers, "Host": host, "Cookie": cookie };
    }

    async getUserInfo(cookie) {
        if (!cookie) throw new Error("Cookie为空");
        try {
            const res = await axios.get("https://webapi.115.com/files/index_info", {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent,
                timeout: 6000
            });
            if (res.data.state) {
                return { success: true, name: res.data.data?.user_name || "115用户" };
            }
            throw new Error("Cookie无效或已过期");
        } catch (e) {
            throw new Error("连接115失败: " + (e.response?.status || e.message));
        }
    }

    // 获取文件夹列表，返回子目录列表和当前路径面包屑
    async getFolderList(cookie, cid = "0", limit = 100) {
        try {
            const res = await axios.get("https://webapi.115.com/files", {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent,
                params: { aid: 1, cid: cid, o: "user_ptime", asc: 0, offset: 0, show_dir: 1, limit, type: 0, format: "json" }
            });
            if (res.data.state) {
                return {
                    success: true,
                    path: res.data.path || [],
                    list: (res.data.data || []).filter(item => item.cid).map(i => ({ cid: String(i.cid), name: i.n }))
                };
            }
            throw new Error(res.data.error || "获取目录失败");
        } catch (e) {
            throw new Error(e.message);
        }
    }

    async getFolderEntries(cookie, cid = "0", limit = 1000) {
        try {
            const res = await axios.get("https://webapi.115.com/files", {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent,
                params: { aid: 1, cid, o: "user_ptime", asc: 0, offset: 0, show_dir: 1, limit, type: 0, format: "json" }
            });
            if (!res.data.state) {
                throw new Error(res.data.error || "获取目录内容失败");
            }
            return {
                success: true,
                path: res.data.path || [],
                list: (res.data.data || []).map(item => ({
                    id: String(item.cid || item.fid),
                    cid: item.cid ? String(item.cid) : null,
                    fid: item.fid ? String(item.fid) : null,
                    name: item.n || '',
                    isFolder: Boolean(item.cid && !item.fid)
                }))
            };
        } catch (e) {
            throw new Error(e.message);
        }
    }

    async getAllFolders(cookie, cid = "0", pageSize = 1000) {
        const all = [];
        let offset = 0;
        let path = [];

        while (true) {
            const res = await axios.get("https://webapi.115.com/files", {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent,
                params: {
                    aid: 1,
                    cid,
                    o: "user_ptime",
                    asc: 0,
                    offset,
                    show_dir: 1,
                    limit: pageSize,
                    type: 0,
                    format: "json"
                }
            });

            if (!res.data.state) {
                throw new Error(res.data.error || "获取目录失败");
            }

            path = res.data.path || path;
            const page = (res.data.data || [])
                .filter(item => item.cid)
                .map(i => ({ cid: String(i.cid), name: i.n }));
            all.push(...page);

            const count = Number(res.data.count || 0);
            offset += page.length;
            if (page.length === 0 || offset >= count) {
                break;
            }
        }

        return {
            success: true,
            path,
            list: all
        };
    }

    async addFolder(cookie, parentCid, folderName) {
        const postData = qs.stringify({ pid: parentCid, cname: folderName });
        try {
            const res = await axios.post("https://webapi.115.com/files/add", postData, {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent
            });
            if (res.data.state) {
                return { success: true, cid: String(res.data.cid), name: res.data.file_name };
            }
            throw new Error(res.data.error || "创建文件夹失败");
        } catch (e) {
            throw new Error("创建文件夹失败: " + e.message);
        }
    }

    async getShareInfo(cookie, shareCode, receiveCode) {
        try {
            const res = await axios.get("https://webapi.115.com/share/snap", {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent,
                timeout: 10000,
                params: { share_code: shareCode, receive_code: receiveCode, offset: 0, limit: 100, cid: "" }
            });
            if (!res.data.state) {
                throw new Error(res.data.error || res.data.msg || "链接无效或提取码错误");
            }
            const items = (res.data.data.list || []).map(item => ({
                id: String(item.cid || item.fid),
                cid: item.cid ? String(item.cid) : null,
                fid: item.fid ? String(item.fid) : null,
                name: item.n || '',
                isFolder: Boolean(item.cid && !item.fid)
            }));
            const fileIds = items
                .map(item => item.id)
                .sort();
            return {
                success: true,
                fileIds,
                items,
                shareTitle: res.data.data.share_title || (res.data.data.list[0] ? res.data.data.list[0].n : "未命名"),
                count: res.data.data.count
            };
        } catch (e) {
            throw new Error(e.message);
        }
    }

    async saveFiles(cookie, targetCid, shareCode, receiveCode, fileIds) {
        if (!fileIds.length) return { success: true, count: 0 };
        const postData = qs.stringify({
            cid: targetCid,
            share_code: shareCode,
            receive_code: receiveCode,
            file_id: fileIds.join(',')
        });
        try {
            const res = await axios.post("https://webapi.115.com/share/receive", postData, {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent
            });
            if (res.data.state) return { success: true, count: fileIds.length };
            return { success: false, msg: res.data.error || res.data.msg || "转存被拒绝" };
        } catch (e) {
            return { success: false, msg: "转存请求失败: " + e.message };
        }
    }

    async renameFile(cookie, fileId, fileName) {
        const postData = qs.stringify({
            fid: fileId,
            file_name: fileName
        });
        try {
            const res = await axios.post("https://webapi.115.com/files/edit", postData, {
                headers: this._getHeaders(cookie),
                httpsAgent: this.agent
            });
            if (res.data.state) {
                return { success: true };
            }
            throw new Error(res.data.error || res.data.msg || "重命名失败");
        } catch (e) {
            throw new Error("重命名失败: " + e.message);
        }
    }

    async moveItems(cookie, ids, targetCid) {
        const list = Array.isArray(ids) ? ids.filter(Boolean) : [ids].filter(Boolean);
        if (list.length === 0) return { success: true, count: 0 };
        const postData = qs.stringify({
            ids: list.join(','),
            to_cid: targetCid
        });
        try {
            const res = await axios.post("https://proapi.115.com/android/files/move", postData, {
                headers: this._getHeaders(cookie, "proapi.115.com"),
                httpsAgent: this.agent
            });
            if (res.data?.state || res.data?.errNo === 0) {
                return { success: true, count: list.length, data: res.data };
            }
            throw new Error(res.data?.error || res.data?.msg || "移动失败");
        } catch (e) {
            throw new Error("移动失败: " + e.message);
        }
    }

    async deleteItems(cookie, ids) {
        const list = Array.isArray(ids) ? ids.filter(Boolean) : [ids].filter(Boolean);
        if (list.length === 0) return { success: true, count: 0 };
        const postData = qs.stringify({
            file_ids: list.join(',')
        });
        try {
            const res = await axios.post("https://proapi.115.com/android/rb/delete", postData, {
                headers: this._getHeaders(cookie, "proapi.115.com"),
                httpsAgent: this.agent
            });
            if (res.data?.state || res.data?.errNo === 0) {
                return { success: true, count: list.length, data: res.data };
            }
            throw new Error(res.data?.error || res.data?.msg || "删除失败");
        } catch (e) {
            throw new Error("删除失败: " + e.message);
        }
    }
}

module.exports = new Service115();
