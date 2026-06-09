import React from "react";
import { OffthreadVideo, Img, AbsoluteFill, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate } from "remotion";

interface BackgroundProps {
    src: string;
    videoDurationInSeconds?: number | null;
    sequenceDurationInFrames?: number;
    backgroundType?: string;
    backgroundColor?: string;
    gradientStart?: string;
    gradientEnd?: string;
    gradientDirection?: string;
    backgroundScale?: number;
    backgroundX?: number;
    backgroundY?: number;
    kenBurns?: boolean;
    videoSpeed?: number;         // e.g. 0.5, 1, 2 — applied as playbackRate
    overlayType?: string;        // 'none' | 'dark' | 'spotlight'
    overlayOpacity?: number;     // 0–1
    spotlightRadius?: number;    // 0–100 (% of frame — clear center area)
    spotlightSoftness?: number;  // 0–100 (% — transition width)
    backgroundBlur?: number;     // 0–100 % blur (converted to 0–20 px internally)
    videoAudioVolume?: number;   // 0–1; 0 = muted (default for stock/looping video)
    videoFit?: 'cover' | 'contain-black' | 'contain-blur'; // how a landscape video fills a portrait frame
    clipStart?: number;          // seconds into the video to start the clip
    clipEnd?: number;            // seconds into the video to end the clip
}

