const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mp3Duration = require('mp3-duration');

// ── Single-instance guard ─────────────────────────────────────────────────────
// Kill ALL stale server instances so re-running the script always binds to 3000
// and never opens extra browser tabs.
const PID_FILE = path.join(__dirname, '.server.pid');
(function singleInstance() {
    // 1. Kill the known previous instance via PID file
    if (fs.existsSync(PID_FILE)) {
        const prev = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (prev && !isNaN(prev) && prev !== process.pid) {
            try { process.kill(prev, 'SIGTERM'); console.log(`🛑 Stopped previous instance (PID ${prev})`); }
            catch (_) {}
        }
        try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
    // 2. Also clear any stale processes on ports 3000-3004 (covers instances that
    //    predate the PID file, i.e. multiple tabs issue before v1.3.2).
    let killed = false;
    for (let p = 3000; p <= 3004; p++) {
        try {
            const pids = execSync(`lsof -ti tcp:${p} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
            for (const pid of pids.split('\n').filter(s => s && parseInt(s) !== process.pid)) {
                try { process.kill(parseInt(pid), 'SIGTERM'); console.log(`🛑 Cleared stale process on port ${p} (PID ${pid})`); killed = true; }
                catch (_) {}
            }
        } catch (_) {}
    }
    // 3. Brief pause so the OS can release the ports before we try to bind
    if (killed) { try { execSync('sleep 0.4'); } catch (_) {} }
    // 4. Write our own PID
    fs.writeFileSync(PID_FILE, String(process.pid));
    const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch (_) {} };
    process.on('exit', cleanup);
    process.on('SIGINT',  () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
})();
// ─────────────────────────────────────────────────────────────────────────────

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    });
}

// Uploaded files land in public/backgrounds/, public/overlays/, public/voiceovers/, public/sfx/, or public/brand/ depending on route
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dest = req.path === '/upload-overlay'
            ? './public/overlays/'
            : req.path === '/upload-scene-audio'
                ? './public/voiceovers/'
                : req.path === '/upload-scene-sfx'
                    ? './public/sfx/'
                    : req.path === '/upload-custom-music'
                        ? './public/music/'
                        : req.path === '/upload-brand-image'
                            ? './public/brand/'
                            : req.path === '/upload-overlay-video'
                                ? './public/overlay-videos/'
                                : './public/backgrounds/';
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        const fallbackExt = (req.path === '/upload-scene-audio' || req.path === '/upload-scene-sfx' || req.path === '/upload-custom-music') ? '.mp3' : '.mp4';
        const ext = path.extname(file.originalname) || fallbackExt;
        cb(null, `upload-${Date.now()}${ext}`);
    }
});
const upload = multer({ storage });
const CONTENT_PATH = './src/Content.json';
const SETTINGS_PATH = './src/VideoSettings.json';
const PROJECT_DRAFT_PATH = './src/ProjectDraft.json';
const SCENE_DRAFTS_PATH = './src/SceneDrafts.json';
const SCENE_DRAFT_LIBRARY_PATH = './src/SceneDraftLibrary.json';
const MEDIA_LIBRARY_PATH = './src/MediaLibrary.json';

function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonFile(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function mapSceneDraftIndices(mapper) {
    const current = readJsonFile(SCENE_DRAFTS_PATH, {});
    const next = {};
    Object.entries(current || {}).forEach(([key, value]) => {
        const mapped = mapper(Number(key), value);
        if (Number.isInteger(mapped) && mapped >= 0) {
            next[String(mapped)] = value;
        }
    });
    writeJsonFile(SCENE_DRAFTS_PATH, next);
}

function reorderSceneDraftIndices(fromIndex, toIndex) {
    const current = readJsonFile(SCENE_DRAFTS_PATH, {});
    const ordered = Object.keys(current)
        .map((key) => ({ index: Number(key), value: current[key] }))
        .filter((entry) => Number.isInteger(entry.index))
        .sort((a, b) => a.index - b.index);
    const fromPos = ordered.findIndex((entry) => entry.index === fromIndex);
    const toPos = ordered.findIndex((entry) => entry.index === toIndex);
    if (fromPos === -1 && toPos === -1) return;
    if (fromPos === -1 || toPos === -1) {
        mapSceneDraftIndices((index) => {
            if (fromIndex < toIndex) {
                if (index === fromIndex) return toIndex;
                if (index > fromIndex && index <= toIndex) return index - 1;
            } else if (fromIndex > toIndex) {
                if (index === fromIndex) return toIndex;
                if (index >= toIndex && index < fromIndex) return index + 1;
            }
            return index;
        });
        return;
    }
    const [moved] = ordered.splice(fromPos, 1);
    ordered.splice(toPos, 0, moved);
    const next = {};
    ordered.forEach((entry, idx) => {
        next[String(idx)] = entry.value;
    });
    writeJsonFile(SCENE_DRAFTS_PATH, next);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Disable timeouts for large file uploads (videos can be several GB)
server.headersTimeout = 0;
server.requestTimeout = 0;
server.timeout = 0;

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function normalizeSceneMedia(scene = {}) {
    if (!scene || typeof scene !== 'object') return scene;
    const nextScene = { ...scene };
    const sfxFile = nextScene.soundEffect?.file;
    if (sfxFile) {
        const sfxPath = path.join(__dirname, 'public', 'sfx', sfxFile);
        if (!fs.existsSync(sfxPath)) delete nextScene.soundEffect;
    }
    nextScene.backgroundMusicEnabled = nextScene.backgroundMusicEnabled !== false;
    if ('backgroundMusicVolume' in nextScene) {
        const bgmVolume = Number(nextScene.backgroundMusicVolume);
        nextScene.backgroundMusicVolume = Number.isFinite(bgmVolume)
            ? Math.max(0, Math.min(100, bgmVolume))
            : 100;
    } else {
        nextScene.backgroundMusicVolume = 100;
    }
    return nextScene;
}

// Log message translations used throughout the production pipeline.
const LOG = {
    en: {
        cancelled:        '⏹ Production cancelled.',
        script_info:      (n, jp, ct) => `📋 Script ${n}: ${jp ? '🇯🇵 Japanese mode' : '🇺🇸 English mode'} • Mode: ${ct === 'captions' ? '🎨 Captions Only' : '🎬 Stock Backgrounds'}`,
        parsing:          (captions) => `🔍 Parsing script${captions ? ' (captions only — skipping stock video fetch)' : ''}...`,
        parsed:           '✅ Script parsed into segments',
        applying_colors:  '🎨 Applying background colours...',
        assigned_colors:  (brand, n) => `✅ Assigned ${brand ? 'brand' : 'random'} colours to ${n} scene(s)`,
        gen_voice:        '🎙️ Generating voiceovers...',
        voice_ready:      '✅ Voiceovers ready',
        rendering:        '🎬 Rendering video (this takes a few minutes)...',
        done_status:      (f) => `✅ Done: renders/${f}`,
        saved:            (f) => `✅ Saved to renders/${f}`,
        error:            (msg) => `❌ Error: ${msg}`,
        batch_complete:   '🏁 Batch complete!',
        regen_voice:      '🎙️ Re-generating voiceovers...',
        rendering_only:   '🎬 Rendering...',
        saved_only:       (f) => `✅ Saved: renders/${f}`,
        warn_sfx:         (n, f) => `Scene ${n}: SFX file "${f}" not found — removed from render`,
        warn_voice:       (n, f) => `Scene ${n}: Voiceover file "${f}" not found — removed from render`,
    },
    ja: {
        cancelled:        '⏹ 制作がキャンセルされました。',
        script_info:      (n, jp, ct) => `📋 スクリプト ${n}: ${jp ? '🇯🇵 日本語モード' : '🇺🇸 英語モード'} • モード: ${ct === 'captions' ? '🎨 キャプションのみ' : '🎬 ストック背景'}`,
        parsing:          (captions) => `🔍 スクリプトを解析中${captions ? '（キャプションのみ — ストック動画取得をスキップ）' : ''}...`,
        parsed:           '✅ スクリプトをセグメントに分割しました',
        applying_colors:  '🎨 背景色を適用中...',
        assigned_colors:  (brand, n) => `✅ ${brand ? 'ブランドカラー' : 'ランダムカラー'}を${n}シーンに割り当てました`,
        gen_voice:        '🎙️ 音声を生成中...',
        voice_ready:      '✅ 音声の準備が完了しました',
        rendering:        '🎬 動画をレンダリング中（数分かかります）...',
        done_status:      (f) => `✅ 完了: renders/${f}`,
        saved:            (f) => `✅ renders/${f} に保存しました`,
        error:            (msg) => `❌ エラー: ${msg}`,
        batch_complete:   '🏁 バッチ処理が完了しました！',
        regen_voice:      '🎙️ 音声を再生成中...',
        rendering_only:   '🎬 レンダリング中...',
        saved_only:       (f) => `✅ 保存しました: renders/${f}`,
        warn_sfx:         (n, f) => `シーン${n}: 効果音ファイル「${f}」が見つかりません — レンダリングから除外します`,
        warn_voice:       (n, f) => `シーン${n}: 音声ファイル「${f}」が見つかりません — レンダリングから除外します`,
    },
};

// Delete background videos no longer referenced in any draft or content file.
function cleanupUnusedBackgrounds(logFn) {
    const bgDir = path.join(__dirname, 'public', 'backgrounds');
    if (!fs.existsSync(bgDir)) return;

    const draftFiles = [
        './src/Content.json',
        './src/SceneDraftLibrary.json',
        './src/SceneDrafts.json',
        './src/ProjectDraft.json',
    ];

    const referenced = new Set();
    for (const f of draftFiles) {
        try {
            const text = fs.readFileSync(f, 'utf8');
            const matches = text.match(/"[^"]*\.mp4"/g) || [];
            matches.forEach(m => referenced.add(m.replace(/"/g, '').replace(/^.*\//, '')));
        } catch { /* file missing — skip */ }
    }

    const files = fs.readdirSync(bgDir).filter(f => f.endsWith('.mp4'));
    let deleted = 0;
    for (const file of files) {
        if (!referenced.has(file)) {
            try {
                fs.unlinkSync(path.join(bgDir, file));
                deleted++;
            } catch { /* skip if locked */ }
        }
    }
    if (deleted > 0) logFn(`🧹 Cleaned up ${deleted} unused background video${deleted === 1 ? '' : 's'}`);
}

// Pre-render validation: strip any asset references whose files are missing from disk.
// Returns a list of warning strings (empty = all good).
function validateContentForRender(logFn, lang = 'en') {
    try {
        const segs = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        let changed = false;
        const warnings = [];
        segs.forEach((seg, idx) => {
            // SFX
            if (seg.soundEffect?.file) {
                const p = path.join(__dirname, 'public', 'sfx', seg.soundEffect.file);
                if (!fs.existsSync(p)) {
                    warnings.push((LOG[lang]||LOG.en).warn_sfx(idx + 1, seg.soundEffect.file));
                    delete seg.soundEffect;
                    changed = true;
                }
            }
            // Custom voiceover
            if (seg.voiceover_audio) {
                const p = path.join(__dirname, 'public', 'voiceovers', seg.voiceover_audio);
                if (!fs.existsSync(p)) {
                    warnings.push((LOG[lang]||LOG.en).warn_voice(idx + 1, seg.voiceover_audio));
                    delete seg.voiceover_audio;
                    changed = true;
                }
            }
        });
        if (changed) {
            writeJsonFile('./src/Content.json', segs);
            warnings.forEach(w => logFn && logFn('⚠️ ' + w));
        }
        return warnings;
    } catch (e) {
        return [];
    }
}

// Return current segments so the dashboard can show them
app.get('/segments', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    try {
        const rawSegments = readJsonFile(CONTENT_PATH, []);
        const segments = Array.isArray(rawSegments) ? rawSegments.map(normalizeSceneMedia) : [];
        res.json(segments);
    } catch { res.json([]); }
});

app.get('/draft-status', (req, res) => {
    const projectDraft = readJsonFile(PROJECT_DRAFT_PATH, null);
    const library = readJsonFile(SCENE_DRAFT_LIBRARY_PATH, {});
    const libraryList = Object.values(library)
        .map(d => ({ name: d.name, savedAt: d.savedAt }))
        .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    res.json({
        project: projectDraft ? { savedAt: projectDraft.savedAt || null } : null,
        library: libraryList,
    });
});

app.post('/save-project-draft', (req, res) => {
    try {
        const payload = {
            savedAt: new Date().toISOString(),
            settings: readSettings(),
            segments: readJsonFile(CONTENT_PATH, []),
        };
        writeJsonFile(PROJECT_DRAFT_PATH, payload);
        res.json({ ok: true, savedAt: payload.savedAt, sceneCount: payload.segments.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/load-project-draft', (req, res) => {
    try {
        const payload = readJsonFile(PROJECT_DRAFT_PATH, null);
        if (!payload) return res.status(404).json({ error: 'No project draft found.' });
        writeJsonFile(CONTENT_PATH, Array.isArray(payload.segments) ? payload.segments : []);
        if (payload.settings && typeof payload.settings === 'object') {
            writeJsonFile(SETTINGS_PATH, payload.settings);
        }
        res.json({ ok: true, savedAt: payload.savedAt || null, sceneCount: Array.isArray(payload.segments) ? payload.segments.length : 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Save a named scene draft to the persistent library (index-independent)
app.post('/save-scene-draft', (req, res) => {
    try {
        const { index, name } = req.body;
        const segments = readJsonFile(CONTENT_PATH, []);
        if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
            return res.status(400).json({ error: 'Invalid scene index.' });
        }
        const draftName = (typeof name === 'string' && name.trim()) ? name.trim() : null;
        if (!draftName) return res.status(400).json({ error: 'A name is required to save a scene draft.' });
        const savedAt = new Date().toISOString();
        const library = readJsonFile(SCENE_DRAFT_LIBRARY_PATH, {});
        library[draftName] = { name: draftName, savedAt, scene: segments[index] };
        writeJsonFile(SCENE_DRAFT_LIBRARY_PATH, library);
        res.json({ ok: true, savedAt, name: draftName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Load a named draft from the library into a scene slot
app.post('/load-scene-draft', (req, res) => {
    try {
        const { index, name } = req.body;
        if (!name) return res.status(400).json({ error: 'Draft name is required.' });
        const library = readJsonFile(SCENE_DRAFT_LIBRARY_PATH, {});
        const saved = library[name];
        if (!saved?.scene) return res.status(404).json({ error: `No draft named "${name}" found.` });
        const segments = readJsonFile(CONTENT_PATH, []);
        if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
            return res.status(400).json({ error: 'Invalid scene index.' });
        }
        segments[index] = saved.scene;
        writeJsonFile(CONTENT_PATH, segments);
        res.json({ ok: true, savedAt: saved.savedAt || null, name: saved.name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a named draft from the library
app.post('/delete-scene-draft', (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Draft name is required.' });
        const library = readJsonFile(SCENE_DRAFT_LIBRARY_PATH, {});
        if (!library[name]) return res.status(404).json({ error: `No draft named "${name}" found.` });
        delete library[name];
        writeJsonFile(SCENE_DRAFT_LIBRARY_PATH, library);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List all named drafts in the library (metadata only, no scene data)
app.get('/scene-draft-library', (req, res) => {
    try {
        const library = readJsonFile(SCENE_DRAFT_LIBRARY_PATH, {});
        const list = Object.values(library).map(d => ({ name: d.name, savedAt: d.savedAt }));
        list.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
        res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download a remote video to public/backgrounds/ and return the local filename
// Probe a local video file for its duration using ffprobe.
// Returns the duration in seconds (rounded to 2 dp), or null if ffprobe fails / is unavailable.
async function getVideoDuration(filepath) {
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            filepath,
        ], (err, stdout) => {
            if (err) { resolve(null); return; }
            try {
                const data = JSON.parse(stdout);
                const dur = parseFloat(data.format?.duration);
                resolve(Number.isFinite(dur) && dur > 0 ? Math.round(dur * 100) / 100 : null);
            } catch { resolve(null); }
        });
    });
}

// Probe a local video file for its display aspect ratio.
// Returns a number (width/height rounded to 3 dp) or null if unavailable.
async function getVideoAspectRatio(filepath) {
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-select_streams', 'v:0',
            filepath,
        ], (err, stdout) => {
            if (err) { resolve(null); return; }
            try {
                const data = JSON.parse(stdout);
                const stream = data.streams?.[0];
                if (!stream || !stream.width || !stream.height) { resolve(null); return; }
                resolve(Math.round((stream.width / stream.height) * 1000) / 1000);
            } catch { resolve(null); }
        });
    });
}

async function downloadVideo(url) {
    if (!fs.existsSync('./public/backgrounds')) fs.mkdirSync('./public/backgrounds', { recursive: true });
    const axios = require('axios');
    const filename = `pexels-${Date.now()}.mp4`;
    const dest = `./public/backgrounds/${filename}`;
    const response = await axios.get(url, { responseType: 'stream', timeout: 55000 });
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        // Abort if download stalls for more than 55 seconds
        const stall = setTimeout(() => {
            writer.destroy();
            reject(new Error('Video download timed out'));
        }, 55000);
        writer.on('finish', () => clearTimeout(stall));
        writer.on('error', () => clearTimeout(stall));
    });
    return filename;
}

// Replace the video for one segment by searching Pexels with a new query
app.post('/replace-video', async (req, res) => {
    const { index, query } = req.body;
    const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
    try {
        const axios = require('axios');
        const result = await axios.get(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`,
            { headers: { Authorization: PEXELS_API_KEY }, timeout: 15000 }
        );
        if (!result.data.videos?.length) return res.status(404).json({ error: 'No videos found' });
        const idx = result.data.videos.length > 1 ? 1 : 0;
        const chosen = result.data.videos[idx];
        const remoteUrl = chosen.video_files.sort((a, b) => b.width - a.width)[0].link;

        const filename = await downloadVideo(remoteUrl);
        const videoDuration = await getVideoDuration(`./public/backgrounds/${filename}`);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].background_url  = filename;
        segments[index].video_duration  = videoDuration;
        segments[index].background_type = 'video';
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ url: `/public/backgrounds/${filename}`, local: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Replace the background for one segment by fetching a specific Pexels video OR photo page URL
app.post('/replace-video-by-url', async (req, res) => {
    const { index, url } = req.body;
    const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
    try {
        const axios = require('axios');
        const videoMatch = url.match(/pexels\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/video\/[^/]*?-(\d+)\/?(?:[?#].*)?$/i);
        const photoMatch = url.match(/pexels\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/photo\/[^/]*?-(\d+)\/?(?:[?#].*)?$/i);

        if (videoMatch) {
            // ── Video URL ──────────────────────────────────────────────────────
            const videoId = videoMatch[1];
            const result = await axios.get(
                `https://api.pexels.com/videos/videos/${videoId}`,
                { headers: { Authorization: PEXELS_API_KEY }, timeout: 15000 }
            );
            const video = result.data;
            if (!video || !video.video_files || !video.video_files.length) {
                return res.status(404).json({ error: 'No video files found for this Pexels video.' });
            }
            const remoteUrl = video.video_files.sort((a, b) => b.width - a.width)[0].link;
            const filename = await downloadVideo(remoteUrl);
            const videoDuration = await getVideoDuration(`./public/backgrounds/${filename}`);
            const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
            segments[index].background_url  = filename;
            segments[index].video_duration  = videoDuration;
            segments[index].background_type = 'video';
            fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
            return res.json({ url: `/public/backgrounds/${filename}`, local: true, backgroundType: 'video' });

        } else if (photoMatch) {
            // ── Photo URL ─────────────────────────────────────────────────────
            const photoId = photoMatch[1];
            const result = await axios.get(
                `https://api.pexels.com/v1/photos/${photoId}`,
                { headers: { Authorization: PEXELS_API_KEY }, timeout: 15000 }
            );
            const photo = result.data;
            // Prefer portrait crop for 9:16, fall back to large/original
            const photoUrl = photo.src?.portrait || photo.src?.large2x || photo.src?.large || photo.src?.original;
            if (!photoUrl) return res.status(404).json({ error: 'No image found for this Pexels photo.' });

            const bgDir = './public/backgrounds';
            if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
            const filename = `pexels-photo-${Date.now()}.jpg`;
            const dest = `${bgDir}/${filename}`;
            const imgResponse = await axios.get(photoUrl, { responseType: 'stream', timeout: 30000 });
            await new Promise((resolve, reject) => {
                const writer = fs.createWriteStream(dest);
                imgResponse.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
            segments[index].background_url  = filename;
            segments[index].background_type = 'image';
            delete segments[index].video_duration;
            fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
            return res.json({ url: `/public/backgrounds/${filename}`, local: true, backgroundType: 'image' });

        } else {
            return res.status(400).json({ error: 'Could not extract an ID from the URL. Paste a Pexels video URL (pexels.com/video/…) or photo URL (pexels.com/photo/…).' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Search Pixabay for a video and download it
app.post('/replace-video-pixabay', async (req, res) => {
    const { index, query } = req.body;
    const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
    try {
        const axios = require('axios');
        const result = await axios.get(
            `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&per_page=5&video_type=film&order=popular`,
            { timeout: 15000 }
        );
        if (!result.data.hits?.length) return res.status(404).json({ error: 'No Pixabay videos found for that query' });
        const chosen = result.data.hits[0];
        // Prefer large (4K) → medium (1080p) → small → tiny
        const vids = chosen.videos;
        const remoteUrl = (vids.large?.url && vids.large.size > 0 ? vids.large.url :
                           vids.medium?.url ? vids.medium.url :
                           vids.small?.url  ? vids.small.url  : vids.tiny.url);
        const filename = await downloadVideo(remoteUrl);
        const videoDuration = await getVideoDuration(`./public/backgrounds/${filename}`);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].background_url  = filename;
        segments[index].video_duration  = videoDuration;
        segments[index].background_type = 'video';
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ url: `/public/backgrounds/${filename}`, local: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Fetch a specific Pixabay video by page URL and download it
// Supports URLs like: https://pixabay.com/videos/radio-tower-night-view-211067/
app.post('/replace-video-pixabay-url', async (req, res) => {
    const { index, url } = req.body;
    const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
    try {
        const axios = require('axios');
        // Extract the numeric ID from the end of the URL slug, e.g. "211067"
        const pageMatch = url.match(/pixabay\.com\/videos\/[^/]*?-(\d+)\/?$/);
        if (!pageMatch) {
            return res.status(400).json({ error: 'Could not extract a video ID from the URL. Make sure it is a Pixabay video page URL (e.g. https://pixabay.com/videos/radio-tower-night-view-211067/)' });
        }
        const videoId = pageMatch[1];
        const result = await axios.get(
            `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&id=${videoId}`,
            { timeout: 15000 }
        );
        if (!result.data.hits?.length) return res.status(404).json({ error: 'No Pixabay video found for that ID' });
        const chosen = result.data.hits[0];
        const vids = chosen.videos;
        const remoteUrl = (vids.large?.url && vids.large.size > 0 ? vids.large.url :
                           vids.medium?.url ? vids.medium.url :
                           vids.small?.url  ? vids.small.url  : vids.tiny.url);
        const filename = await downloadVideo(remoteUrl);
        const videoDuration = await getVideoDuration(`./public/backgrounds/${filename}`);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].background_url  = filename;
        segments[index].video_duration  = videoDuration;
        segments[index].background_type = 'video';
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ url: `/public/backgrounds/${filename}`, local: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Upload an overlay image with editable placement, crop, and fade settings
app.post('/upload-overlay', upload.single('image'), (req, res) => {
    try {
        const index = parseInt(req.body.index);
        const filename = req.file.filename;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        const existingList = Array.isArray(segments[index].overlayImages) && segments[index].overlayImages.length
            ? segments[index].overlayImages
            : (segments[index].overlayImage?.src ? [segments[index].overlayImage] : []);
        const existing = existingList[existingList.length - 1] || segments[index].overlayImage || {};
        const fallbackX = existing.x ?? ({ left: 18, center: 50, right: 82 }[existing.hPos || 'center'] ?? 50);
        const fallbackY = existing.y ?? ({ top: 18, center: 50, bottom: 82 }[existing.vPos || 'center'] ?? 50);
        const overlay = {
            src: `overlays/${filename}`,
            x: fallbackX,
            y: fallbackY,
            size: existing.size || 55,
            zOrder: existing.zOrder || 15,
            cropEnabled: !!existing.cropEnabled,
            cropScale: existing.cropScale || 1,
            cropX: existing.cropX || 50,
            cropY: existing.cropY || 50,
            rotation: existing.rotation || 0,
            aspectRatio: existing.aspectRatio || 1,
            animation: ['static', 'fade-in', 'fade-out', 'fade-both', 'fade', 'fader'].includes(existing.animation) ? (existing.animation === 'fade' ? 'fade-both' : existing.animation) : 'fade-both',
            fadeInDuration: existing.fadeInDuration || 1.5,
            fadeOutDuration: existing.fadeOutDuration || 1.5,
            faderDuration: Math.max(0.5, Math.min(10, Number(existing.faderDuration) || 1)),
            startAt: existing.startAt || 0,
            endAt: existing.endAt ?? null,
        };
        segments[index].overlayImages = [...existingList, overlay];
        segments[index].overlayImage = segments[index].overlayImages[0] || overlay;
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ src: overlay.src, overlay, previewUrl: `/public/overlays/${filename}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Upload a background image and assign it to a segment (with Ken Burns in Remotion)
app.post('/upload-image', upload.single('image'), (req, res) => {
    try {
        const index = parseInt(req.body.index);
        const filename = req.file.filename;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].background_url  = filename;
        segments[index].background_type = 'image';
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ filename, previewUrl: `/public/backgrounds/${filename}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Upload a local video file and assign it to a segment
app.post('/upload-video', upload.single('video'), async (req, res) => {
    try {
        const index = parseInt(req.body.index);
        const filename = req.file.filename; // e.g. "upload-1234567890.mp4"
        const videoDuration = await getVideoDuration(req.file.path);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        const isFirstVideo = !segments[index].background_url;
        segments[index].background_url  = filename; // stored as filename, Background.tsx picks it up from backgrounds/
        segments[index].video_duration  = videoDuration;
        segments[index].background_type = 'video';
        // Auto-set scene duration to video length on first upload to a new scene
        let durationUpdated = false;
        if (isFirstVideo && videoDuration) {
            segments[index].duration = videoDuration;
            durationUpdated = true;
        }
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ filename, previewUrl: `/public/backgrounds/${filename}`, videoDuration, durationUpdated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Upload a video file as a positioned overlay for a scene
app.post('/upload-overlay-video', upload.single('video'), async (req, res) => {
    try {
        const index = parseInt(req.body.index);
        if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });
        const filename = req.file.filename;
        const [videoDurationInSeconds, aspectRatio] = await Promise.all([
            getVideoDuration(req.file.path),
            getVideoAspectRatio(req.file.path),
        ]);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        const existing = Array.isArray(segments[index].overlayVideos) ? segments[index].overlayVideos : [];
        const newOv = {
            src: filename,
            x: 50,
            y: 50,
            size: 80,
            aspectRatio: aspectRatio ?? (16 / 9),
            rotation: 0,
            borderRadius: 0,
            zOrder: 20,
            volume: 0,
            playbackRate: 1,
            videoDurationInSeconds: videoDurationInSeconds ?? null,
            useAsBlurredBg: false,
        };
        segments[index].overlayVideos = [...existing, newOv];
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({
            filename,
            previewUrl: `/public/overlay-videos/${filename}`,
            videoDurationInSeconds,
            aspectRatio,
            overlayIndex: existing.length,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/upload-scene-audio', upload.single('audio'), async (req, res) => {
    try {
        const index = parseInt(req.body.index);
        if (!req.file) return res.status(400).json({ error: 'No MP3 file uploaded.' });
        if (path.extname(req.file.filename).toLowerCase() != '.mp3') {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Please upload an MP3 file for scene audio.' });
        }
        const duration = await mp3Duration(req.file.path);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].customAudioFile = req.file.filename;
        segments[index].audioFile = req.file.filename;
        segments[index].audioDuration = duration;
        segments[index].duration = duration;
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ filename: req.file.filename, previewUrl: `/public/voiceovers/${req.file.filename}`, duration });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/clear-scene-audio', (req, res) => {
    try {
        const index = parseInt(req.body.index);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        delete segments[index].customAudioFile;
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/upload-scene-sfx', upload.single('audio'), (req, res) => {
    try {
        const index = parseInt(req.body.index);
        if (!req.file) return res.status(400).json({ error: 'No sound effect file uploaded.' });
        const ext = path.extname(req.file.filename).toLowerCase();
        const allowed = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];
        if (!allowed.includes(ext)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Upload an audio file such as MP3, WAV, M4A, AAC, or OGG.' });
        }
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        const existing = segments[index].soundEffect || {};
        segments[index].soundEffect = {
            file: req.file.filename,
            startAt: existing.startAt ?? 0,
            volume: existing.volume ?? 1,
        };
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ filename: req.file.filename, previewUrl: `/public/sfx/${req.file.filename}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/clear-scene-sfx', (req, res) => {
    try {
        const index = parseInt(req.body.index);
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        delete segments[index].soundEffect;
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List videos available in public/stockvideo/
app.get('/stock-videos', (req, res) => {
    try {
        const dir = './public/stockvideo';
        if (!fs.existsSync(dir)) return res.json([]);
        const files = fs.readdirSync(dir).filter(f => /\.(mp4|mov|webm)$/i.test(f));
        res.json(files);
    } catch { res.json([]); }
});

app.get('/music-files', (req, res) => {
    try {
        const dir = './public/music';
        if (!fs.existsSync(dir)) return res.json([]);
        const files = fs.readdirSync(dir)
            .filter(f => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f))
            .sort((a, b) => a.localeCompare(b));
        res.json(files);
    } catch {
        res.json([]);
    }
});

app.post('/upload-custom-music', upload.single('audio'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No MP3 file uploaded.' });
        if (path.extname(req.file.filename).toLowerCase() !== '.mp3') {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Please upload an MP3 file for background music.' });
        }
        const settings = readSettings();
        const updated = {
            ...settings,
            backgroundMusicCustomFile: req.file.filename,
            backgroundMusicUseCustom: true,
            backgroundMusicRandom: false,
        };
        fs.writeFileSync('./src/VideoSettings.json', JSON.stringify(updated, null, 2));
        res.json({ filename: req.file.filename, previewUrl: `/public/music/${req.file.filename}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Assign a stock video to a segment
app.post('/use-stock-video', (req, res) => {
    try {
        const { index, filename } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].background_url = `stockvideo/${filename}`; // Background.tsx resolves via staticFile()
        segments[index].background_type = 'video';
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Read/write VideoSettings.json
function readSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch {
        return {
            voice: 'gtts',
            voicevoxSpeaker: 'ずんだもん',
            textStyle: 'box',
            glowColor: '#00ffff',
            glowSize: 1,
            font: 'noto',
            blockColor: '#ffdd00',
            textColor: '#000000',
            textStrokeColor: '#000000',
            textStrokeSize: 0,
            boxBorderRadius: 20,
            blockBorderRadius: 10,
            videoSizePreset: '9:16',
            outputWidth: 1080,
            outputHeight: 1920,
            backgroundMusicRandom: true,
            backgroundMusicFile: '',
            backgroundMusicUseCustom: false,
            backgroundMusicCustomFile: '',
        };
    }
}
function applyStylesToContent(settings) {
    try {
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments.forEach(seg => {
            seg.textStyle  = settings.textStyle  || 'box';
            seg.glowColor  = settings.glowColor  || '#00ffff';
            seg.glowSize   = settings.glowSize   ?? 1;
            seg.font       = settings.font       || 'noto';
            seg.blockColor = settings.blockColor || '#ffdd00';
            seg.textColor  = settings.textColor  || '#000000';
            seg.textStrokeColor = settings.textStrokeColor || '#000000';
            seg.textStrokeSize  = settings.textStrokeSize  ?? 0;
            seg.boxBorderRadius = settings.boxBorderRadius ?? 20;
            seg.blockBorderRadius = settings.blockBorderRadius ?? 10;
            delete seg.textStrokeColorOverride;
            delete seg.textStrokeSizeOverride;
            if (!seg.textAnimation) seg.textAnimation = 'pop';
        });
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
    } catch(e) { console.log('Could not apply styles to Content.json:', e.message); }
}

app.get('/settings', (req, res) => res.json(readSettings()));

app.post('/settings', (req, res) => {
    try {
        const updated = { ...readSettings(), ...req.body };
        writeJsonFile(SETTINGS_PATH, updated);
        applyStylesToContent(updated);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Proxy to VOICEVOX speakers list
app.get('/voicevox-speakers', async (req, res) => {
    try {
        const axios = require('axios');
        const { data } = await axios.get('http://localhost:50021/speakers');
        // Return flat list: [{ name, styleName, id }]
        const flat = data.flatMap(s => s.styles.map(style => ({
            speaker: s.name, style: style.name, id: style.id
        })));
        res.json(flat);
    } catch(e) {
        res.status(503).json({ error: 'VOICEVOX not running at localhost:50021' });
    }
});

function normalizePreviewText(text = '') {
    return String(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function shouldUseVoicevox(settings = {}, voiceSettings = {}) {
    return settings.voice === 'voicevox' || !!String(voiceSettings.voicevoxSpeaker || '').trim();
}

function contentUsesVoicevox(segments = [], settings = {}) {
    return settings.voice === 'voicevox' || segments.some(seg => String(seg.voicevoxSpeaker || '').trim());
}

function buildShortPreviewText(text = '') {
    const normalized = normalizePreviewText(text);
    const firstLine = normalized.split('\n').map(line => line.trim()).find(Boolean) || normalized;
    if (!firstLine) return '';
    return firstLine.length > 60 ? `${firstLine.slice(0, 60).trim()}…` : firstLine;
}

async function getVoicevoxPreviewSpeakerId(speakerName) {
    const axios = require('axios');
    const { data: speakers } = await axios.get('http://localhost:50021/speakers');
    for (const speaker of speakers) {
        if (speaker.name === speakerName) return speaker.styles[0].id;
    }
    for (const speaker of speakers) {
        if (speaker.name.includes(speakerName) || speakerName.includes(speaker.name)) return speaker.styles[0].id;
    }
    throw new Error(`VOICEVOX speaker not found: ${speakerName}`);
}

async function synthesizeVoicePreview(text, settings, voiceSettings, outputPath) {
    if (shouldUseVoicevox(settings, voiceSettings)) {
        const axios = require('axios');
        const speakerName = voiceSettings.voicevoxSpeaker || settings.voicevoxSpeaker || 'ずんだもん';
        const speakerId = await getVoicevoxPreviewSpeakerId(speakerName);
        const { data: query } = await axios.post(
            `http://localhost:50021/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
            {},
            { headers: { 'Content-Type': 'application/json' } }
        );
        if (voiceSettings.voiceSpeed != null) query.speedScale = Number(voiceSettings.voiceSpeed);
        if (voiceSettings.voicePitch != null) query.pitchScale = Number(voiceSettings.voicePitch);
        if (voiceSettings.voiceVolume != null) query.volumeScale = Number(voiceSettings.voiceVolume);
        const { data: audio } = await axios.post(
            `http://localhost:50021/synthesis?speaker=${speakerId}`,
            query,
            { headers: { 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
        );
        fs.writeFileSync(outputPath, Buffer.from(audio));
        return { approximate: false };
    }

    const gTTS = require('gtts');
    const lang = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text) ? 'ja' : 'en';
    await new Promise((resolve, reject) => {
        const gtts = new gTTS(text, lang);
        gtts.save(outputPath, (err) => err ? reject(err) : resolve());
    });
    return { approximate: true };
}

app.post('/preview-voice', async (req, res) => {
    try {
        const { text, mode, voiceSpeed, voicePitch, voiceVolume, voicevoxSpeaker } = req.body;
        const fullText = normalizePreviewText(text);
        const previewText = mode === 'short' ? buildShortPreviewText(fullText) : fullText;
        if (!previewText) return res.status(400).json({ error: 'Add some voice text first.' });

        const previewDir = path.join(__dirname, 'public', 'voice-previews');
        if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

        const settings = readSettings();
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const useVoicevox = shouldUseVoicevox(settings, { voicevoxSpeaker });
        const ext = useVoicevox ? 'wav' : 'mp3';
        const filename = `preview-${stamp}.${ext}`;
        const outputPath = path.join(previewDir, filename);

        const result = await synthesizeVoicePreview(previewText, settings, {
            voiceSpeed,
            voicePitch,
            voiceVolume,
            voicevoxSpeaker,
        }, outputPath);

        res.json({ ok: true, url: `/public/voice-previews/${filename}`, approximate: result.approximate });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add a new blank scene (optionally at a specific position)
app.post('/add-scene', (req, res) => {
    try {
        const { afterIndex, text, voiceover_text, resetAll, backgroundMusicEnabled } = req.body;
        const settings = readSettings();
        const segments = resetAll ? [] : JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        const newScene = {
            text: text !== undefined ? text : 'New Scene',
            voiceover_text: voiceover_text !== undefined ? voiceover_text : '',
            background_url: '',
            background_type: 'video',
            duration: 5,
            textStyle: settings.textStyle || 'box',
            textAnimation: 'pop',
            textFadeInDuration: 1.5,
            textFadeOutDuration: 1.5,
            glowColor:  settings.glowColor  || '#00ffff',
            glowSize:   settings.glowSize   ?? 1,
            font:       settings.font       || 'noto',
            blockColor: settings.blockColor || '#ffdd00',
            textColor:  settings.textColor  || '#000000',
            textStrokeColor: settings.textStrokeColor || '#000000',
            textStrokeSize:  settings.textStrokeSize  ?? 0,
            boxBorderRadius: settings.boxBorderRadius ?? 20,
            blockBorderRadius: settings.blockBorderRadius ?? 10,
            sceneFadeInDuration: 1.5,
            sceneFadeOutDuration: 1.5,
            textNoWrap: true,
            backgroundMusicEnabled: backgroundMusicEnabled !== false,
        };
        const insertAt = (afterIndex !== undefined && afterIndex >= 0) ? afterIndex + 1 : segments.length;
        segments.splice(insertAt, 0, newScene);
        mapSceneDraftIndices((index) => index >= insertAt ? index + 1 : index);
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true, index: insertAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Duplicate a scene (deep copy inserted immediately after the original)
app.post('/duplicate-scene', (req, res) => {
    try {
        const { index } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
            return res.status(400).json({ error: 'Invalid scene index.' });
        }
        const copy = JSON.parse(JSON.stringify(segments[index]));
        const insertAt = index + 1;
        segments.splice(insertAt, 0, copy);
        mapSceneDraftIndices((idx) => idx >= insertAt ? idx + 1 : idx);
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true, index: insertAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a scene by index
app.post('/delete-scene', (req, res) => {
    try {
        const { index } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        if (index < 0 || index >= segments.length) return res.status(400).json({ error: 'Invalid index' });
        segments.splice(index, 1);
        mapSceneDraftIndices((draftIndex) => {
            if (draftIndex === index) return null;
            return draftIndex > index ? draftIndex - 1 : draftIndex;
        });
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/move-scene', (req, res) => {
    try {
        const { index, direction } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
            return res.status(400).json({ error: 'Invalid scene index.' });
        }
        const targetIndex = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : index;
        if (targetIndex < 0 || targetIndex >= segments.length) {
            return res.status(400).json({ error: `This scene cannot move ${direction}.` });
        }
        const [scene] = segments.splice(index, 1);
        segments.splice(targetIndex, 0, scene);
        reorderSceneDraftIndices(index, targetIndex);
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true, index: targetIndex });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reorder a scene from one index to another (drag-and-drop)
app.post('/reorder-scene', (req, res) => {
    try {
        const { fromIndex, toIndex } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= segments.length) {
            return res.status(400).json({ error: 'Invalid fromIndex.' });
        }
        if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= segments.length) {
            return res.status(400).json({ error: 'Invalid toIndex.' });
        }
        if (fromIndex === toIndex) return res.json({ ok: true });
        const [scene] = segments.splice(fromIndex, 1);
        segments.splice(toIndex, 0, scene);
        reorderSceneDraftIndices(fromIndex, toIndex);
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update text position, style override, extra text layers, shapes, and color overrides for a segment
app.post('/update-scene-texts', (req, res) => {
    try {
        const {
            index, text, textPosition, textHPosition, textAlign, textAnimation, textFadeInDuration, textFadeOutDuration, extraTexts, mainTextStyleOverride,
            overlayImage, overlayImages, overlayShapes, overlayVideos, voiceover_text, voiceoverRichText, voiceEmphasis, voicevoxSpeaker,
            mainTextStartAt, mainTextEndAt,
            sceneAnimation, soundEffect, sceneFadeInDuration, sceneFadeOutDuration,
            backgroundMusicEnabled, backgroundMusicVolume, textNoWrap, textBoxWidth, textPadding,
        } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        if (text                  !== undefined) segments[index].text                  = text;
        if (textPosition          !== undefined) segments[index].textPosition          = textPosition;
        if (textHPosition         !== undefined) segments[index].textHPosition         = textHPosition;
        if (textAlign             !== undefined) segments[index].textAlign             = textAlign;
        if (textAnimation         !== undefined) segments[index].textAnimation         = textAnimation;
        if (textFadeInDuration    !== undefined) segments[index].textFadeInDuration    = textFadeInDuration;
        if (textFadeOutDuration   !== undefined) segments[index].textFadeOutDuration   = textFadeOutDuration;
        if (extraTexts            !== undefined) segments[index].extraTexts            = extraTexts;
        if (mainTextStyleOverride !== undefined) segments[index].mainTextStyleOverride = mainTextStyleOverride;
        if (overlayImages         !== undefined) {
            segments[index].overlayImages = Array.isArray(overlayImages) ? overlayImages : [];
            segments[index].overlayImage = overlayImage !== undefined ? overlayImage : (segments[index].overlayImages[0] || null);
        } else if (overlayImage   !== undefined) {
            segments[index].overlayImage = overlayImage;
            segments[index].overlayImages = overlayImage?.src ? [overlayImage] : [];
        }
        if (overlayShapes         !== undefined) segments[index].overlayShapes         = overlayShapes;
        if (overlayVideos         !== undefined) segments[index].overlayVideos         = Array.isArray(overlayVideos) ? overlayVideos : [];
        if (sceneAnimation        !== undefined) segments[index].sceneAnimation        = sceneAnimation;
        if (sceneFadeInDuration   !== undefined) segments[index].sceneFadeInDuration   = sceneFadeInDuration;
        if (sceneFadeOutDuration  !== undefined) segments[index].sceneFadeOutDuration  = sceneFadeOutDuration;
        if (backgroundMusicEnabled !== undefined) segments[index].backgroundMusicEnabled = backgroundMusicEnabled !== false;
        if (backgroundMusicVolume  !== undefined) {
            const bgmVolume = Number(backgroundMusicVolume);
            segments[index].backgroundMusicVolume = Number.isFinite(bgmVolume)
                ? Math.max(0, Math.min(100, bgmVolume))
                : 100;
        }
        if (soundEffect           !== undefined) {
            if (soundEffect && soundEffect.file) segments[index].soundEffect = soundEffect;
            else delete segments[index].soundEffect;
        }
        if (textNoWrap             !== undefined) segments[index].textNoWrap             = textNoWrap === true;
        if (textPadding !== undefined) {
            const p = Number(textPadding);
            if (textPadding === null) delete segments[index].textPadding;
            else if (Number.isFinite(p) && p >= 0 && p <= 200) segments[index].textPadding = p;
        }
        if (textBoxWidth            !== undefined) {
            const w = Number(textBoxWidth);
            if (textBoxWidth === null) delete segments[index].textBoxWidth;
            else if (Number.isFinite(w) && w > 0 && w <= 200) segments[index].textBoxWidth = w;
        }
        if (voiceover_text        !== undefined) segments[index].voiceover_text        = voiceover_text;
        if (voiceoverRichText     !== undefined) segments[index].voiceoverRichText     = voiceoverRichText;
        if (voiceEmphasis         !== undefined) segments[index].voiceEmphasis         = voiceEmphasis;
        if (voicevoxSpeaker       !== undefined) segments[index].voicevoxSpeaker       = voicevoxSpeaker;
        // Nullable fields: null = delete (revert to default), number/string = set
        const nullableFields = [
             'textX', 'textY', 'backgroundBlur',
            'rotation', 'fontSize',
            'blockColorOverride', 'textColorOverride', 'textStrokeColorOverride', 'textStrokeSizeOverride', 'glowColorOverride', 'glowTextColorOverride', 'glowSizeOverride',
            'boxBorderRadius', 'blockBorderRadius',
            'mainTextStartAt', 'mainTextEndAt',
            'voiceSpeed', 'voicePitch', 'voiceVolume',
            'backgroundScale', 'backgroundX', 'backgroundY', 'kenBurns',
            'videoSpeed', 'overlayType', 'overlayOpacity', 'spotlightRadius', 'spotlightSoftness', 'videoAudioVolume', 'videoFit',
            'clipStart', 'clipEnd',
        ];
        nullableFields.forEach(f => {
            if (f in req.body) {
                if (req.body[f] === null) delete segments[index][f];
                else segments[index][f] = req.body[f];
            }
        });
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update only the duration of a scene (used by global timeline drag-resize)
app.post('/update-scene-duration', (req, res) => {
    try {
        const { index, duration } = req.body;
        const d = parseFloat(duration);
        if (!Number.isFinite(d) || d < 0.1) return res.status(400).json({ error: 'Invalid duration' });
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        if (!segments[index]) return res.status(404).json({ error: 'Scene not found' });
        segments[index].duration = Math.round(d * 10) / 10;
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set a static colour or gradient background on a segment
app.post('/set-background-style', (req, res) => {
    try {
        const { index, type, color, gradientStart, gradientEnd, gradientDirection } = req.body;
        const segments = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
        segments[index].background_type = type; // 'color' | 'gradient' | 'video'
        if (type === 'color') {
            segments[index].background_color = color;
            segments[index].background_url = '';
        } else if (type === 'gradient') {
            segments[index].gradient_start     = gradientStart;
            segments[index].gradient_end       = gradientEnd;
            segments[index].gradient_direction = gradientDirection || 'to bottom';
            segments[index].background_url = '';
        }
        // type === 'video' or 'image': leave background_url untouched
        fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detect Japanese text (hiragana, katakana, kanji)
function isJapanese(text) {
    return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text);
}

io.on('connection', (socket) => {
    socket.on('start-batch', async (data) => {
        const scripts = data.scripts.filter(s => s.trim() !== "").slice(0, 2);
        const contentType = data.contentType || 'stock'; // 'stock' | 'captions'
        const lang = data.lang || 'en';
        const L = LOG[lang] || LOG.en;

        // ── Cancellation support ──────────────────────────────────────────
        let cancelled = false;
        let activeProc = null;

        const cancelHandler = () => {
            cancelled = true;
            if (activeProc) {
                try { activeProc.kill('SIGTERM'); } catch (_) {}
                activeProc = null;
            }
            socket.emit('log', L.cancelled);
            socket.emit('batch-cancelled');
        };
        socket.once('cancel-batch', cancelHandler);

        // Helper: spawn a process, stream its output, reject on non-zero exit
        const runProc = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
            if (cancelled) return reject(new Error('cancelled'));
            const proc = spawn(cmd, args, opts);
            activeProc = proc;
            const fwd = d => d.toString().split('\n').filter(l => l.trim()).forEach(l => socket.emit('log', l));
            proc.stdout?.on('data', fwd);
            proc.stderr?.on('data', fwd);
            proc.on('close', code => {
                activeProc = null;
                if (cancelled) return reject(new Error('cancelled'));
                code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`));
            });
        });
        // ─────────────────────────────────────────────────────────────────

        // Palette of visually distinct dark/rich colours for captions-only random mode
        const RANDOM_PALETTE = [
            '#0f172a','#1e1b4b','#1a0533','#0c1a2e','#0f2027','#1a1a2e',
            '#0d0d0d','#1e3a5f','#2d1b69','#0a2342','#1a0a2e','#0f3460',
            '#16213e','#1b1b2f','#2c003e','#0d1b2a','#1a2744','#0a1628'
        ];

        for (let i = 0; i < scripts.length; i++) {
            if (cancelled) break;
            try {
                const script = scripts[i];
                const japanese = isJapanese(script);

                socket.emit('log', L.script_info(i + 1, japanese, contentType));

                fs.writeFileSync('temp_input.txt', script);

                // Step 1: Parse script → Content.json
                const parserScript = contentType === 'captions' ? 'parser-captions.js' : 'parser.js';
                socket.emit('log', L.parsing(contentType === 'captions'));
                await runProc('node', [parserScript]);
                if (cancelled) break;
                socket.emit('log', L.parsed);

                // For captions-only: assign brand or random colours to each scene
                if (contentType === 'captions') {
                    socket.emit('log', L.applying_colors);
                    const segments = readJsonFile(CONTENT_PATH, []);
                    const mediaLib = readMediaLibrary();
                    const brandColors = (mediaLib.brandColors || []).map(c => c.color).filter(Boolean);
                    const palette = brandColors.length > 0 ? brandColors : RANDOM_PALETTE;
                    let paletteIndex = Math.floor(Math.random() * palette.length);
                    segments.forEach((seg) => {
                        const color = palette[paletteIndex % palette.length];
                        paletteIndex++;
                        seg.background_url = '';
                        seg.background_type = 'color';
                        seg.background_color = color;
                    });
                    writeJsonFile(CONTENT_PATH, segments);
                    socket.emit('log', L.assigned_colors(brandColors.length > 0, segments.length));
                }

                // Step 1b: Apply current style settings to all parsed segments
                applyStylesToContent(readSettings());

                // Step 2: Generate voiceovers
                socket.emit('log', L.gen_voice);
                const voiceSettings = readSettings();
                const segmentsForVoice = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
                const audioScriptName = contentUsesVoicevox(segmentsForVoice, voiceSettings)
                    ? 'generate-audio-voicevox.js'
                    : japanese ? 'generate-audio-ja.js' : 'generate-audio.js';
                await runProc('node', [audioScriptName]);
                if (cancelled) break;
                socket.emit('log', L.voice_ready);

                // Step 3: Render video
                const title = fs.readFileSync('temp_title.txt', 'utf8').trim();
                const finalName = `${title}_${Date.now()}.mp4`;

                validateContentForRender(msg => socket.emit('log', msg), lang);
                socket.emit('log', L.rendering);
                await runProc('npx', ['remotion', 'render', 'src/index.ts', '1', '--force', '--concurrency=1'], { shell: true });
                if (cancelled) break;

                if (!fs.existsSync('renders')) fs.mkdirSync('renders');
                fs.renameSync('out/1.mp4', `renders/${finalName}`);
                cleanupUnusedBackgrounds(msg => socket.emit('log', msg));
                socket.emit('status', { msg: L.done_status(finalName), progress: ((i + 1) / scripts.length) * 100 });
                socket.emit('log', L.saved(finalName));

            } catch (err) {
                if (err.message === 'cancelled') break;
                socket.emit('log', L.error(err.message));
            }
        }

        socket.off('cancel-batch', cancelHandler);
        if (!cancelled) {
            socket.emit('status', { msg: L.batch_complete, progress: 100 });
        }
    });

    // ── Render-only cancellation support ─────────────────────────
    let _renderOnlyAudioProc = null;
    let _renderOnlyVideoProc = null;
    let _renderOnlyCancelled = false;

    socket.on('cancel-render', () => {
        _renderOnlyCancelled = true;
        if (_renderOnlyAudioProc) { try { _renderOnlyAudioProc.kill('SIGTERM'); } catch (_) {} _renderOnlyAudioProc = null; }
        if (_renderOnlyVideoProc) { try { _renderOnlyVideoProc.kill('SIGTERM'); } catch (_) {} _renderOnlyVideoProc = null; }
        socket.emit('render-cancelled');
        socket.emit('log', '⏹ Render cancelled.');
    });

    // Re-render only (after manually replacing videos)
    socket.on('render-only', async (data) => {
        const lang = (data && data.lang) || 'en';
        const L = LOG[lang] || LOG.en;
        _renderOnlyCancelled = false;
        try {
            const japanese = (() => {
                try {
                    const segs = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
                    return segs.some(s => /[\u3040-\u30FF\u4E00-\u9FFF]/.test(s.voiceover_text));
                } catch { return false; }
            })();
            const voiceSettings2 = readSettings();
            const segmentsForVoice2 = JSON.parse(fs.readFileSync('./src/Content.json', 'utf8'));
            const audioCmd2 = contentUsesVoicevox(segmentsForVoice2, voiceSettings2)
                ? 'node generate-audio-voicevox.js'
                : japanese ? 'node generate-audio-ja.js' : 'node generate-audio.js';

            socket.emit('log', L.regen_voice);
            // Use spawn (not execSync) so the event loop stays free and logs stream live
            const audioScript = audioCmd2.replace(/^node\s+/, '');
            const audioProc = spawn('node', [audioScript], { shell: false });
            _renderOnlyAudioProc = audioProc;
            audioProc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(line => socket.emit('log', line)));
            audioProc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(line => socket.emit('log', line)));
            const audioCode = await new Promise(res => audioProc.on('close', c => { _renderOnlyAudioProc = null; res(c); }));
            if (audioCode !== 0) throw new Error(`Audio generation failed (exit ${audioCode})`);
            socket.emit('log', L.voice_ready);

            validateContentForRender(msg => socket.emit('log', msg), lang);
            socket.emit('log', L.rendering_only);
            const render = spawn('npx', ['remotion', 'render', 'src/index.ts', '1', '--force', '--concurrency=1'], { shell: true });
            _renderOnlyVideoProc = render;
            render.stdout.on('data', d => socket.emit('log', d.toString().trim()));
            render.stderr.on('data', d => socket.emit('log', d.toString().trim()));
            await new Promise(res => render.on('close', c => { _renderOnlyVideoProc = null; res(c); }));

            const finalName = `render_${Date.now()}.mp4`;
            if (!fs.existsSync('renders')) fs.mkdirSync('renders');
            fs.renameSync('out/1.mp4', `renders/${finalName}`);
            cleanupUnusedBackgrounds(msg => socket.emit('log', msg));
            socket.emit('render-done', { file: `renders/${finalName}` });
            socket.emit('log', L.saved_only(finalName));
        } catch (err) {
            if (_renderOnlyCancelled) { _renderOnlyCancelled = false; return; }
            socket.emit('log', L.error(err.message));
        }
    });
});

// ─────────────────────────────────────────
// LONG VIDEO ROUTES
// ─────────────────────────────────────────

const uploadLongVideo = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = './public/long-video-input';
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.mp4';
            cb(null, `lv-source-${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // 8 GB
});

app.post('/upload-long-video', (req, res) => {
    uploadLongVideo.single('video')(req, res, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        res.json({ filename: req.file.filename, size: req.file.size });
    });
});

// Socket handlers for the Long Video pipeline
io.on('connection', (socket) => {

    // ── Split a large source video into scene-sized chunks ──
    socket.on('split-long-video', async ({ filename, chunkDuration = 5, transcriptText = '' }) => {
        const { execFile } = require('child_process');
        const srcPath = path.join(__dirname, 'public', 'long-video-input', filename);
        if (!fs.existsSync(srcPath)) {
            return socket.emit('lv-split-error', { message: 'Source file not found.' });
        }

        const ts = Date.now();
        const bgDir = path.join(__dirname, 'public', 'backgrounds');
        if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
        const outPattern = path.join(bgDir, `lv-${ts}-%04d.mp4`);

        socket.emit('lv-split-log', `📐 Splitting into ${chunkDuration}s chunks…`);

        // Get total duration for progress
        let totalDuration = null;
        try {
            const probe = JSON.parse(await new Promise((res, rej) => {
                execFile('ffprobe', ['-v','quiet','-print_format','json','-show_format', srcPath],
                    (e, out) => e ? rej(e) : res(out));
            }));
            totalDuration = parseFloat(probe.format?.duration) || null;
        } catch (_) {}

        // Run ffmpeg split
        await new Promise((resolve) => {
            const args = [
                '-i', srcPath,
                '-c', 'copy',
                '-f', 'segment',
                '-segment_time', String(chunkDuration),
                '-reset_timestamps', '1',
                '-avoid_negative_ts', 'make_zero',
                outPattern,
            ];
            const proc = execFile('ffmpeg', args);
            let lastPct = 0;
            proc.stderr?.on('data', (d) => {
                const txt = d.toString();
                const m = txt.match(/time=(\d+):(\d+):([\d.]+)/);
                if (m && totalDuration) {
                    const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                    const pct = Math.min(99, Math.round(secs / totalDuration * 100));
                    if (pct !== lastPct) { lastPct = pct; socket.emit('lv-split-progress', { pct }); }
                }
            });
            proc.on('close', resolve);
        });

        // Collect created chunks
        const chunks = fs.readdirSync(bgDir)
            .filter(f => f.startsWith(`lv-${ts}-`) && f.endsWith('.mp4'))
            .sort();

        if (!chunks.length) {
            return socket.emit('lv-split-error', { message: 'ffmpeg produced no output chunks.' });
        }

        socket.emit('lv-split-log', `✅ ${chunks.length} chunks created`);

        // Distribute transcript lines evenly across scenes
        const transcriptLines = transcriptText
            ? transcriptText.split('\n').map(l => l.trim()).filter(Boolean)
            : [];

        // Build Content.json scenes
        const settings = readSettings();
        const scenes = await Promise.all(chunks.map(async (file, i) => {
            const fp = path.join(bgDir, file);
            let dur = null;
            try {
                const probe = JSON.parse(await new Promise((res, rej) => {
                    execFile('ffprobe', ['-v','quiet','-print_format','json','-show_format', fp],
                        (e, out) => e ? rej(e) : res(out));
                }));
                dur = parseFloat(probe.format?.duration) || chunkDuration;
            } catch (_) { dur = chunkDuration; }

            const text = transcriptLines.length
                ? (transcriptLines[Math.floor(i / chunks.length * transcriptLines.length)] || '')
                : '';

            return {
                text,
                voiceover_text: '',
                background_url: file,
                background_type: 'video',
                video_duration: Math.round(dur * 100) / 100,
                duration: Math.round(dur * 100) / 100,
                videoAudioVolume: 100,
                backgroundMusicEnabled: false,
                textStyle: settings.textStyle || 'box',
                textAnimation: 'pop',
                textFadeInDuration: 1.5,
                textFadeOutDuration: 1.5,
                glowColor: settings.glowColor || '#00ffff',
                glowSize: settings.glowSize ?? 1,
                font: settings.font || 'noto',
                blockColor: settings.blockColor || '#ffdd00',
                textColor: settings.textColor || '#000000',
                textStrokeColor: settings.textStrokeColor || '#000000',
                textStrokeSize: settings.textStrokeSize ?? 0,
                boxBorderRadius: settings.boxBorderRadius ?? 20,
                blockBorderRadius: settings.blockBorderRadius ?? 10,
                sceneFadeInDuration: 1.5,
                sceneFadeOutDuration: 1.5,
                textNoWrap: true,
            };
        }));

        writeJsonFile(CONTENT_PATH, scenes);
        socket.emit('lv-split-progress', { pct: 100 });
        socket.emit('lv-split-done', { chunkCount: chunks.length });
    });

    // ── Batch render the split scenes into a single final MP4 ──
    let _lvRenderStop = false;
    socket.on('lv-render-stop', () => { _lvRenderStop = true; });

    socket.on('long-video-render', async ({ batchSize = 20 }) => {
        _lvRenderStop = false;
        const segments = readJsonFile(CONTENT_PATH, []);
        if (!segments.length) {
            return socket.emit('lv-render-error', { message: 'No scenes loaded. Split a video first.' });
        }

        const savedContent = JSON.stringify(segments);
        const ts = Date.now();
        const rendersDir = path.join(__dirname, 'renders');
        if (!fs.existsSync(rendersDir)) fs.mkdirSync(rendersDir, { recursive: true });
        const batchFiles = [];

        const totalBatches = Math.ceil(segments.length / batchSize);
        socket.emit('lv-log', `🎬 Rendering ${segments.length} scenes in ${totalBatches} batch(es) of ${batchSize}…`);

        try {
            for (let b = 0; b < totalBatches; b++) {
                if (_lvRenderStop) throw new Error('Cancelled by user.');
                const batch = segments.slice(b * batchSize, (b + 1) * batchSize);
                writeJsonFile(CONTENT_PATH, batch);

                const pct = Math.round((b / totalBatches) * 80);
                socket.emit('lv-render-progress', { batch: b + 1, total: totalBatches, phase: 'render', pct });
                socket.emit('lv-log', `🎬 Batch ${b + 1}/${totalBatches}…`);

                await new Promise((resolve, reject) => {
                    const proc = spawn('npx', ['remotion', 'render', 'src/index.ts', '1', '--force', '--concurrency=1'], { shell: true });
                    proc.stdout?.on('data', d => socket.emit('lv-log', d.toString().trim()));
                    proc.stderr?.on('data', d => socket.emit('lv-log', d.toString().trim()));
                    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Render exited ${code}`)));
                });

                const batchFile = `renders/lv-batch-${ts}-${b}.mp4`;
                fs.renameSync('out/1.mp4', batchFile);
                batchFiles.push(batchFile);
                socket.emit('lv-log', `✅ Batch ${b + 1} done`);
            }

            // Concat all batch files
            socket.emit('lv-render-progress', { phase: 'concat', pct: 85 });
            socket.emit('lv-log', '🔗 Concatenating batches…');

            const listPath = `renders/lv-list-${ts}.txt`;
            fs.writeFileSync(listPath, batchFiles.map(f => `file '${path.resolve(f)}'`).join('\n'));

            const finalFile = `renders/lv-final-${ts}.mp4`;
            await new Promise((resolve, reject) => {
                const proc = spawn('ffmpeg', [
                    '-f', 'concat', '-safe', '0',
                    '-i', listPath,
                    '-c', 'copy',
                    finalFile,
                ]);
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Concat exited ${code}`)));
            });

            fs.unlinkSync(listPath);
            batchFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

            writeJsonFile(CONTENT_PATH, JSON.parse(savedContent));
            socket.emit('lv-render-progress', { phase: 'done', pct: 100 });
            socket.emit('lv-done', { file: finalFile });
            socket.emit('lv-log', `✅ Done: ${finalFile}`);

        } catch (err) {
            try { writeJsonFile(CONTENT_PATH, JSON.parse(savedContent)); } catch (_) {}
            socket.emit('lv-render-error', { message: err.message });
        }
    });

    // ── Auto-detect scene cuts + silences with live progress ──
    socket.on('lv-detect-scenes', async ({ filename, threshold = 0.3 }) => {
        const { spawn } = require('child_process');
        const srcPath = path.join(__dirname, 'public', 'long-video-input', filename);
        if (!fs.existsSync(srcPath)) {
            return socket.emit('lv-detect-error', { message: 'Source file not found.' });
        }
        const thresh = Math.min(0.9, Math.max(0.1, parseFloat(threshold) || 0.3));

        function parseTimeStr(str) {
            if (!str) return null;
            const p = str.split(':');
            if (p.length !== 3) return null;
            return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + parseFloat(p[2]);
        }

        // Get total duration for progress %
        let totalDuration = 0;
        try {
            const probe = JSON.parse(await new Promise((res, rej) => {
                const { execFile } = require('child_process');
                execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', srcPath],
                    (e, out) => e ? rej(e) : res(out));
            }));
            totalDuration = parseFloat(probe.format?.duration) || 0;
        } catch (_) {}

        // Phase 1: scene cut detection
        socket.emit('lv-detect-progress', { phase: 1, pct: 0, label: 'Phase 1/2 — scene cuts…' });
        const sceneTimestamps = [];
        await new Promise((resolve) => {
            const proc = spawn('ffmpeg', [
                '-i', srcPath,
                '-vf', `select=gt(scene\\,${thresh}),showinfo`,
                '-vsync', 'vfr', '-an', '-f', 'null', '-'
            ]);
            proc.stderr.on('data', (chunk) => {
                const s = chunk.toString();
                const reScene = /pts_time:([\d.]+)/g;
                let m;
                while ((m = reScene.exec(s)) !== null) {
                    const t = parseFloat(m[1]);
                    if (!isNaN(t)) sceneTimestamps.push(t);
                }
                const tm = s.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
                if (tm && totalDuration > 0) {
                    const cur = parseTimeStr(tm[1]);
                    if (cur !== null) {
                        const pct = Math.min(99, Math.round(cur / totalDuration * 100));
                        socket.emit('lv-detect-progress', { phase: 1, pct, label: 'Phase 1/2 — scene cuts…' });
                    }
                }
            });
            proc.on('close', resolve);
        });

        // Phase 2: silence detection
        socket.emit('lv-detect-progress', { phase: 2, pct: 0, label: 'Phase 2/2 — silences…' });
        const silenceTimestamps = [];
        await new Promise((resolve) => {
            const proc = spawn('ffmpeg', [
                '-i', srcPath,
                '-af', 'silencedetect=noise=-30dB:duration=0.8',
                '-f', 'null', '-'
            ]);
            proc.stderr.on('data', (chunk) => {
                const s = chunk.toString();
                const reSil = /silence_end:\s*([\d.]+)/g;
                let m;
                while ((m = reSil.exec(s)) !== null) {
                    const t = parseFloat(m[1]);
                    if (!isNaN(t)) silenceTimestamps.push(t);
                }
                const tm = s.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
                if (tm && totalDuration > 0) {
                    const cur = parseTimeStr(tm[1]);
                    if (cur !== null) {
                        const pct = Math.min(99, Math.round(cur / totalDuration * 100));
                        socket.emit('lv-detect-progress', { phase: 2, pct, label: 'Phase 2/2 — silences…' });
                    }
                }
            });
            proc.on('close', resolve);
        });

        // Merge + deduplicate
        const all = [...sceneTimestamps, ...silenceTimestamps].sort((a, b) => a - b);
        const merged = [];
        for (const t of all) {
            if (t < 2) continue;
            if (totalDuration > 0 && t > totalDuration - 2) continue;
            if (merged.length === 0 || t - merged[merged.length - 1] >= 1.5) {
                merged.push(Math.round(t * 10) / 10);
            }
        }
        socket.emit('lv-detect-done', { timestamps: merged, totalDuration });
    });
});

// ─────────────────────────────────────────
// MEDIA LIBRARY ROUTES
// ─────────────────────────────────────────

function readMediaLibrary() {
    const defaults = { brandColors: [], brandImages: [] };
    try {
        const data = readJsonFile(MEDIA_LIBRARY_PATH, defaults);
        if (!Array.isArray(data.brandColors)) data.brandColors = [];
        if (!Array.isArray(data.brandImages)) data.brandImages = [];
        return data;
    } catch { return defaults; }
}

function writeMediaLibrary(data) {
    writeJsonFile(MEDIA_LIBRARY_PATH, data);
}

// GET full media library
app.get('/media-library', (req, res) => {
    res.json(readMediaLibrary());
});

// POST add or update a brand colour
app.post('/media-library/add-color', (req, res) => {
    try {
        const { color, name } = req.body;
        if (!color || !/^#[0-9a-f]{3,8}$/i.test(color)) {
            return res.status(400).json({ error: 'Invalid colour value.' });
        }
        const lib = readMediaLibrary();
        // Avoid exact duplicates by hex value
        if (!lib.brandColors.find(c => c.color.toLowerCase() === color.toLowerCase())) {
            lib.brandColors.push({ color: color.toLowerCase(), name: name || '', addedAt: new Date().toISOString() });
            writeMediaLibrary(lib);
        }
        res.json({ ok: true, brandColors: lib.brandColors });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST remove a brand colour by hex value
app.post('/media-library/remove-color', (req, res) => {
    try {
        const { color } = req.body;
        const lib = readMediaLibrary();
        lib.brandColors = lib.brandColors.filter(c => c.color.toLowerCase() !== (color || '').toLowerCase());
        writeMediaLibrary(lib);
        res.json({ ok: true, brandColors: lib.brandColors });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST update brand colour name
app.post('/media-library/update-color-name', (req, res) => {
    try {
        const { color, name } = req.body;
        const lib = readMediaLibrary();
        const entry = lib.brandColors.find(c => c.color.toLowerCase() === (color || '').toLowerCase());
        if (entry) entry.name = name || '';
        writeMediaLibrary(lib);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST upload a brand image
app.post('/upload-brand-image', upload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
        const lib = readMediaLibrary();
        const entry = {
            filename: req.file.filename,
            originalName: req.file.originalname,
            addedAt: new Date().toISOString(),
            url: `/public/brand/${req.file.filename}`,
        };
        lib.brandImages.push(entry);
        writeMediaLibrary(lib);
        res.json({ ok: true, image: entry, brandImages: lib.brandImages });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST delete a brand image
app.post('/media-library/delete-image', (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ error: 'Filename required.' });
        const lib = readMediaLibrary();
        lib.brandImages = lib.brandImages.filter(img => img.filename !== filename);
        writeMediaLibrary(lib);
        // Also delete the actual file
        const filePath = path.join(__dirname, 'public', 'brand', filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ ok: true, brandImages: lib.brandImages });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// LONG VIDEO EDITOR ROUTES
// ─────────────────────────────────────────

// GET /lv-video-info?filename=X  →  { duration }
app.get('/lv-video-info', (req, res) => {
    const { execFile } = require('child_process');
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const srcPath = path.join(__dirname, 'public', 'long-video-input', filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found' });
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', srcPath], (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        try {
            const probe = JSON.parse(stdout);
            const duration = parseFloat(probe.format?.duration) || 0;
            res.json({ duration });
        } catch (e) { res.status(500).json({ error: 'ffprobe parse error' }); }
    });
});

// POST /lv-detect-scenes  →  { timestamps: [number, ...] }
app.post('/lv-detect-scenes', async (req, res) => {
    const { execFile } = require('child_process');
    const { filename, threshold = 0.3 } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const srcPath = path.join(__dirname, 'public', 'long-video-input', filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found' });

    const thresh = Math.min(0.9, Math.max(0.1, parseFloat(threshold) || 0.3));

    // Get duration first
    let totalDuration = 0;
    try {
        const probe = JSON.parse(await new Promise((resolve, reject) => {
            execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', srcPath],
                (e, out) => e ? reject(e) : resolve(out));
        }));
        totalDuration = parseFloat(probe.format?.duration) || 0;
    } catch (_) {}

    // Scene detection
    const sceneTimestamps = [];
    try {
        await new Promise((resolve) => {
            execFile('ffmpeg', [
                '-i', srcPath,
                '-vf', `select=gt(scene\\,${thresh}),showinfo`,
                '-vsync', 'vfr',
                '-an', '-f', 'null', '-'
            ], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
                const combined = (stdout || '') + (stderr || '');
                const re = /pts_time:([\d.]+)/g;
                let m;
                while ((m = re.exec(combined)) !== null) {
                    const t = parseFloat(m[1]);
                    if (!isNaN(t)) sceneTimestamps.push(t);
                }
                resolve();
            });
        });
    } catch (_) {}

    // Silence detection
    const silenceTimestamps = [];
    try {
        await new Promise((resolve) => {
            execFile('ffmpeg', [
                '-i', srcPath,
                '-af', 'silencedetect=noise=-30dB:duration=0.8',
                '-f', 'null', '-'
            ], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
                const combined = (stdout || '') + (stderr || '');
                const re = /silence_end:\s*([\d.]+)/g;
                let m;
                while ((m = re.exec(combined)) !== null) {
                    const t = parseFloat(m[1]);
                    if (!isNaN(t)) silenceTimestamps.push(t);
                }
                resolve();
            });
        });
    } catch (_) {}

    // Merge, sort, deduplicate within 1.5s, filter < 2s and > (duration - 2s)
    const all = [...sceneTimestamps, ...silenceTimestamps].sort((a, b) => a - b);
    const merged = [];
    for (const t of all) {
        if (t < 2) continue;
        if (totalDuration > 0 && t > totalDuration - 2) continue;
        if (merged.length === 0 || t - merged[merged.length - 1] >= 1.5) {
            merged.push(Math.round(t * 10) / 10);
        }
    }

    res.json({ timestamps: merged });
});

// POST /lv-split-at-timestamps  →  { chunkCount, scenes }
app.post('/lv-split-at-timestamps', async (req, res) => {
    const { execFile } = require('child_process');
    const { filename, timestamps = [], transcriptText = '' } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const srcPath = path.join(__dirname, 'public', 'long-video-input', filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found' });

    // Sort and validate timestamps
    const sorted = [...timestamps]
        .map(t => parseFloat(t))
        .filter(t => !isNaN(t) && t > 0)
        .sort((a, b) => a - b);

    const ts = Date.now();
    const bgDir = path.join(__dirname, 'public', 'backgrounds');
    if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
    const outPattern = path.join(bgDir, `lv-${ts}-%04d.mp4`);

    // Build ffmpeg args: -segment_times "t1,t2,t3"
    const segTimes = sorted.join(',');
    const args = [
        '-i', srcPath,
        '-c', 'copy',
        '-f', 'segment',
    ];
    if (segTimes) {
        args.push('-segment_times', segTimes);
    }
    args.push(
        '-reset_timestamps', '1',
        '-avoid_negative_ts', 'make_zero',
        outPattern
    );

    try {
        await new Promise((resolve, reject) => {
            execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
    } catch (e) {
        return res.status(500).json({ error: 'ffmpeg split failed: ' + e.message });
    }

    // Collect created chunks
    const chunks = fs.readdirSync(bgDir)
        .filter(f => f.startsWith(`lv-${ts}-`) && f.endsWith('.mp4'))
        .sort();

    if (!chunks.length) {
        return res.status(500).json({ error: 'ffmpeg produced no output chunks.' });
    }

    // Distribute transcript lines evenly across scenes
    const transcriptLines = transcriptText
        ? transcriptText.split('\n').map(l => l.trim()).filter(Boolean)
        : [];

    const settings = readSettings();
    const scenes = await Promise.all(chunks.map(async (file, i) => {
        const fp = path.join(bgDir, file);
        let dur = 5;
        try {
            const probe = JSON.parse(await new Promise((resolve, reject) => {
                execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', fp],
                    (e, out) => e ? reject(e) : resolve(out));
            }));
            dur = parseFloat(probe.format?.duration) || 5;
        } catch (_) {}

        const text = transcriptLines.length
            ? (transcriptLines[Math.floor(i / chunks.length * transcriptLines.length)] || '')
            : '';

        return {
            text,
            voiceover_text: '',
            background_url: file,
            background_type: 'video',
            video_duration: Math.round(dur * 100) / 100,
            duration: Math.round(dur * 100) / 100,
            videoAudioVolume: 100,
            backgroundMusicEnabled: false,
            textStyle: settings.textStyle || 'box',
            textAnimation: 'pop',
            textFadeInDuration: 1.5,
            textFadeOutDuration: 1.5,
            glowColor: settings.glowColor || '#00ffff',
            glowSize: settings.glowSize ?? 1,
            font: settings.font || 'noto',
            blockColor: settings.blockColor || '#ffdd00',
            textColor: settings.textColor || '#000000',
            textStrokeColor: settings.textStrokeColor || '#000000',
            textStrokeSize: settings.textStrokeSize ?? 0,
            boxBorderRadius: settings.boxBorderRadius ?? 20,
            blockBorderRadius: settings.blockBorderRadius ?? 10,
            sceneFadeInDuration: 1.5,
            sceneFadeOutDuration: 1.5,
            textNoWrap: true,
        };
    }));

    writeJsonFile(CONTENT_PATH, scenes);
    res.json({ chunkCount: chunks.length, scenes });
});

// ─────────────────────────────────────────
// SCREEN RECORDER ROUTES
// ─────────────────────────────────────────

const screenRecordSessions = {};
const RECORDINGS_DIR = path.join(__dirname, 'Recordings');
const SR_TEMP_DIR    = path.join(__dirname, 'public', 'screen-recordings');

// Check ffmpeg availability once at startup
let ffmpegAvailable = false;
try { execSync('ffmpeg -version 2>/dev/null'); ffmpegAvailable = true; }
catch (_) { console.log('⚠️  ffmpeg not found — screen recordings will save as WebM until installed'); }

app.post('/screen-record/start', (req, res) => {
    try {
        // Clean up any previous undownloaded recordings
        if (fs.existsSync(RECORDINGS_DIR)) {
            for (const f of fs.readdirSync(RECORDINGS_DIR)) {
                try { fs.unlinkSync(path.join(RECORDINGS_DIR, f)); } catch (_) {}
            }
        } else {
            fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
        }
        // Also purge orphaned temp webm files from crashed sessions
        if (fs.existsSync(SR_TEMP_DIR)) {
            for (const f of fs.readdirSync(SR_TEMP_DIR)) {
                try { fs.unlinkSync(path.join(SR_TEMP_DIR, f)); } catch (_) {}
            }
        } else {
            fs.mkdirSync(SR_TEMP_DIR, { recursive: true });
        }

        const sessionId = `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const filePath = path.join(SR_TEMP_DIR, `${sessionId}.webm`);
        const stream = fs.createWriteStream(filePath);
        screenRecordSessions[sessionId] = { filePath, stream };
        res.json({ sessionId });
    } catch (e) {
        console.error('screen-record/start error:', e);
        res.status(500).json({ error: 'Failed to start session: ' + e.message });
    }
});

app.post('/screen-record/chunk/:sessionId',
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    (req, res) => {
        const session = screenRecordSessions[req.params.sessionId];
        if (!session) return res.status(404).json({ error: 'Session not found' });
        session.stream.write(Buffer.from(req.body));
        res.json({ ok: true });
    }
);

app.post('/screen-record/stop/:sessionId', (req, res) => {
    const session = screenRecordSessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    delete screenRecordSessions[req.params.sessionId];
    session.stream.end(() => {
        const { execFile } = require('child_process');
        const webmPath = session.filePath;
        const ts = Date.now();
        const finalName = `screen-recording-${ts}.mp4`;
        const finalPath = path.join(RECORDINGS_DIR, finalName);
        execFile('ffmpeg', [
            '-i', webmPath,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            finalPath,
        ], (err) => {
            if (!err) {
                // ffmpeg succeeded — remove temp webm, return mp4
                try { fs.unlinkSync(webmPath); } catch (_) {}
                const size = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
                return res.json({ filename: finalName, size });
            }
            if (err.code === 'ENOENT') {
                // ffmpeg not installed — save the raw webm so the recording isn't lost
                const webmName = `screen-recording-${ts}.webm`;
                const webmFinal = path.join(RECORDINGS_DIR, webmName);
                try {
                    fs.renameSync(webmPath, webmFinal);
                    const size = fs.statSync(webmFinal).size;
                    return res.json({ filename: webmName, size, noFfmpeg: true });
                } catch (e2) {
                    return res.status(500).json({ error: 'Failed to save recording: ' + e2.message });
                }
            }
            // other ffmpeg error
            try { fs.unlinkSync(webmPath); } catch (_) {}
            return res.status(500).json({ error: 'Conversion failed: ' + err.message });
        });
    });
});

app.get('/screen-record/download/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^screen-recording-\d+\.(mp4|webm)$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(RECORDINGS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath, filename);
});

app.get('/ffmpeg-check', (req, res) => res.json({ available: ffmpegAvailable }));

app.post('/ffmpeg-install', (req, res) => {
    // Check brew is available first
    let brewOk = false;
    try { execSync('brew --version 2>/dev/null'); brewOk = true; } catch (_) {}
    if (!brewOk) {
        return res.json({ started: false, error: 'no-brew' });
    }
    res.json({ started: true });
    const proc = spawn('brew', ['install', 'ffmpeg'], { stdio: 'pipe' });
    proc.stdout.on('data', d => io.emit('ffmpeg-install-log', d.toString()));
    proc.stderr.on('data', d => io.emit('ffmpeg-install-log', d.toString()));
    proc.on('close', code => {
        if (code === 0) {
            ffmpegAvailable = true;
            io.emit('ffmpeg-install-done', { ok: true });
            console.log('✅ ffmpeg installed successfully');
        } else {
            io.emit('ffmpeg-install-done', { ok: false });
        }
    });
    proc.on('error', () => io.emit('ffmpeg-install-done', { ok: false }));
});

// ─────────────────────────────────────────
// AUTO-UPDATE ROUTES
// ─────────────────────────────────────────
const UPDATE_REPO_RAW = 'https://raw.githubusercontent.com/keithforit/pc-long-vid-updates/main';
const UPDATABLE_FILES = ['index.html', 'server.js', 'parser-captions.js', 'parser.js'];

function getLocalVersion() {
    // pc-long-vid tracks its own version in version-long.json
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version-long.json'), 'utf8')).version || '0.0.0'; }
    catch { return '0.0.0'; }
}

// GET /version — returns the local installed version
app.get('/version', (req, res) => {
    res.json({ version: getLocalVersion() });
});

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
}

// GET /check-update  — returns { current, latest, upToDate, notes }
app.get('/check-update', async (req, res) => {
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            https.get(`${UPDATE_REPO_RAW}/version-long.json?t=${Date.now()}`, r => {
                let body = '';
                r.on('data', c => body += c);
                r.on('end', () => resolve(body));
            }).on('error', reject);
        });
        const remote = JSON.parse(data);
        const local = getLocalVersion();
        res.json({
            current: local,
            latest: remote.version,
            notes: remote.notes || '',
            date: remote.date || '',
            upToDate: compareVersions(local, remote.version) >= 0
        });
    } catch (e) {
        res.status(500).json({ error: 'Could not reach update server: ' + e.message });
    }
});

// POST /apply-update  — downloads and replaces updatable files, then restarts
app.post('/apply-update', async (req, res) => {
    try {
        const https = require('https');
        function downloadFile(url) {
            return new Promise((resolve, reject) => {
                https.get(url, r => {
                    const chunks = [];
                    r.on('data', c => chunks.push(c));
                    r.on('end', () => resolve(Buffer.concat(chunks)));
                }).on('error', reject);
            });
        }
        // Fetch remote version-long.json (pc-long-vid's own update track)
        const versionBuf = await downloadFile(`${UPDATE_REPO_RAW}/version-long.json?t=${Date.now()}`);
        const remote = JSON.parse(versionBuf.toString());
        const filesToUpdate = remote.files || UPDATABLE_FILES;
        for (let idx = 0; idx < filesToUpdate.length; idx++) {
            const remoteFile = filesToUpdate[idx];
            const localFile  = remoteFile;
            io.emit('update-progress', { file: localFile, current: idx + 1, total: filesToUpdate.length });
            const buf = await downloadFile(`${UPDATE_REPO_RAW}/${remoteFile}?t=${Date.now()}`);
            fs.mkdirSync(path.dirname(path.join(__dirname, localFile)), { recursive: true });
            fs.writeFileSync(path.join(__dirname, localFile), buf);
        }
        // Update local version-long.json
        fs.writeFileSync(path.join(__dirname, 'version-long.json'), JSON.stringify({ version: remote.version }, null, 2));
        res.json({ ok: true, version: remote.version, notes: remote.notes });
        // Restart the server after a short delay so the response can be sent
        setTimeout(() => {
            console.log(`\n🔄 Restarting after update to v${remote.version}...`);
            server.close(() => {
                console.log('Server closed, restarting...');
                server.listen(activePort, () => {
                    console.log(`🚀 Dashboard at http://localhost:${activePort}`);
                });
            });
        }, 1500);
    } catch (e) {
        res.status(500).json({ error: 'Update failed: ' + e.message });
    }
});

// Simple liveness probe — client polls this to know when the server is back up after a restart
app.get('/ping', (req, res) => res.json({ ok: true }));

let activePort = 3000;
(function tryListen(port) {
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️  Port ${port} in use, trying ${port + 1}...`);
            tryListen(port + 1);
        } else throw err;
    });
    server.listen(port, () => {
        activePort = port;
        if (port !== 3000) console.log(`⚠️  Port 3000 in use — running on http://localhost:${port}`);
        console.log(`🚀 Dashboard at http://localhost:${port}`);
        exec(`open http://localhost:${port}`);
    // Backfill video_duration for any existing segments that are missing it.
    // Runs once at startup so scenes already in the project loop correctly.
    (async () => {
        try {
            const contentPath = './src/Content.json';
            const segs = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
            let changed = false;
            for (const seg of segs) {
                if (
                    seg.background_url &&
                    seg.background_type !== 'image' &&
                    seg.background_type !== 'color' &&
                    seg.background_type !== 'gradient' &&
                    (seg.video_duration == null)
                ) {
                    const filepath = `./public/backgrounds/${seg.background_url}`;
                    if (fs.existsSync(filepath)) {
                        const dur = await getVideoDuration(filepath);
                        if (dur != null) {
                            seg.video_duration = dur;
                            changed = true;
                        }
                    }
                }
            }
            if (changed) {
                fs.writeFileSync(contentPath, JSON.stringify(segs, null, 2));
                console.log('✅ Backfilled video_duration for existing scenes');
            }
        } catch (e) {
            console.warn('⚠️  video_duration backfill failed:', e.message);
        }
    })();
    });
})(3000);
