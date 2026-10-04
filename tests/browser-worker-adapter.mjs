import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = { postMessage: data => parentPort.postMessage(data) };
await import(workerData.url);
parentPort.on('message', data => self.onmessage({ data }));
