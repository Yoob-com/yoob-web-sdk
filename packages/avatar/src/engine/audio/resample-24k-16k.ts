// scipy.signal.resample_poly(x, 2, 3), Kaiser(beta=5), copied from the validated
// native 24 kHz TTS-to-avatar resampling implementation.
export const RESAMPLE_FILTER = new Float32Array([
  0, 0, 0, -9.546140932e-19, -0.001015151618, -0.001434323029,
  2.47261904e-18, 0.002551661804, 0.003272651462, -4.659273471e-18,
  -0.005103380419, -0.006242331583, 7.47593099e-18, 0.009052845649,
  0.01076549385, -1.07889738e-17, -0.01493457705, -0.01745822653,
  1.43761178e-17, 0.02361527272, 0.02738134004, -1.794782744e-17,
  -0.03679697588, -0.04277165979, 2.118134594e-17, 0.05868207663,
  0.06968268007, -2.376238272e-17, -0.1036561802, -0.1325264722,
  2.542798367e-17, 0.2731044292, 0.5502954721, 0.667070806,
  0.5502954721, 0.2731044292, 2.542798367e-17, -0.1325264722,
  -0.1036561802, -2.376238272e-17, 0.06968268007, 0.05868207663,
  2.118134594e-17, -0.04277165979, -0.03679697588, -1.794782744e-17,
  0.02738134004, 0.02361527272, 1.43761178e-17, -0.01745822653,
  -0.01493457705, -1.07889738e-17, 0.01076549385, 0.009052845649,
  7.47593099e-18, -0.006242331583, -0.005103380419, -4.659273471e-18,
  0.003272651462, 0.002551661804, 2.47261904e-18, -0.001434323029,
  -0.001015151618, -9.546140932e-19,
]);

export function resample24kTo16k(input: Float32Array): Float32Array {
  if (input.length === 0) return new Float32Array();
  const outputCount = Math.floor((input.length * 2 + 2) / 3);
  const output = new Float32Array(outputCount);
  const preRemove = 11;
  for (let j = 0; j < outputCount; j += 1) {
    const time = (j + preRemove) * 3;
    const first = Math.max(0, Math.ceil((time - (RESAMPLE_FILTER.length - 1)) / 2));
    const last = Math.min(input.length - 1, Math.floor(time / 2));
    let sum = 0;
    for (let k = first; k <= last; k += 1) sum += RESAMPLE_FILTER[time - k * 2] * input[k];
    output[j] = sum;
  }
  return output;
}

export function pcm16ToFloat32(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) output[i] = input[i] / 32768;
  return output;
}
