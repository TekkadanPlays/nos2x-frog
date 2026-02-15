/**
 * React shim — re-exports Inferno's createElement so that esbuild-plugin-svgr
 * generated SVG components (which `import * as React from "react"`) work with
 * Inferno instead of React.
 */
export { createElement } from 'inferno-create-element';
export default { createElement: require('inferno-create-element').createElement };
