import { STICKERS, type StickerId } from '../shared/protocol';
import { currentMode } from '../theme/tokens';

type Tone = { bg: string; edge: string; text: string };
type ToneName = 'ice' | 'warm' | 'neutral' | 'alert';
const tones: Record<'dark' | 'light', Record<ToneName, Tone>> = {
  dark: {
    ice: { bg: '#123A57', edge: '#2B6D96', text: '#CDEBFF' },
    warm: { bg: '#3B2A17', edge: '#7A5326', text: '#FFE2B8' },
    neutral: { bg: '#1E2A55', edge: '#3A4A86', text: '#DCE3FF' },
    alert: { bg: '#3D1720', edge: '#8A2C3A', text: '#FFD3D8' },
  },
  light: {
    ice: { bg: '#E4F2FC', edge: '#A3CDEA', text: '#0F4C75' },
    warm: { bg: '#FFF1DD', edge: '#EAC28A', text: '#7A4A0C' },
    neutral: { bg: '#EAEEFB', edge: '#B7C1E8', text: '#26346B' },
    alert: { bg: '#FDE7EA', edge: '#F0A9B2', text: '#8A1C2B' },
  },
};

/** Sticker colours for the active theme. */
export const stickerTone: Record<ToneName, Tone> = new Proxy({} as Record<ToneName, Tone>, { get: (_, k) => tones[currentMode()][k as ToneName] });

export const stickerById = (id: StickerId) => STICKERS.find((s) => s.id === id) ?? STICKERS[0];
