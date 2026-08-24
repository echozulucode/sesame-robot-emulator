import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// Deliberately NOT StrictMode's double-invoke in development only — the whole
// app is mounted once here and StrictMode's remount would open two backends and
// two WebGL contexts, which is a lot of noise for the one thing it would catch.
// The backend effect is written to be idempotent anyway; this is about not
// paying for a second GPU context in a headless capture.
const strict = new URLSearchParams(window.location.search).has('strict');

createRoot(container).render(strict ? <StrictMode><App /></StrictMode> : <App />);
