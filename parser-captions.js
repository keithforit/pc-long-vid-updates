// parser-captions.js
// Parses the script into segments WITHOUT fetching any stock video backgrounds.
// Background colours are assigned by the server after parsing.
//
// Handles all known ChatGPT/Claude output variations:
//   Headers  : "2. HOOK" / "HOOK" / "フック" / "4. CTA" / "CTA" / "Scene 2" / "Scene #2" / "シーン2" / "場面2" / "第N位"
//   On-screen: "On-screen text:" / "キャプション:" / "テロップ:" / "画面テキスト:"
//   Narration: "Narration:" / "ナレーション:" / "Spoken narration:" / "Spoken hook:" / "Spoken CTA:"
//   Topic    : "1. VIDEO TOPIC" / "VIDEO TOPIC" / "1. VIDEO_TOPIC" / "VIDEO_TOPIC"
const fs = require('fs');

async function parse() {
    const rawText = fs.readFileSync('temp_input.txt', 'utf8');

    // ── Topic / title ────────────────────────────────────────────────────────
    const topicMatch = rawText.match(/(?:\d+\.\s*)?VIDEO[_ ]TOPIC\s*\n\s*(.+)/i);
    const title = topicMatch
        ? topicMatch[1].trim().replace(/[^a-z0-9]/gi, '_').toLowerCase()
        : 'vid_' + Date.now();
    fs.writeFileSync('temp_title.txt', title);

    // ── Split into blocks on any recognised scene header ─────────────────────
    // Matches (with or without leading number+dot):
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
            /(?:On-screen text|キャプション|テロップ|画面テキスト)[:：]\s*([\s\S]*?)(?=\n[ \t]*(?:Narration|ナレーション|Spoken|Visual|視覚案)[ \t]*[:：]|\s*$)/i
        );
        if (!textMatch) continue; // block has no displayable text — skip

        // ── Narration / voiceover ────────────────────────────────────────────
        // Accepts: "Narration:", "ナレーション:", "Spoken narration:", "Spoken hook:", "Spoken CTA:", etc.
        const narrationMatch = trimmed.match(
            /(?:Narration|ナレーション|Spoken\s+\S+?)[:：]\s*[「""]?([\s\S]*?)[」""]?\s*(?=\r?\n\s*(?:Visual|視覚案|On-screen|テロップ|キャプション|画面テキスト|ナレーション|Scene|シーン|場面|フック|HOOK|CTA|\d+\.|$)|$)/i
        );

        segments.push({
            text: textMatch[1].trim(),
            voiceover_text: narrationMatch
                ? narrationMatch[1].trim().replace(/\r?\n|\r/g, ' ')
                : textMatch[1].trim().replace(/\r?\n|\r/g, ' '),
            background_url: '',
            background_type: 'color',
            background_color: '#0f172a', // placeholder; server overwrites with brand/random colour
            textPosition: 'center',
            textAlign: 'center',
            duration: 5
        });
    }

    fs.writeFileSync('./src/Content.json', JSON.stringify(segments, null, 2));
    console.log(`✅ Parsed ${segments.length} segment(s) (captions-only mode)`);
}

parse();
