import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

const COLORS = {
  bg: '#06090d',
  grid: 'rgba(255,255,255,0.025)',
  accent: '#00d4aa',
  accentDim: 'rgba(0,212,170,0.15)',
  amber: '#f0a040',
  amberDim: 'rgba(240,160,64,0.1)',
  text: '#cdd6de',
  muted: '#4a5666',
};

function noise(x: number, y: number, t: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 0.5) * 43758.5453;
  return n - Math.floor(n);
}

export const HeroBackground: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame * 0.02;

  const gridSize = 80;
  const cols = Math.ceil(width / gridSize) + 1;
  const rows = Math.ceil(height / gridSize) + 1;

  const gridLines = useMemo(() => {
    const lines: React.ReactNode[] = [];
    for (let i = 0; i <= cols; i++) {
      const x = i * gridSize;
      const opacity = 0.3 + 0.7 * (1 - Math.abs(i - cols / 2) / (cols / 2)) * 0.5;
      lines.push(
        <line key={`v${i}`} x1={x} y1={0} x2={x} y2={height}
          stroke={COLORS.grid} strokeWidth={1}
          style={{ opacity }} />
      );
    }
    for (let j = 0; j <= rows; j++) {
      const y = j * gridSize;
      const opacity = 0.3 + 0.7 * (1 - Math.abs(j - rows / 2) / (rows / 2)) * 0.5;
      lines.push(
        <line key={`h${j}`} x1={0} y1={y} x2={width} y2={y}
          stroke={COLORS.grid} strokeWidth={1}
          style={{ opacity }} />
      );
    }
    return lines;
  }, [cols, rows, width, height]);

  const particles = useMemo(() => {
    const pts: { x: number; y: number; size: number; speed: number; phase: number }[] = [];
    for (let i = 0; i < 60; i++) {
      pts.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 3 + 1,
        speed: Math.random() * 0.3 + 0.05,
        phase: Math.random() * Math.PI * 2,
      });
    }
    return pts;
  }, [width, height]);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      {/* Radial glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 0%, ${COLORS.accentDim} 0%, transparent 60%),
                     radial-gradient(ellipse at 80% 20%, ${COLORS.amberDim} 0%, transparent 50%)`,
        opacity: 0.6,
      }} />

      {/* Noise texture */}
      <svg style={{ position: 'absolute', inset: 0, opacity: 0.03 }}>
        <filter id="noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#noise)" />
      </svg>

      {/* Grid */}
      <svg style={{ position: 'absolute', inset: 0 }}>
        {gridLines}
      </svg>

      {/* Particles */}
      <svg style={{ position: 'absolute', inset: 0 }}>
        {particles.map((p, i) => {
          const px = (p.x + Math.sin(t * p.speed + p.phase) * 40 + width) % width;
          const py = (p.y + Math.cos(t * p.speed * 1.3 + p.phase) * 30 + height) % height;
          const alpha = 0.15 + 0.35 * Math.sin(t * 0.8 + p.phase);
          const isAccent = i % 5 === 0;
          return (
            <circle key={i} cx={px} cy={py} r={p.size}
              fill={isAccent ? COLORS.accent : COLORS.text}
              style={{ opacity: alpha }} />
          );
        })}
      </svg>

      {/* Ambient data lines */}
      <svg style={{ position: 'absolute', inset: 0, opacity: 0.08 }}>
        {[0, 1, 2, 3, 4].map(i => (
          <path key={`line${i}`}
            d={`M ${-100 + i * 400} ${height * 0.3 + i * 80} Q ${width * 0.5 + Math.sin(t + i) * 200} ${height * 0.2 + Math.cos(t * 0.7 + i) * 100}, ${width + 100} ${height * 0.5 + i * 60}`}
            stroke={i % 2 === 0 ? COLORS.accent : COLORS.amber}
            strokeWidth={1.5}
            fill="none"
          />
        ))}
      </svg>

      {/* Center glow pulse */}
      <div style={{
        position: 'absolute',
        left: '50%', top: '35%',
        transform: 'translate(-50%, -50%)',
        width: 600, height: 200,
        background: `radial-gradient(ellipse, ${COLORS.accentDim} 0%, transparent 70%)`,
        opacity: 0.5 + 0.3 * Math.sin(t * 0.5),
      }} />

      {/* Floating text - Excel AI */}
      <div style={{
        position: 'absolute',
        left: '50%', top: '38%',
        transform: 'translate(-50%, -50%)',
        textAlign: 'center',
        opacity: 0.15 + 0.05 * Math.sin(t * 0.3),
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 14, color: COLORS.muted,
          letterSpacing: 4, marginBottom: 8,
        }}>
          DEEPSEEK v4
        </div>
        <div style={{
          fontFamily: 'serif',
          fontSize: 80, fontWeight: 500,
          color: COLORS.text,
          letterSpacing: -2,
          fontStyle: 'italic',
        }}>
          Excel<span style={{ color: COLORS.accent }}>AI</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
