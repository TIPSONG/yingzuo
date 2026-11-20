'use strict';

/** A different local installation can expose different nodes at the same URL. */
function comfyEnvironment(url, root) {
  return {comfyUrl: String(url ?? '').replace(/\/+$/, ''), comfyRoot: root ?? ''};
}

module.exports = {comfyEnvironment};
