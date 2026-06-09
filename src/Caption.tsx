import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

interface CaptionProps {
    text: string;
    textStyle?: string;
    animation?: string;       // 'pop' | 'static' | 'fade' | 'fade-in' | 'fade-out' | 'fade-both' | 'wipe' | 'block'
    glowColor?: string;
    glowSize?: number;
    font?: string;
    position?: string;
    textHPosition?: string;  // horizontal screen position: 'left' | 'center' | 'right'
    textAlign?: string;      // text formatting: 'left' | 'center' | 'right'
    blockColor?: string;
    textColor?: string;
    textStrokeColor?: string;
    textStrokeSize?: number;
    boxBorderRadius?: number;
    blockBorderRadius?: number;
    totalDurationInFrames?: number;
    textX?: number;
    textY?: number;
    rotation?: number;
    fontSize?: number;
    glowTextColor?: string;
    startAtFrame?: number;
    hideAtFrame?: number;
    fadeInDurationSec?: number;
    fadeOutDurationSec?: number;
    noWrap?: boolean;
    textBoxWidth?: number; // percentage of video width, e.g. 85 = 85%
    textPadding?: number;  // padding in px for block/box styles (applied as px top/bottom and 2x px left/right)
}

export const Caption: React.FC<CaptionProps> = ({
    text,
    textStyle = 'box',
    animation = 'pop',
    glowColor = '#00ffff',
    glowSize = 1,
    font = 'noto',
    position = 'bottom',
    textHPosition = 'center',
    textAlign = 'center',
    blockColor = '#ffdd00',
    textColor = '#000000',
    textStrokeColor = '#000000',
    textStrokeSize = 0,
    boxBorderRadius = 20,
    blockBorderRadius = 10,
    totalDurationInFrames,
    textX,
    textY,
    rotation = 0,
    fontSize = 70,
    glowTextColor = 'white',
    startAtFrame,
    hideAtFrame,
    fadeInDurationSec = 1.5,
    fadeOutDurationSec = 1.5,
    noWrap = false,
    textBoxWidth,
    textPadding,
}) => {
    const { width: videoWidth } = useVideoConfig();
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    const isFreePos = textX !== undefined && textY !== undefined;
    const hasStarted = startAtFrame == null || frame >= startAtFrame;
    const localFrame = startAtFrame != null ? Math.max(0, frame - startAtFrame) : frame;

    const fadeInFrames = Math.max(8, Math.round((fadeInDurationSec || 1.5) * fps));
    const fadeOutFrames = Math.max(8, Math.round((fadeOutDurationSec || 1.5) * fps));
    const exitStart = totalDurationInFrames ? Math.max(0, totalDurationInFrames - fadeOutFrames) : Infinity;
    const hideFrames = Math.max(8, Math.round((fadeOutDurationSec || 1.5) * fps));

    const hideOp = (hideAtFrame != null && frame >= hideAtFrame - hideFrames)
        ? Math.max(0, interpolate(frame, [hideAtFrame - hideFrames, hideAtFrame], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.inOut(Easing.ease),
        }))
        : 1;

    const exitFade = totalDurationInFrames && frame >= exitStart
        ? interpolate(frame, [exitStart, totalDurationInFrames], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.inOut(Easing.ease),
        })
        : 1;

    let scale = 1;
    let opacity = hideOp;
    let textRevealOpacity = 1;
    let clipPath: string | undefined;
    // wipe: block sweeps left-to-right revealing text underneath
    let wipeSweepX = -105; // translateX % of the block cover
    let showWipeCover = false;

    if (!hasStarted) {
        scale = 1;
        opacity = 0;
        textRevealOpacity = 0;
    } else {
        switch (animation) {
            case 'static': {
                opacity = hideOp;
                break;
            }
            case 'fade':
            case 'fade-both': {
                const fadeIn = interpolate(localFrame, [0, fadeInFrames], [0, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                    easing: Easing.out(Easing.cubic),
                });
                opacity = fadeIn * exitFade * hideOp;
                break;
            }
            case 'fade-in': {
                // Fades in at start, stays fully visible — no exit fade
                const fadeIn = interpolate(localFrame, [0, fadeInFrames], [0, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                    easing: Easing.out(Easing.cubic),
                });
                opacity = fadeIn * hideOp;
                break;
            }
            case 'fade-out': {
                // Appears immediately, fades out at end
                opacity = exitFade * hideOp;
                break;
            }
            case 'wipe': {
                // Phase 1: coloured block sweeps left→right over the text (covers it)
                // Phase 2: block continues sweeping right, revealing text behind it
                const sweepMid = Math.max(8, Math.round(fadeInFrames * 0.45));
                wipeSweepX = interpolate(localFrame, [0, sweepMid, fadeInFrames], [-105, 0, 105], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                    easing: Easing.inOut(Easing.ease),
                });
                showWipeCover = localFrame < fadeInFrames;
                // Text fades in from behind the block as it sweeps away
                textRevealOpacity = interpolate(localFrame, [sweepMid, fadeInFrames], [0, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                    easing: Easing.out(Easing.cubic),
                });
                opacity = exitFade * hideOp;
                break;
            }
            default: {
                // Pop: scale in place using transform-origin center
                const popFrames = Math.max(14, Math.min(24, fadeInFrames));
                scale = interpolate(localFrame, [0, Math.round(popFrames * 0.35), Math.round(popFrames * 0.7), popFrames], [0.7, 1.12, 0.98, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                    easing: Easing.inOut(Easing.ease),
                });
                opacity = exitFade * hideOp;
            }
        }
    }

    const fontMap: Record<string, string> = {
        noto:        '"Noto Sans JP", sans-serif',
        dela:        '"Dela Gothic One", sans-serif',
        notoserifJP: '"Noto Serif JP", serif',
        bebas:       '"Bebas Neue", sans-serif',
        oswald:      '"Oswald", sans-serif',
        bangers:     '"Bangers", sans-serif',
        mplus:       '"M PLUS Rounded 1c", sans-serif',
    };
    const fontFamily = fontMap[font] ?? '"Noto Sans JP", sans-serif';

    const positionStyle = (() => {
        const vertical = (() => {
            switch (position) {
                case 'top':    return { justifyContent: 'flex-start' as const, paddingTop: 150 };
                case 'center': return { justifyContent: 'center' as const };
                default:       return { justifyContent: 'flex-end' as const, paddingBottom: 200 };
            }
        })();
        const horizontal = (() => {
            switch (textHPosition) {
                case 'left':   return { alignItems: 'flex-start' as const, paddingLeft: 60 };
                case 'right':  return { alignItems: 'flex-end' as const, paddingRight: 60 };
                default:       return { alignItems: 'center' as const };
            }
        })();
        return { ...vertical, ...horizontal };
    })();

    const shellTransform: React.CSSProperties = isFreePos
        ? { position: 'absolute' as const, left: `${textX}%`, top: `${textY}%`, transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`, transformOrigin: 'center center' }
        : { transform: `rotate(${rotation}deg) scale(${scale})`, transformOrigin: 'center center' };

    const strokeWidth = Math.max(0, Number(textStrokeSize) || 0);
    const blockBorderStyle = strokeWidth > 0
        ? { border: `${strokeWidth}px solid ${textStrokeColor}`, boxSizing: 'border-box' as const }
        : {};
    const glowAmount = Math.max(0, Number(glowSize) || 0);
    const glowShadow = glowAmount > 0
        ? [
            `0 0 ${Math.max(1, Math.round(glowAmount * 0.5))}px ${glowColor}`,
            `0 0 ${Math.max(2, Math.round(glowAmount))}px ${glowColor}`,
            `0 0 ${Math.max(3, Math.round(glowAmount * 2))}px ${glowColor}`,
            `0 0 ${Math.max(4, Math.round(glowAmount * 4))}px ${glowColor}`,
            `0 2px 8px rgba(0,0,0,0.9)`
        ].join(', ')
        : '0 2px 8px rgba(0,0,0,0.9)';

    // Width: compute in pixels to avoid CSS circular dependency (% on inline-block has no definite containing block)
    const resolvedMaxWidthPx = textBoxWidth != null
        ? Math.round(videoWidth * textBoxWidth / 100)
        : Math.round(videoWidth * 0.85);
    // noWrap: override width to be unconstrained so text never wraps
    const widthStyle: React.CSSProperties = noWrap
        ? { whiteSpace: 'pre' as const, width: 'max-content', maxWidth: 'none', overflow: 'visible' }
        : {};

    let textContentStyle: React.CSSProperties;
    const blockPad = textPadding != null ? `${textPadding}px ${textPadding * 2}px` : '18px 40px';
    const boxPad   = textPadding != null ? `${textPadding}px ${textPadding * 2}px` : '25px 45px';
    if (textStyle === 'block') {
        textContentStyle = { textAlign: textAlign as any, padding: blockPad, borderRadius: `${blockBorderRadius}px`, backgroundColor: blockColor, color: textColor, fontSize, fontWeight: '900', fontFamily, lineHeight: 1.3, ...blockBorderStyle, ...widthStyle };
    } else if (textStyle === 'glow') {
        textContentStyle = { textAlign: textAlign as any, padding: '0 30px', color: glowTextColor, fontSize, fontWeight: '900', fontFamily, lineHeight: 1.3, WebkitTextStroke: `${Math.max(1, Math.round(glowAmount * 0.2))}px ${glowColor}`, textShadow: glowShadow, ...widthStyle };
    } else if (textStyle === 'shadow') {
        textContentStyle = { textAlign: textAlign as any, padding: '0 30px', color: textColor, fontSize, fontWeight: '900', fontFamily, lineHeight: 1.3, textShadow: '2px 3px 6px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.6)', ...widthStyle };
    } else if (textStyle === 'plain') {
        textContentStyle = { textAlign: textAlign as any, padding: '0 30px', color: textColor || 'white', fontSize, fontWeight: '900', fontFamily, lineHeight: 1.3, ...widthStyle };
    } else {
        textContentStyle = { backgroundColor: 'rgba(0,0,0,0.7)', padding: boxPad, borderRadius: `${boxBorderRadius}px`, textAlign: textAlign as any, color: textColor || 'white', fontSize, fontWeight: '600', fontFamily, ...widthStyle };
    }

    const shellBorderRadius = textStyle === 'block'
        ? `${blockBorderRadius}px`
        : textStyle === 'box'
            ? `${boxBorderRadius}px`
            : '10px';
    const stripColor = textStyle === 'glow' ? glowColor : blockColor;

    return (
        <AbsoluteFill style={isFreePos ? {} : positionStyle}>
            <div style={{ ...shellTransform, opacity, clipPath, display: 'inline-block', position: isFreePos ? 'absolute' : 'relative', overflow: noWrap ? 'visible' : undefined, width: noWrap ? undefined : `${resolvedMaxWidthPx}px`, textAlign: textAlign as any }}>
                <div style={{ position: 'relative', display: 'inline-block', overflow: (animation === 'wipe' && !noWrap) ? 'hidden' : 'visible', borderRadius: shellBorderRadius }}>
                    {showWipeCover && (
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                backgroundColor: stripColor,
                                transform: `translateX(${wipeSweepX}%)`,
                                borderRadius: shellBorderRadius,
                                pointerEvents: 'none',
                                zIndex: 2,
                            }}
                        />
                    )}
                    <div style={{ ...textContentStyle, position: 'relative', zIndex: 1, opacity: animation === 'wipe' ? textRevealOpacity : 1 }}>
                        {String(text ?? '').split('\n').map((line, idx, arr) => (
                            <React.Fragment key={idx}>
                                {line}
                                {idx < arr.length - 1 && <br />}
                            </React.Fragment>
                        ))}
                    </div>
                </div>
            </div>
        </AbsoluteFill>
    );
};
