import React from 'react';
import { Composition } from 'remotion';
import { HeroBackground } from './HeroBackground';
import { LogoAnimation } from './LogoAnimation';
import { TerminalDemo } from './TerminalDemo';
import { UseCaseSlides } from './UseCaseSlides';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HeroBackground"
        component={HeroBackground}
        durationInFrames={8 * 30}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LogoAnimation"
        component={LogoAnimation}
        durationInFrames={4 * 30}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="TerminalDemo"
        component={TerminalDemo}
        durationInFrames={16 * 30}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="UseCaseSlides"
        component={UseCaseSlides}
        durationInFrames={12 * 30}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