export const Background: React.FC<BackgroundProps> = ({
    src,
    videoDurationInSeconds,
    sequenceDurationInFrames,
    backgroundType,
    backgroundColor,
    gradientStart,
    gradientEnd,
    gradientDirection = "to bottom",
    backgroundScale = 1,
    backgroundX = 0,
    backgroundY = 0,
    kenBurns = true,
    videoSpeed = 1,
    videoFit = 'cover',
    overlayType,
    overlayOpacity = 0.5,
    spotlightRadius = 30,
    spotlightSoftness = 25,
    backgroundBlur = 0,
    videoAudioVolume = 0,
    clipStart,
    clipEnd,
}) => {
    const { fps } = useVideoConfig();
    const frame = useCurrentFrame();

    // Ken Burns values (computed unconditionally to satisfy React hook rules)
    const totalFrames = sequenceDurationInFrames || 150;
    const kbScale = interpolate(frame, [0, totalFrames], [1.0, 1.1], { extrapolateRight: "clamp" });
    const kbTx    = interpolate(frame, [0, totalFrames], [0, -3],    { extrapolateRight: "clamp" });
    const kbTy    = interpolate(frame, [0, totalFrames], [0, -2],    { extrapolateRight: "clamp" });

    const speed    = Math.max(0.1, Number(videoSpeed) || 1);
    const audioVol = Math.max(0, Math.min(1, Number(videoAudioVolume) || 0));
    const op      = Math.max(0, Math.min(1, Number(overlayOpacity) ?? 0.5));
    const sRadius = Math.max(0, Math.min(100, Number(spotlightRadius) ?? 30));
    const sSoft   = Math.max(0, Math.min(100 - sRadius, Number(spotlightSoftness) ?? 25));
    const blurPct = Math.max(0, Number(backgroundBlur) || 0);
    const blurPx  = blurPct * 0.2; // 0–100 % stored → 0–20 px CSS
    // Blur wrapper: applied around background content only (overlay stays sharp)
    const blurWrapStyle: React.CSSProperties = blurPct > 0
        ? { position: 'absolute', inset: 0, filter: `blur(${blurPx}px)`, overflow: 'hidden' }
        : { position: 'absolute', inset: 0 };

    // ── Overlay element (placed on top of every background type) ──
    const overlay = (overlayType && overlayType !== 'none') ? (
        <AbsoluteFill style={{ pointerEvents: 'none' as const }}>
            {overlayType === 'spotlight' ? (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    background: `radial-gradient(circle at center, transparent 0%, transparent ${sRadius}%, rgba(0,0,0,${op}) ${Math.min(100, sRadius + sSoft)}%)`,
                }} />
            ) : (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundColor: `rgba(0,0,0,${op})`,
                }} />
            )}
        </AbsoluteFill>
    ) : null;

    // ── Solid colour ──
    if (backgroundType === "color") {
        return (
            <AbsoluteFill>
                <div style={{ ...blurWrapStyle, backgroundColor: backgroundColor || "#000000" }} />
                {overlay}
            </AbsoluteFill>
        );
    }

    // ── Gradient ──
    if (backgroundType === "gradient") {
        return (
            <AbsoluteFill>
                <div style={{ ...blurWrapStyle, background: `linear-gradient(${gradientDirection}, ${gradientStart || "#000000"}, ${gradientEnd || "#ffffff"})` }} />
                {overlay}
            </AbsoluteFill>
        );
    }

    // ── Image (with optional Ken Burns effect) ──
    if (backgroundType === "image") {
        if (!src) return <AbsoluteFill style={{ backgroundColor: "#000" }}>{overlay}</AbsoluteFill>;
        const resolvedImg = src.startsWith("http")
            ? src
            : staticFile(src.includes("/") ? src : `backgrounds/${src}`);
        const imgScale = Math.max(1, Number(backgroundScale) || 1);
        const imgX = Math.max(-100, Math.min(100, Number(backgroundX) || 0));
        const imgY = Math.max(-100, Math.min(100, Number(backgroundY) || 0));
        const imgTransform = kenBurns
            ? `translate(${imgX}%, ${imgY}%) scale(${imgScale * kbScale}) translate(${kbTx}%, ${kbTy}%)`
            : `translate(${imgX}%, ${imgY}%) scale(${imgScale})`;
        return (
            <AbsoluteFill style={{ overflow: "hidden" }}>
                <div style={blurWrapStyle}>
                    <Img
                        src={resolvedImg}
                        style={{
                            position: "absolute",
                            width: "114%",
                            height: "114%",
                            top: "-7%",
                            left: "-7%",
                            objectFit: "cover",
                            transform: imgTransform,
                            transformOrigin: "center center",
                        }}
                    />
                </div>
                {overlay}
            </AbsoluteFill>
        );
    }

    // ── Video (default) ──
    if (!src) return <AbsoluteFill style={{ backgroundColor: "#000" }}>{overlay}</AbsoluteFill>;

    const resolvedSrc = src.startsWith("http")
        ? src
        : staticFile(src.includes("/") ? src : `backgrounds/${src}`);
    const videoScale = Math.max(1, Number(backgroundScale) || 1);
    const videoX = Math.max(-100, Math.min(100, Number(backgroundX) || 0));
    const videoY = Math.max(-100, Math.min(100, Number(backgroundY) || 0));

    // cover = fill frame (default), contain = letterbox
    const fitMode: 'cover' | 'contain' = (videoFit === 'contain-black' || videoFit === 'contain-blur') ? 'contain' : 'cover';

    // object-position pans the video content within the element — this correctly reveals
    // left/right of landscape videos. translate() only moves the element box and doesn't
    // expose new content when object-fit:cover has already cropped a landscape source.
    const objX = 50 + videoX / 2;
    const objY = 50 + videoY / 2;
    const videoStyle = {
        width: "100%",
        height: "100%",
        objectFit: fitMode,
        objectPosition: `${objX}% ${objY}%` as const,
        transform: `scale(${videoScale})`,
        transformOrigin: "center center" as const,
    };

    // Blurred full-frame cover style used as background layer for contain-blur mode
    const blurBgStyle: React.CSSProperties = {
        width: "100%",
        height: "100%",
        objectFit: "cover" as const,
        objectPosition: "center center" as const,
    };

    // Clip boundaries (in seconds)
    const clipStartSecs = Math.max(0, Number(clipStart) || 0);
    const clipEndSecs = (clipEnd != null && Number(clipEnd) > clipStartSecs) ? Number(clipEnd) : null;
    // Effective duration for one loop cycle: clip range, or full video minus start
    const effectiveVideoDuration = clipEndSecs
        ? clipEndSecs - clipStartSecs
        : (videoDurationInSeconds ? videoDurationInSeconds - clipStartSecs : null);

    // Helper: render video sequences for manual-loop (when duration is known)
    const renderLoopSequences = (style: React.CSSProperties, muted: boolean) => {
        const startFromFrames = Math.round(clipStartSecs * fps);
        const loopFrames = Math.max(1, Math.round((effectiveVideoDuration as number) * fps / speed));
        const numLoops = Math.ceil((sequenceDurationInFrames as number) / loopFrames) + 1;
        return Array.from({ length: numLoops }).map((_, idx) => (
            <Sequence key={idx} from={idx * loopFrames} durationInFrames={loopFrames}>
                <OffthreadVideo
                    src={resolvedSrc}
                    style={style}
                    startFrom={startFromFrames}
                    {...(muted ? { muted: true } : { volume: audioVol })}
                    playbackRate={speed}
                />
            </Sequence>
        ));
    };

    // ── contain-blur: blurred fill behind + sharp contained video on top ──
    if (videoFit === 'contain-blur') {
        const blurLayerStyle: React.CSSProperties = {
            position: 'absolute', inset: 0,
            filter: 'blur(18px)',
            transform: 'scale(1.06)', // avoid white edges from blur
            transformOrigin: 'center',
            overflow: 'hidden',
        };
        const containLayerStyle: React.CSSProperties = { position: 'absolute', inset: 0 };

        if (effectiveVideoDuration && effectiveVideoDuration > 0 && sequenceDurationInFrames) {
            return (
                <AbsoluteFill style={{ backgroundColor: '#000' }}>
                    {/* Blurred background */}
                    <div style={blurLayerStyle}>
                        {renderLoopSequences(blurBgStyle, true)}
                    </div>
                    {/* Sharp contained video */}
                    <div style={containLayerStyle}>
                        {renderLoopSequences(videoStyle, audioVol <= 0)}
                    </div>
                    {overlay}
                </AbsoluteFill>
            );
        }
        return (
            <AbsoluteFill style={{ backgroundColor: '#000' }}>
                <div style={blurLayerStyle}>
                    <OffthreadVideo src={resolvedSrc} style={blurBgStyle} muted loop startFrom={Math.round(clipStartSecs * fps)} playbackRate={speed} />
                </div>
                <div style={containLayerStyle}>
                    <OffthreadVideo
                        src={resolvedSrc}
                        style={videoStyle}
                        {...(audioVol > 0 ? { volume: audioVol } : { muted: true })}
                        loop
                        startFrom={Math.round(clipStartSecs * fps)}
                        playbackRate={speed}
                    />
                </div>
                {overlay}
            </AbsoluteFill>
        );
    }

    // ── contain-black: black bars, video contained ──
    // ── cover (default): fill frame ──
    const bgColor = videoFit === 'contain-black' ? '#000000' : undefined;

    // Manual looping via stacked Sequences when video duration is known (Pexels / stock / clipped)
    if (effectiveVideoDuration && effectiveVideoDuration > 0 && sequenceDurationInFrames) {
        return (
            <AbsoluteFill style={bgColor ? { backgroundColor: bgColor } : {}}>
                <div style={blurWrapStyle}>
                    {renderLoopSequences(videoStyle, audioVol <= 0)}
                </div>
                {overlay}
            </AbsoluteFill>
        );
    }

    // Fallback: local files — loop prop handles looping natively
    return (
        <AbsoluteFill style={bgColor ? { backgroundColor: bgColor } : {}}>
            <div style={blurWrapStyle}>
                <OffthreadVideo
                    src={resolvedSrc}
                    style={videoStyle}
                    {...(audioVol > 0 ? { volume: audioVol } : { muted: true })}
                    loop
                    startFrom={Math.round(clipStartSecs * fps)}
                    playbackRate={speed}
                />
            </div>
            {overlay}
        </AbsoluteFill>
    );
};
