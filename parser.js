const fs = require('fs');
const path = require('path');
const axios = require('axios');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    });
}
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// Download a remote video to public/backgrounds/ and return the local filename
async function downloadVideo(url) {
    if (!fs.existsSync('./public/backgrounds')) fs.mkdirSync('./public/backgrounds', { recursive: true });
    const filename = `pexels-${Date.now()}.mp4`;
    const dest = `./public/backgrounds/${filename}`;
    const response = await axios.get(url, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    return filename;
}

function clearOldPexelsBackgrounds() {
    const dir = './public/backgrounds';
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
        if (!/^pexels-.*\.(mp4|mov|webm)$/i.test(file)) continue;
        try {
            fs.unlinkSync(path.join(dir, file));
            console.log(`🧹 Removed old Pexels background: ${file}`);
        } catch (e) {
            console.log(`⚠ Could not remove old Pexels background ${file}: ${e.message}`);
        }
    }
}

async function parse() {
    clearOldPexelsBackgrounds();
    const rawText = fs.readFileSync('temp_input.txt', 'utf8');

    // ── Topic / title ────────────────────────────────────────────────────────
    // Handles: "1. VIDEO TOPIC" / "VIDEO TOPIC" / "1. VIDEO_TOPIC" / "VIDEO_TOPIC"
    const topicMatch = rawText.match(/(?:\d+\.\s*)?VIDEO[_ ]TOPIC\s*\n\s*(.+)/i);
    const title = topicMatch
        ? topicMatch[1].trim().replace(/[^a-z0-9]/gi, '_').toLowerCase()
        : 'vid_' + Date.now();
    fs.writeFileSync('temp_title.txt', title);

    // ── Split into blocks on any recognised scene header ─────────────────────
    // Handles (with or without leading number+dot):
    //   "2. HOOK" / "HOOK" / "フック"
    //   "3. SCENES" / "SCENES"  (header-only, skipped below)
    //   "4. CTA"  / "CTA"
    //   "Scene #2" / "Scene 2" / "シーン2" / "場面2"
    //   "第N位"
    const HEADER_RE = /(?=(?:\d+\.\s*)?(?:HOOK|フック|SCENES?|CTA)\b|Scene\s*#?\d+|シーン\s*#?\d+|場面\s*#?\d+|第\d+位)/i;
    const blocks = rawText.split(HEADER_RE);

    const segments = [];

    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        // Skip pure section headers that carry no scene content
        if (/^(?:\d+\.\s*)?(?:SCENES?|VIDEO[_ ]TOPIC)\s*$/i.test(trimmed)) continue;

        // ── On-screen text ───────────────────────────────────────────────────
        // Use [\s\S]*? so multi-line on-screen text is captured in full,
        // stopping when the next known label (Narration/Spoken/Visual) appears.
        // Also accepts Japanese aliases: キャプション / テロップ / 画面テキスト
        const textMatch = trimmed.match(
            /(?:On-screen text|キャプション|テロップ|画面テキスト|画面テロップ)[:：]\s*([\s\S]*?)(?=\n[ \t]*(?:Narration|ナレーション|Spoken|Visual|視覚案|映像素材)[ \t]*[:：]|\s*$)/i
        );
        if (!textMatch) continue;

        // ── Narration / voiceover ────────────────────────────────────────────
        // Accepts: "Narration:", "ナレーション:", "Spoken narration:", "Spoken hook:", "Spoken CTA:", etc.
        const narrationMatch = trimmed.match(
            /(?:Narration|ナレーション|Spoken\s+\S+?)[:：]\s*[「""]?([\s\S]*?)[」""]?\s*(?=\r?\n\s*(?:Visual|視覚案|映像素材|グラフ|On-screen|テロップ|キャプション|画面テキスト|画面テロップ|ナレーション|Scene|シーン|場面|フック|HOOK|CTA|\d+\.|$)|$)/i
        );

        // ── Visual / stock footage query ─────────────────────────────────────
        const visualMatch = trimmed.match(/(?:Visual idea|Visual \/ stock footage idea|視覚案|ビジュアルアイデア|映像素材のアイデア|映像素材)[:：]\s*(.*)/i);

        let query = visualMatch ? visualMatch[1].trim() : textMatch[1].trim();
        query = query.replace(/(Person looking |Close-up of |Quick flash of )/gi, '');

        // Warn if query is non-English — Pexels works best with English search terms
        if (/[぀-ヿ一-鿿]/.test(query)) {
            console.log(`⚠️ Visual idea "${query}" contains non-English text — Pexels searches work best in English. / 視覚案が日本語です。英語で入力すると動画が見つかりやすくなります。`);
        }

        let videoFile = '';
        try {
            const res = await axios.get(
                `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`,
                { headers: { Authorization: PEXELS_API_KEY } }
            );
            if (res.data.videos?.length > 0) {
                const videoIdx = res.data.videos.length > 1 ? 1 : 0;
                const chosen   = res.data.videos[videoIdx];
                const remoteUrl = chosen.video_files.sort((a, b) => b.width - a.width)[0].link;
                console.log(`⬇ Downloading video for: ${query}`);
                videoFile = await downloadVideo(remoteUrl);
                console.log(`✅ Saved: ${videoFile}`);
            }
        } catch (e) { console.log('Pexels/download error for:', query, e.message); }

        segments.push({
            text: textMatch[1].trim(),
            voiceover_text: narrationMatch
                ? narrationMatch[1].trim().replace(/\r?\n|\r/g, ' ')
                : textMatch[1].trim().replace(/\r?\n|\r/g, ' '),
            background_url: videoFile,
            textPosition: 'center',
            textAlign: 'center',
            duration: 5
        });
    }

    fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
}

parse();
