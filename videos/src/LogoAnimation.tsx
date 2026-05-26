import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

const BG = '#06090d';
const GREEN = '#00d4aa';

export const LogoAnimation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, from: 0, to: 1, config: { damping: 10, stiffness: 100 } });
  const opacity = spring({ frame: frame - 10, fps, from: 0, to: 1, config: { damping: 20 } });
  const glowOpacity = interpolate(frame, [30, 40, 60, 80], [0, 1, 0.6, 0.3], { extrapolateRight: 'clamp' });
  const barWidth = spring({ frame: frame - 5, fps, from: 0, to: 1, config: { damping: 15, stiffness: 80 } });

  return (
    <AbsoluteFill style={{ backgroundColor: BG, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Glow pulse */}
      <div style={{
        position: 'absolute',
        width: 400, height: 400,
        borderRadius: '50%',
        background: `radial-gradient(circle, rgba(0,212,170,0.2) 0%, transparent 60%)`,
        opacity: glowOpacity,
        transform: `scale(${1 + 0.3 * glowOpacity})`,
      }} />

      {/* Central logo */}
      <div style={{
        transform: `scale(${scale})`,
        display: 'flex', alignItems: 'center', gap: 16,
        opacity,
      }}>
        {/* Mark */}
        <div style={{
          width: 80, height: 80,
          backgroundColor: GREEN,
          borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 36, fontWeight: 700,
          color: BG,
          boxShadow: `0 0 60px rgba(0,212,170,0.4)`,
        }}>
          E
        </div>

        {/* Text + bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 32, fontWeight: 500,
            color: '#cdd6de', letterSpacing: 2,
          }}>
            EXCEL AI
          </div>
          <div style={{
            width: 200, height: 2,
            backgroundColor: GREEN,
            opacity: 0.5,
          }}>
            <div style={{
              width: '100%', height: '100%',
              backgroundColor: GREEN,
              transform: `scaleX(${barWidth})`,
              transformOrigin: 'left',
              opacity: 0.8,
            }} />
          </div>
        </div>
      </div>

      {/* Subtitle */}
      <div style={{
        position: 'absolute', bottom: 200,
        fontFamily: 'serif',
        fontSize: 24, fontStyle: 'italic',
        color: GREEN, opacity: interpolate(frame, [40, 60], [0, 0.6], { extrapolateRight: 'clamp' }),
      }}>
        Assistente AI per professionisti finanziari
      </div>
    </AbsoluteFill>
  );
};
