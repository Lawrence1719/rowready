import { parseCSV } from './data.js';
self.onmessage = ({ data }) => {
  try {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new Error('This file is not UTF-8. Save or export it as UTF-8 CSV and try again.'); }
    self.postMessage({ result: parseCSV(text) });
  } catch (error) { self.postMessage({ error: error.message }); }
};
