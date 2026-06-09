const fs = require('fs');
const path = require('path');
const gTTS = require('gtts');
const mp3Duration = require('mp3-duration');

async function generate() {
    const contentPath = path.join(__dirname, 'src', 'Content.json');
    let segments = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
    const voiceDir = path.join(__dirname, 'public', 'voiceovers');
    if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

    for (let i = 0; i < segments.length; i++) {
        const text = (segments[i].voiceover_text || '').trim();
        const customAudio = segments[i].customAudioFile;

        // Use uploaded custom audio if present
        if (customAudio) {
            const customPath = path.join(voiceDir, customAudio);
            if (fs.existsSync(customPath)) {
                const duration = await mp3Duration(customPath);
                segments[i].audioDuration = duration;
                segments[i].duration = duration;
                segments[i].audioFile = customAudio;
                console.log(`🎧 [${i + 1}/${segments.length}] Using uploaded MP3 ${customAudio} (${duration.toFixed(2)}s)`);
                continue;
            }
        }

        // Skip TTS if there is no voiceover text — keep existing duration or default to 5s
        if (!text) {
            console.log(`⏭️  [${i + 1}/${segments.length}] No voiceover text — skipping TTS, keeping duration ${(segments[i].duration || 5).toFixed(2)}s`);
            if (!segments[i].duration) segments[i].duration = 5;
            segments[i].audioFile = null;
            continue;
        }

        const filePath = path.join(voiceDir, `segment_${i}.mp3`);

        await new Promise((resolve, reject) => {
            try {
                const gtts = new gTTS(text, 'en');
                gtts.save(filePath, (err) => {
                    if (err) { console.error(`⚠️  [${i + 1}] TTS save error:`, err.message); }
                    resolve();
                });
            } catch (err) {
                console.error(`⚠️  [${i + 1}] TTS error:`, err.message);
                resolve();
            }
        });

        if (fs.existsSync(filePath)) {
            const duration = await mp3Duration(filePath);
            const prevAudioDur = segments[i].audioDuration;
            const prevSceneDur = segments[i].duration;
            const wasAutoSet = prevAudioDur == null || !prevSceneDur || Math.abs(prevSceneDur - (prevAudioDur + 0.5)) < 0.15;
            segments[i].audioDuration = duration;
            if (wasAutoSet) segments[i].duration = duration + 0.5;
            segments[i].audioFile = `segment_${i}.mp3`;
            console.log(`🎙️  [${i + 1}/${segments.length}] Generated TTS (${duration.toFixed(2)}s)`);
        } else {
            console.log(`⚠️  [${i + 1}/${segments.length}] TTS file not created — keeping duration ${(segments[i].duration || 5).toFixed(2)}s`);
            if (!segments[i].duration) segments[i].duration = 5;
        }
    }

    fs.writeFileSync(contentPath, JSON.stringify(segments, null, 2));
    console.log("✅ Sync Complete");
}
generate();
