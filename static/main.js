/**
 * Claude Dashboard — ES module entry point.
 *
 * esbuild bundles this into static/bundle.js.
 * Load order matters: app.js defines core globals (state, bus, utils),
 * charts.js defines chart helpers, then domain modules consume them.
 *
 * Each file is imported for side effects (they register globals).
 * Future refactoring can gradually convert to explicit import/export.
 */

// Core: state, bus, accessors, routing, utils, WS, auth, modals
import './app.js';

// Chart helpers: CC, themeColors, CHART_D, chart loaders
import './charts.js';

// Domain modules (depend on core + chart helpers)
import './sessions.js';
import './overview.js';
import './plan.js';
import './subagents.js';
import './timeline.js';
