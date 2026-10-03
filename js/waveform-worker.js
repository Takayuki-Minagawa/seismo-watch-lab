/* Response correction is isolated so another station selection can cancel it. */
importScripts('instrument-response.js');
self.onmessage = ({ data }) => {
  try {
    const result = InstrumentResponse.correct(data.samples, data.sampleRate, data.response, {
      preFilter: data.preFilter, taperFraction: 0.05,
    });
    self.postMessage(result, [result.acceleration.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
