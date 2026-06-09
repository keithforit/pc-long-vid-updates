/**
 * Japanese voiceover generator using gTTS with lang='ja'.
 * Replaces generate-audio.js for Japanese-language videos.
 */
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
        const text = segments[i].voiceover_text;
        const customAudio = segments[i].customAudioFile;
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

        const filePath = path.join(voiceDir, `segment_${i}.mp3`);

        console.log(`🎙️ [${i + 1}/${segments.length}] ${text.substring(0, 40)}...`);

        await new Promise((resolve, reject) => {
            const gtts = new gTTS(text, 'ja');
            gtts.save(filePath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        const duration = await mp3Duration(filePath);
        const prevAudioDur = segments[i].audioDuration;
        const prevSceneDur = segments[i].duration;
        const wasAutoSet = prevAudioDur == null || !prevSceneDur || Math.abs(prevSceneDur - (prevAudioDur + 0.5)) < 0.15;
        segments[i].audioDuration = duration;
        if (wasAutoSet) segments[i].duration = duration + 0.5;
        segments[i].audioFile = `segment_${i}.mp3`;
        console.log(`   ✅ ${duration.toFixed(2)}s → segment_${i}.mp3`);
    }

    fs.writeFileSync(contentPath, JSON.stringify(segments, null, 2));
    console.log('\n✅ All Japanese voiceovers generated and durations synced.');
}

generate();
