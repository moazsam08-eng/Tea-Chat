const sampleRate = 8_000;
const sampleCount = sampleRate * 5;
const dataSize = sampleCount * 2;
const buffer = new ArrayBuffer(44 + dataSize);
const view = new DataView(buffer);

function writeText(offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

writeText(0, 'RIFF');
view.setUint32(4, 36 + dataSize, true);
writeText(8, 'WAVE');
writeText(12, 'fmt ');
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, sampleRate, true);
view.setUint32(28, sampleRate * 2, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
writeText(36, 'data');
view.setUint32(40, dataSize, true);

const bytes = new Uint8Array(buffer);
let binary = '';
for (let offset = 0; offset < bytes.length; offset += 16_000) {
  binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_000));
}

export const sampleAudio = `data:audio/wav;base64,${window.btoa(binary)}`;
