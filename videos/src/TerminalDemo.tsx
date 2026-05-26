import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

const BG = '#06090d';
const SURFACE = '#0c1118';
const GREEN = '#00d4aa';
const AMBER = '#f0a040';
const TEXT = '#cdd6de';
const MUTED = '#7e8c9e';
const BORDER = '#1e2a36';
const RED = '#ff5c6c';

const terminalLines = [
  { time: 0, type: 'prompt', text: '$', cmd: 'crea un foglio di bilancio con ricavi, costi e margine' },
  { time: 60, type: 'output', text: '→ Analisi del foglio attuale in corso...' },
  { time: 90, type: 'output', text: '→ Struttura rilevata (colonne: Data, Descrizione, Importo)' },
  { time: 120, type: 'output', text: '→ Piano: 6 azioni preparate' },
  { time: 150, type: 'action', num: 1, total: 6, action: 'INSERT_ROW', detail: 'A1:C1 | "Ricavi" | "Costi" | "Margine"' },
  { time: 180, type: 'action', num: 2, total: 6, action: 'SET_FORMULA', detail: 'C2 | =A2-B2' },
  { time: 210, type: 'action', num: 3, total: 6, action: 'SET_FORMAT', detail: 'Valuta €, grassetto intestazioni, bordi' },
  { time: 240, type: 'action', num: 4, total: 6, action: 'SET_FORMULA', detail: 'D2 | =C2/A2*100 (margine %)' },
  { time: 270, type: 'action', num: 5, total: 6, action: 'AUTO_FILL', detail: 'C2:D2 → C3:D50' },
  { time: 300, type: 'action', num: 6, total: 6, action: 'CREATE_CHART', detail: 'A1:D50 → grafico a barre' },
  { time: 330, type: 'output', text: '→ In attesa di autorizzazione...' },
  { time: 360, type: 'prompt', text: '$', cmd: '' },
];

export const TerminalDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const w = Math.min(width * 0.72, 960);
  const h = Math.min(height * 0.7, 640);
  const x = (width - w) / 2;
  const y = (height - h) / 2 - 20;

  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {/* Subtle background */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 30%, rgba(0,212,170,0.03) 0%, transparent 60%)`,
      }} />

      {/* Title */}
      <div style={{
        position: 'absolute', top: y - 60, left: x,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11, color: GREEN, letterSpacing: 2, textTransform: 'uppercase',
        opacity: interpolate(frame, [0, 15], [0, 1]),
      }}>
        // Excel AI — Demo interattiva
      </div>

      {/* Terminal window */}
      <div style={{
        position: 'absolute', left: x, top: y, width: w, height: h,
        backgroundColor: '#020408',
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        opacity: spring({ frame, fps, from: 0, to: 1, config: { damping: 15 } }),
        transform: `scale(${spring({ frame, fps, from: 0.95, to: 1, config: { damping: 12 } })})`,
      }}>
        {/* Title bar */}
        <div style={{
          height: 36, backgroundColor: SURFACE,
          borderBottom: `1px solid ${BORDER}`,
          display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8,
        }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: RED }} />
          <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: AMBER }} />
          <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: GREEN }} />
          <div style={{ marginLeft: 12, fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: MUTED }}>
            excel-agent ~ audit-trail
          </div>
        </div>

        {/* Terminal body */}
        <div style={{
          padding: '20px 24px',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 13, lineHeight: 1.9,
        }}>
          {terminalLines.map((line, i) => {
            const appearAt = line.time / (30 / fps);
            const opacity = interpolate(frame, [appearAt, appearAt + 8], [0, 1], { extrapolateLeft: 'clamp' });

            if (frame < appearAt) return <div key={i} style={{ height: 13 * 1.9 }} />;

            if (line.type === 'prompt') {
              return (
                <div key={i} style={{ opacity }}>
                  <span style={{ color: GREEN }}>$</span>
                  <span style={{ color: TEXT, marginLeft: 8 }}>{line.cmd}</span>
                  {line.cmd === '' && frame >= line.time / (30 / fps) + 15 && (
                    <span style={{
                      display: 'inline-block', width: 8, height: 16,
                      backgroundColor: GREEN, verticalAlign: 'middle', marginLeft: 2,
                      animation: 'none',
                      opacity: Math.sin(frame * 0.3) > 0 ? 1 : 0,
                    }} />
                  )}
                </div>
              );
            }

            if (line.type === 'output') {
              return (
                <div key={i} style={{ opacity, color: MUTED }}>{line.text}</div>
              );
            }

            if (line.type === 'action') {
              return (
                <div key={i} style={{ opacity }}>
                  <span style={{ color: AMBER, fontWeight: 500 }}>[{line.num}/{line.total}] {line.action}</span>
                  <span style={{ color: MUTED, marginLeft: 8 }}>| {line.detail}</span>
                </div>
              );
            }

            return null;
          })}
        </div>
      </div>

      {/* Progress bar at bottom */}
      <div style={{
        position: 'absolute', bottom: 60, left: x, width: w, height: 2,
        backgroundColor: BORDER, borderRadius: 1,
      }}>
        <div style={{
          width: `${interpolate(frame, [0, 420], [0, 100], { extrapolateRight: 'clamp' })}%`,
          height: '100%', backgroundColor: GREEN,
          transition: 'width 0.1s',
        }} />
      </div>
      <div style={{
        position: 'absolute', bottom: 40, left: x,
        fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: MUTED,
      }}>
        {frame < 420 ? 'Elaborazione in corso...' : 'In attesa di approvazione'}
      </div>
    </AbsoluteFill>
  );
};
