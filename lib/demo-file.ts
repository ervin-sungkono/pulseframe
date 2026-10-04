import { generateDemo } from './audio-dsp.mjs';
export function makeDemoFile(): File {
  const rate = 44100, channels = generateDemo(rate, 32), length = channels[0].length;
  const bytes = new ArrayBuffer(44 + length * 4), view = new DataView(bytes);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length * 4, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length * 4, true);
  for (let i = 0; i < length; i++) for (let c = 0; c < 2; c++) view.setInt16(44 + i * 4 + c * 2, Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), true);
  return new File([bytes], 'Glasshouse — sample.wav', { type: 'audio/wav' });
}
