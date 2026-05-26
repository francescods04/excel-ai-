import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

const BG = '#06090d';
const GREEN = '#00d4aa';
const AMBER = '#f0a040';
const TEXT = '#cdd6de';
const MUTED = '#7e8c9e';

const useCases = [
  { tag: 'Contabilità', title: 'Riconciliazione bancaria', before: '2 ore di cerca.vert e controlli', after: '"Riconcilia colonna B con D per data e importo"' },
  { tag: 'Bilancio', title: 'Riclassificazione CE', before: '3 ore di aggregazioni e formule', after: '"Riclassifica per margine di contribuzione"' },
  { tag: 'Revisione', title: 'Verifica incrociata', before: '4 ore di controlli a campione', after: '"Verifica che partitario e bilancio combacino"' },
  { tag: 'Fiscale', title: 'Calcolo imposte', before: '5 ore di calcoli e verifiche', after: '"Calcola IRES e IRAP su questo bilancio"' },
  { tag: 'Controllo', title: 'Analisi scostamenti', before: '3 ore tra Excel e PowerPoint', after: '"Analizza scostamenti >10% sulla colonna"' },
  { tag: 'Reporting', title: 'Dashboard KPI', before: '2 ore per ogni dashboard', after: '"Crea dashboard con KPI principali"' },
];

const SLIDE_DURATION = 55;
const TOTAL_SLIDES = useCases.length;

export const UseCaseSlides: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const currentSlide = Math.floor(frame / SLIDE_DURATION);
  const slideFrame = frame % SLIDE_DURATION;
  const uc = useCases[Math.min(currentSlide, TOTAL_SLIDES - 1)];

  const titleIn = spring({ frame: slideFrame, fps, from: 0, to: 1, config: { damping: 12, stiffness: 80 } });
  const cardIn = spring({ frame: slideFrame - 8, fps, from: 0, to: 1, config: { damping: 15, stiffness: 70 } });
  const beforeIn = spring({ frame: slideFrame - 18, fps, from: 0, to: 1, config: { damping: 15, stiffness: 60 } });
  const afterIn = spring({ frame: slideFrame - 28, fps, from: 0, to: 1, config: { damping: 15, stiffness: 60 } });

  const progress = TOTAL_SLIDES > 1 ? (currentSlide + slideFrame / SLIDE_DURATION) / TOTAL_SLIDES * 100 : 100;

  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {/* Progress dots */}
      <div style={{
        position: 'absolute', top: 40, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 10,
      }}>
        {useCases.map((_, i) => (
          <div key={i} style={{
            width: i === currentSlide ? 24 : 8, height: 8,
            borderRadius: 4,
            backgroundColor: i <= currentSlide ? GREEN : MUTED,
            opacity: i === currentSlide ? 1 : 0.4,
            transition: 'all 0.3s',
          }} />
        ))}
      </div>

      {/* Section label */}
      <div style={{
        position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)',
        fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
        color: GREEN, letterSpacing: 2, textTransform: 'uppercase',
        opacity: titleIn,
      }}>
        // {uc.tag}
      </div>

      {/* Title */}
      <div style={{
        position: 'absolute', top: 130, left: '50%', transform: `translateX(-50%) scale(${titleIn})`,
        fontFamily: 'serif', fontSize: 48, fontWeight: 500,
        color: TEXT, textAlign: 'center', lineHeight: 1.15,
        fontStyle: 'italic',
      }}>
        {uc.title}
      </div>

      {/* Before/After cards */}
      <div style={{
        position: 'absolute', top: 260, left: '50%', transform: `translateX(-50%)`,
        width: 760, display: 'flex', gap: 20,
      }}>
        {/* Before */}
        <div style={{
          flex: 1, backgroundColor: '#0c1118',
          border: `1px solid #1e2a36`, borderRadius: 12, padding: '28px 24px',
          opacity: beforeIn, transform: `translateY(${(1 - beforeIn) * 20}px)`,
        }}>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: MUTED, textTransform: 'uppercase', letterSpacing: 1.5,
            marginBottom: 12,
          }}>
            Prima
          </div>
          <div style={{
            fontSize: 16, color: MUTED, lineHeight: 1.6,
          }}>
            {uc.before}
          </div>
        </div>

        {/* Arrow */}
        <div style={{
          display: 'flex', alignItems: 'center',
          fontSize: 28, color: GREEN,
          opacity: interpolate(slideFrame, [22, 28], [0, 1], { extrapolateLeft: 'clamp' }),
          transform: `scale(${interpolate(slideFrame, [22, 28], [0.5, 1], { extrapolateLeft: 'clamp' })})`,
        }}>
          →
        </div>

        {/* After */}
        <div style={{
          flex: 1, backgroundColor: '#0c1118',
          border: `1px solid ${GREEN}`, borderRadius: 12, padding: '28px 24px',
          opacity: afterIn, transform: `translateY(${(1 - afterIn) * 20}px)`,
          boxShadow: `0 0 20px rgba(0,212,170,0.08)`,
        }}>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: GREEN, textTransform: 'uppercase', letterSpacing: 1.5,
            marginBottom: 12,
          }}>
            Dopo
          </div>
          <div style={{
            fontSize: 16, color: TEXT, lineHeight: 1.6,
            fontStyle: 'italic',
          }}>
            {uc.after}
          </div>
        </div>
      </div>

      {/* Bottom progress bar */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: 2,
        backgroundColor: '#1e2a36',
      }}>
        <div style={{
          width: `${progress}%`, height: '100%',
          backgroundColor: GREEN,
        }} />
      </div>
    </AbsoluteFill>
  );
};
