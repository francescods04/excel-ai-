'use strict';

function parseTargetReference(target) {
  if (typeof target !== 'string') return { rangeAddress: target };
  const match = target.match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
  if (!match) return { rangeAddress: target };
  return {
    sheetName: (match[1] || match[2] || '').replace(/''/g, "'"),
    rangeAddress: match[3]
  };
}

export { parseTargetReference };
