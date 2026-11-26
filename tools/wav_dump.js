// Reads a room JSON on stdin, writes the 48k float32 WAV for source 0 / receiver 0.
const fs = require('fs');
const E = require('../app/engine.js');

const room = E.validateRoom(JSON.parse(fs.readFileSync(0, 'utf8')));
const seqs = E.enumerateSequences(room.order);
const paths = E.solvePair(room, 0, 0, seqs);
const resp = E.buildResponse(room, paths);
const blob = E.encodeWav(resp);
const ab = blob.arrayBuffer ? blob : null;
// Node Blob -> buffer
blob.arrayBuffer().then((buf) => process.stdout.write(Buffer.from(buf)));
