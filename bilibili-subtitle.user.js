// ==UserScript==
// @name         B站字幕一键下载
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  B站视频页面自动注入字幕下载按钮 | 支持SRT/JSON格式
// @author       太子
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @connect      aisubtitle.hdslb.com
// @connect      www.bilibili.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // 等待页面加载完成
    function init() {
        // 找到播放器区域
        const player = document.querySelector('.bilibili-player-video-wrap') || 
                       document.querySelector('#bilibili-player') ||
                       document.querySelector('.player-container');
        
        if (!player) {
            setTimeout(init, 1000);
            return;
        }

        // 避免重复注入
        if (document.getElementById('subtitle-download-panel')) return;

        injectStyles();
        createPanel();
        attachListeners();
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #subtitle-download-panel {
                position: fixed;
                top: 80px;
                right: 20px;
                z-index: 99999;
                background: linear-gradient(135deg, #0d1117ee, #161b22ee);
                border: 1px solid rgba(0,212,255,0.3);
                border-radius: 12px;
                padding: 16px;
                width: 300px;
                font-family: -apple-system, 'PingFang SC', sans-serif;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                color: #c9d1d9;
            }
            #subtitle-download-panel h3 {
                font-size: 14px;
                color: #00d4ff;
                margin-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #subtitle-download-panel .status {
                font-size: 12px;
                color: #888;
                margin-bottom: 10px;
                padding: 8px;
                background: rgba(0,0,0,0.3);
                border-radius: 6px;
            }
            #subtitle-download-panel .btn-row {
                display: flex;
                gap: 6px;
                margin-top: 8px;
            }
            #subtitle-download-panel button {
                flex: 1;
                padding: 8px 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
                font-size: 12px;
                font-weight: bold;
                transition: transform 0.2s;
            }
            #subtitle-download-panel button:hover { transform: translateY(-1px); }
            .btn-fetch { background: linear-gradient(135deg, #00d4ff, #0099cc); color: #fff; }
            .btn-srt { background: linear-gradient(135deg, #ff6b9d, #c44569); color: #fff; }
            .btn-close { background: rgba(255,255,255,0.1); color: #888; }
            #subtitle-log {
                font-size: 11px;
                color: #555;
                margin-top: 8px;
                max-height: 80px;
                overflow-y: auto;
            }
            #subtitle-log .log-entry { margin-bottom: 3px; }
            #subtitle-log .ok { color: #00ff88; }
            #subtitle-log .err { color: #ff6b9d; }
        `;
        document.head.appendChild(style);
    }

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'subtitle-download-panel';
        panel.innerHTML = `
            <h3>🎬 B站字幕下载</h3>
            <div class="status" id="sub-status">⏳ 等待获取字幕信息...</div>
            <div class="btn-row">
                <button class="btn-fetch" id="btn-fetch">🔍 获取字幕</button>
                <button class="btn-srt" id="btn-srt" disabled>⬇️ 下载SRT</button>
                <button class="btn-close" id="btn-close">✕</button>
            </div>
            <div id="subtitle-log"></div>
        `;
        document.body.appendChild(panel);

        document.getElementById('btn-close').onclick = () => panel.remove();
    }

    function getBvid() {
        return window.__INITIAL_STATE__?.bvid || 
               location.pathname.match(/BV\w+/)?.[0] || 
               document.querySelector('[data-vue-file]')?.__vue__?.bvid ||
               null;
    }

    function log(msg, type='info') {
        const el = document.getElementById('subtitle-log');
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        el.appendChild(entry);
        el.scrollTop = el.scrollHeight;
    }

    function setStatus(msg) {
        document.getElementById('sub-status').textContent = msg;
    }

    function toSRT(body) {
        const fmt = (s) => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            const ms = Math.floor((s % 1) * 1000);
            return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')},${ms.toString().padStart(3,'0')}`;
        };
        return body.map((s, i) => `${i+1}\n${fmt(s.from)} --> ${fmt(s.to)}\n${s.content}`).join('\n\n');
    }

    let cachedData = null;

    function attachListeners() {
        document.getElementById('btn-fetch').onclick = fetchSubtitle;
        document.getElementById('btn-srt').onclick = downloadSRT;
    }

    async function fetchSubtitle() {
        const bvid = getBvid();
        if (!bvid) {
            setStatus('❌ 无法获取BV号');
            return;
        }

        setStatus(`🔍 正在获取 ${bvid} 的字幕...`);
        document.getElementById('btn-fetch').disabled = true;
        document.getElementById('btn-srt').disabled = true;
        log('开始获取字幕信息...');

        try {
            // 方法1: 从页面HTML提取字幕hash
            const htmlResp = await GM_fetch(location.href, 'text');
            const hashMatch = htmlResp.match(/aisubtitle\.hdslb\.com\/bfs\/ai_subtitle\/prod\/([^"?]+)/);
            
            if (hashMatch) {
                const hash = hashMatch[1];
                log(`找到字幕hash: ${hash.substring(0, 20)}...`, 'ok');
                await fetchSubtitleData(hash);
                return;
            }

            // 方法2: 从player API获取
            log('页面未找到，尝试player API...');
            const apiUrl = `https://api.bilibili.com/x/player/v2?aid=${bvid}`;
            const apiResp = await GM_fetch_json(apiUrl);
            
            if (apiResp?.data?.subtitle?.subtitles?.length > 0) {
                const subtitle = apiResp.data.subtitle.subtitles[0];
                log(`找到字幕: ${subtitle.lyric} / ${subtitle.sr_id}`, 'ok');
                // 获取字幕需要先访问播放页获取aid
                const aidResp = await GM_fetch_json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
                const aid = aidResp?.data?.aid;
                if (aid) {
                    const subtitleUrl = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/${subtitle.lyric}?aid=${aid}&raw=1`;
                    await fetchSubtitleData(subtitle.lyric, subtitleUrl);
                    return;
                }
            }

            setStatus('❌ 未找到字幕（视频可能没有字幕）');
            log('API和页面都未找到字幕', 'err');
        } catch(e) {
            setStatus('❌ 获取失败: ' + e.message);
            log('错误: ' + e.message, 'err');
        } finally {
            document.getElementById('btn-fetch').disabled = false;
        }
    }

    async function fetchSubtitleData(hash, directUrl) {
        try {
            const url = directUrl || `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${hash}?raw=1`;
            log(`请求字幕: ${url.substring(0, 60)}...`);
            
            const data = await GM_fetch_json(url);
            
            if (data && data.body && data.body.length > 0) {
                cachedData = data;
                const count = data.body.length;
                const lastTime = data.body[data.body.length - 1].to;
                const mins = Math.floor(lastTime / 60);
                setStatus(`✅ 找到 ${count} 条字幕 (${mins}分)`);
                document.getElementById('btn-srt').disabled = false;
                log(`成功! ${count}条字幕`, 'ok');
            } else {
                setStatus('❌ 字幕为空');
                log('字幕数据为空', 'err');
            }
        } catch(e) {
            setStatus('❌ 下载字幕失败');
            log('下载失败: ' + e.message, 'err');
        }
    }

    async function GM_fetch(url, responseType = 'text') {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
                responseType: responseType,
                onload: (r) => resolve(r.response),
                onerror: (e) => reject(new Error(e.error || '请求失败')),
                ontimeout: () => reject(new Error('请求超时'))
            });
        });
    }

    async function GM_fetch_json(url) {
        const text = await GM_fetch(url);
        return JSON.parse(text);
    }

    function downloadSRT() {
        if (!cachedData || !cachedData.body) {
            alert('请先获取字幕');
            return;
        }
        const bvid = getBvid() || 'subtitles';
        const srt = toSRT(cachedData.body);
        const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${bvid}.srt`;
        a.click();
        log('SRT文件已下载', 'ok');
    }

    // 启动
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
    setTimeout(init, 2000);
})();
