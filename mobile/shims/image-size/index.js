'use strict';
// Metro calls image-size 1.x style with a file path; 2.x only takes bytes.
const fs = require('fs');
const { imageSize } = require('image-size-patched');

function sizeOf(input) {
  return imageSize(typeof input === 'string' ? fs.readFileSync(input) : input);
}

module.exports = sizeOf;
module.exports.default = sizeOf;
module.exports.imageSize = sizeOf;
