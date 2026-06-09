/**
 * VOICEVOX audio generator.
 * Requires VOICEVOX to be running locally at http://localhost:50021
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mp3Duration = require('mp3-duration');

const VOICEVOX_URL = 'http://localhost:50021';
const contentPath  = path.join(__dirname, 'src', 'Content.json');
const settingsPath = path.join(__dirname, 'src', 'VideoSettings.json');
const voiceDir     = path.join(__dirname, 'public', 'voiceovers');

// Read duration directly from WAV header (no extra deps needed)
function getWavDuration(filePath) {
    const buf = fs.readFileSync(filePath);
    const sampleRate   = buf.readUInt32LE(24);
    const channels     = buf.readUInt16LE(22);
    const bitsPerSample = buf.readUInt16LE(34);
    let dataSize = 0;
    for (let i = 12; i < buf.length - 8; i++) {
        if (buf.toString('ascii', i, i + 4) === 'data') {
            dataSize = buf.readUInt32LE(i + 4);
            break;
        }
    }
    return dataSize / (sampleRate * channels * (bitsPerSample / 8));
}

// Find speaker ID by name (exact first, then partial)
async function getSpeakerId(speakerName) {
    const { data: speakers } = await axios.get(`${VOICEVOX_URL}/speakers`);
    for (const s of speakers) {
        if (s.name === speakerName) return s.styles[0].id;
    }
    for (const s of speakers) {
        if (s.name.includes(speakerName) || speakerName.includes(s.name)) return s.styles[0].id;
    }
    const names = speakers.map(s => s.name).join(', ');
    throw new Error(`Speaker "${speakerName}" not found. Available: ${names}`);
}

async function synthesize(text, speakerId, outputPath, voiceSettings = {}) {
    const { data: query } = await axios.post(
        `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
        {}, { headers: { 'Content-Type': 'application/json' } }
    );
    // Apply per-segment voice tuning (fall back to query defaults if not set)
    if (voiceSettings.voiceSpeed     != null) query.speedScale      = voiceSettings.voiceSpeed;
    if (voiceSettings.voicePitch     != null) query.pitchScale      = voiceSettings.voicePitch;
    if (voiceSettings.voiceVolume    != null) query.volumeScale     = voiceSettings.voiceVolume;
    const { data: audio } = await axios.post(
        `${VOICEVOX_URL}/synthesis?speaker=${speakerId}`,
        query,
        { headers: { 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
    );
    fs.writeFileSync(outputPath, Buffer.from(audio));
}

async function main() {
    if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const defaultSpeakerName = settings.voicevoxSpeaker || 'ずんだもん';
    const speakerCache = new Map();

    async function resolveSpeakerId(speakerName) {
        if (!speakerCache.has(speakerName)) {
            console.log(`🎙️ Looking up VOICEVOX speaker "${speakerName}"...`);
            speakerCache.set(speakerName, await getSpeakerId(speakerName));
        }
        return speakerCache.get(speakerName);
    }

    let segments = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

    for (let i = 0; i < segments.length; i++) {
        const text     = segments[i].voiceover_text;
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

        const filePath = path.join(voiceDir, `segment_${i}.wav`);
        const speakerName = segments[i].voicevoxSpeaker || defaultSpeakerName;
        const speakerId = await resolveSpeakerId(speakerName);

        console.log(`🎙️ [${i + 1}/${segments.length}] ${speakerName} — ${text.substring(0, 40)}...`);
        await synthesize(text, speakerId, filePath, {
            voiceSpeed:  segments[i].voiceSpeed,
            voicePitch:  segments[i].voicePitch,
            voiceVolume: segments[i].voiceVolume,
        });

        const duration = getWavDuration(filePath);
        const prevAudioDur = segments[i].audioDuration;
        const prevSceneDur = segments[i].duration;
        const wasAutoSet = prevAudioDur == null || !prevSceneDur || Math.abs(prevSceneDur - (prevAudioDur + 0.5)) < 0.15;
        segments[i].audioDuration = duration;
        if (wasAutoSet) segments[i].duration = duration + 0.5;
        segments[i].audioFile = `segment_${i}.wav`;
        console.log(`   ✅ ${duration.toFixed(2)}s → segment_${i}.wav`);
    }

    fs.writeFileSync(contentPath, JSON.stringify(segments, null, 2));
    console.log('\n✅ All VOICEVOX audio generated.');
}

main().catch(err => {
    console.error('❌ VOICEVOX error:', err.message);
    console.error('Make sure VOICEVOX is running at http://localhost:50021');
    process.exit(1);
});
